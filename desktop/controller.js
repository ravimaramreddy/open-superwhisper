const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { atomicWrite, textVersion, MAX_TEXT } = require("./history");
const { AudioArchive } = require("./audio-archive");
const { DEFAULT_VOCABULARY, normalizeVocabulary } = require("./vocabulary");
const {
  MODES,
  STYLES,
  validApp,
  normalizeAppRules,
  effectiveSettings,
} = require("./editing-settings");

const DEFAULT_SETTINGS = Object.freeze({
  profile: "auto",
  cleanup: true,
  editingMode: "polished",
  style: "neutral",
  appRules: [],
  format: "prose",
  vocabulary: DEFAULT_VOCABULARY,
  microphoneId: "default",
  hotkey: "Control+Alt+Space",
  historyEnabled: true,
  retainAudio: false,
  launchAtLogin: false,
});
const MAX_AUDIO_BYTES = 60 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 128 * 1024;

function normalizeSettings(patch, base = DEFAULT_SETTINGS) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("Invalid settings");
  const next = { ...base };
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error("Unknown setting");
    const value = patch[key];
    if (key === "profile" && !["auto", "studio", "air", "gemini"].includes(value))
      throw new Error("Invalid profile");
    if (key === "editingMode" && !MODES.has(value)) throw new Error("Invalid editing mode");
    if (key === "style" && !STYLES.has(value)) throw new Error("Invalid writing style");
    if (key === "appRules") {
      next[key] = normalizeAppRules(value);
      continue;
    }
    if (key === "format" && !["prose", "paragraphs", "list"].includes(value))
      throw new Error("Invalid text format");
    if (key === "vocabulary") {
      next[key] = normalizeVocabulary(value);
      continue;
    }
    if (
      ["cleanup", "historyEnabled", "retainAudio", "launchAtLogin"].includes(key) &&
      typeof value !== "boolean"
    )
      throw new Error("Invalid setting value");
    if (key === "microphoneId" && (typeof value !== "string" || value.length > 256))
      throw new Error("Invalid microphone");
    if (
      key === "hotkey" &&
      (typeof value !== "string" ||
        value.length > 80 ||
        !/^(?:(?:(?:Control|Command|Alt|Option|Shift|Super)\+)+(?:Space|[A-Z0-9])|(?:(?:Control|Command|Alt|Option|Shift|Super)\+)*F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(
          value
        ))
    ) {
      throw new Error("Use a shortcut such as Control+Alt+Space");
    }
    next[key] = value;
  }
  // Older preferences have only cleanup. A new explicit mode takes precedence.
  if (Object.hasOwn(patch, "editingMode")) next.cleanup = next.editingMode !== "exact";
  else if (Object.hasOwn(patch, "cleanup")) next.editingMode = patch.cleanup ? "polished" : "exact";
  if (!next.historyEnabled) next.retainAudio = false;
  return next;
}

