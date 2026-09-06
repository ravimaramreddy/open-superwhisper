const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { maxRecordingSeconds } = require("../local-runtime/recording-limits.json");

const LIMIT_BYTES = 1024 * 1024 * 1024;
const LIMIT_CLIPS = 2000;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ENTRIES = LIMIT_CLIPS * 4 + 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW;

function identity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function lookup(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function owned(stat) {
  return stat && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

function privateFile(stat) {
  return owned(stat) && stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0;
}

function validateId(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid recording identifier");
  return id;
}

function metadataBytes(id, metadata) {
  let nodes = 0;
  const check = (value, depth = 0) => {
    if (++nodes > 10000 || depth > 12) throw new Error("Recording details are too large");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (value.length > MAX_METADATA_BYTES) throw new Error("Recording details are too large");
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object" || Buffer.isBuffer(value) || ArrayBuffer.isView(value))
      throw new Error("Invalid recording details");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Invalid recording details");
    for (const item of Object.values(value)) if (item !== undefined) check(item, depth + 1);
  };
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Invalid recording details");
  check(metadata);
  if (
    (Object.hasOwn(metadata, "id") && metadata.id !== id) ||
    (Object.hasOwn(metadata, "version") && metadata.version !== 1)
  )
    throw new Error("Recording details do not match this recording");
  const data = Buffer.from(JSON.stringify({ ...metadata, version: 1, id }, null, 2) + "\n");
  if (data.length > MAX_METADATA_BYTES) throw new Error("Recording details are too large");
  return data;
}

function validateWav(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 44 ||
    buffer.length > 10000000 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE" ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  )
    throw new Error("Recording must be a valid WAV file");
  let format = false,
    audioBytes = 0,
    offset = 12;
  while (offset + 8 <= buffer.length) {
    const kind = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (offset + 8 + size > buffer.length) throw new Error("Recording is incomplete");
    if (kind === "fmt " && size >= 16)
      format =
        buffer.readUInt16LE(offset + 8) === 1 &&
        buffer.readUInt16LE(offset + 10) === 1 &&
        buffer.readUInt32LE(offset + 12) === 16000 &&
        buffer.readUInt16LE(offset + 22) === 16;
    if (kind === "data") audioBytes += size;
    offset += 8 + size + (size % 2);
  }
  if (
    !format ||
    audioBytes === 0 ||
    audioBytes % 2 ||
    audioBytes > 16000 * 2 * maxRecordingSeconds ||
    offset !== buffer.length
  )
    throw new Error(
      `Recording must be 16 kHz mono PCM16 WAV, up to ${maxRecordingSeconds / 60} minutes`
    );
}

class AudioArchive {
  constructor(userData) {
    this.userData = path.resolve(userData);
    this.root = path.join(this.userData, "retained-audio");
    this.parentIdentity = lookup(this.userData);
    if (!owned(this.parentIdentity) || !this.parentIdentity.isDirectory())
      throw new Error("The recording storage folder is unavailable");
    this.rootIdentity = null;
  }

  directory() {
    const parent = lookup(this.userData);
    if (!owned(parent) || !parent.isDirectory() || !identity(parent, this.parentIdentity))
      throw new Error("The recording storage folder changed; restart before saving audio");
    let root = lookup(this.root);
    if (!root) {
      if (this.rootIdentity) throw new Error("The retained audio folder was moved or removed");
      fs.mkdirSync(this.root, { mode: 0o700 });
      root = lookup(this.root);
    }
    if (
      !owned(root) ||
      !root.isDirectory() ||
      (root.mode & 0o077) !== 0 ||
      (this.rootIdentity && !identity(root, this.rootIdentity))
    )
      throw new Error("The retained audio folder is not a private app-owned directory");
    const descriptor = fs.openSync(
      this.root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW
    );
    try {
      if (
        !identity(root, fs.fstatSync(descriptor)) ||
        !identity(parent, fs.lstatSync(this.userData))
      )
        throw new Error("The recording storage folder changed");
    } finally {
      fs.closeSync(descriptor);
    }
    this.rootIdentity = root;
    return this.root;
  }

  paths(id) {
    validateId(id);
    this.directory();
    return { wav: path.join(this.root, `${id}.wav`), json: path.join(this.root, `${id}.json`) };
  }

  stats() {
    this.directory();
    const clips = new Set();
    let bytes = 0,
      entries = 0;
    const directory = fs.opendirSync(this.root);
    try {
      let entry;
      while ((entry = directory.readSync())) {
        if (++entries > MAX_ENTRIES)
          throw new Error("Retained audio needs cleanup before more recordings can be saved");
        this.directory();
        const stat = lookup(path.join(this.root, entry.name));
        if (!stat) continue;
        // Finder writes this ordinary metadata file when the user opens the
        // private archive folder. Count its bytes without reading its contents.
        const finderMetadata =
          entry.name === ".DS_Store" &&
          owned(stat) &&
          stat.isFile() &&
          stat.nlink === 1 &&
          (stat.mode & 0o777) === 0o644;
        if (!privateFile(stat) && !finderMetadata)
          throw new Error(
            "Retained audio contains an unexpected file; check the folder before saving more"
          );
        bytes += stat.size;
        if (!Number.isSafeInteger(bytes)) throw new Error("Retained audio is too large");
        const id = entry.name.slice(0, 36);
        if (
          UUID.test(id) &&
          /^(?:\.(?:wav|json)|\.[0-9a-f-]{36}\.(?:wav|json)\.tmp)$/.test(entry.name.slice(36))
        )
          clips.add(id);
      }
    } finally {
      directory.closeSync();
    }
    this.directory();
    return { count: clips.size, bytes, limitBytes: LIMIT_BYTES };
  }

  checkCapacity(bytes, newClip) {
    const usage = this.stats();
    if (usage.bytes + bytes > LIMIT_BYTES || (newClip && usage.count >= LIMIT_CLIPS))
      throw new Error(
        "Retained audio is full (1 GiB or 2,000 recordings). Clean up saved audio to retain more; existing recordings are kept."
      );
  }

  writeTemporary(id, extension, data, created) {
    this.directory();
    const file = path.join(this.root, `${id}.${randomUUID()}.${extension}.tmp`);
    const descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
      0o600
    );
    try {
      const stat = fs.fstatSync(descriptor);
      created.push({ file, stat });
      this.directory();
      fs.writeFileSync(descriptor, data);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    this.directory();
    return file;
  }

  cleanup(created) {
    let complete = true;
    for (let index = created.length - 1; index >= 0; index--) {
      const { file, stat } = created[index];
      try {
        this.directory();
        const current = lookup(file);
        if (current) {
          if (identity(current, stat)) fs.unlinkSync(file);
          else complete = false;
        }
      } catch {
        // A replacement folder/file is never removed while handling a failure.
        complete = false;
      }
    }
    return complete;
  }

  save(id, buffer, metadata) {
    const files = this.paths(id);
    validateWav(buffer);
    const json = metadataBytes(id, metadata);
    if (lookup(files.wav) || lookup(files.json))
      throw new Error("This recording is already retained");
    this.checkCapacity(buffer.length + json.length, true);
    const created = [];
    try {
      const wavTemporary = this.writeTemporary(id, "wav", buffer, created);
      const jsonTemporary = this.writeTemporary(id, "json", json, created);
      for (const [temporary, destination] of [
        [wavTemporary, files.wav],
        [jsonTemporary, files.json],
      ]) {
        this.directory();
        const stat = lookup(temporary);
        const expected = created.find((entry) => entry.file === temporary).stat;
        if (!privateFile(stat) || !identity(stat, expected))
          throw new Error("Recording data changed before it could be saved");
        // link is atomic and refuses collisions; rename would overwrite them.
        fs.linkSync(temporary, destination);
        created.push({ file: destination, stat });
        this.directory();
        fs.unlinkSync(temporary);
      }
      return { fileName: `${id}.wav`, bytes: buffer.length };
    } catch (error) {
      const cleanupRetainedAudio = () => this.cleanup(created);
      if (!cleanupRetainedAudio()) {
        // Main-process only: cancellation/finalization can retry the exact
        // files created by this attempt without touching later replacements.
        Object.defineProperty(error, "cleanupRetainedAudio", { value: cleanupRetainedAudio });
        error.audioMayRemain = true;
        error.message += " Audio may remain; open saved recordings to review it.";
      }
      throw error;
    }
  }

  annotate(id, metadata) {
    const files = this.paths(id);
    const before = lookup(files.json);
    if (!privateFile(before) || before.size > MAX_METADATA_BYTES)
      throw new Error("Recording details are unavailable or invalid");
    const descriptor = fs.openSync(files.json, fs.constants.O_RDONLY | NOFOLLOW);
    let original;
    try {
      this.directory();
      const stat = fs.fstatSync(descriptor);
      if (!privateFile(stat) || !identity(stat, before) || stat.size > MAX_METADATA_BYTES)
        throw new Error("Recording details changed");
      const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1);
      const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (length > MAX_METADATA_BYTES) throw new Error("Recording details are too large");
      original = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (!original || original.version !== 1 || original.id !== id)
        throw new Error("Recording details do not match this recording");
    } finally {
      fs.closeSync(descriptor);
    }
    metadataBytes(id, metadata);
    const json = metadataBytes(id, { ...original, ...metadata });
    this.checkCapacity(json.length - before.size, false);
    const created = [];
    try {
      const temporary = this.writeTemporary(id, "json", json, created);
      this.directory();
      const current = lookup(files.json);
      if (!privateFile(current) || !identity(current, before))
        throw new Error("Recording details changed");
      fs.renameSync(temporary, files.json);
      return { fileName: `${id}.wav`, bytes: lookup(files.wav)?.size || 0 };
    } finally {
      this.cleanup(created);
    }
  }

  file(id) {
    const { wav } = this.paths(id);
    const before = lookup(wav);
    if (!privateFile(before)) return null;
    let descriptor;
    try {
      descriptor = fs.openSync(wav, fs.constants.O_RDONLY | NOFOLLOW);
      this.directory();
      const current = fs.fstatSync(descriptor);
      if (!privateFile(current) || !identity(current, before) || current.size > 10000000)
        return null;
      const data = Buffer.alloc(current.size + 1);
      let length = 0,
        read;
      while (
        length < data.length &&
        (read = fs.readSync(descriptor, data, length, data.length - length, length))
      )
        length += read;
      try {
        validateWav(data.subarray(0, length));
      } catch {
        return null;
      }
      this.directory();
      const final = lookup(wav);
      if (!privateFile(final) || !identity(final, current)) return null;
      return wav;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  remove(id) {
    const files = this.paths(id);
    for (const file of Object.values(files)) {
      this.directory();
      const stat = lookup(file);
      if (!stat) continue;
      if (!owned(stat) || (!stat.isFile() && !stat.isSymbolicLink()))
        throw new Error("Unexpected recording entry; it was not removed");
      // unlink removes the directory entry itself, never a symlink's target.
      fs.unlinkSync(file);
    }
  }
}

module.exports = { AudioArchive, LIMIT_BYTES, LIMIT_CLIPS, MAX_METADATA_BYTES };
