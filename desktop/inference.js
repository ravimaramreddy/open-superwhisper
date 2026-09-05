const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { AirWorkerClient, throwIfAborted } = require("./air-worker-client");
const { StudioClient } = require("./studio-client");

function resourceRoot(resourcesPath) {
  const candidates = [
    resourcesPath && path.join(resourcesPath, "app.asar.unpacked"),
    resourcesPath,
    path.join(__dirname, ".."),
  ].filter(Boolean);
  const root = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "local-runtime", "models.lock.json"))
  );
  if (!root) throw new Error("The packaged local runtime is missing");
  return root;
}

function findUv(configured) {
  const candidates = [
    configured,
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
    path.join(os.homedir(), ".local", "bin", "uv"),
    ...(process.env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.join(entry, "uv")),
  ];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* Try the next location. */
    }
  }
  throw new Error("Install uv from astral.sh/uv, then run local setup again");
}

async function validateAudio(audioPath, userData) {
  const [resolved, root] = await Promise.all([fsp.realpath(audioPath), fsp.realpath(userData)]);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Audio must be an app-owned recording");
  }
  const stat = await fsp.stat(resolved);
  if (!stat.isFile() || stat.size > 10000000) throw new Error("Invalid or oversized recording");
  const data = await fsp.readFile(resolved);
  if (
    data.length < 44 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Recording must be a WAV file");
  }
  let validFormat = false;
  let audioBytes = 0;
  for (let offset = 12; offset + 8 <= data.length;) {
    const kind = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (offset + 8 + size > data.length) throw new Error("Incomplete WAV recording");
    if (kind === "fmt " && size >= 16) {
      validFormat =
        data.readUInt16LE(offset + 8) === 1 &&
        data.readUInt16LE(offset + 10) === 1 &&
        data.readUInt32LE(offset + 12) === 16000 &&
        data.readUInt16LE(offset + 22) === 16;
    }
    if (kind === "data") audioBytes += size;
    offset += 8 + size + (size % 2);
  }
  if (!validFormat || audioBytes === 0 || audioBytes % 2 || audioBytes > 16000 * 2 * 120) {
    throw new Error("Recording must be 16 kHz mono PCM16 WAV, up to 120 seconds");
  }
  return resolved;
}

