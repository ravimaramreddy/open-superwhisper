const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AirWorkerClient } = require("../../desktop/air-worker-client");
const { StudioClient, gatewayKeySource } = require("../../desktop/studio-client");

// The tests of the LM Studio path select it, as machine.json does with "studioText".
const lmstudio = { backend: "lmstudio" };

function fakeChild(onRequest = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      onRequest(JSON.parse(String(chunk)), child);
      callback();
    },
  });
  child.killed = false;
  child.kill = (signal) => {
    child.killed = signal;
    queueMicrotask(() => child.emit("close", null));
    return true;
  };
  child.send = (message) => child.stdout.write(JSON.stringify(message) + "\n");
  return child;
}

function workerFixture(handler) {
  const children = [];
  const client = new AirWorkerClient({
    getRuntime: async () => ({ python: "/python", models: { qwen: "/qwen", s1: "/s1" } }),
    workerPath: "/worker",
    audioRoot: "/audio",
    spawnImpl: () => {
      const child = fakeChild(handler);
      children.push(child);
      queueMicrotask(() => child.send({ v: 1, event: "ready" }));
      return child;
    },
  });
  return { client, children };
}

test("warm requests reuse one worker; idle exit allows a fresh worker", async () => {
  const { client, children } = workerFixture((request, child) =>
    queueMicrotask(() => {
      child.send({ v: 1, id: request.id, ok: true, result: { text: "done" } });
    })
  );
  assert.equal((await client.process({ audioPath: "/audio/x", cleanup: true })).text, "done");
  await client.process({ audioPath: "/audio/x", cleanup: true });
  assert.equal(children.length, 1);
  children[0].emit("close", 0);
  await client.process({ audioPath: "/audio/x", cleanup: true });
  assert.equal(children.length, 2);
  await client.shutdown();
  assert.equal(children[1].killed, "SIGKILL");
});

