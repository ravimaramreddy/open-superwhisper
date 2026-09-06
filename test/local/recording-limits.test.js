const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateWav } = require("../../desktop/controller");
const { validateAudio, createInference } = require("../../desktop/inference");
const { AudioArchive } = require("../../desktop/audio-archive");
const { GeminiClient } = require("../../desktop/gemini-client");

function wav(frames) {
  const b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 2, 40);
  b.writeInt16LE(1000, 44);
  b.writeInt16LE(-1000, b.length - 2);
  return b;
}

test("five-minute audio survives admission, retention, cloud read and local fallback intact", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "recording-limit-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const bytes = wav(300 * 16000);
  const audioPath = path.join(userData, "synthetic.wav");
  fs.writeFileSync(audioPath, bytes, { mode: 0o600 });
  assert.equal(validateWav(bytes).durationMs, 300000);
  assert.equal(await validateAudio(audioPath, userData), fs.realpathSync(audioPath));
  const archive = new AudioArchive(userData),
    id = randomUUID();
  archive.save(id, bytes, { durationMs: 300000 });
  assert.deepEqual(fs.readFileSync(archive.file(id)), bytes);
  const cloudReader = new GeminiClient();
  t.after(() => cloudReader.shutdown());
  const read = await cloudReader.operation((scope) => cloudReader.audio(audioPath, scope));
  assert.deepEqual(read, bytes);
  const seen = [];
  const inference = createInference({
    userData,
    config: {
      _deps: {
        gemini: {
          process: async () => {
            seen.push("gemini");
            throw new Error("offline");
          },
          shutdown: async () => {},
        },
        studio: {
          transcribe: async () => {
            seen.push("studio");
            throw Object.assign(new Error("offline"), { code: "STUDIO_UNAVAILABLE" });
          },
          shutdown: async () => {},
        },
        air: {
          process: async (request) => {
            seen.push("air");
            assert.deepEqual(fs.readFileSync(request.audioPath), bytes);
            return {
              rawText: "Opening and final thought.",
              text: "Opening and final thought.",
              cleanupStatus: "off",
              timings: { asrMs: 1, cleanupMs: 0, totalMs: 1 },
            };
          },
          shutdown: async () => {},
        },
      },
    },
  });
  t.after(() => inference.shutdown());
  const result = await inference.processWav({ audioPath, profile: "gemini", editingMode: "exact" });
  assert.deepEqual(seen, ["gemini", "studio", "air"]);
  assert.equal(result.actualProfile, "air");
  assert.match(result.fallbackReason, /Gemini/);
});

test("one sample beyond five minutes is rejected before processing or retention", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "recording-limit-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const bytes = wav(300 * 16000 + 1);
  const audioPath = path.join(userData, "too-long.wav");
  fs.writeFileSync(audioPath, bytes, { mode: 0o600 });
  assert.throws(() => validateWav(bytes), /limited/);
  await assert.rejects(validateAudio(audioPath, userData), /300 seconds/);
  const archive = new AudioArchive(userData);
  assert.throws(() => archive.save(randomUUID(), bytes, { durationMs: 300001 }), /5 minutes/);
  assert.equal(archive.stats().count, 0);
});
