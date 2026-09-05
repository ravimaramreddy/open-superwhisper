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
