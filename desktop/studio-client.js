const { spawn, execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { abortError, throwIfAborted, awaitAbortable } = require("./air-worker-client");
const { normalizeVocabulary } = require("./vocabulary");

const MAX_OUTPUT_TOKENS = 4096;
// The text model has two paths, chosen by `studioText` in machine.json:
//   gateway (default): the owner's dictation gateway on the Studio. OpenAI chat route, a model
//     alias, a bearer key. The gateway starts its model server and loads the model by itself.
//   lmstudio: LM Studio on port 1234. This client loads and unloads its own model instance.
const DEFAULT_TEXT = { backend: "gateway", port: 8640, model: "dictation" };
const KEY_ENV = "OPEN_SUPERWHISPER_GATEWAY_KEY";
const KEY_VAULT = ["/apps/dictation-gateway", "DICTATION_GATEWAY_API_KEY"];
// The gateway keeps the model loaded for a while after a request. Inside this time a new
// recording needs no warm request.
const WARM_FOR_MS = 5 * 60 * 1000;

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
// Returns null for LM Studio. The port goes into the ssh command and the alias into a request,
// so only plain values are accepted.
function textConfig(text) {
  if (text === undefined || text === null) text = DEFAULT_TEXT;
  if (typeof text !== "object" || Array.isArray(text))
    throw new Error("Invalid Studio text settings");
  const { backend = "gateway", port = DEFAULT_TEXT.port, model = DEFAULT_TEXT.model } = text;
  if (backend === "lmstudio") return null;
  if (
    backend !== "gateway" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)
  )
    throw new Error("Invalid Studio text settings");
  return { port, model };
}

function electronSafeStorage() {
  try {
    // Outside Electron this module is only the path of the Electron program.
    const { safeStorage } = require("electron");
    return typeof safeStorage?.isEncryptionAvailable === "function" ? safeStorage : null;
  } catch {
    return null;
  }
}

