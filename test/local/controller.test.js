const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Controller, validateWav } = require("../../desktop/controller");
const { History } = require("../../desktop/history");
const { DEFAULT_SETTINGS, normalizeSettings } = require("../../desktop/controller");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function wav({ silence = false } = {}) {
  const audio = Buffer.alloc(44 + 3200);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  if (!silence) audio.writeInt16LE(3000, 44);
  return audio;
}
const modelResult = () => ({
  rawText: "keep the original",
  text: "Keep the original.",
  actualProfile: "studio",
  cleanupStatus: "applied",
  timings: { asrMs: 100, cleanupMs: 50, totalMs: 150 },
});
function harness(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-controller-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const history = new History(path.join(directory, "history.json"));
  const calls = { inference: [], delivery: [], copy: [] };
  const inference = {
    isLocalReady: async () => true,
    checkStudio: async () => true,
    prepareLocal: async () => {},
    processWav: async (request) => {
      calls.inference.push(request);
      assert.ok(fs.existsSync(request.audioPath));
      return modelResult();
    },
    rewrite: async () => ({ text: "A rewritten sentence." }),
    ...overrides.inference,
  };
  const controller = new Controller({
    userData: directory,
    history,
    inference,
    native: {
      captureTarget: async () => ({ pid: 123, bundleId: "app.example" }),
      deliver: async (request) => {
        calls.delivery.push(request);
        assert.equal(history.list()[0].rawText, "keep the original");
        assert.equal(history.list()[0].delivery, "uncertain", "claim must precede side effect");
        return { delivery: "dispatched" };
      },
      ...overrides.native,
    },
    clipboard: { writeText: (text) => calls.copy.push(text) },
    permissions: {
      get: () => ({ microphone: "granted", accessibility: true }),
      request: async () => {},
    },
    ...overrides.controller,
  });
  return { controller, history, calls, directory };
}

test("old preferences gain dictionary/format defaults and save custom vocabulary across restart", async (t) => {
  const { controller, directory } = harness(t);
  const words = [{ word: "Quartz", aliases: ["quarts"] }];
  await controller.updateSettings({ vocabulary: words, format: "list", launchAtLogin: true });
  words[0].aliases.push("mutated");
  assert.deepEqual(controller.getState().settings.vocabulary[0].aliases, ["quarts"]);
  const stored = JSON.parse(fs.readFileSync(path.join(directory, "settings.json")));
  assert.equal(stored.launchAtLogin, true);
  assert.equal(stored.format, "list");
  assert.deepEqual(stored.vocabulary, [{ word: "Quartz", aliases: ["quarts"] }]);
  const old = normalizeSettings({ profile: "air", cleanup: false, launchAtLogin: true });
  assert.equal(old.format, "prose");
  assert.deepEqual(old.vocabulary, DEFAULT_SETTINGS.vocabulary);
  assert.equal(old.profile, "air");
  assert.equal(old.cleanup, false);
  await assert.rejects(controller.updateSettings({ vocabulary: [{ word: "a", aliases: ["a"] }] }));
  assert.deepEqual(controller.getState().settings.vocabulary, stored.vocabulary);
});

test("recording snapshots dictionary and format; later settings only affect future recordings", async (t) => {
  const { controller, calls } = harness(t);
  await controller.updateSettings({
    vocabulary: [{ word: "Quartz", aliases: [] }],
    format: "list",
  });
  const session = await controller.beginRecording();
  session.settings.vocabulary[0].word = "Mutated";
  await controller.updateSettings({ vocabulary: [], format: "prose" });
  await controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 });
  assert.equal(calls.inference[0].vocabulary[0].word, "Quartz");
  assert.equal(calls.inference[0].format, "list");
});

