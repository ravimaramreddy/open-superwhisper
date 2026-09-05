const test = require("node:test");
const assert = require("node:assert/strict");
const { createInference } = require("../../desktop/inference");

const airResult = {
  rawText: "raw locally",
  text: "Raw locally.",
  actualProfile: "air",
  cleanupStatus: "applied",
  timings: { asrMs: 1, cleanupMs: 2, totalMs: 3 },
};
function fixture(overrides = {}) {
  const calls = [];
  const air = {
    process: async () => {
      calls.push("air");
      return airResult;
    },
    shutdown: async () => {},
  };
  const studio = {
    transcribe: async () => {
      calls.push("asr");
      return "raw studio";
    },
    edit: async () => {
      calls.push("edit");
      return "Raw Studio.";
    },
    check: async () => true,
    shutdown: async () => {},
  };
  Object.assign(studio, overrides.studio);
  Object.assign(air, overrides.air);
  const instance = createInference({
    userData: "/private/tmp/osw-test",
    config: {
      _deps: {
        air,
        studio,
        validateAudio: async (audio) => audio,
        readRuntime: async () => ({}),
      },
    },
  });
  return { instance, calls };
}
const request = { audioPath: "/private/tmp/osw-test/audio.wav", profile: "auto", cleanup: true };

test("Studio success preserves raw transcript and avoids the Air", async () => {
  const { instance, calls } = fixture();
  const result = await instance.processWav(request);
  assert.deepEqual(calls, ["asr", "edit"]);
  assert.equal(result.rawText, "raw studio");
  assert.equal(result.text, "Raw Studio.");
  assert.equal(result.actualProfile, "studio");
  assert.equal(result.cleanupStatus, "applied");
});

test("auto falls back only for unavailable Studio ASR", async () => {
  const offline = Object.assign(new Error("offline"), { code: "STUDIO_UNAVAILABLE" });
  const { instance, calls } = fixture({
    studio: {
      transcribe: async () => {
        throw offline;
      },
    },
  });
  const result = await instance.processWav(request);
  assert.deepEqual(calls, ["air"]);
  assert.equal(result.actualProfile, "air");
  assert.match(result.fallbackReason, /unavailable/);
  const invalid = fixture({
    studio: {
      transcribe: async () => {
        throw new Error("bad audio");
      },
    },
  });
  await assert.rejects(invalid.instance.processWav(request), /bad audio/);
  assert.deepEqual(invalid.calls, []);
});

test("forced profiles do not silently select another machine", async () => {
  const failed = fixture({
    studio: {
      transcribe: async () => {
        throw Object.assign(new Error("offline"), { code: "STUDIO_UNAVAILABLE" });
      },
    },
  });
  await assert.rejects(failed.instance.processWav({ ...request, profile: "studio" }), /offline/);
  assert.deepEqual(failed.calls, []);
  const local = fixture();
  await local.instance.processWav({ ...request, profile: "air" });
  assert.deepEqual(local.calls, ["air"]);
});

test("cleanup failure returns raw text without redoing recognition", async () => {
  const { instance, calls } = fixture({
    studio: {
      edit: async () => {
        throw Object.assign(new Error("offline"), { code: "STUDIO_UNAVAILABLE" });
      },
    },
  });
  const result = await instance.processWav(request);
  assert.deepEqual(calls, ["asr"]);
  assert.equal(result.text, result.rawText);
  assert.equal(result.cleanupStatus, "failed");
  assert.match(result.warning, /original transcript kept/);
  assert.equal(result.actualProfile, "studio");
});

test("cleanup off bypasses correction", async () => {
  const { instance, calls } = fixture();
  const result = await instance.processWav({ ...request, cleanup: false });
  assert.deepEqual(calls, ["asr"]);
  assert.equal(result.text, result.rawText);
  assert.equal(result.cleanupStatus, "off");
});

for (const stage of ["transcribe", "edit"]) {
  test(`late cancellation after ${stage} cannot return text or trigger fallback`, async () => {
    const controller = new AbortController();
    const { instance, calls } = fixture({
      studio: {
        [stage]: async () => {
          controller.abort();
          return "late result";
        },
      },
    });
    await assert.rejects(instance.processWav({ ...request, signal: controller.signal }), {
      name: "AbortError",
    });
    assert.ok(!calls.includes("air"));
  });
}

test("late Air response after cancellation is discarded", async () => {
  const controller = new AbortController();
  const { instance } = fixture({
    air: {
      process: async () => {
        controller.abort();
        return airResult;
      },
    },
  });
  await assert.rejects(
    instance.processWav({ ...request, profile: "air", signal: controller.signal }),
    { name: "AbortError" }
  );
});

test("explicit rewrite uses Studio and propagates failure", async () => {
  let received;
  const { instance } = fixture({
    studio: {
      edit: async (args) => {
        received = args;
        return "Edited";
      },
    },
  });
  assert.equal((await instance.rewrite({ text: "original" })).text, "Edited");
  assert.equal(received.rewrite, true);
  assert.equal(received.text, "original");
});

test("overlapping inference is rejected instead of concurrently loading models", async () => {
  let finish;
  const { instance } = fixture({
    studio: {
      transcribe: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const first = instance.processWav(request);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(instance.processWav(request), { code: "BUSY" });
  finish("raw");
  await first;
});
