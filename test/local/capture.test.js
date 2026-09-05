const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  CaptureController,
  encodePCM16,
  createBrowserRecorder,
} = require("../../local-ui/capture.ts");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const session = (id) => ({ requestId: id, settings: { microphoneId: "chosen-device" } });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(overrides = {}) {
  const calls = [];
  let recorderOptions;
  const recorder = {
    stop: async () => ({ audio: new ArrayBuffer(46), durationMs: 10 }),
    cancel: () => calls.push("recorder-cancel"),
  };
  const api = {
    beginRecording: async () => {
      calls.push("begin");
      return session("request-one");
    },
    transcribe: async (request) => {
      calls.push(["transcribe", request]);
      return { id: "result" };
    },
    cancel: async (id) => {
      calls.push(["cancel", id]);
    },
    ...overrides.api,
  };
  const changes = [],
    errors = [],
    results = [];
  const owner = new CaptureController(api, {
    createRecorder: async (options) => {
      calls.push("mic");
      recorderOptions = options;
      return recorder;
    },
    onChange: (view) => changes.push(view),
    onError: (key) => errors.push(key),
    onComplete: (result) => results.push(result),
    ...overrides.options,
  });
  return { owner, calls, recorder, changes, errors, results, options: () => recorderOptions };
}

test("snapshot is captured before microphone opens; rapid stops submit once", async () => {
  const h = harness();
  await h.owner.start();
  assert.deepEqual(h.calls, ["begin", "mic"]);
  assert.equal(h.options().microphoneId, "chosen-device");
  await Promise.all([h.owner.stop(), h.owner.stop()]);
  const submits = h.calls.filter((call) => call[0] === "transcribe");
  assert.equal(submits.length, 1);
  assert.equal(submits[0][1].requestId, "request-one");
  assert.ok(submits[0][1].audio instanceof ArrayBuffer);
  assert.equal(h.owner.phase, "idle");
});

test("quick toggle while main is opening cancels; late session never acquires mic", async () => {
  const pending = deferred();
  const h = harness({ api: { beginRecording: () => pending.promise } });
  const starting = h.owner.toggle();
  await h.owner.toggle();
  pending.resolve(session("late-session"));
  await starting;
  assert.equal(h.owner.phase, "idle");
  assert.equal(h.calls.includes("mic"), false);
  assert.ok(h.calls.some((call) => call[0] === "cancel" && call[1] === "late-session"));
  assert.equal(h.results.length, 0);
});

test("cancel while mic opens disposes late stream owner and suppresses recording", async () => {
  const pending = deferred();
  const h = harness({ options: { createRecorder: () => pending.promise } });
  const starting = h.owner.start();
  await flush();
  await h.owner.cancel();
  pending.resolve(h.recorder);
  await starting;
  assert.equal(h.owner.phase, "idle");
  assert.equal(h.calls.filter((call) => call === "recorder-cancel").length, 1);
  assert.equal(
    h.changes.some((change) => change.phase === "recording"),
    false
  );
});

test("cancel during audio draining never submits WAV", async () => {
  const pending = deferred();
  const h = harness();
  h.recorder.stop = () => pending.promise;
  await h.owner.start();
  const stopping = h.owner.stop();
  await h.owner.cancel();
  pending.resolve({ audio: new ArrayBuffer(46), durationMs: 10 });
  await stopping;
  assert.equal(
    h.calls.some((call) => call[0] === "transcribe"),
    false
  );
});

test("busy persists through main completion; late completion after cancel cannot update result", async () => {
  const pending = deferred();
  const h = harness({ api: { transcribe: () => pending.promise } });
  await h.owner.start();
  const stopping = h.owner.stop();
  await flush();
  assert.equal(h.owner.phase, "processing");
  await h.owner.toggle();
  assert.equal(h.calls.filter((call) => call === "begin").length, 1);
  await h.owner.cancel();
  pending.resolve({ id: "late-text" });
  await stopping;
  assert.equal(h.results.length, 0);
  assert.equal(h.owner.phase, "idle");
});

test("input-ended cancels request and reports a useful microphone error", async () => {
  const h = harness();
  await h.owner.start();
  h.options().onEnded();
  await flush();
  assert.equal(h.owner.phase, "idle");
  assert.deepEqual(h.errors, ["capture.disconnected"]);
  assert.equal(
    h.calls.some((call) => call[0] === "transcribe"),
    false
  );
  assert.ok(h.calls.some((call) => call[0] === "cancel" && call[1] === "request-one"));
});

test("recording limit finishes once; old mic events cannot cancel a newer session", async () => {
  const h = harness();
  await h.owner.start();
  const oldOptions = h.options();
  oldOptions.onLimit();
  oldOptions.onLimit();
  await flush();
  assert.equal(h.calls.filter((call) => call[0] === "transcribe").length, 1);
  await h.owner.start();
  oldOptions.onEnded();
  assert.equal(h.owner.phase, "recording");
  await h.owner.dispose();
});

test("StrictMode disposal while idle does not cancel a different renderer request", async () => {
  const h = harness();
  await h.owner.dispose();
  assert.equal(h.calls.length, 0);
});

test("capture failure releases main recording session", async () => {
  const h = harness({
    options: {
      createRecorder: async () => {
        throw new Error("denied");
      },
    },
  });
  await h.owner.start();
  assert.equal(h.owner.phase, "idle");
  assert.deepEqual(h.errors, ["capture.openFailed"]);
  assert.ok(h.calls.some((call) => call[0] === "cancel" && call[1] === "request-one"));
});

test("WAV headers describe 16 kHz mono PCM16, with clipping and finite samples", () => {
  const wav = encodePCM16(new Float32Array([-2, -1, 0, 1, 2, NaN]));
  const view = new DataView(wav);
  assert.equal(Buffer.from(wav).toString("ascii", 0, 4), "RIFF");
  assert.equal(Buffer.from(wav).toString("ascii", 8, 12), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 12);
  assert.deepEqual(
    Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true)),
    [-32768, -32768, 0, 32767, 32767, 0]
  );
});

test("browser mic acquired after abort closes its tracks without opening an audio graph", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const pending = deferred();
  let trackStops = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => pending.promise } },
  });
  try {
    const abort = new AbortController();
    const acquiring = createBrowserRecorder({
      microphoneId: "",
      signal: abort.signal,
      onLevel() {},
      onEnded() {},
      onLimit() {},
    });
    abort.abort();
    pending.resolve({ getTracks: () => [{ stop: () => trackStops++ }] });
    await assert.rejects(acquiring, { name: "AbortError" });
    assert.equal(trackStops, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});

test("worklet drains a partial final block, averages stereo, and ignores post-stop samples", () => {
  let Worklet;
  const messages = [];
  const context = vm.createContext({
    Float32Array,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (message) => messages.push(message) };
      }
    },
    registerProcessor: (_, constructor) => {
      Worklet = constructor;
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../../local-ui/pcm-worklet.js"), "utf8"),
    context
  );
  const processor = new Worklet();
  processor.process([[new Float32Array([1, 0]), new Float32Array([-1, 1])]]);
  processor.port.onmessage({ data: { type: "flush" } });
  processor.process([[new Float32Array([1])]]);
  assert.equal(messages.length, 2);
  assert.deepEqual([...messages[0].samples], [0, 0.5]);
  assert.equal(messages[1].type, "flushed");
});
