const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { History } = require("../../desktop/history");

function fixture(t, limit) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-history-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "history.json");
  return { file, directory, history: new History(file, { limit }) };
}
const row = (id = "first") => ({
  id,
  createdAt: new Date().toISOString(),
  rawText: "literal original",
  text: "Literal original.",
  actualProfile: "air",
  cleanupStatus: "applied",
  durationMs: 100,
  timings: { asrMs: 2, cleanupMs: 3, totalMs: 5 },
  delivery: "pending",
});

test("Gemini origin and combined timing survive local edits and restart", (t) => {
  const { history, file } = fixture(t);
  const gemini = {
    ...row("gemini-sample"),
    actualProfile: "gemini",
    timings: { asrMs: 0, cleanupMs: 0, geminiMs: 1450, totalMs: 1450 },
    edit: { source: "dictation", profile: "gemini", elapsedMs: 0 },
  };
  history.save(gemini);
  history.update(gemini.id, {
    text: "A local revision.",
    edit: { source: "retry", profile: "studio", elapsedMs: 230 },
    previousVersion: { text: gemini.text, cleanupStatus: "applied", edit: gemini.edit },
  });
  const saved = new History(file).get(gemini.id);
  assert.equal(saved.actualProfile, "gemini");
  assert.equal(saved.rawText, gemini.rawText);
  assert.deepEqual(saved.timings, gemini.timings);
  assert.equal(saved.edit.profile, "studio");
  assert.equal(saved.previousVersion.edit.profile, "gemini");
});

test("optional Gemini attempt timing accepts local fallback and rejects invalid durations", (t) => {
  const { history, file } = fixture(t);
  history.save(row("legacy"));
  const fallback = {
    ...row("fallback"),
    timings: { ...row().timings, geminiMs: 920, totalMs: 925 },
  };
  history.save(fallback);
  assert.deepEqual(new History(file).get("fallback").timings, fallback.timings);
  assert.equal(new History(file).get("legacy").timings.geminiMs, undefined);
  for (const invalid of [-1, Infinity, NaN, "10", null])
    assert.throws(
      () => history.save({ ...row("invalid"), timings: { ...row().timings, geminiMs: invalid } }),
      /Invalid transcript/
    );
});

test("original and identity are immutable across updates; duplicate saves return first record", (t) => {
  const { history } = fixture(t);
  history.save(row());
  history.update("first", { text: "Edited", rawText: "replaced", id: "changed" });
  assert.equal(history.get("first").rawText, "literal original");
  assert.equal(history.get("first").text, "Edited");
  history.save({ ...row(), rawText: "duplicate input" });
  assert.equal(history.list().length, 1);
  assert.equal(history.get("first").rawText, "literal original");
});

test("delivery is claimed durably once and never replayed after restart", (t) => {
  const { history, file } = fixture(t);
  history.save(row());
  assert.equal(history.claimDelivery("first"), true);
  assert.equal(history.claimDelivery("first"), false);
  const restarted = new History(file);
  assert.equal(restarted.get("first").delivery, "uncertain");
  assert.equal(restarted.claimDelivery("first"), false);
});

test("unclaimed pending record after restart is uncertain, not automatically deliverable", (t) => {
  const { history, file } = fixture(t);
  history.save(row());
  const restarted = new History(file);
  assert.equal(restarted.get("first").delivery, "uncertain");
  assert.equal(restarted.claimDelivery("first"), false);
});

test("history is bounded and private; disabled retention stays in memory", (t) => {
  const { history, file } = fixture(t, 2);
  history.save(row("one"));
  history.save(row("two"));
  history.save(row("three"));
  assert.deepEqual(
    history.list().map((item) => item.id),
    ["three", "two"]
  );
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  history.save(row("ephemeral"), { persist: false });
  history.claimDelivery("ephemeral");
  assert.equal(history.get("ephemeral").rawText, "literal original");
  assert.deepEqual(
    history.list().map((item) => item.id),
    ["three", "two"]
  );
  assert.equal(new History(file).get("ephemeral"), null);
});

test("invalid history is preserved separately and does not poison later saves", (t) => {
  const { file, directory } = fixture(t);
  fs.writeFileSync(file, "{broken");
  const history = new History(file);
  assert.match(history.warning, /preserved/);
  const backup = fs.readdirSync(directory).find((name) => name.includes(".invalid-"));
  assert.equal(fs.readFileSync(path.join(directory, backup), "utf8"), "{broken");
  history.save(row());
  assert.equal(new History(file).list().length, 1);
});

test("caller mutations cannot corrupt history", (t) => {
  const { history } = fixture(t);
  const value = row();
  history.save(value);
  value.rawText = "changed";
  const read = history.get("first");
  read.rawText = "changed again";
  assert.equal(history.get("first").rawText, "literal original");
});

test("version snapshots are bounded, validated and detached from caller objects", (t) => {
  const { history, file } = fixture(t);
  history.save(row());
  const previousVersion = {
    text: "Before.",
    cleanupStatus: "off",
    edit: { source: "retry", profile: "air", elapsedMs: 1 },
  };
  history.update("first", { text: "After.", cleanupStatus: "applied", previousVersion });
  previousVersion.text = "Mutated";
  previousVersion.edit.profile = "studio";
  assert.equal(history.get("first").previousVersion.text, "Before.");
  assert.equal(new History(file).get("first").previousVersion.edit.profile, "air");
  assert.throws(
    () => history.update("first", { previousVersion: { ...previousVersion, previousVersion } }),
    /Invalid transcript/
  );
  assert.throws(
    () => history.update("first", { edit: { source: "retry", profile: "cloud", elapsedMs: 1 } }),
    /Invalid transcript/
  );
  assert.throws(
    () =>
      history.update("first", {
        previousVersion: { ...previousVersion, candidateText: "No reason" },
      }),
    /Invalid transcript/
  );
  assert.equal(history.get("first").text, "After.");
});
