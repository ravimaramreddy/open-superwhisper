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

test("editing modes preserve exact ASR and pass fixed editing choices to both editors", async () => {
  for (const profile of ["studio", "air"]) {
    for (const editingMode of ["exact", "clean", "polished"]) {
      const rawText = "use quarts i cant find it";
      const edited = "Use Quartz. I cannot find it.";
      let editedOnStudio = false;
      const { instance } = fixture({
        studio: {
          transcribe: async () => rawText,
          edit: async (args) => {
            editedOnStudio = true;
            assert.equal(args.editingMode, editingMode);
            assert.equal(args.style, "email");
            return edited;
          },
        },
        air: {
          process: async (args) => {
            assert.equal(args.editingMode, editingMode);
            assert.equal(args.cleanup, editingMode !== "exact");
            assert.equal(args.style, "email");
            return {
              ...airResult,
              rawText,
              text: editingMode === "exact" ? rawText : edited,
              cleanupStatus: editingMode === "exact" ? "off" : "applied",
            };
          },
        },
      });
      const result = await instance.processWav({
        ...request,
        profile,
        editingMode,
        style: "email",
        vocabulary: [{ word: "Quartz", aliases: ["quarts"] }],
      });
      assert.equal(result.rawText, rawText);
      if (editingMode === "exact") {
        assert.equal(result.text, rawText);
        assert.equal(result.cleanupStatus, "off");
        assert.equal(editedOnStudio, false);
      }
    }
  }
});

test("resolved name search passes through both production cleanup paths; factual uncertainty stays guarded", async () => {
  for (const profile of ["studio", "air"]) {
    for (const [rawText, text, guarded] of [
      [
        "I don't recall the name of the app what's it called oh right Quartz is it working",
        "Is Quartz working?",
        false,
      ],
      [
        "I don't remember whether Quartz worked last time I think it might have failed",
        "Quartz worked last time.",
        true,
      ],
      [
        "I don't recall the name of the app what's it called oh right Quartz do not deploy it",
        "Deploy Quartz.",
        true,
      ],
    ]) {
      const { instance } = fixture({
        studio: { transcribe: async () => rawText, edit: async () => text },
        air: { process: async () => ({ ...airResult, rawText, text }) },
      });
      const result = await instance.processWav({ ...request, profile });
      assert.equal(result.text, guarded ? rawText : text);
      assert.equal(Boolean(result.candidateText), guarded);
    }
  }
});

test("text-only retries obey the chosen profile and retain review protection", async () => {
  for (const profile of ["studio", "air"]) {
    const { instance, calls } = fixture({
      studio: {
        edit: async (args) => {
          assert.equal(args.text, "send 15 copies");
          assert.equal(args.editingMode, "clean");
          assert.equal(args.style, "chat");
          return "Send 50 copies.";
        },
      },
      air: {
        rewrite: async (args) => {
          assert.equal(args.text, "send 15 copies");
          assert.equal(args.editingMode, "clean");
          assert.equal(args.style, "chat");
          return { text: "Send 50 copies." };
        },
      },
    });
    const result = await instance.rewrite({
      text: "send 15 copies",
      profile,
      editingMode: "clean",
      style: "chat",
    });
    assert.equal(result.text, "send 15 copies");
    assert.equal(result.candidateText, "Send 50 copies.");
    assert.equal(result.actualProfile, profile);
    assert.equal(result.cleanupStatus, "applied");
    assert.equal(result.timings.asrMs, 0);
    assert.deepEqual(calls, []);
  }
});

test("Auto text retry falls back only when Studio is unavailable", async () => {
  for (const [code, fallsBack] of [
    ["STUDIO_UNAVAILABLE", true],
    ["INVALID_MODEL_OUTPUT", false],
  ]) {
    let localCalls = 0;
    const { instance } = fixture({
      studio: {
        edit: async () => {
          throw Object.assign(new Error("failed"), { code });
        },
      },
      air: {
        rewrite: async () => {
          localCalls++;
          return { text: "Edited." };
        },
      },
    });
    const retry = instance.rewrite({ text: "edited", profile: "auto" });
    if (fallsBack) {
      const result = await retry;
      assert.equal(result.actualProfile, "air");
      assert.match(result.fallbackReason, /unavailable/);
    } else await assert.rejects(retry, { code });
    assert.equal(localCalls, fallsBack ? 1 : 0);
  }
});

test("exact text retry uses neither model nor vocabulary replacements", async () => {
  const { instance, calls } = fixture();
  const result = await instance.rewrite({
    text: "use quarts",
    editingMode: "exact",
    vocabulary: [{ word: "Quartz", aliases: ["quarts"] }],
  });
  assert.equal(result.text, "use quarts");
  assert.equal(result.cleanupStatus, "off");
  assert.equal(result.actualProfile, undefined);
  assert.deepEqual(calls, []);
});

test("invalid editing controls fail before any model request", async () => {
  const { instance, calls } = fixture();
  for (const options of [{ editingMode: "instructions" }, { style: "instructions" }]) {
    await assert.rejects(instance.processWav({ ...request, ...options }), /Invalid/);
    await assert.rejects(instance.rewrite({ text: "raw", ...options }), /Invalid/);
  }
  assert.deepEqual(calls, []);
});
