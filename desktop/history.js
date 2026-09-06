const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { MODES, STYLES, FORMATS, validApp } = require("./editing-settings");

const MAX_RECORDS = 100;
const MAX_TEXT = 100_000;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const DELIVERY = new Set(["pending", "dispatched", "clipboard-only", "uncertain", "cancelled"]);
const VERSION_KEYS = [
  "text",
  "cleanupStatus",
  "warning",
  "candidateText",
  "reviewReasons",
  "editingMode",
  "style",
  "format",
  "edit",
];

function textVersion(record) {
  return Object.fromEntries(VERSION_KEYS.map((key) => [key, structuredClone(record[key])]));
}

function validVersion(record) {
  return (
    record &&
    typeof record === "object" &&
    typeof record.text === "string" &&
    record.text.length <= MAX_TEXT &&
    ["off", "applied", "failed"].includes(record.cleanupStatus) &&
    (record.warning === undefined ||
      (typeof record.warning === "string" && record.warning.length <= 4000)) &&
    (record.candidateText === undefined ||
      (typeof record.candidateText === "string" &&
        record.candidateText.length > 0 &&
        record.candidateText.length <= MAX_TEXT)) &&
    (record.reviewReasons === undefined ||
      (Array.isArray(record.reviewReasons) &&
        record.reviewReasons.length > 0 &&
        record.reviewReasons.length <= 8 &&
        record.reviewReasons.every(
          (reason) => typeof reason === "string" && reason.length > 0 && reason.length <= 500
        ))) &&
    Boolean(record.candidateText) === Boolean(record.reviewReasons) &&
    (record.editingMode === undefined || MODES.has(record.editingMode)) &&
    (record.style === undefined || STYLES.has(record.style)) &&
    (record.format === undefined || FORMATS.has(record.format)) &&
    (record.edit === undefined ||
      (record.edit &&
        ["dictation", "retry", "accepted"].includes(record.edit.source) &&
        ["studio", "air"].includes(record.edit.profile) &&
        Number.isFinite(record.edit.elapsedMs) &&
        record.edit.elapsedMs >= 0 &&
        (record.edit.fallbackReason === undefined ||
          (typeof record.edit.fallbackReason === "string" &&
            record.edit.fallbackReason.length <= 4000))))
  );
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Keep the original write error; a stale temp file is never loaded. */
    }
  }
}

function validRecord(record) {
  return (
    record &&
    typeof record === "object" &&
    validVersion(record) &&
    (record.historyEdited === undefined || typeof record.historyEdited === "boolean") &&
    (record.audio === undefined ||
      (record.audio &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          record.id
        ) &&
        record.audio.fileName === `${record.id}.wav` &&
        Number.isSafeInteger(record.audio.bytes) &&
        record.audio.bytes >= 44 &&
        record.audio.bytes <= 60 * 1024 * 1024)) &&
    (record.audioWarning === undefined ||
      (typeof record.audioWarning === "string" && record.audioWarning.length <= 4000)) &&
    (record.targetApp === undefined || validApp(record.targetApp)) &&
    (record.previousVersion === undefined ||
      (validVersion(record.previousVersion) &&
        Object.keys(record.previousVersion).every((key) => VERSION_KEYS.includes(key)))) &&
    typeof record.id === "string" &&
    /^[a-zA-Z0-9-]{1,80}$/.test(record.id) &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.rawText === "string" &&
    record.rawText.length <= MAX_TEXT &&
    ["studio", "air"].includes(record.actualProfile) &&
    Number.isFinite(record.durationMs) &&
    record.durationMs >= 0 &&
    DELIVERY.has(record.delivery) &&
    record.timings &&
    ["asrMs", "cleanupMs", "totalMs"].every(
      (key) => Number.isFinite(record.timings[key]) && record.timings[key] >= 0
    ) &&
    (record.fallbackReason === undefined ||
      (typeof record.fallbackReason === "string" && record.fallbackReason.length <= 4000))
  );
}