test("cancellation kills the worker and ignores its late result", async () => {
  let pending;
  const { client, children } = workerFixture((request) => {
    pending = request;
  });
  const controller = new AbortController();
  const promise = client.process({
    audioPath: "/audio/x",
    cleanup: true,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  children[0].send({ v: 1, id: pending.id, ok: true, result: { text: "must not escape" } });
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(children[0].killed, "SIGKILL");
  await client.shutdown();
});

test("cancellation during runtime readiness does not leave a loaded worker", async () => {
  let provideRuntime;
  const children = [];
  const client = new AirWorkerClient({
    getRuntime: () =>
      new Promise((resolve) => {
        provideRuntime = resolve;
      }),
    workerPath: "/worker",
    audioRoot: "/audio",
    spawnImpl: () => {
      const child = fakeChild();
      children.push(child);
      queueMicrotask(() => child.send({ v: 1, event: "ready" }));
      return child;
    },
  });
  const controller = new AbortController();
  const result = client.process({ audioPath: "/audio/x", signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  provideRuntime({ python: "/python", models: { qwen: "/qwen", s1: "/s1" } });
  await assert.rejects(result, { name: "AbortError" });
  assert.ok(children.every((child) => child.killed));
  await client.shutdown();
});

test("malformed worker response kills that process", async () => {
  const { client, children } = workerFixture((_request, child) =>
    queueMicrotask(() => child.stdout.write("library noise\n"))
  );
  await assert.rejects(client.process({ audioPath: "/audio/x", cleanup: true }), /protocol/);
  assert.equal(children[0].killed, "SIGKILL");
  await client.shutdown();
});

test("missing model runtime does not spawn Python", async () => {
  const client = new AirWorkerClient({
    getRuntime: async () => null,
    spawnImpl: () => assert.fail("must not spawn"),
  });
  await assert.rejects(client.process({ audioPath: "/audio/x" }), { code: "LOCAL_NOT_READY" });
  await client.shutdown();
});

test("Air sends per-request vocabulary and trained format selection to its worker", async () => {
  let observed;
  const { client } = workerFixture((request, child) => {
    observed = request.params;
    queueMicrotask(() =>
      child.send({ v: 1, id: request.id, ok: true, result: { rawText: "raw", text: "clean" } })
    );
  });
  const vocabulary = [{ word: "OpenSuperwhisper", aliases: ["open super whisper"] }];
  try {
    const result = await client.process({
      audioPath: "/audio/x",
      cleanup: true,
      vocabulary,
      format: "list",
    });
    assert.deepEqual(observed, {
      audioPath: "/audio/x",
      cleanup: true,
      editingMode: "polished",
      style: "neutral",
      vocabulary,
      format: "list",
    });
    assert.deepEqual(result, { rawText: "raw", text: "clean" });
  } finally {
    await client.shutdown();
  }
});

test("Studio recognition sends canonical vocabulary only and omits an empty hint", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osw-vocabulary-"));
  const audioPath = path.join(directory, "fixture.wav");
  await fs.writeFile(audioPath, "fixture");
  const client = new StudioClient({ prompts: {} });
  const requests = [];
  client.connect = async () => ({ asr: "http://127.0.0.1:8766" });
  client.json = async (_url, options) => {
    requests.push(options.body);
    return { text: "Transcript." };
  };
  try {
    await client.transcribe({
      audioPath,
      vocabulary: [
        { word: "OpenSuperwhisper", aliases: ["open super whisper"] },
        { word: "Tailscale", aliases: [] },
      ],
    });
    await client.transcribe({ audioPath });
    assert.equal(requests[0].get("vocab"), "OpenSuperwhisper, Tailscale");
    assert.equal(requests[0].get("file").name, "dictation.wav");
    assert.equal(requests[1].has("vocab"), false);
  } finally {
    await client.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Studio editing keeps personal vocabulary and format in JSON data", async () => {
  const client = new StudioClient({
    text: lmstudio,
    prompts: { cleanup: "fixed cleanup", rewrite: "fixed rewrite" },
  });
  client.connect = async () => ({ editor: "http://127.0.0.1:1234" });
  client.ensureEditor = async () => {};
  let body;
  client.json = async (_url, options) => {
    body = JSON.parse(options.body);
    return { output: [{ type: "message", content: "Edited." }] };
  };
  const vocabulary = [{ word: "OpenSuperwhisper", aliases: ["open super whisper"] }];
  await client.edit({ text: 'Use "open super whisper".', vocabulary, format: "paragraphs" });
  assert.equal(body.system_prompt, "fixed cleanup");
  assert.deepEqual(JSON.parse(body.input), {
    transcript: 'Use "open super whisper".',
    vocabulary,
    format: "paragraphs",
    editing_mode: "polished",
    style: "neutral",
  });
  await client.edit({ text: "raw", vocabulary, rewrite: true, format: "list" });
  assert.equal(body.system_prompt, "fixed cleanup");
  assert.equal(JSON.parse(body.input).format, "list");
  assert.equal(JSON.parse(body.input).editing_instruction, undefined);
  await client.shutdown();
});

test("Studio uses private forwards, owned instance, and reasoning off", async () => {
  const calls = [],
    requests = [];
  let port = 24000;
  const client = new StudioClient({
    text: lmstudio,
    prompts: { cleanup: "clean", rewrite: "rewrite" },
    portImpl: async () => ++port,
    sleepImpl: async () => {},
    spawnImpl: (_executable, args) => {
      calls.push(args);
      const child = fakeChild();
      if (!args.includes("-N")) queueMicrotask(() => child.emit("close", 0));
      return child;
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      let response;
      if (url.endsWith("/health")) response = { status: "healthy" };
      if (url.endsWith("/models"))
        response = { models: [{ loaded_instances: [{ id: "someone-elses-model" }] }] };
      if (url.endsWith("/chat"))
        response = {
          output: [{ type: "message", content: "Edited." }],
          stats: { total_output_tokens: 3 },
        };
      return { ok: true, json: async () => response };
    },
  });
  assert.equal(await client.edit({ text: "raw" }), "Edited.");
  assert.ok(calls[0].includes("127.0.0.1:24001:127.0.0.1:8766"));
  assert.ok(calls[0].includes("127.0.0.1:24002:127.0.0.1:1234"));
  const body = JSON.parse(requests.find((request) => request.url.endsWith("/chat")).options.body);
  assert.match(body.model, /^open-superwhisper-26b-/);
  assert.equal(body.reasoning, "off");
  assert.equal(body.store, false);
  assert.equal(body.temperature, 0);
  assert.ok(calls.some((args) => args.at(-1).includes("'--context-length' '16384'")));
  assert.equal(JSON.parse(body.input).transcript, "raw");
  await client.shutdown();
  assert.ok(calls.at(-1).at(-1).includes(`'unload' '${client.instance}'`));
  assert.ok(!calls.at(-1).at(-1).includes("someone-elses-model"));
});

test("Studio warm starts one quiet editor load that a later edit reuses", async () => {
  const progress = [],
    commands = [];
  let finishLoad;
  const client = new StudioClient({
    text: lmstudio,
    prompts: { cleanup: "clean" },
    onProgress: (message) => progress.push(message),
  });
  client.connect = async () => ({ editor: "http://127.0.0.1:1234" });
  client.command = (args) => {
    commands.push(args[0]);
    return args[0] === "load"
      ? new Promise((resolve) => (finishLoad = resolve))
      : Promise.resolve();
  };
  client.json = async (url) =>
    url.endsWith("/models")
      ? { models: [] }
      : { output: [{ type: "message", content: "Edited." }], stats: { total_output_tokens: 1 } };
  try {
    client.warm();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(commands, ["load"]);
    assert.deepEqual(progress, []);
    const edited = client.edit({ text: "raw" });
    await new Promise((resolve) => setImmediate(resolve));
    finishLoad();
    assert.equal(await edited, "Edited.");
    assert.deepEqual(commands, ["load"]);
    assert.ok(progress.includes("Loading Mac Studio correction"));
  } finally {
    await client.shutdown();
  }
});

test("Studio accepts complete correction longer than 512 tokens", async () => {
  const client = new StudioClient({ text: lmstudio, prompts: { cleanup: "clean" } });
  client.connect = async () => ({ editor: "http://127.0.0.1:1234" });
  client.ensureEditor = async () => {};
  const tokens = [...Array(767).fill("Edited "), "final detail."];
  client.json = async (_url, options) => {
    const generated = tokens.slice(0, JSON.parse(options.body).max_output_tokens);
    return {
      output: [{ type: "message", content: generated.join("") }],
      stats: { total_output_tokens: generated.length },
    };
  };
  try {
    assert.equal(await client.edit({ text: "raw ".repeat(768) }), tokens.join(""));
  } finally {
    await client.shutdown();
  }
});

test("Studio refuses exhausted correction output using every supported stop signal", async () => {
  const client = new StudioClient({ text: lmstudio, prompts: { cleanup: "clean" } });
  client.connect = async () => ({ editor: "http://127.0.0.1:1234" });
  client.ensureEditor = async () => {};
  try {
    for (const stop of [
      { stats: { total_output_tokens: 4096 } },
      { stats: { output_tokens: 4096 } },
      { stats: { total_output_tokens: 4097 } },
      { stats: { stop_reason: "max_tokens" } },
      { stop_reason: "max_tokens" },
    ]) {
      client.json = async () => ({
        output: [{ type: "message", content: "Partial" }],
        ...stop,
      });
      await assert.rejects(client.edit({ text: "raw" }), /incomplete/);
    }
  } finally {
    await client.shutdown();
  }
});

function coldStudioFixture() {
  const children = [];
  const client = new StudioClient({
    text: lmstudio,
    prompts: { cleanup: "clean" },
    spawnImpl: (_exe, args) => {
      const child = fakeChild();
      children.push({ child, args });
      if (args.at(-1).includes("'unload'")) queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  client.connect = async () => ({ editor: "http://127.0.0.1:1234" });
  client.json = async () => ({ models: [] });
  return { client, children };
}

test("cancelling cold Studio load rejects promptly and terminates its CLI child", async () => {
  const { client, children } = coldStudioFixture();
  const controller = new AbortController();
  const result = client.edit({ text: "raw", signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1);
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(children[0].child.killed, "SIGTERM");
  await client.shutdown();
  assert.ok(children.at(-1).args.at(-1).includes(`'unload' '${client.instance}'`));
});

test("shutdown interrupts cold model loading before unloading only its own identifier", async () => {
  const { client, children } = coldStudioFixture();
  const rejection = assert.rejects(client.edit({ text: "raw" }), { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  await client.shutdown();
  await rejection;
  assert.equal(children[0].child.killed, "SIGTERM");
  assert.equal(children.length, 2);
  assert.ok(children[1].args.at(-1).includes(`'unload' '${client.instance}'`));
});

test("Studio caller can cancel while an SSH connection is still starting", async () => {
  const client = new StudioClient({ prompts: {} });
  let connected;
  client.connect = () =>
    new Promise((resolve) => {
      connected = resolve;
    });
  const controller = new AbortController();
  const result = client.transcribe({ audioPath: "/never-read.wav", signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  connected({});
  await client.shutdown();
});

test("Air retry has its own text-only protocol method and reuses the worker", async () => {
  const observed = [];
  const { client, children } = workerFixture((request, child) => {
    observed.push(request);
    queueMicrotask(() =>
      child.send({ v: 1, id: request.id, ok: true, result: { text: "Edited." } })
    );
  });
  try {
    for (let i = 0; i < 2; i++)
      await client.rewrite({
        text: "edited",
        editingMode: "clean",
        style: "email",
        format: "paragraphs",
      });
    assert.equal(children.length, 1);
    for (const request of observed) {
      assert.equal(request.method, "rewrite");
      assert.deepEqual(request.params, {
        text: "edited",
        editingMode: "clean",
        style: "email",
        format: "paragraphs",
        vocabulary: [],
      });
      assert.equal(request.params.audioPath, undefined);
    }
  } finally {
    await client.shutdown();
  }
});

test("Studio receives explicit mode and style instructions without mixing them into transcript data", async () => {
  const prompts = require("../../local-runtime/prompts.json");
  const client = new StudioClient({ text: lmstudio, prompts });
  client.connect = async () => ({ editor: "http://127.0.0.1:1234" });
  client.ensureEditor = async () => {};
  let observed;
  client.json = async (_url, options) => {
    observed = JSON.parse(options.body);
    return { output: [{ type: "message", content: "Edited." }] };
  };
  await client.edit({ text: "original", editingMode: "clean", style: "email", rewrite: true });
  const input = JSON.parse(observed.input);
  assert.equal(input.editing_mode, "clean");
  assert.equal(input.style, "email");
  assert.equal(input.transcript, "original");
  assert.equal(input.editing_instruction, undefined);
  assert.match(observed.system_prompt, /preserving sentence order/);
  assert.match(observed.system_prompt, /Never invent a greeting/);
  assert.match(observed.system_prompt, /Do not condense complete thoughts/);
  await client.shutdown();
});

test("Studio unavailable classification excludes invalid model output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osw-output-"));
  const audioPath = path.join(directory, "fixture.wav");
  await fs.writeFile(audioPath, "fixture");
  const client = new StudioClient({ prompts: {} });
  client.connect = async () => ({ asr: "http://127.0.0.1:8766" });
  client.json = async () => ({ text: null });
  try {
    await assert.rejects(client.transcribe({ audioPath }), (error) => {
      assert.match(error.message, /invalid transcript/);
      assert.notEqual(error.code, "STUDIO_UNAVAILABLE");
      return true;
    });
  } finally {
    await client.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
  }
  const offline = new StudioClient({
    prompts: {},
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
  });
  await assert.rejects(offline.json("http://127.0.0.1:1234"), { code: "STUDIO_UNAVAILABLE" });
  await offline.shutdown();
});

// ---- The dictation gateway: the default path of the text model ----

function gatewayFixture({ chat, key = async () => "test-key" } = {}) {
  const calls = [],
    requests = [];
  let port = 24000;
  const client = new StudioClient({
    prompts: { cleanup: "fixed cleanup" },
    keyImpl: key,
    portImpl: async () => ++port,
    sleepImpl: async () => {},
    spawnImpl: (_executable, args) => {
      calls.push(args);
      return fakeChild();
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/health")) return { ok: true, json: async () => ({ status: "healthy" }) };
      return chat(JSON.parse(options.body));
    },
  });
  const chats = () => requests.filter((request) => request.url.endsWith("/v1/chat/completions"));
  return { client, calls, requests, chats };
}
const answer = (content, extra = {}) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { completion_tokens: 3 },
    ...extra,
  }),
});

test("the gateway is the default text path: its own port, chat route, bearer key, thinking off, no lms", async () => {
  const { client, calls, chats } = gatewayFixture({ chat: async () => answer(" Edited. ") });
  const vocabulary = [{ word: "OpenSuperwhisper", aliases: ["open super whisper"] }];
  assert.equal(await client.edit({ text: "raw", vocabulary, format: "list" }), "Edited.");
  assert.ok(calls[0].includes("127.0.0.1:24001:127.0.0.1:8766"));
  assert.ok(calls[0].includes("127.0.0.1:24002:127.0.0.1:8640"));
  assert.equal(chats().length, 1);
  const { url, options } = chats()[0];
  assert.equal(url, "http://127.0.0.1:24002/v1/chat/completions");
  assert.equal(options.headers.Authorization, "Bearer test-key");
  const body = JSON.parse(options.body);
  assert.equal(body.model, "dictation");
  assert.equal(body.temperature, 0);
  assert.equal(body.enable_thinking, false);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.messages[0], { role: "system", content: "fixed cleanup" });
  assert.equal(body.messages[1].role, "user");
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    transcript: "raw",
    vocabulary,
    format: "list",
    editing_mode: "polished",
    style: "neutral",
  });
  await client.shutdown();
  // Only the tunnel was started: no remote lms load, and no unload at shutdown.
  assert.equal(calls.length, 1);
  assert.ok(calls.every((args) => !args.at(-1).includes("lms")));
});

test("machine settings select the gateway port and alias, or LM Studio, and reject unsafe values", () => {
  const own = new StudioClient({ prompts: {}, text: { port: 9001, model: "my-model.v2" } });
  assert.deepEqual(own.gateway, { port: 9001, model: "my-model.v2" });
  assert.deepEqual(new StudioClient({ prompts: {}, text: null }).gateway, {
    port: 8640,
    model: "dictation",
  });
  assert.equal(new StudioClient({ prompts: {}, text: { backend: "lmstudio" } }).gateway, null);
  for (const text of [
    "lmstudio",
    [],
    { backend: "cloud" },
    { port: "8640" },
    { port: 80 },
    { port: 70000 },
    { model: "-o ProxyCommand=x" },
    { model: "a b" },
    { model: "" },
  ])
    assert.throws(() => new StudioClient({ prompts: {}, text }), /Invalid Studio text settings/);
});

test("gateway warm sends one small request, and a later edit needs no second warm", async () => {
  const bodies = [];
  const { client, chats } = gatewayFixture({
    chat: async (body) => {
      bodies.push(body);
      return answer(body.max_tokens === 1 ? "OK" : "Edited.");
    },
  });
  try {
    client.warm();
    client.warm();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(chats().length, 1);
    assert.equal(bodies[0].max_tokens, 1);
    assert.ok(!JSON.stringify(bodies[0]).includes("transcript"));
    assert.equal(await client.edit({ text: "raw" }), "Edited.");
    client.warm();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(chats().length, 2);
  } finally {
    await client.shutdown();
  }
});

test("gateway refuses empty or exhausted correction output", async () => {
  for (const response of [
    answer(""),
    answer("   "),
    answer("Partial", { choices: [{ message: { content: "Partial" }, finish_reason: "length" }] }),
    answer("Partial", { usage: { completion_tokens: 4096 } }),
    { ok: true, json: async () => ({ choices: [] }) },
    { ok: true, json: async () => ({}) },
  ]) {
    const { client } = gatewayFixture({ chat: async () => response });
    await assert.rejects(client.edit({ text: "raw" }), /empty or incomplete/);
    await client.shutdown();
  }
});

test("a missing key or a refusal from the gateway is a plain error; only a lost connection is Studio-unavailable", async () => {
  // No key: the text is not sent anywhere.
  const noKey = gatewayFixture({
    chat: async () => answer("Edited."),
    key: async () => {
      throw new Error("The dictation gateway key is not available; check the vault");
    },
  });
  await assert.rejects(noKey.client.edit({ text: "private words" }), (error) => {
    assert.match(error.message, /key is not available/);
    assert.notEqual(error.code, "STUDIO_UNAVAILABLE");
    return true;
  });
  assert.equal(noKey.chats().length, 0);
  await noKey.client.shutdown();

  for (const status of [400, 401, 403, 404, 409, 422, 500]) {
    let resets = 0;
    const key = async () => "old-key";
    key.reset = () => resets++;
    const refused = gatewayFixture({ chat: async () => ({ ok: false, status }), key });
    await assert.rejects(refused.client.edit({ text: "raw" }), (error) => {
      assert.equal(error.status, status);
      assert.notEqual(error.code, "STUDIO_UNAVAILABLE");
      return true;
    });
    // A refused key is read again from the vault on the next request.
    assert.equal(resets, [401, 403].includes(status) ? 1 : 0);
    await refused.client.shutdown();
  }

  for (const failure of [
    async () => ({ ok: false, status: 503 }),
    async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
  ]) {
    const away = gatewayFixture({ chat: failure });
    await assert.rejects(away.client.edit({ text: "raw" }), { code: "STUDIO_UNAVAILABLE" });
    await away.client.shutdown();
  }
});

function keyFixture({ vault, saved, encryption = true, env = {} }) {
  const execs = [],
    keychain = [],
    files = new Map(saved ? [["/data/key.bin", Buffer.from(`sealed:${saved}`)]] : []);
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const source = gatewayKeySource({
    cachePath: "/data/key.bin",
    env,
    execFileImpl: (file, args, options, done) => {
      execs.push({ file, args, options });
      const result = vault();
      queueMicrotask(() => done(result.error || null, result.stdout || ""));
    },
    safeStorageImpl: () => ({
      isEncryptionAvailable: () => {
        keychain.push("ask");
        return encryption;
      },
      encryptString: (value) => Buffer.from(`sealed:${value}`),
      decryptString: (buffer) => String(buffer).replace(/^sealed:/, ""),
    }),
    fsImpl: {
      stat: async (file) => {
        if (!files.has(file)) throw missing();
        return {};
      },
      writeFile: async (file, data, options) => {
        files.set(file, data);
        files.mode = options.mode;
      },
      readFile: async (file) => {
        if (!files.has(file)) throw missing();
        return files.get(file);
      },
    },
  });
  return { source, execs, files, keychain };
}

test("gateway key comes from the vault once per run and leaves an encrypted copy", async () => {
  const { source, execs, files } = keyFixture({ vault: () => ({ stdout: "vault-key\n" }) });
  assert.equal(await source(), "vault-key");
  assert.equal(await source(), "vault-key");
  assert.equal(execs.length, 1);
  assert.equal(execs[0].file, path.join(os.homedir(), ".local", "bin", "creds"));
  assert.deepEqual(execs[0].args, ["get", "/apps/dictation-gateway", "DICTATION_GATEWAY_API_KEY"]);
  assert.ok(execs[0].options.timeout <= 5000);
  assert.equal(String(files.get("/data/key.bin")), "sealed:vault-key");
  assert.equal(files.mode, 0o600);
});

test("gateway key leaves the Keychain alone on a normal start, and replaces the copy after a refusal", async () => {
  let current = "new-key";
  const { source, execs, files, keychain } = keyFixture({
    vault: () => ({ stdout: current }),
    saved: "old-key",
  });
  assert.equal(await source(), "new-key");
  assert.deepEqual(keychain, []);
  assert.equal(String(files.get("/data/key.bin")), "sealed:old-key");
  // The gateway refused the key: the vault is asked again and the copy is replaced.
  current = "newer-key";
  source.reset();
  assert.equal(await source(), "newer-key");
  assert.equal(execs.length, 2);
  assert.equal(String(files.get("/data/key.bin")), "sealed:newer-key");
});

test("gateway key uses the encrypted copy when the vault is away, and fails plainly with no copy", async () => {
  const offline = () => ({ error: new Error("vault away"), stdout: "" });
  const withCopy = keyFixture({ vault: offline, saved: "saved-key" });
  assert.equal(await withCopy.source(), "saved-key");

  for (const fixture of [
    keyFixture({ vault: offline }),
    keyFixture({ vault: offline, saved: "saved-key", encryption: false }),
    keyFixture({ vault: () => ({ stdout: "  \n" }) }),
  ]) {
    await assert.rejects(fixture.source(), (error) => {
      assert.match(error.message, /key is not available/);
      assert.notEqual(error.code, "STUDIO_UNAVAILABLE");
      assert.ok(!error.message.includes("saved-key"));
      return true;
    });
    // A failure is not remembered: the next request asks the vault again.
    await assert.rejects(fixture.source());
    assert.equal(fixture.execs.length, 2);
  }

  const noEncryption = keyFixture({ vault: () => ({ stdout: "vault-key" }), encryption: false });
  assert.equal(await noEncryption.source(), "vault-key");
  assert.equal(noEncryption.files.size, 0);
});

test("gateway key from the environment needs neither the vault nor a saved copy", async () => {
  const { source, execs, files } = keyFixture({
    vault: () => ({ stdout: "vault-key" }),
    env: { OPEN_SUPERWHISPER_GATEWAY_KEY: "env-key" },
  });
  assert.equal(await source(), "env-key");
  assert.equal(execs.length, 0);
  assert.equal(files.size, 0);
});