test("guarded correction pastes kept text once, persists candidate and copies only on request", async (t) => {
  const { controller, calls, history, directory } = harness(t, {
    inference: {
      processWav: async () => ({
        ...modelResult(),
        text: "keep the original",
        candidateText: "Different suggestion.",
        reviewReasons: ["A saved name changed."],
        warning: "Original kept.",
      }),
    },
  });
  const session = await controller.beginRecording();
  const row = await controller.transcribe({
    requestId: session.requestId,
    audio: wav(),
    durationMs: 100,
  });
  assert.equal(calls.delivery[0].text, "keep the original");
  assert.equal(calls.delivery.length, 1);
  const reloaded = new History(path.join(directory, "history.json")).get(row.id);
  assert.equal(reloaded.candidateText, "Different suggestion.");
  assert.deepEqual(reloaded.reviewReasons, ["A saved name changed."]);
  assert.equal(calls.copy.length, 0);
  await controller.copyTranscript(row.id, "suggestion");
  assert.deepEqual(calls.copy, ["Different suggestion."]);
  await controller.rewriteTranscript(row.id);
  assert.equal(history.get(row.id).candidateText, undefined);
  assert.equal(history.get(row.id).rawText, "keep the original");
  assert.equal(calls.delivery.length, 1);
});

test("duplicate submissions share one inference, history row and delivery", async (t) => {
  const { controller, history, calls } = harness(t);
  const session = await controller.beginRecording();
  const request = { requestId: session.requestId, audio: wav(), durationMs: 100 };
  const one = controller.transcribe(request);
  const two = controller.transcribe(request);
  assert.equal(one, two);
  const record = await one;
  assert.equal(record.delivery, "dispatched");
  assert.equal(calls.inference.length, 1);
  assert.equal(calls.delivery.length, 1);
  assert.equal(history.list().length, 1);
  assert.equal(controller.getState().phase, "idle");
  assert.equal(fs.existsSync(calls.inference[0].audioPath), false);
  await controller.transcribe(request);
  assert.equal(calls.delivery.length, 1);
});

test("cancelled inference cannot save or paste a late result; busy ends only when it settles", async (t) => {
  const model = deferred();
  const { controller, calls, history } = harness(t, {
    inference: { processWav: () => model.promise },
  });
  const session = await controller.beginRecording();
  const pending = controller.transcribe({
    requestId: session.requestId,
    audio: wav(),
    durationMs: 100,
  });
  await controller.cancel(session.requestId);
  assert.equal(controller.getState().phase, "processing");
  await assert.rejects(controller.beginRecording(), /Finish or cancel/);
  model.resolve(modelResult());
  assert.equal(await pending, null);
  assert.equal(calls.delivery.length, 0);
  assert.equal(history.list().length, 0);
  assert.equal(controller.getState().phase, "idle");
});

test("cancelled target capture cannot clear a newer recording", async (t) => {
  const target = deferred();
  let attempt = 0;
  const { controller } = harness(t, {
    native: { captureTarget: () => (++attempt === 1 ? target.promise : Promise.resolve(null)) },
  });
  const first = controller.beginRecording();
  await controller.cancel();
  const second = await controller.beginRecording();
  target.resolve(null);
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(controller.active.id, second.requestId);
  assert.equal(controller.getState().phase, "recording");
});

test("capture settings are immutable through a request", async (t) => {
  const { controller, calls } = harness(t);
  await controller.updateSettings({ profile: "air", cleanup: false });
  const session = await controller.beginRecording();
  await controller.updateSettings({ profile: "studio", cleanup: true });
  const result = await controller.transcribe({
    requestId: session.requestId,
    audio: wav(),
    durationMs: 100,
  });
  assert.equal(calls.inference[0].profile, "air");
  assert.equal(calls.inference[0].cleanup, false);
  assert.equal(result.text, result.rawText);
  assert.equal(result.cleanupStatus, "off");
});

test("history failure prevents paste and leaves original copyable", async (t) => {
  const { controller, history, calls } = harness(t);
  history.save = () => {
    throw new Error("Disk full");
  };
  const session = await controller.beginRecording();
  await assert.rejects(
    controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 }),
    /Disk full/
  );
  assert.equal(calls.delivery.length, 0);
  await controller.copyTranscript(session.requestId, "original");
  assert.deepEqual(calls.copy, ["keep the original"]);
});

test("a delivery timeout stays uncertain and is not retried", async (t) => {
  let count = 0;
  const { controller } = harness(t, {
    native: {
      deliver: async () => {
        count++;
        return { delivery: "uncertain" };
      },
    },
  });
  const session = await controller.beginRecording();
  const input = { requestId: session.requestId, audio: wav(), durationMs: 100 };
  assert.equal((await controller.transcribe(input)).delivery, "uncertain");
  await controller.transcribe(input);
  assert.equal(count, 1);
});