// The gateway key. Order: the environment (tests), the vault through the `creds` command, then
// the encrypted copy of the last good vault read, so that a vault that is away does not stop
// dictation. The key stays in memory for the app run. It is never logged, and no failure
// here is a connection failure: a missing key must not select another machine.
function gatewayKeySource({
  cachePath,
  env = process.env,
  execFileImpl = execFile,
  safeStorageImpl = electronSafeStorage,
  fsImpl = fs,
} = {}) {
  let pending = null;
  let refresh = false;
  const fromVault = () =>
    new Promise((resolve, reject) => {
      execFileImpl(
        path.join(os.homedir(), ".local", "bin", "creds"),
        ["get", ...KEY_VAULT],
        { timeout: 4000, encoding: "utf8" },
        (error, stdout) => {
          const key = String(stdout || "").trim();
          if (error || !key) reject(new Error("The vault did not give the key"));
          else resolve(key);
        }
      );
    });
  // The macOS Keychain holds the encryption key, and macOS can ask the user before it gives
  // that key to a rebuilt app. So the Keychain is used only when it is necessary: to write the
  // first copy (or a new one after the gateway refused the key), and to read the copy when
  // the vault is away.
  const storage = () => {
    const safe = cachePath ? safeStorageImpl() : null;
    return safe?.isEncryptionAvailable() ? safe : null;
  };
  const saveCopy = async (key) => {
    if (!cachePath) return;
    const exists = await fsImpl.stat(cachePath).then(
      () => true,
      () => false
    );
    if (exists && !refresh) return;
    const safe = storage();
    if (!safe) return;
    await fsImpl.writeFile(cachePath, safe.encryptString(key), { mode: 0o600 });
    refresh = false;
  };
  const readCopy = async () => {
    const key = storage()?.decryptString(await fsImpl.readFile(cachePath));
    if (!key) throw new Error("No saved copy");
    return key;
  };
  const load = async () => {
    if (env[KEY_ENV]) return String(env[KEY_ENV]);
    let key;
    try {
      key = await fromVault();
    } catch {
      try {
        return await readCopy();
      } catch {
        throw new Error("The dictation gateway key is not available; check the vault");
      }
    }
    await saveCopy(key).catch(() => {});
    return key;
  };
  const get = () => {
    if (!pending)
      pending = load().catch((error) => {
        pending = null; // the next request asks the vault again
        throw error;
      });
    return pending;
  };
  // The gateway refused the key: read it again, and replace the saved copy.
  get.reset = () => {
    pending = null;
    refresh = true;
  };
  return get;
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
    text,
    keyImpl,
    keyCachePath,
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
    this.gateway = textConfig(text);
    this.keyImpl = keyImpl || gatewayKeySource({ cachePath: keyCachePath });
    this.usedAt = 0;
    this.instance = `open-superwhisper-26b-${randomUUID().slice(0, 8)}`;
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
        `127.0.0.1:${editorPort}:127.0.0.1:${this.gateway ? this.gateway.port : 1234}`,
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

  // Start loading the editor while the user is still speaking, so the first
  // dictation after an idle period waits less. Failures are ignored here;
  // edit() reports them if they still apply when the text is ready.
  warm() {
    if (this.closed) return;
    this.connect()
      .then((tunnel) => this.ensureEditor(tunnel, this.lifetime.signal, { quiet: true }))
      .catch(() => {});
  }

  // One request to the gateway (OpenAI chat route). Thinking is off, as it is in LM Studio.
  async chat(tunnel, system, input, maxTokens, signal) {
    const key = await awaitAbortable(this.keyImpl(), signal);
    let result;
    try {
      result = await this.json(
        `${tunnel.editor}/v1/chat/completions`,
        {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: this.gateway.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: input },
            ],
            temperature: 0,
            max_tokens: maxTokens,
            enable_thinking: false,
            stream: false,
          }),
        },
        120000
      );
    } catch (error) {
      // A changed key is read again from the vault on the next request.
      if (error.status === 401 || error.status === 403) this.keyImpl.reset?.();
      throw error;
    }
    this.usedAt = Date.now();
    return result;
  }

  async ensureEditor(tunnel, signal, { quiet = false } = {}) {
    if (this.closed) throw new Error("Studio connection has shut down");
    if (this.gateway) {
      // One small request makes the gateway start its model server and load the model.
      if (Date.now() - this.usedAt < WARM_FOR_MS) return;
      if (!this.loading)
        this.loading = this.chat(tunnel, "Answer with OK.", "OK", 1, signal).finally(() => {
          this.loading = null;
        });
      await this.loading;
      return;
    }
    if (this.loading) {
      if (!quiet) this.onProgress("Loading Mac Studio correction");
      return this.loading;
    }
    this.loading = (async () => {
      const catalog = await this.json(`${tunnel.editor}/api/v1/models`, { signal });
      const found = catalog.models?.some((model) =>
        model.loaded_instances?.some((item) => item.id === this.instance)
      );
      if (found) return;
      if (!quiet) this.onProgress("Loading Mac Studio correction");
      this.ownLoadAttempted = true;
      await this.command(
        [
          "load",
          "google/gemma-4-26b-a4b",
          "--identifier",
          this.instance,
          "--context-length",
          "16384",
          "--gpu",
          "max",
          "--ttl",
          "900",
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
    // The gateway loads its model on the request itself: no separate load step.
    if (!this.gateway) await awaitAbortable(this.ensureEditor(tunnel, signal), signal);
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
    if (this.gateway) {
      const result = await this.chat(
        tunnel,
        this.prompts.cleanup,
        JSON.stringify(input),
        MAX_OUTPUT_TOKENS,
        signal
      );
      const choice = result.choices?.[0];
      const content = choice?.message?.content;
      const output = typeof content === "string" ? content.trim() : "";
      if (
        !output ||
        choice.finish_reason === "length" ||
        result.usage?.completion_tokens >= MAX_OUTPUT_TOKENS
      ) {
        throw new Error("Correction was empty or incomplete; original text kept");
      }
      throwIfAborted(signal);
      return output;
    }
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
          max_output_tokens: MAX_OUTPUT_TOKENS,
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
      result.stats?.total_output_tokens >= MAX_OUTPUT_TOKENS ||
      result.stats?.output_tokens >= MAX_OUTPUT_TOKENS ||
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

module.exports = { StudioClient, unavailable, gatewayKeySource };
