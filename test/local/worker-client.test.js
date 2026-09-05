const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AirWorkerClient } = require("../../desktop/air-worker-client");
const { StudioClient } = require("../../desktop/studio-client");

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
  });
  await client.edit({ text: "raw", vocabulary, rewrite: true, format: "list" });
  assert.equal(body.system_prompt, "fixed rewrite");
  assert.equal(JSON.parse(body.input).format, "list");
  assert.match(JSON.parse(body.input).editing_instruction, /without changing meaning/);
  await client.shutdown();
});

test("Studio uses private forwards, owned instance, and reasoning off", async () => {
  const calls = [],
    requests = [];
  let port = 24000;
  const client = new StudioClient({
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
  assert.match(body.model, /^open-superwhisper-e4b-/);
  assert.equal(body.reasoning, "off");
  assert.equal(body.store, false);
  assert.equal(body.temperature, 0);
  assert.equal(JSON.parse(body.input).transcript, "raw");
  await client.shutdown();
  assert.ok(calls.at(-1).at(-1).includes(`'unload' '${client.instance}'`));
  assert.ok(!calls.at(-1).at(-1).includes("someone-elses-model"));
});

test("Studio refuses truncated correction output", async () => {
  const client = new StudioClient({ prompts: { cleanup: "clean" } });
  client.connect = async () => ({ editor: "http://127.0.0.1:1234" });
  client.ensureEditor = async () => {};
  client.json = async () => ({
    output: [{ type: "message", content: "Partial" }],
    stats: { total_output_tokens: 512 },
  });
  await assert.rejects(client.edit({ text: "raw" }), /incomplete/);
});

function coldStudioFixture() {
  const children = [];
  const client = new StudioClient({
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