test("the controller remains busy through delivery bookkeeping", async (t) => {
  const delivery = deferred();
  const { controller } = harness(t, { native: { deliver: () => delivery.promise } });
  const session = await controller.beginRecording();
  const pending = controller.transcribe({
    requestId: session.requestId,
    audio: wav(),
    durationMs: 100,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().phase, "delivering");
  await assert.rejects(controller.beginRecording(), /Finish or cancel/);
  delivery.resolve({ delivery: "dispatched" });
  await pending;
  assert.equal(controller.getState().phase, "idle");
});

test("legacy cleanup migration preserves independent preferences and validates app rules", async (t) => {
  const { controller } = harness(t);
  const old = normalizeSettings({
    cleanup: false,
    historyEnabled: false,
    launchAtLogin: true,
    hotkey: "Alt+F3",
    vocabulary: [],
  });
  assert.equal(old.editingMode, "exact");
  assert.equal(old.historyEnabled, false);
  assert.equal(old.launchAtLogin, true);
  assert.equal(old.hotkey, "Alt+F3");
  assert.deepEqual(old.vocabulary, []);
  const enabled = normalizeSettings({ cleanup: true });
  assert.equal(enabled.editingMode, "polished");
  const explicit = normalizeSettings({ cleanup: false, editingMode: "clean" });
  assert.equal(explicit.cleanup, true);
  const rule = {
    bundleId: "app.example",
    name: "Example",
    editingMode: "clean",
    style: "email",
    format: "paragraphs",
  };
  await controller.updateSettings({ appRules: [rule] });
  rule.name = "Mutated";
  assert.equal(controller.getState().settings.appRules[0].name, "Example");
  await assert.rejects(controller.updateSettings({ appRules: [rule, rule] }), /one style/);
  await assert.rejects(
    controller.updateSettings({ appRules: [{ ...rule, style: "custom" }] }),
    /Invalid app/
  );
  await assert.rejects(controller.updateSettings({ editingMode: "unknown" }), /Invalid editing/);
});

test("app rule is resolved from the recording target and frozen until completion", async (t) => {
  const { controller, calls } = harness(t);
  await controller.updateSettings({
    appRules: [
      {
        bundleId: "app.example",
        name: "Example",
        editingMode: "clean",
        style: "email",
        format: "paragraphs",
      },
    ],
  });
  const session = await controller.beginRecording();
  await controller.updateSettings({ editingMode: "exact", appRules: [] });
  const record = await controller.transcribe({
    requestId: session.requestId,
    audio: wav(),
    durationMs: 100,
  });
  assert.equal(session.settings.editingMode, "clean");
  assert.equal(calls.inference[0].editingMode, "clean");
  assert.equal(calls.inference[0].style, "email");
  assert.equal(calls.inference[0].format, "paragraphs");
  assert.equal(record.targetApp.bundleId, "app.example");
  assert.equal(record.editingMode, "clean");
});

test("retry always starts from original, fixes old off/failed labels, and undo survives restart", async (t) => {
  let input;
  const { controller, history, directory, calls } = harness(t, {
    inference: {
      rewrite: async (args) => {
        input = args;
        return {
          text: "Keep the original, please.",
          actualProfile: "air",
          timings: { cleanupMs: 25 },
        };
      },
    },
  });
  const session = await controller.beginRecording();
  await controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 });
  for (const status of ["off", "failed"]) {
    history.update(session.requestId, {
      text: "Previous edit.",
      cleanupStatus: status,
      warning: "Old warning",
    });
    await controller.updateSettings({ editingMode: "clean", profile: "air", style: "chat" });
    const retried = await controller.rewriteTranscript(session.requestId);
    assert.equal(input.text, "keep the original");
    assert.equal(input.profile, "air");
    assert.equal(retried.cleanupStatus, "applied");
    assert.equal(retried.edit.profile, "air");
    assert.equal(retried.actualProfile, "studio", "ASR provenance remains original");
    assert.equal(retried.warning, undefined);
    const reloaded = new History(path.join(directory, "history.json"));
    assert.equal(reloaded.get(session.requestId).previousVersion.cleanupStatus, status);
    controller.history = reloaded;
    const restored = await controller.undoTranscript(session.requestId);
    assert.equal(restored.text, "Previous edit.");
    assert.equal(restored.cleanupStatus, status);
    assert.equal(restored.warning, "Old warning");
    assert.equal(restored.previousVersion, undefined);
    await assert.rejects(controller.undoTranscript(session.requestId), /No previous/);
    controller.history = history;
  }
  assert.equal(calls.delivery.length, 1);
});