function readSettings(file) {
  try {
    if (fs.statSync(file).size > MAX_SETTINGS_BYTES) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function cleanupAbandonedRecordings(root) {
  try {
    if (!fs.existsSync(root)) return null;
    if (!fs.lstatSync(root).isDirectory()) throw new Error("Invalid recordings directory");
    const owned = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && /^open-superwhisper-[A-Za-z0-9]{6}$/.test(entry.name)
      );
    for (const entry of owned.slice(0, 1000)) {
      fs.rmSync(path.join(root, entry.name), { recursive: true });
    }
    if (owned.length > 1000) throw new Error("Too many abandoned recordings");
    return null;
  } catch {
    return "Some temporary recordings could not be removed from the app's recordings folder.";
  }
}

function validateWav(audio) {
  if (!(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio))
    throw new Error("Expected WAV audio bytes");
  const buffer =
    audio instanceof ArrayBuffer
      ? Buffer.from(audio)
      : Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (
    buffer.length < 44 ||
    buffer.length > MAX_AUDIO_BYTES ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Invalid or oversized WAV audio");
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new Error("Incomplete WAV audio");
  let format = false;
  let data = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > buffer.length - start) throw new Error("Incomplete WAV chunk");
    const kind = buffer.toString("ascii", offset, offset + 4);
    if (kind === "fmt ") {
      if (
        size < 16 ||
        buffer.readUInt16LE(start) !== 1 ||
        buffer.readUInt16LE(start + 2) !== 1 ||
        buffer.readUInt32LE(start + 4) !== 16000 ||
        buffer.readUInt16LE(start + 12) !== 2 ||
        buffer.readUInt16LE(start + 14) !== 16
      )
        throw new Error("Audio must be mono 16 kHz PCM16 WAV");
      format = true;
    }
    if (kind === "data") {
      if (data) throw new Error("Multiple audio chunks are not supported");
      data = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data || data.length === 0 || data.length % 2)
    throw new Error("WAV contains no complete audio samples");
  if (data.length / 32 > 120_000) throw new Error("Recordings are limited to two minutes");
  let peak = 0;
  for (let offset = 0; offset < data.length; offset += 2)
    peak = Math.max(peak, Math.abs(data.readInt16LE(offset)));
  return { buffer, durationMs: data.length / 32, silent: peak <= 2 };
}

function cancelled() {
  const error = new Error("Cancelled");
  error.name = "AbortError";
  return error;
}
function cleanError(error) {
  return String(error?.message || "The operation failed").slice(0, 1000);
}

class Controller {
  constructor({
    userData,
    history,
    inference,
    native,
    clipboard,
    permissions,
    onState = () => {},
    applySettings = async () => {},
    temporaryRoot = path.join(userData, "recordings"),
    audioArchive = new AudioArchive(userData),
  }) {
    this.userData = userData;
    this.history = history;
    this.inference = inference;
    this.native = native;
    this.clipboard = clipboard;
    this.permissions = permissions;
    this.onState = onState;
    this.applySettings = applySettings;
    this.temporaryRoot = temporaryRoot;
    this.audioArchive = audioArchive;
    this.settingsFile = path.join(userData, "settings.json");
    this.active = null;
    this.completed = new Map();
    this.rewrites = new Set();
    this.settingsQueue = Promise.resolve();
    this.state = {
      settings: readSettings(this.settingsFile),
      permissions: permissions.get(),
      localReady: false,
      studio: "unknown",
      gemini: "unknown",
      phase: "idle",
      progress: "",
      latest: history.list()[0] || null,
      error:
        [history.warning, cleanupAbandonedRecordings(temporaryRoot)].filter(Boolean).join(" ") ||
        null,
    };
  }

  getState() {
    return structuredClone({
      ...this.state,
      permissions: this.permissions.get(),
      history: this.history.list(),
    });
  }
  emit() {
    this.onState(this.getState());
  }
  progress(message) {
    if (this.state.phase !== "idle") {
      this.state.progress = String(message).slice(0, 500);
      this.emit();
    }
  }
  assertOwned(request) {
    if (this.active !== request || request.abort.signal.aborted) throw cancelled();
  }
  idleRequired() {
    if (this.state.phase !== "idle")
      throw new Error("Finish or cancel the current recording first");
  }

  updateSettings(patch) {
    const operation = this.settingsQueue
      .catch(() => {})
      .then(async () => {
        const previous = this.state.settings;
        const next = normalizeSettings(patch, previous);
        // Use the same serialized limit as the reader, before changing OS settings.
        if (Buffer.byteLength(JSON.stringify(next, null, 2)) > MAX_SETTINGS_BYTES)
          throw new Error("Settings are too large. Shorten some vocabulary or app names.");
        await this.applySettings(next, previous);
        try {
          atomicWrite(this.settingsFile, next);
        } catch (error) {
          await this.applySettings(previous, next).catch(() => {});
          throw error;
        }
        this.state.settings = next;
        this.emit();
        return this.getState();
      });
    this.settingsQueue = operation;
    return operation;
  }

  async requestPermission(kind) {
    if (!["microphone", "accessibility"].includes(kind)) throw new Error("Unknown permission");
    await this.permissions.request(kind);
    this.emit();
    return this.permissions.get();
  }

  async checkConnections() {
    const checks = await Promise.allSettled([
      this.inference.isLocalReady(),
      this.inference.checkStudio(),
      this.state.settings.profile === "gemini"
        ? (this.inference.checkGemini?.() ?? Promise.resolve("unconfigured"))
        : Promise.resolve(this.state.gemini),
    ]);
    this.state.localReady = checks[0].status === "fulfilled" && checks[0].value === true;
    this.state.studio =
      checks[1].status === "fulfilled" && checks[1].value === true ? "ready" : "offline";
    this.state.gemini =
      checks[2].status === "fulfilled" &&
      ["unknown", "ready", "offline", "unconfigured"].includes(checks[2].value)
        ? checks[2].value
        : "offline";
    this.emit();
    return this.getState();
  }

  async prepareLocal() {
    this.idleRequired();
    this.state.phase = "setup";
    this.state.error = null;
    this.state.progress = "Preparing local models…";
    this.emit();
    try {
      await this.inference.prepareLocal();
      this.state.localReady = await this.inference.isLocalReady();
    } catch (error) {
      this.state.error = cleanError(error);
      throw error;
    } finally {
      this.state.phase = "idle";
      this.state.progress = "";
      this.emit();
    }
    return this.getState();
  }

  async beginRecording() {
    this.idleRequired();
    const request = {
      id: randomUUID(),
      settings: structuredClone(this.state.settings),
      abort: new AbortController(),
      target: null,
      submitted: false,
    };
    this.active = request;
    this.state.phase = "recording";
    this.state.error = null;
    this.state.progress = "Listening…";
    this.emit();
    try {
      request.target = await this.native.captureTarget();
      this.assertOwned(request);
      const app = request.target && {
        bundleId: request.target.bundleId,
        name: request.target.name || request.target.bundleId,
      };
      request.targetApp = validApp(app) ? app : undefined;
      request.settings = effectiveSettings(request.settings, request.targetApp);
      return { requestId: request.id, settings: structuredClone(request.settings) };
    } catch (error) {
      if (this.active === request) {
        this.active = null;
        this.state.phase = "idle";
        this.state.progress = "";
        this.emit();
      }
      throw error;
    }
  }

  transcribe({ requestId, audio, durationMs } = {}) {
    if (this.completed.has(requestId)) return this.completed.get(requestId);
    const saved = this.history.get(requestId);
    if (saved) return Promise.resolve(saved);
    const request = this.active;
    if (!request || request.id !== requestId || request.submitted)
      return Promise.reject(new Error("Recording session expired"));
    request.submitted = true;
    const result = this.runTranscription(request, audio, durationMs);
    this.completed.set(requestId, result);
    // Deduplicate only in-flight work. History handles completed IDs; keeping
    // settled promises would retain deleted/nonpersistent transcript text.
    const release = () => {
      this.completed.delete(requestId);
    };
    void result.then(release, release);
    return result;
  }

  async runTranscription(request, audio, suppliedDuration) {
    let directory;
    let savedAudio;
    let audioWarning;
    let archiveCleanup;
    let archiveSaveError;
    let archiveStatus = "failed";
    const createdAt = new Date().toISOString();
    try {
      this.assertOwned(request);
      if (!Number.isFinite(suppliedDuration) || suppliedDuration < 0)
        throw new Error("Invalid recording duration");
      const wav = validateWav(audio);
      if (wav.silent) {
        this.state.progress = "No audio detected";
        return null;
      }
      this.state.phase = "processing";
      this.state.progress = "Transcribing…";
      this.emit();
      if (request.settings.historyEnabled && request.settings.retainAudio) {
        try {
          savedAudio = this.audioArchive.save(request.id, wav.buffer, {
            createdAt,
            status: "processing",
            durationMs: wav.durationMs,
            settings: {
              profile: request.settings.profile,
              editingMode: request.settings.editingMode,
              style: request.settings.style,
              format: request.settings.format,
              vocabulary: request.settings.vocabulary,
            },
            targetApp: request.targetApp,
          });
        } catch (error) {
          archiveSaveError = cleanError(error);
          if (typeof error.cleanupRetainedAudio === "function") {
            archiveCleanup = error.cleanupRetainedAudio;
            audioWarning = `Some audio may remain after a failed save. Open saved recordings to remove partial files: ${archiveSaveError}`;
          } else audioWarning = `Audio was not saved: ${archiveSaveError}`;
        }
      }
      fs.mkdirSync(this.temporaryRoot, { recursive: true, mode: 0o700 });
      directory = fs.mkdtempSync(path.join(this.temporaryRoot, "open-superwhisper-"));
      fs.chmodSync(directory, 0o700);
      const audioPath = path.join(directory, "recording.wav");
      fs.writeFileSync(audioPath, wav.buffer, { mode: 0o600, flag: "wx" });
      this.assertOwned(request);
      const result = await this.inference.processWav({
        audioPath,
        profile: request.settings.profile,
        cleanup: request.settings.cleanup,
        editingMode: request.settings.editingMode,
        style: request.settings.style,
        vocabulary: request.settings.vocabulary,
        format: request.settings.format,
        signal: request.abort.signal,
      });
      this.assertOwned(request);
      if (result.actualProfile === "studio") this.state.studio = "ready";
      else if (result.actualProfile === "air" && result.fallbackReason)
        this.state.studio = "offline";
      if (result.actualProfile === "gemini") this.state.gemini = "ready";
      else if (request.settings.profile === "gemini" && this.state.gemini !== "unconfigured")
        this.state.gemini = "offline";
      if (
        typeof result?.rawText !== "string" ||
        typeof result?.text !== "string" ||
        result.rawText.length > MAX_TEXT ||
        result.text.length > MAX_TEXT
      )
        throw new Error("The model returned an invalid transcript");
      if (!result.rawText.trim()) {
        archiveStatus = "no-speech";
        this.state.progress = "No speech detected";
        return null;
      }
      const record = {
        id: request.id,
        createdAt,
        rawText: result.rawText,
        text: request.settings.cleanup && result.text.trim() ? result.text : result.rawText,
        actualProfile: result.actualProfile,
        cleanupStatus: request.settings.cleanup
          ? result.text.trim()
            ? result.cleanupStatus
            : "failed"
          : "off",
        durationMs: wav.durationMs,
        timings: result.timings,
        editingMode: request.settings.editingMode,
        style: request.settings.style,
        format: request.settings.format,
        edit: {
          source: "dictation",
          profile: result.actualProfile,
          elapsedMs:
            result.actualProfile === "gemini" ? result.timings.geminiMs : result.timings.cleanupMs,
        },
        ...(request.targetApp ? { targetApp: request.targetApp } : {}),
        delivery: "pending",
        ...(savedAudio ? { audio: savedAudio } : {}),
        ...(audioWarning ? { audioWarning } : {}),
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
        ...(result.candidateText
          ? { candidateText: result.candidateText, reviewReasons: result.reviewReasons }
          : {}),
        ...(result.warning
          ? { warning: result.warning }
          : request.settings.cleanup && !result.text.trim()
            ? { warning: "Cleanup returned no text. The original transcript was kept." }
            : {}),
      };
      if (savedAudio) {
        try {
          // Keep the initial pipeline output for comparisons, independent of later History edits.
          this.audioArchive.annotate(request.id, {
            rawText: record.rawText,
            text: record.text,
            actualProfile: record.actualProfile,
            cleanupStatus: record.cleanupStatus,
            timings: record.timings,
            candidateText: record.candidateText,
            reviewReasons: record.reviewReasons,
          });
        } catch (error) {
          audioWarning = `Audio was saved, but transcript details could not be saved: ${cleanError(error)}`;
          record.audioWarning = audioWarning;
        }
      }
      archiveStatus = "transcribed";
      if (record.text !== record.rawText && !record.candidateText) {
        record.previousVersion = {
          text: record.rawText,
          cleanupStatus: "off",
          editingMode: "exact",
          style: "neutral",
          format: "prose",
        };
      }
      this.state.latest = record;
      // A failed disk save prevents automatic paste; latest remains available to copy.
      this.history.save(record, { persist: request.settings.historyEnabled });
      this.assertOwned(request);
      this.state.phase = "delivering";
      this.state.progress = "Pasting…";
      this.emit();
      if (!this.history.claimDelivery(record.id)) return this.history.get(record.id);
      this.state.latest = this.history.get(record.id);
      this.assertOwned(request);
      const outcome = await this.native.deliver({
        text: record.text,
        target: request.target,
        signal: request.abort.signal,
      });
      // Cancellation after key dispatch cannot undo the user's document safely.
      const changes = {
        delivery: outcome.delivery,
        ...(outcome.warning ? { warning: outcome.warning } : {}),
      };
      this.state.latest = { ...record, ...changes };
      this.history.update(record.id, changes);
      return this.state.latest;
    } catch (error) {
      if (request.abort.signal.aborted || error.name === "AbortError") {
        request.abort.abort();
        const record = this.history.get(request.id);
        if (record && record.delivery !== "dispatched") {
          this.state.latest = this.history.update(request.id, { delivery: "cancelled" });
        }
        return null;
      }
      if (this.state.latest?.delivery !== "dispatched" && this.history.get(request.id))
        this.state.latest = this.history.get(request.id);
      this.state.error = cleanError(error);
      throw error;
    } finally {
      if (archiveCleanup) {
        // Retry only entries whose identities were captured by this failed save.
        // In particular, cancellation must not abandon a partially published WAV.
        if (archiveCleanup()) audioWarning = "Audio was not saved. Partial files were removed.";
      }
      if (savedAudio) {
        try {
          if (request.abort.signal.aborted) {
            this.audioArchive.remove(request.id);
            const record = this.history.get(request.id);
            if (record) this.history.update(request.id, { audio: undefined });
            if (this.state.latest?.id === request.id) delete this.state.latest.audio;
          } else {
            this.audioArchive.annotate(request.id, {
              status: archiveStatus,
              delivery: this.history.get(request.id)?.delivery,
            });
          }
        } catch (error) {
          audioWarning = request.abort.signal.aborted
            ? `The cancelled recording could not be fully removed. Open saved recordings to remove it: ${cleanError(error)}`
            : `Audio was saved, but its final status could not be saved: ${cleanError(error)}`;
        }
      }
      if (audioWarning) {
        this.state.error = [this.state.error, audioWarning].filter(Boolean).join(" ");
        if (this.state.latest?.id === request.id) this.state.latest.audioWarning = audioWarning;
        try {
          if (this.history.get(request.id)) this.history.update(request.id, { audioWarning });
        } catch {
          /* Dictation and delivery do not depend on archive warnings being persisted. */
        }
      }
      if (directory) {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
        } catch {
          this.state.error =
            "The temporary recording could not be removed. It remains in the app's recordings folder.";
        }
      }
      if (this.active === request) {
        this.active = null;
        this.state.phase = "idle";
        this.state.progress = "";
        this.emit();
      }
    }
  }

  async cancel(requestId) {
    const request = this.active;
    if (!request || (requestId && request.id !== requestId)) return;
    request.abort.abort();
    if (!request.submitted) {
      this.active = null;
      this.state.phase = "idle";
      this.state.progress = "";
    } else {
      this.state.progress = "Cancelling…";
    }
    this.emit();
  }

  async copyTranscript(id, source) {
    if (!["original", "edited", "suggestion"].includes(source))
      throw new Error("Unknown transcript source");
    this.idleRequired();
    const record =
      this.history.get(id) || (this.state.latest?.id === id ? this.state.latest : null);
    if (!record) throw new Error("Transcript not found");
    if (source === "suggestion" && !record.candidateText)
      throw new Error("No suggested edit to copy");
    this.clipboard.writeText(
      source === "original"
        ? record.rawText
        : source === "suggestion"
          ? record.candidateText
          : record.text
    );
  }

  rewriteTranscript(id) {
    const pending = this.runRewrite(id);
    this.rewrites.add(pending);
    const release = () => {
      this.rewrites.delete(pending);
    };
    void pending.then(release, release);
    return pending;
  }

  async drain() {
    await Promise.allSettled([...this.completed.values(), ...this.rewrites]);
  }

  async runRewrite(id) {
    this.idleRequired();
    const record = this.history.get(id);
    if (!record) throw new Error("Transcript not found");
    const settings = effectiveSettings(this.state.settings, record.targetApp);
    const request = { id: randomUUID(), abort: new AbortController(), submitted: true };
    this.active = request;
    this.state.phase = "processing";
    this.state.progress = "Editing the original transcript…";
    this.state.error = null;
    this.emit();
    try {
      const result =
        settings.editingMode === "exact"
          ? { text: record.rawText, cleanupStatus: "off", timings: { cleanupMs: 0 } }
          : await this.inference.rewrite({
              text: record.rawText,
              profile: settings.profile,
              editingMode: settings.editingMode,
              style: settings.style,
              vocabulary: settings.vocabulary,
              format: settings.format,
              signal: request.abort.signal,
            });
      this.assertOwned(request);
      const text = typeof result === "string" ? result : result?.text;
      if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT)
        throw new Error("The model returned an invalid rewrite");
      const updated = this.history.update(id, {
        text: result.candidateText ? record.text : text,
        cleanupStatus: result.candidateText
          ? record.cleanupStatus
          : settings.editingMode === "exact"
            ? "off"
            : "applied",
        candidateText: result.candidateText,
        reviewReasons: result.reviewReasons,
        warning: result.warning,
        editingMode: settings.editingMode,
        style: settings.style,
        format: settings.format,
        edit: {
          source: "retry",
          profile: result.actualProfile || record.edit?.profile || record.actualProfile,
          elapsedMs: result.timings?.cleanupMs || 0,
          ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
        },
        previousVersion: textVersion(record),
        historyEdited: true,
      });
      if (this.state.latest?.id === id) this.state.latest = updated;
      return updated;
    } catch (error) {
      if (error.name !== "AbortError" && !request.abort.signal.aborted)
        this.state.error = cleanError(error);
      throw error;
    } finally {
      if (this.active === request) {
        this.active = null;
        this.state.phase = "idle";
        this.state.progress = "";
        this.emit();
      }
    }
  }

  async undoTranscript(id) {
    this.idleRequired();
    const record = this.history.get(id);
    if (!record?.previousVersion) throw new Error("No previous edit to restore");
    const updated = this.history.update(id, {
      ...textVersion(record.previousVersion),
      previousVersion: undefined,
      historyEdited: true,
    });
    if (this.state.latest?.id === id) this.state.latest = updated;
    this.emit();
    return updated;
  }

  async acceptSuggestion(id) {
    this.idleRequired();
    const record = this.history.get(id);
    if (!record?.candidateText) throw new Error("No suggested edit to use");
    const updated = this.history.update(id, {
      text: record.candidateText,
      cleanupStatus: "applied",
      candidateText: undefined,
      reviewReasons: undefined,
      warning: undefined,
      previousVersion: textVersion(record),
      historyEdited: true,
      edit: {
        source: "accepted",
        profile: record.edit?.profile || record.actualProfile,
        elapsedMs: record.edit?.elapsedMs || record.timings.cleanupMs,
      },
    });
    if (this.state.latest?.id === id) this.state.latest = updated;
    this.emit();
    return updated;
  }

  async deleteTranscript(id) {
    this.idleRequired();
    const record = this.history.get(id);
    if (!record) throw new Error("Transcript not found");
    // A failed archive deletion leaves the History entry available to retry.
    if (record.audio) this.audioArchive.remove(id);
    this.history.delete(id);
    this.completed.delete(id);
    if (this.state.latest?.id === id) this.state.latest = null;
    this.emit();
    return this.getState();
  }

  audioDirectory() {
    return this.audioArchive.directory();
  }

  recordingFile(id) {
    const record = this.history.get(id);
    if (!record?.audio) throw new Error("No saved recording for this transcript");
    const file = this.audioArchive.file(id);
    if (!file) throw new Error("The saved recording is missing or unavailable");
    return file;
  }
}

module.exports = { Controller, DEFAULT_SETTINGS, normalizeSettings, validateWav };
