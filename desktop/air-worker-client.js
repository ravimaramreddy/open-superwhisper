const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

function abortError() {
  return Object.assign(new Error("Cancelled"), { name: "AbortError", code: "CANCELLED" });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function awaitAbortable(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

class AirWorkerClient {
  constructor({
    getRuntime,
    workerPath,
    audioRoot,
    onProgress = () => {},
    spawnImpl = spawn,
    startupMs = 30000,
    requestMs = 300000,
    idleSeconds = 120,
  }) {
    Object.assign(this, {
      getRuntime,
      workerPath,
      audioRoot,
      onProgress,
      spawnImpl,
      startupMs,
      requestMs,
      idleSeconds,
    });
    this.state = null;
    this.starting = null;
    this.closing = Promise.resolve();
    this.busy = false;
    this.closed = false;
  }

  async start() {
    await this.closing;
    if (this.closed) throw new Error("Local worker has shut down");
    if (this.state) return this.state.ready;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async launch() {
    const runtime = await this.getRuntime();
    if (this.closed) throw new Error("Local worker has shut down");
    if (!runtime)
      throw Object.assign(new Error("Set up local models first"), { code: "LOCAL_NOT_READY" });
    const child = this.spawnImpl(
      runtime.python,
      [
        "-u",
        this.workerPath,
        "--qwen",
        runtime.models.qwen,
        "--s1",
        runtime.models.s1,
        "--audio-root",
        this.audioRoot,
        "--idle-seconds",
        String(this.idleSeconds),
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          TOKENIZERS_PARALLELISM: "false",
        },
      }
    );
    const state = { child, buffer: "", stderr: "", pending: null, settled: false };
    this.state = state;
    state.ready = new Promise((resolve, reject) => {
      state.resolve = () => {
        state.settled = true;
        clearTimeout(state.timer);
        resolve(state);
      };
      state.reject = (error) => {
        state.settled = true;
        clearTimeout(state.timer);
        reject(error);
      };
    });
    state.timer = setTimeout(
      () => this.stop(new Error("Local worker did not start in time")),
      this.startupMs
    );
    state.exited = new Promise((resolve) => {
      state.onExit = resolve;
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      state.stderr = (state.stderr + data).slice(-8192);
    });
    child.stdout.on("data", (data) => this.read(state, data));
    child.stdin.on("error", (error) => {
      if (this.state === state) this.stop(error);
    });
    child.on("error", (error) => {
      this.fail(state, error);
      state.onExit();
    });
    child.on("close", () => {
      this.fail(state, new Error("Local worker stopped"));
      state.onExit();
    });
    return state.ready;
  }

  read(state, data) {
    if (this.state !== state) return;
    state.buffer += data;
    if (state.buffer.length > 1048576) return this.stop(new Error("Invalid local worker response"));
    let newline;
    while ((newline = state.buffer.indexOf("\n")) !== -1) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.stop(new Error("Invalid local worker protocol"));
        return;
      }
      if (message.v !== 1) {
        this.stop(new Error("Unsupported local worker protocol"));
        return;
      }
      if (message.event === "ready") state.resolve();
      else if (message.event === "progress") this.onProgress(String(message.message || ""));
      else if (state.pending?.id === message.id) {
        const pending = state.pending;
        state.pending = null;
        if (message.ok) pending.resolve(message.result);
        else
          pending.reject(
            Object.assign(new Error(message.error?.message || "Local inference failed"), {
              code: message.error?.code || "LOCAL_INFERENCE_FAILED",
            })
          );
      }
    }
  }

  fail(state, error) {
    if (this.state === state) this.state = null;
    if (!state.settled) state.reject(error);
    state.pending?.reject(error);
    state.pending = null;
  }

  stop(error = abortError()) {
    const state = this.state;
    if (!state) return this.closing;
    this.fail(state, error);
    // MLX cannot safely cancel halfway through a graph. A process boundary gives
    // cancellation a definite end and releases both models' memory.
    this.closing = state.exited;
    state.child.kill("SIGKILL");
    return this.closing;
  }

  async process({ audioPath, cleanup, signal }) {
    throwIfAborted(signal);
    if (this.busy)
      throw Object.assign(new Error("Local inference is already running"), { code: "BUSY" });
    this.busy = true;
    const onAbort = () => {
      this.stop(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer;
    try {
      const state = await this.start();
      throwIfAborted(signal);
      const id = randomUUID();
      const result = await new Promise((resolve, reject) => {
        state.pending = { id, resolve, reject };
        timer = setTimeout(() => this.stop(new Error("Local inference timed out")), this.requestMs);
        state.child.stdin.write(
          JSON.stringify({ v: 1, id, method: "process", params: { audioPath, cleanup } }) + "\n"
        );
      });
      throwIfAborted(signal);
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.busy = false;
      if (signal?.aborted) await this.stop(abortError());
    }
  }

  async shutdown() {
    this.closed = true;
    await this.stop(new Error("Application is closing"));
  }
}

module.exports = { AirWorkerClient, abortError, throwIfAborted, awaitAbortable };
