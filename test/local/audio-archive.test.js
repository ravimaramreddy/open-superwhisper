const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const {
  AudioArchive,
  LIMIT_BYTES,
  LIMIT_CLIPS,
  MAX_METADATA_BYTES,
} = require("../../desktop/audio-archive");

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "audio-archive-test-"));
  const userData = path.join(parent, "app");
  fs.mkdirSync(userData, { mode: 0o700 });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const archive = new AudioArchive(userData);
  return { archive, userData, parent, root: path.join(userData, "retained-audio") };
}

function wav() {
  const buffer = Buffer.alloc(364);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(320, 40);
  return buffer;
}

function metadata(extra = {}) {
  return { createdAt: "2026-01-01T12:00:00.000Z", status: "processing", durationMs: 10, ...extra };
}

test("retained synthetic WAV and matching details are private, durable and counted together", (t) => {
  const { archive, root, userData } = fixture(t);
  const id = randomUUID(),
    audio = wav();
  assert.deepEqual(archive.save(id, audio, metadata()), {
    fileName: `${id}.wav`,
    bytes: audio.length,
  });
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  for (const extension of ["wav", "json"])
    assert.equal(fs.statSync(path.join(root, `${id}.${extension}`)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(archive.file(id)), audio);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, `${id}.json`))), {
    ...metadata(),
    version: 1,
    id,
  });
  const usage = new AudioArchive(userData).stats();
  assert.equal(usage.count, 1);
  assert.equal(usage.bytes, audio.length + fs.statSync(path.join(root, `${id}.json`)).size);
  assert.equal(usage.limitBytes, LIMIT_BYTES);
});

test("annotations preserve initial metadata and support bounded non-ASCII transcript pairs", (t) => {
  const { archive, root } = fixture(t);
  const id = randomUUID();
  archive.save(id, wav(), metadata());
  const rawText = "語".repeat(100000),
    text = "文".repeat(100000);
  archive.annotate(id, { status: "completed", rawText, text, optional: undefined });
  const saved = JSON.parse(fs.readFileSync(path.join(root, `${id}.json`)));
  assert.equal(saved.id, id);
  assert.equal(saved.version, 1);
  assert.equal(saved.createdAt, metadata().createdAt);
  assert.equal(saved.rawText, rawText);
  assert.equal(saved.text, text);
  assert.ok(fs.statSync(path.join(root, `${id}.json`)).size < MAX_METADATA_BYTES);
  for (const invalid of [
    { id: randomUUID() },
    { version: 2 },
    { audio: wav() },
    { text: "x".repeat(MAX_METADATA_BYTES + 1) },
  ])
    assert.throws(() => archive.annotate(id, invalid));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, `${id}.json`))), saved);
});

test("invalid IDs and audio are rejected without creating archive entries", (t) => {
  const { archive, root } = fixture(t);
  for (const id of [
    "../escape",
    "not-a-uuid",
    `${randomUUID()}.wav`,
    "00000000-0000-0000-0000-000000000000",
  ])
    for (const action of [
      () => archive.save(id, wav(), metadata()),
      () => archive.file(id),
      () => archive.remove(id),
    ])
      assert.throws(action, /identifier/);
  const wrongRate = wav();
  wrongRate.writeUInt32LE(44100, 24);
  for (const data of [Buffer.from("not audio"), wav().subarray(0, 45), wrongRate])
    assert.throws(() => archive.save(randomUUID(), data, metadata()));
  assert.deepEqual(fs.readdirSync(root), []);
});