test("guarded retries keep current text; explicit acceptance and undo do not paste", async (t) => {
  const { controller, calls } = harness(t, {
    inference: {
      rewrite: async () => ({
        text: "keep the original",
        candidateText: "Send fifty copies.",
        reviewReasons: ["A number changed."],
        warning: "Review this edit.",
        actualProfile: "air",
        timings: { cleanupMs: 40 },
      }),
    },
  });
  const session = await controller.beginRecording();
  await controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 });
  const candidate = await controller.rewriteTranscript(session.requestId);
  assert.equal(candidate.text, "Keep the original.");
  assert.equal(candidate.rawText, "keep the original");
  const accepted = await controller.acceptSuggestion(session.requestId);
  assert.equal(accepted.text, "Send fifty copies.");
  assert.equal(accepted.cleanupStatus, "applied");
  assert.equal(accepted.edit.source, "accepted");
  assert.equal(accepted.candidateText, undefined);
  const undone = await controller.undoTranscript(session.requestId);
  assert.equal(undone.text, "Keep the original.");
  assert.equal(undone.candidateText, "Send fifty copies.");
  assert.equal(calls.delivery.length, 1);
  assert.equal(calls.copy.length, 0);
});

test("Exact retry restores raw without models and unsaved history stays private", async (t) => {
  let deliveries = 0;
  const { controller, directory } = harness(t, {
    inference: { rewrite: async () => assert.fail("Exact cannot run the editor") },
    native: {
      deliver: async () => {
        deliveries++;
        return { delivery: "dispatched" };
      },
    },
  });
  await controller.updateSettings({ historyEnabled: false });
  const session = await controller.beginRecording();
  await controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 });
  await controller.updateSettings({ editingMode: "exact" });
  const exact = await controller.rewriteTranscript(session.requestId);
  assert.equal(exact.text, "keep the original");
  assert.equal(exact.cleanupStatus, "off");
  assert.equal(exact.edit.elapsedMs, 0);
  await controller.undoTranscript(session.requestId);
  assert.equal(new History(path.join(directory, "history.json")).list().length, 0);
  assert.equal(deliveries, 1);
});

test("failed retry save preserves the last version and cancellation discards late results", async (t) => {
  const pending = deferred();
  const { controller, history } = harness(t, { inference: { rewrite: () => pending.promise } });
  const session = await controller.beginRecording();
  await controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 });
  const original = history.get(session.requestId);
  const run = controller.rewriteTranscript(session.requestId);
  await controller.cancel();
  pending.resolve({ text: "Late change." });
  await assert.rejects(run, { name: "AbortError" });
  assert.deepEqual(history.get(session.requestId), original);
  controller.inference.rewrite = async () => ({ text: "New version." });
  history.commit = () => {
    throw new Error("Disk full");
  };
  await assert.rejects(controller.rewriteTranscript(session.requestId), /Disk full/);
  assert.deepEqual(history.get(session.requestId), original);
  assert.equal(controller.getState().phase, "idle");
});

test("initial cleanup can be undone without altering the delivered text or original", async (t) => {
  const { controller, calls } = harness(t);
  const session = await controller.beginRecording();
  await controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 });
  const undone = await controller.undoTranscript(session.requestId);
  assert.equal(undone.text, "keep the original");
  assert.equal(undone.rawText, "keep the original");
  assert.equal(undone.cleanupStatus, "off");
  assert.equal(undone.editingMode, "exact");
  assert.equal(undone.previousVersion, undefined);
  assert.equal(calls.delivery.length, 1);
  assert.equal(calls.delivery[0].text, "Keep the original.");
});

test("rewrite changes edited text only and never pastes again", async (t) => {
  const { controller, history, calls } = harness(t);
  const session = await controller.beginRecording();
  await controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 });
  const rewritten = await controller.rewriteTranscript(session.requestId);
  assert.equal(rewritten.rawText, "keep the original");
  assert.equal(rewritten.text, "A rewritten sentence.");
  assert.equal(history.get(session.requestId).rawText, "keep the original");
  assert.equal(calls.delivery.length, 1);
});

