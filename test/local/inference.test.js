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

test("dictionary reaches ASR/editor and explicit spelling corrections retain raw ASR", async () => {
  const vocabulary = [{ word: "Quartz", aliases: ["quarts"] }];
  const { instance } = fixture({
    studio: {
      transcribe: async (args) => {
        assert.deepEqual(args.vocabulary, vocabulary);
        return "use quarts";
      },
      edit: async (args) => {
        assert.equal(args.text, "use Quartz");
        assert.equal(args.format, "list");
        return "Use Quartz.";
      },
    },
  });
  const result = await instance.processWav({ ...request, vocabulary, format: "list" });
  assert.equal(result.rawText, "use quarts");
  assert.equal(result.text, "Use Quartz.");
});

test("both profiles retain original and candidate when cleanup changes a protected number", async () => {
  for (const profile of ["studio", "air"]) {
    const { instance } = fixture({
      studio: { transcribe: async () => "send 15 copies", edit: async () => "Send 50 copies." },
      air: {
        process: async (args) => {
          assert.equal(args.format, "paragraphs");
          return { ...airResult, rawText: "send 15 copies", text: "Send 50 copies." };
        },
      },
    });
    const result = await instance.processWav({ ...request, profile, format: "paragraphs" });
    assert.equal(result.rawText, "send 15 copies");
    assert.equal(result.text, result.rawText);
    assert.equal(result.candidateText, "Send 50 copies.");
    assert.ok(result.reviewReasons.some((reason) => reason.includes("number")));
  }
});

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

test("setup cannot spawn after shutdown during initial readiness check", async () => {
  let ready;
  let spawned = false;
  const runtime = new Promise((resolve) => {
    ready = resolve;
  });
  const instance = createInference({
    userData: "/unused",
    config: {
      _deps: {
        air: { shutdown: async () => {} },
        studio: { shutdown: async () => {} },
        readRuntime: () => runtime,
        spawn: () => {
          spawned = true;
          throw new Error("unexpected spawn");
        },
      },
    },
  });
  const pending = instance.prepareLocal();
  await instance.shutdown();
  ready(null);
  await assert.rejects(pending, /closing/);
  assert.equal(spawned, false);
});

test("shutdown terminates setup and waits for the child close event", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-setup-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => {
    killed = true;
  };
  let started;
  const spawning = new Promise((resolve) => {
    started = resolve;
  });
  const instance = createInference({
    userData: directory,
    config: {
      uvPath: process.execPath,
      _deps: {
        air: { shutdown: async () => {} },
        studio: { shutdown: async () => {} },
        readRuntime: async () => null,
        spawn: () => {
          started();
          return child;
        },
      },
    },
  });
  const pending = instance.prepareLocal();
  const rejected = assert.rejects(pending, /failed|closing/);
  await spawning;
  let finished = false;
  const shutdown = instance.shutdown().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(killed, true);
  assert.equal(finished, false);
  child.emit("close", 1);
  await Promise.all([shutdown, rejected]);
  assert.equal(finished, true);
});

test(
  "setup shutdown kills an owned descendant that ignores TERM and holds stderr",
  { timeout: 6500, skip: process.platform === "win32" },
  async (t) => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { spawn } = require("node:child_process");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-setup-group-"));
    let child;
    t.after(() => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const descendant = path.join(directory, "descendant.cjs");
    fs.writeFileSync(
      descendant,
      'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000);'
    );
    const parent = path.join(directory, "parent.cjs");
    fs.writeFileSync(
      parent,
      'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,[process.argv[2]],{stdio:["ignore","pipe","inherit"]}); c.stdout.once("data",()=>console.log(JSON.stringify({event:"progress",message:"fixture ready"})));'
    );
    let ready;
    const waiting = new Promise((resolve) => {
      ready = resolve;
    });
    const instance = createInference({
      userData: directory,
      onProgress: (message) => {
        if (message === "fixture ready") ready();
      },
      config: {
        uvPath: process.execPath,
        _deps: {
          air: { shutdown: async () => {} },
          studio: { shutdown: async () => {} },
          readRuntime: async () => null,
          spawn: (_command, _args, options) => {
            assert.equal(options.detached, true);
            child = spawn(process.execPath, [parent, descendant], options);
            return child;
          },
        },
      },
    });
    const rejected = assert.rejects(instance.prepareLocal(), /failed|closing/);
    await waiting;
    const started = performance.now();
    await instance.shutdown();
    await rejected;
    assert.ok(
      performance.now() - started < 5000,
      "inherited stderr must close after group termination"
    );
  }
);
