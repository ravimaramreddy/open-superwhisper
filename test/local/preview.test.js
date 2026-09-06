const test = require("node:test");
const assert = require("node:assert/strict");
const { createPreviewAPI } = require("../../local-ui/preview.ts");

test("preview Gemini connection checks are explicit and local preparation stays available", async () => {
  for (const geminiStatus of ["ready", "offline", "unconfigured"]) {
    const api = createPreviewAPI({ geminiStatus });
    assert.equal((await api.getState()).settings.profile, "auto");
    assert.equal((await api.checkConnections()).gemini, "unknown");
    await api.updateSettings({ profile: "gemini" });
    assert.equal((await api.checkConnections()).gemini, geminiStatus);
    assert.equal((await api.prepareLocal()).localReady, true);
    assert.equal((await api.getState()).settings.profile, "gemini");
  }
});

test("preview Gemini transcript retries locally without replacing its origin or timing", async () => {
  const api = createPreviewAPI();
  const original = (await api.getState()).history.find((item) => item.id === "preview-gemini");
  assert.ok(original);
  await api.updateSettings({ profile: "gemini" });
  const retried = await api.rewriteTranscript(original.id);
  assert.equal(retried.actualProfile, "gemini");
  assert.equal(retried.edit.profile, "studio");
  assert.equal(retried.rawText, original.rawText);
  assert.deepEqual(retried.timings, original.timings);
  assert.equal(retried.delivery, original.delivery);
  assert.match(retried.text, /blue panel/);
  assert.match(retried.text, /not change the sidebar/);
});

test("processing details show combined Gemini time and separate fallback stages honestly", async () => {
  const { processingTimings } = require("../../local-ui/processing.ts");
  const api = createPreviewAPI();
  const item = (await api.getState()).history.find((row) => row.id === "preview-gemini");
  assert.deepEqual(processingTimings(item), [
    { label: "geminiTiming", ms: item.timings.geminiMs },
    { label: "totalTiming", ms: item.timings.totalMs },
  ]);
  assert.deepEqual(
    processingTimings({
      ...item,
      actualProfile: "air",
      timings: { geminiMs: 900, asrMs: 100, cleanupMs: 200, totalMs: 1200 },
    }),
    [
      { label: "geminiAttemptTiming", ms: 900 },
      { label: "speechTiming", ms: 100 },
      { label: "cleanupTiming", ms: 200 },
      { label: "totalTiming", ms: 1200 },
    ]
  );
});

test("preview review acceptance and one-level undo preserve original and delivery history", async () => {
  const api = createPreviewAPI();
  const original = (await api.getState()).history.find((item) => item.id === "preview-review");
  const accepted = await api.acceptSuggestion(original.id);
  assert.equal(accepted.text, original.candidateText);
  assert.equal(accepted.rawText, original.rawText);
  assert.equal(accepted.delivery, original.delivery);
  assert.equal(accepted.edit.source, "accepted");
  assert.equal(accepted.candidateText, undefined);
  assert.equal((await api.getState()).latest.text, accepted.text);
  const undone = await api.undoTranscript(original.id);
  assert.equal(undone.text, original.text);
  assert.equal(undone.candidateText, original.candidateText);
  assert.equal(undone.cleanupStatus, original.cleanupStatus);
  assert.equal(undone.previousVersion, undefined);
  await assert.rejects(api.undoTranscript(original.id), /No previous/);
});

test("preview retry starts from original and uses current rules while separating route metadata", async () => {
  const api = createPreviewAPI();
  const original = (await api.getState()).history.find((item) => item.id === "preview-sample");
  await api.updateSettings({ editingMode: "exact", profile: "air" });
  const exact = await api.rewriteTranscript(original.id);
  assert.equal(exact.text, original.rawText);
  assert.equal(exact.cleanupStatus, "off");
  assert.equal(exact.edit.elapsedMs, 0);
  assert.equal(exact.actualProfile, "studio");
  assert.equal(exact.edit.profile, "air");
  assert.deepEqual(exact.timings, original.timings);
  await api.updateSettings({
    appRules: [
      { ...original.targetApp, editingMode: "clean", style: "email", format: "paragraphs" },
    ],
  });
  const retried = await api.rewriteTranscript(original.id);
  assert.equal(retried.editingMode, "clean");
  assert.equal(retried.style, "email");
  assert.equal(retried.rawText, original.rawText);
  assert.notEqual(retried.text, original.rawText);
  assert.equal(retried.previousVersion.text, original.rawText);
  await api.undoTranscript(original.id);
  assert.equal(
    (await api.getState()).history.find((item) => item.id === original.id).text,
    original.rawText
  );
});

test("preview state emissions, app rule removal and initial undo are functional", async () => {
  const api = createPreviewAPI();
  let emissions = 0;
  const unsubscribe = api.onState(() => emissions++);
  const { history } = await api.getState();
  const sample = history.find((item) => item.id === "preview-sample");
  const undone = await api.undoTranscript(sample.id);
  assert.equal(undone.text, sample.rawText);
  assert.equal(undone.historyEdited, true);
  assert.equal(
    undone.edit,
    undefined,
    "undo must not invent an editor run to mark a History action"
  );
  await api.updateSettings({
    appRules: [{ ...sample.targetApp, editingMode: "exact", style: "neutral", format: "prose" }],
  });
  await api.updateSettings({ appRules: [] });
  assert.deepEqual((await api.getState()).settings.appRules, []);
  assert.equal(emissions, 3);
  unsubscribe();
});

test("preview audio saving needs history and switching off preserves existing clip markers", async () => {
  const api = createPreviewAPI();
  const original = await api.getState();
  assert.equal(original.settings.retainAudio, false);
  const clip = original.history.find((item) => item.audio);
  assert(clip);
  await api.updateSettings({ retainAudio: true });
  assert.equal((await api.getState()).settings.retainAudio, true);
  await api.updateSettings({ historyEnabled: false });
  assert.equal((await api.getState()).settings.retainAudio, false);
  await api.updateSettings({ retainAudio: true });
  const disabled = await api.getState();
  assert.equal(disabled.settings.retainAudio, false);
  assert.deepEqual(disabled.history.find((item) => item.id === clip.id).audio, clip.audio);
  await api.openAudioFolder();
  await api.showRecording(clip.id);
  await api.updateSettings({ historyEnabled: true });
  assert.equal((await api.getState()).settings.retainAudio, false);
});