function createInference({ userData, resourcesPath, onProgress = () => {}, config = {} }) {
  const root = resourceRoot(resourcesPath);
  const lockPath = path.join(root, "local-runtime", "models.lock.json");
  const lockBytes = fs.readFileSync(lockPath);
  const lock = JSON.parse(lockBytes);
  const lockHash = createHash("sha256").update(lockBytes).digest("hex");
  const runtimeDir = path.join(userData, "runtime");
  // Internal dependency injection keeps routing and lifecycle tests off the GPU.
  const deps = config._deps || {};
  const now = deps.now || (() => performance.now());
  let setupPromise = null;
  let setupChild = null;
  let setupExited = null;
  let closed = false;
  let busy = false;
  const lifetime = new AbortController();
  function stopSetupChild(child, signal) {
    if (!child) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    } else child.kill(signal);
  }

  async function readRuntime() {
    try {
      const ready = JSON.parse(await fsp.readFile(path.join(runtimeDir, "ready.json"), "utf8"));
      if (
        ready.version !== 1 ||
        ready.lockSha256 !== lockHash ||
        ready.python !== path.join(runtimeDir, ".venv", "bin", "python")
      )
        return null;
      await fsp.access(ready.python, fs.constants.X_OK);
      for (const [name, model] of Object.entries(lock.models)) {
        const directory = path.join(userData, "models", `${name}-${model.revision}`);
        if (ready.models[name] !== directory) return null;
        for (const file of model.files) {
          const stat = await fsp.stat(path.join(directory, file.name));
          if (!stat.isFile() || stat.size !== file.bytes) return null;
        }
      }
      return ready;
    } catch {
      return null;
    }
  }
  const getRuntime = deps.readRuntime || readRuntime;
  const air =
    deps.air ||
    new AirWorkerClient({
      getRuntime,
      audioRoot: userData,
      workerPath: path.join(root, "local-runtime", "worker.py"),
      onProgress,
    });
  const studio =
    deps.studio ||
    new StudioClient({
      target: config.studioSshTarget || "mac-studio",
      prompts: JSON.parse(
        fs.readFileSync(path.join(root, "local-runtime", "prompts.json"), "utf8")
      ),
      onProgress,
    });

  async function prepareLocal() {
    if (closed) throw new Error("Application is closing");
    const ready = await getRuntime();
    if (closed) throw new Error("Application is closing");
    if (ready) return true;
    if (setupPromise) return setupPromise;
    setupPromise = (async () => {
      const uv = findUv(config.uvPath);
      await fsp.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      const args = [
        "run",
        "--no-project",
        "--python",
        lock.python,
        path.join(root, "scripts", "setup-local-runtime.py"),
        "--user-data",
        userData,
        "--uv",
        uv,
        "--lock",
        lockPath,
      ];
      if (config.seedQwen) args.push("--seed-qwen", config.seedQwen);
      if (config.seedS1) args.push("--seed-s1", config.seedS1);
      await new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("Application is closing"));
          return;
        }
        const child = (deps.spawn || spawn)(uv, args, {
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            UV_CACHE_DIR: path.join(runtimeDir, "uv-cache"),
            UV_PYTHON_INSTALL_DIR: path.join(runtimeDir, "python"),
            PYTHONUNBUFFERED: "1",
          },
        });
        setupChild = child;
        setupExited = new Promise((exited) => child.once("close", exited));
        let buffer = "",
          stderr = "",
          failure;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (data) => {
          stderr = (stderr + data).slice(-8192);
        });
        child.stdout.on("data", (data) => {
          buffer += data;
          if (buffer.length > 65536) {
            stopSetupChild(child, "SIGTERM");
            failure = "Invalid setup response";
            return;
          }
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const event = JSON.parse(line);
              if (event.event === "progress") onProgress(String(event.message));
              if (event.event === "error") failure = String(event.message);
            } catch {
              /* uv status output is not part of setup progress. */
            }
          }
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 && !failure
            ? resolve()
            : reject(new Error(failure || "Local setup failed; retry setup"))
        );
      });
      if (closed) throw new Error("Application is closing");
      if (!(await getRuntime())) throw new Error("Local setup did not finish correctly");
      return true;
    })();
    try {
      return await setupPromise;
    } finally {
      setupPromise = null;
      setupChild = null;
    }
  }

  async function exclusive(operation, signal) {
    throwIfAborted(signal);
    if (closed) throw new Error("Application is closing");
    if (busy)
      throw Object.assign(new Error("A recording is already being processed"), { code: "BUSY" });
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }

  async function processWav({ audioPath, profile = "auto", cleanup = true, signal }) {
    signal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    return exclusive(async () => {
      if (!["auto", "studio", "air"].includes(profile)) throw new Error("Unknown speech profile");
      const started = now();
      audioPath = await (deps.validateAudio || validateAudio)(audioPath, userData);
      throwIfAborted(signal);
      const local = async (fallbackReason) => {
        onProgress(
          fallbackReason
            ? "Mac Studio is unavailable; using local models"
            : "Starting local speech recognition"
        );
        const result = await air.process({ audioPath, cleanup, signal });
        throwIfAborted(signal);
        return {
          ...result,
          actualProfile: "air",
          ...(fallbackReason ? { fallbackReason } : {}),
          timings: { ...result.timings, totalMs: now() - started },
        };
      };
      if (profile === "air") return local();
      let rawText;
      try {
        rawText = await studio.transcribe({ audioPath, signal });
      } catch (error) {
        throwIfAborted(signal);
        if (profile === "auto" && error.code === "STUDIO_UNAVAILABLE")
          return local("Mac Studio speech recognition was unavailable");
        throw error;
      }
      throwIfAborted(signal);
      const afterAsr = now();
      let text = rawText,
        cleanupStatus = "off",
        warning;
      if (cleanup) {
        try {
          text = await studio.edit({ text: rawText, signal });
          throwIfAborted(signal);
          cleanupStatus = "applied";
        } catch (error) {
          throwIfAborted(signal);
          if (error.name === "AbortError") throw error;
          cleanupStatus = "failed";
          warning = "Text correction was unavailable; original transcript kept";
        }
      }
      const finished = now();
      return {
        rawText,
        text,
        actualProfile: "studio",
        cleanupStatus,
        ...(warning ? { warning } : {}),
        timings: {
          asrMs: afterAsr - started,
          cleanupMs: finished - afterAsr,
          totalMs: finished - started,
        },
      };
    }, signal);
  }

  async function rewrite({ text, signal }) {
    signal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    return exclusive(async () => {
      if (typeof text !== "string" || text.length > 32768)
        throw new Error("Invalid or oversized transcript");
      const started = now();
      const output = await studio.edit({ text, rewrite: true, signal });
      throwIfAborted(signal);
      return { text: output, timings: { cleanupMs: now() - started, totalMs: now() - started } };
    }, signal);
  }

  async function shutdown() {
    closed = true;
    lifetime.abort();
    const child = setupChild;
    stopSetupChild(child, "SIGTERM");
    const timer = child ? setTimeout(() => stopSetupChild(child, "SIGKILL"), 2000) : null;
    timer?.unref();
    try {
      await Promise.allSettled([air.shutdown(), studio.shutdown(), setupExited]);
    } finally {
      clearTimeout(timer);
      stopSetupChild(child, "SIGKILL");
    }
  }
  return {
    isLocalReady: async () => Boolean(await getRuntime()),
    prepareLocal,
    checkStudio: () => studio.check(),
    processWav,
    rewrite,
    shutdown,
  };
}

module.exports = { createInference, validateAudio, resourceRoot, findUv };