test("duplicate saves and publication collisions cannot replace or remove preexisting files", (t) => {
  const { archive, root } = fixture(t);
  const id = randomUUID();
  archive.save(id, wav(), metadata());
  const before = fs.readFileSync(path.join(root, `${id}.json`));
  assert.throws(() => archive.save(id, wav(), metadata({ status: "failed" })), /already retained/);
  assert.deepEqual(fs.readFileSync(path.join(root, `${id}.json`)), before);
  const collision = randomUUID(),
    link = fs.linkSync;
  t.mock.method(fs, "linkSync", (source, destination) => {
    if (destination === path.join(root, `${collision}.json`))
      fs.writeFileSync(destination, "existing details", { mode: 0o600 });
    return link(source, destination);
  });
  assert.throws(() => archive.save(collision, wav(), metadata()), { code: "EEXIST" });
  assert.equal(fs.readFileSync(path.join(root, `${collision}.json`), "utf8"), "existing details");
  assert.equal(fs.existsSync(path.join(root, `${collision}.wav`)), false);
  assert.equal(
    fs.readdirSync(root).some((entry) => entry.endsWith(".tmp")),
    false
  );
});

test("failed pair writes clean only their own files and annotation failure retains old details", (t) => {
  const { archive, root } = fixture(t);
  const write = fs.writeFileSync;
  let writes = 0;
  const failingWrite = t.mock.method(fs, "writeFileSync", (...args) => {
    if (++writes === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return write(...args);
  });
  assert.throws(() => archive.save(randomUUID(), wav(), metadata()), /disk full/);
  assert.deepEqual(fs.readdirSync(root), []);
  failingWrite.mock.restore();
  const id = randomUUID();
  archive.save(id, wav(), metadata());
  const before = fs.readFileSync(path.join(root, `${id}.json`));
  t.mock.method(fs, "renameSync", () => {
    throw new Error("rename failed");
  });
  assert.throws(() => archive.annotate(id, { status: "failed" }), /rename failed/);
  assert.deepEqual(fs.readFileSync(path.join(root, `${id}.json`)), before);
  assert.equal(
    fs.readdirSync(root).some((entry) => entry.endsWith(".tmp")),
    false
  );
});

test("capacity includes partial and unknown files and never evicts retained audio", (t) => {
  const { archive, root } = fixture(t);
  archive.directory();
  const partialId = randomUUID(),
    partial = path.join(root, `${partialId}.wav`);
  const descriptor = fs.openSync(partial, "wx", 0o600);
  fs.ftruncateSync(descriptor, LIMIT_BYTES);
  fs.closeSync(descriptor);
  assert.deepEqual(archive.stats(), { count: 1, bytes: LIMIT_BYTES, limitBytes: LIMIT_BYTES });
  assert.throws(() => archive.save(randomUUID(), wav(), metadata()), /Retained audio is full/);
  assert.equal(fs.statSync(partial).size, LIMIT_BYTES);
  archive.remove(partialId);
  const unknown = path.join(root, "recovery.tmp");
  fs.writeFileSync(unknown, "reserved bytes", { mode: 0o600 });
  assert.equal(archive.stats().bytes, Buffer.byteLength("reserved bytes"));
  assert.equal(archive.stats().count, 0);
});

test("2,000 partial clip IDs reach the clip limit without deleting any", (t) => {
  const { archive, root } = fixture(t);
  archive.directory();
  for (let i = 0; i < LIMIT_CLIPS; i++)
    fs.writeFileSync(path.join(root, `${randomUUID()}.json`), "{}", { mode: 0o600 });
  assert.equal(archive.stats().count, LIMIT_CLIPS);
  assert.throws(() => archive.save(randomUUID(), wav(), metadata()), /2,000/);
  assert.equal(fs.readdirSync(root).length, LIMIT_CLIPS);
});

test("crash staging files count toward clip and byte limits", (t) => {
  const { archive, root } = fixture(t);
  archive.directory();
  const id = randomUUID();
  fs.writeFileSync(path.join(root, `${id}.${randomUUID()}.wav.tmp`), "partial", { mode: 0o600 });
  fs.writeFileSync(path.join(root, `${id}.json`), "{}", { mode: 0o600 });
  assert.deepEqual(archive.stats(), { count: 1, bytes: 9, limitBytes: LIMIT_BYTES });
});

test("archive creation is lazy and refuses preexisting or substituted directory symlinks", (t) => {
  const { archive, root, parent, userData } = fixture(t);
  const outside = path.join(parent, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, root);
  assert.doesNotThrow(() => new AudioArchive(userData));
  assert.throws(() => archive.directory(), /private app-owned directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(root);
  archive.directory();
  const moved = path.join(parent, "original");
  fs.renameSync(root, moved);
  fs.symlinkSync(outside, root);
  for (const action of [
    () => archive.stats(),
    () => archive.save(randomUUID(), wav(), metadata()),
    () => archive.file(randomUUID()),
    () => archive.remove(randomUUID()),
  ])
    assert.throws(action);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("parent and archive directory replacements are detected even without symlinks", (t) => {
  const { archive, root, userData, parent } = fixture(t);
  archive.directory();
  fs.renameSync(root, path.join(parent, "old-archive"));
  fs.mkdirSync(root, { mode: 0o700 });
  assert.throws(() => archive.stats(), /private app-owned directory/);
  const second = new AudioArchive(userData);
  second.directory();
  fs.renameSync(userData, path.join(parent, "old-app"));
  fs.mkdirSync(userData, { mode: 0o700 });
  assert.throws(() => second.save(randomUUID(), wav(), metadata()), /folder changed/);
  assert.deepEqual(fs.readdirSync(userData), []);
});

test("entry symlinks and hardlinks are never opened or annotated; removal does not touch targets", (t) => {
  const { archive, root, parent } = fixture(t);
  archive.directory();
  const id = randomUUID(),
    outside = path.join(parent, "outside.txt");
  fs.writeFileSync(outside, "unchanged", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(root, `${id}.wav`));
  fs.symlinkSync(outside, path.join(root, `${id}.json`));
  assert.equal(archive.file(id), null);
  assert.throws(() => archive.annotate(id, { status: "failed" }), /invalid/);
  assert.throws(() => archive.stats(), /unexpected file/);
  archive.remove(id);
  assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
  fs.linkSync(outside, path.join(root, `${id}.wav`));
  assert.equal(archive.file(id), null);
  archive.remove(id);
  assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
});

test("file and removal tolerate absent pair members and cannot affect another recording", (t) => {
  const { archive, root } = fixture(t);
  const id = randomUUID(),
    other = randomUUID();
  assert.equal(archive.file(id), null);
  archive.remove(id);
  archive.save(id, wav(), metadata());
  archive.save(other, wav(), metadata());
  fs.unlinkSync(path.join(root, `${id}.wav`));
  archive.remove(id);
  archive.remove(id);
  assert.equal(fs.existsSync(path.join(root, `${id}.json`)), false);
  assert.ok(archive.file(other));
  assert.equal(archive.stats().count, 1);
});

test("oversized, mismatched or public metadata cannot be annotated", (t) => {
  const { archive, root } = fixture(t);
  const id = randomUUID();
  archive.save(id, wav(), metadata());
  const sidecar = path.join(root, `${id}.json`);
  fs.writeFileSync(sidecar, JSON.stringify({ version: 1, id: randomUUID() }));
  assert.throws(() => archive.annotate(id, { status: "failed" }), /do not match/);
  const descriptor = fs.openSync(sidecar, "r+");
  fs.ftruncateSync(descriptor, MAX_METADATA_BYTES + 1);
  fs.closeSync(descriptor);
  assert.throws(() => archive.annotate(id, { status: "failed" }), /invalid/);
  fs.writeFileSync(sidecar, JSON.stringify({ version: 1, id }));
  fs.chmodSync(sidecar, 0o644);
  assert.throws(() => archive.annotate(id, { status: "failed" }), /invalid/);
});

test("opening retained audio verifies the bounded WAV contents", (t) => {
  const { archive, root } = fixture(t);
  const id = randomUUID();
  archive.save(id, wav(), metadata());
  fs.writeFileSync(path.join(root, `${id}.wav`), "invalid replacement");
  assert.equal(archive.file(id), null);
});