class History {
  constructor(file, { limit = MAX_RECORDS } = {}) {
    this.file = file;
    this.limit = Math.min(MAX_RECORDS, Math.max(1, limit));
    this.records = [];
    this.persistent = new Set();
    this.claimed = new Set();
    this.warning = null;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    let parsed;
    try {
      if (fs.statSync(this.file).size > MAX_FILE_BYTES) throw new Error("History is too large");
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.records) ||
        !parsed.records.every(validRecord)
      ) {
        throw new Error("Invalid history data");
      }
    } catch (_error) {
      const backup = `${this.file}.invalid-${Date.now()}-${randomUUID()}`;
      fs.renameSync(this.file, backup);
      this.warning =
        "Unreadable history was preserved in a backup. New recordings can still be saved.";
      return;
    }
    const seen = new Set();
    this.records = parsed.records
      .filter((record) => {
        if (seen.has(record.id)) return false;
        seen.add(record.id);
        return true;
      })
      .slice(0, this.limit)
      .map((record) => {
        // A process restart can never authorize another automatic paste.
        if (record.delivery === "pending") return { ...record, delivery: "uncertain" };
        return record;
      });
    this.persistent = new Set(this.records.map((record) => record.id));
    this.claimed = new Set(this.records.map((record) => record.id));
  }

  list() {
    return structuredClone(this.records.filter((record) => this.persistent.has(record.id)));
  }
  get(id) {
    const row = this.records.find((record) => record.id === id);
    return row ? structuredClone(row) : null;
  }

  commit(records, persistent = this.persistent) {
    const value = {
      version: 1,
      records: records.filter((record) => persistent.has(record.id)),
    };
    if (Buffer.byteLength(JSON.stringify(value, null, 2)) > MAX_FILE_BYTES)
      throw new Error(
        "History is full. Copy your latest text, then remove older entries to make room."
      );
    atomicWrite(this.file, value);
    this.records = records;
    this.persistent = persistent;
  }

  save(record, { persist = true } = {}) {
    const existing = this.get(record.id);
    if (existing) return existing;
    if (!validRecord(record)) throw new Error("Invalid transcript");
    const retained = this.records.filter((row) => this.persistent.has(row.id));
    if (persist) {
      const records = [structuredClone(record), ...retained].slice(0, this.limit);
      this.commit(records, new Set(records.map((row) => row.id)));
    } else {
      // Keep only the latest unsaved result, without evicting retained history.
      this.records = [structuredClone(record), ...retained];
    }
    this.claimed = new Set(
      [...this.claimed].filter((id) => this.records.some((row) => row.id === id))
    );
    return this.get(record.id);
  }

  update(id, changes) {
    const current = this.get(id);
    if (!current) throw new Error("Transcript not found");
    // Rewrites and delivery changes cannot replace original ASR output or identity.
    const allowed = {};
    for (const key of [
      ...VERSION_KEYS,
      "delivery",
      "previousVersion",
      "historyEdited",
      "audio",
      "audioWarning",
    ])
      if (Object.hasOwn(changes, key)) allowed[key] = structuredClone(changes[key]);
    const updated = { ...current, ...allowed };
    if (!validRecord(updated)) throw new Error("Invalid transcript update");
    const records = this.records.map((record) => (record.id === id ? updated : record));
    if (this.persistent.has(id)) this.commit(records);
    else this.records = records;
    return this.get(id);
  }

  claimDelivery(id) {
    if (this.claimed.has(id) || this.get(id)?.delivery !== "pending") return false;
    // Persist an uncertain claim BEFORE a side effect. A crash must not replay it.
    this.update(id, { delivery: "uncertain" });
    this.claimed.add(id);
    return true;
  }

  delete(id) {
    const records = this.records.filter((record) => record.id !== id);
    const persistent = new Set(this.persistent);
    persistent.delete(id);
    this.commit(records, persistent);
  }
}

module.exports = { History, atomicWrite, validRecord, textVersion, MAX_TEXT };
