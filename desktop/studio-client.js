const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const { abortError, throwIfAborted, awaitAbortable } = require("./air-worker-client");
const { normalizeVocabulary } = require("./vocabulary");

function unavailable(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: "STUDIO_UNAVAILABLE" });
}
function connectionFailure(error) {
  return (
    error.name === "TimeoutError" ||
    [502, 503, 504].includes(error.status) ||
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
      "EPIPE",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(error.code || error.cause?.code)
  );
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

class StudioClient {
  constructor({
    target = "mac-studio",
    prompts,
    onProgress = () => {},
    spawnImpl = spawn,
    fetchImpl = globalThis.fetch,
    portImpl = freePort,
    sleepImpl = sleep,
  }) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(target))
      throw new Error("Invalid Studio SSH target");
    Object.assign(this, { target, prompts, onProgress, spawnImpl, fetchImpl, portImpl, sleepImpl });
    this.instance = `open-superwhisper-e4b-${randomUUID().slice(0, 8)}`;
    this.tunnel = null;
    this.connecting = null;
    this.loading = null;
    this.ownLoadAttempted = false;
    this.closed = false;
    this.lifetime = new AbortController();
  }

  sshOptions() {
    return [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
    ];
  }

  async json(url, options = {}, timeoutMs = 5000) {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    throwIfAborted(signal);
    try {
      const response = await this.fetchImpl(url, {
        ...options,
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.ok) {
        const error = new Error(`Studio request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      const result = await response.json();
      throwIfAborted(signal);
      return result;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (connectionFailure(error)) throw unavailable("Mac Studio is unavailable", error);
      throw error;
    }
  }

  async connect() {
    if (this.closed) throw unavailable("Studio connection has shut down");
    if (this.tunnel?.ready) return this.tunnel;
    if (!this.connecting) this.connecting = this.openTunnel();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async openTunnel() {
    const asrPort = await this.portImpl();
    let editorPort = await this.portImpl();
    if (editorPort === asrPort) editorPort = await this.portImpl();
    const child = this.spawnImpl(
      "/usr/bin/ssh",
      [
        "-N",
        ...this.sshOptions(),
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `127.0.0.1:${asrPort}:127.0.0.1:8766`,
        "-L",
        `127.0.0.1:${editorPort}:127.0.0.1:1234`,
        this.target,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    const tunnel = {
      child,
      asr: `http://127.0.0.1:${asrPort}`,
      editor: `http://127.0.0.1:${editorPort}`,
      ready: false,
      ended: false,
      stderr: "",
    };
    this.tunnel = tunnel;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      tunnel.stderr = (tunnel.stderr + data).slice(-4096);
    });
    const ended = () => {
      tunnel.ended = true;
      if (this.tunnel === tunnel) this.tunnel = null;
    };
    child.on("error", ended);
    child.on("close", ended);
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        if (this.closed || tunnel.ended) break;
        try {
          const health = await this.json(`${tunnel.asr}/health`, {}, 750);
          if (health.status === "healthy") {
            tunnel.ready = true;
            return tunnel;
          }
        } catch {
          /* The forward needs a brief startup interval. */
        }
        await this.sleepImpl(150);
      }
      throw unavailable("Mac Studio speech recognition is unavailable");
    } catch (error) {
      child.kill("SIGTERM");
      if (this.tunnel === tunnel) this.tunnel = null;
      throw error;
    }
  }

  async check() {
    try {
      const tunnel = await this.connect();
      const health = await this.json(`${tunnel.asr}/health`);
      return health.status === "healthy";
    } catch {
      return false;
    }
  }

  async transcribe({ audioPath, vocabulary = [], signal }) {
    signal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    throwIfAborted(signal);
    try {
      const tunnel = await awaitAbortable(this.connect(), signal);
      throwIfAborted(signal);
      const body = new FormData();
      body.append(
        "file",
        new Blob([await fs.readFile(audioPath)], { type: "audio/wav" }),
        "dictation.wav"
      );
      // Recognition needs the desired spellings, not the mishearings we correct
      // later. The existing speech service accepts this per-request hint field.
      const words = normalizeVocabulary(vocabulary).map((entry) => entry.word);
      if (words.length) body.append("vocab", words.join(", "));
      this.onProgress("Transcribing on Mac Studio");
      const result = await this.json(
        `${tunnel.asr}/transcribe`,
        { method: "POST", body, signal },
        180000
      );
      if (typeof result.text !== "string") throw new Error("Studio returned an invalid transcript");
      return result.text.trim();
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw abortError();
      // Invalid output and model errors are not a reason to select another
      // machine. Only a connection failure may activate Auto fallback.
      throw error;
    }
  }

  command(args, timeoutMs = 120000, { signal, duringShutdown = false } = {}) {
    signal = AbortSignal.any([
      ...(duringShutdown ? [] : [this.lifetime.signal]),
      ...(signal ? [signal] : []),
    ]);
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      // Only fixed CLI arguments and our generated identifier enter this remote
      // command. Transcript data travels solely in the forwarded HTTP request.
      const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
      const child = this.spawnImpl(
        "/usr/bin/ssh",
        [
          ...this.sshOptions(),
          this.target,
          ['"$HOME/.lmstudio/bin/lms"', ...args.map(quote)].join(" "),
        ],
        {
          stdio: ["ignore", "ignore", "pipe"],
        }
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-4096);
      });
      const onAbort = () => {
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        child.kill("SIGTERM");
        reject(new Error("Studio model command timed out"));
      }, timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (code === 0) resolve();
        else if (code === 255) reject(unavailable("Mac Studio connection is unavailable"));
        else reject(new Error(`Studio model command failed (${code ?? "connection closed"})`));
      });
    });
  }

  async ensureEditor(tunnel, signal) {
    if (this.closed) throw new Error("Studio connection has shut down");
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const catalog = await this.json(`${tunnel.editor}/api/v1/models`, { signal });
      const found = catalog.models?.some((model) =>
        model.loaded_instances?.some((item) => item.id === this.instance)
      );
      if (found) return;
      this.onProgress("Loading Mac Studio correction");
      this.ownLoadAttempted = true;
      await this.command(
        [
          "load",
          "google/gemma-4-e4b",
          "--identifier",
          this.instance,
          "--context-length",
          "8192",
          "--gpu",
          "max",
          "--ttl",
          "300",
          "--yes",
        ],
        120000,
        { signal }
      );
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async edit({
    text,
    rewrite = false,
    editingMode = "polished",
    style = "neutral",
    vocabulary = [],
    format = "prose",
    signal,
  }) {
    signal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    throwIfAborted(signal);
    if (!["exact", "clean", "polished"].includes(editingMode))
      throw new Error("Invalid editing mode");
    if (!["neutral", "chat", "email"].includes(style)) throw new Error("Invalid text style");
    if (editingMode === "exact") return text;
    if (!text.trim()) return "";
    const tunnel = await awaitAbortable(this.connect(), signal);
    throwIfAborted(signal);
    await awaitAbortable(this.ensureEditor(tunnel, signal), signal);
    throwIfAborted(signal);
    this.onProgress(
      rewrite ? "Improving the wording on Mac Studio" : "Correcting text on Mac Studio"
    );
    const input = {
      transcript: text,
      vocabulary: normalizeVocabulary(vocabulary),
      format: ["paragraphs", "list"].includes(format) ? format : "prose",
      editing_mode: editingMode,
      style,
    };
    const result = await this.json(
      `${tunnel.editor}/api/v1/chat`,
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.instance,
          input: JSON.stringify(input),
          // Retry starts from the original under exactly the same editing
          // instructions as dictation; only the progress message differs.
          system_prompt: this.prompts.cleanup,
          temperature: 0,
          max_output_tokens: 512,
          reasoning: "off",
          store: false,
        }),
      },
      120000
    );
    const output = result.output
      ?.filter((item) => item.type === "message")
      .map((item) => item.content)
      .join("")
      .trim();
    if (
      !output ||
      result.stats?.total_output_tokens >= 512 ||
      result.stats?.output_tokens >= 512 ||
      result.stats?.stop_reason === "max_tokens" ||
      result.stop_reason === "max_tokens"
    ) {
      throw new Error("Correction was empty or incomplete; original text kept");
    }
    throwIfAborted(signal);
    return output;
  }

  async shutdown() {
    this.closed = true;
    this.lifetime.abort();
    this.tunnel?.child.kill("SIGTERM");
    try {
      await this.loading?.catch(() => {});
      if (this.ownLoadAttempted)
        await this.command(["unload", this.instance], 5000, { duringShutdown: true }).catch(
          () => {}
        );
    } finally {
      this.tunnel?.child.kill("SIGTERM");
      this.tunnel = null;
    }
  }
}

module.exports = { StudioClient, unavailable };