test("flat silence bypasses all inference and delivery", async (t) => {
  const { controller, calls, history } = harness(t);
  const session = await controller.beginRecording();
  assert.equal(
    await controller.transcribe({
      requestId: session.requestId,
      audio: wav({ silence: true }),
      durationMs: 100,
    }),
    null
  );
  assert.equal(calls.inference.length, 0);
  assert.equal(calls.delivery.length, 0);
  assert.equal(history.list().length, 0);
});

test("WAV boundary rejects truncation, unsupported sample rate and injected chunk sizes", () => {
  assert.equal(validateWav(wav()).durationMs, 100);
  assert.throws(() => validateWav(wav().subarray(0, 100)), /Incomplete/);
  const wrongRate = wav();
  wrongRate.writeUInt32LE(48000, 24);
  assert.throws(() => validateWav(wrongRate), /16 kHz/);
  const wrongChunk = wav();
  wrongChunk.writeUInt32LE(0xffffffff, 40);
  assert.throws(() => validateWav(wrongChunk), /Incomplete/);
});

test("connection state follows actual Studio and fallback outcomes", async (t) => {
  for (const fallback of [false, true]) {
    const { controller } = harness(t, {
      inference: {
        processWav: async () => ({
          ...modelResult(),
          actualProfile: fallback ? "air" : "studio",
          ...(fallback ? { fallbackReason: "Studio unavailable" } : {}),
        }),
      },
    });
    assert.equal(controller.getState().studio, "unknown");
    const session = await controller.beginRecording();
    await controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 });
    assert.equal(controller.getState().studio, fallback ? "offline" : "ready");
  }
});

test("deleted transcripts cannot be recovered from duplicate request cache", async (t) => {
  const { controller, history, calls } = harness(t);
  const session = await controller.beginRecording();
  const request = { requestId: session.requestId, audio: wav(), durationMs: 100 };
  await controller.transcribe(request);
  await controller.deleteTranscript(session.requestId);
  assert.equal(history.get(session.requestId), null);
  assert.equal(controller.getState().latest, null);
  await assert.rejects(controller.transcribe(request), /session expired/);
  await assert.rejects(controller.copyTranscript(session.requestId, "original"), /not found/);
  assert.equal(calls.inference.length, 1);
  assert.equal(calls.delivery.length, 1);
});

test("history off retains only the latest transcript and no settled promise cache", async (t) => {
  const { controller, history } = harness(t, {
    native: { deliver: async () => ({ delivery: "clipboard-only" }) },
  });
  await controller.updateSettings({ historyEnabled: false });
  const ids = [];
  for (let index = 0; index < 3; index++) {
    const session = await controller.beginRecording();
    ids.push(session.requestId);
    await controller.transcribe({ requestId: session.requestId, audio: wav(), durationMs: 100 });
  }
  assert.equal(controller.completed.size, 0);
  assert.equal(controller.state.history, undefined);
  assert.deepEqual(history.list(), []);
  assert.equal(history.get(ids[0]), null);
  assert.equal(history.get(ids[1]), null);
  assert.equal(history.get(ids[2]).id, ids[2]);
});

test("startup removes only owned abandoned recording folders and never follows symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-orphans-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recordings = path.join(root, "recordings");
  fs.mkdirSync(recordings);
  const orphan = fs.mkdtempSync(path.join(recordings, "open-superwhisper-"));
  fs.writeFileSync(path.join(orphan, "recording.wav"), wav());
  const unrelated = path.join(recordings, "keep-me");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, "keep.txt"), "keep");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  fs.symlinkSync(outside, path.join(recordings, "open-superwhisper-ABC123"));
  harness(t, { controller: { temporaryRoot: recordings } });
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(path.join(unrelated, "keep.txt")), true);
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true);
});

test("shutdown drain waits for delivery bookkeeping and temporary audio removal", async (t) => {
  const delivery = deferred();
  const { controller, directory } = harness(t, { native: { deliver: () => delivery.promise } });
  const session = await controller.beginRecording();
  const pending = controller.transcribe({
    requestId: session.requestId,
    audio: wav(),
    durationMs: 100,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await controller.cancel();
  let drained = false;
  const drain = controller.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  delivery.resolve({ delivery: "uncertain" });
  await Promise.all([pending, drain]);
  assert.equal(controller.getState().phase, "idle");
  assert.deepEqual(fs.readdirSync(path.join(directory, "recordings")), []);
});
