const fs = require("node:fs");
const path = require("node:path");

const MAX_MACHINE_BYTES = 64 * 1024;
const WARNING =
  "Machine settings could not be loaded. Default local connections are available; Gemini is unavailable. Check machine.json and restart.";

function loadMachineConfig(userData, fileSystem = fs) {
  let opened = false;
  try {
    // Nonblocking open also lets us reject special files without hanging startup.
    const descriptor = fileSystem.openSync(
      path.join(userData, "machine.json"),
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
    );
    opened = true;
    try {
      const stat = fileSystem.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_MACHINE_BYTES) throw new Error();
      // Bound the actual read as well as the initial size check if the file grows.
      const buffer = Buffer.alloc(MAX_MACHINE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = fileSystem.readSync(
          descriptor,
          buffer,
          length,
          buffer.length - length,
          length
        );
        if (!read) break;
        length += read;
      }
      if (length > MAX_MACHINE_BYTES) throw new Error();
      const config = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
      return { config, warning: null };
    } finally {
      fileSystem.closeSync(descriptor);
    }
  } catch (error) {
    return {
      config: {},
      warning: !opened && error.code === "ENOENT" ? null : WARNING,
    };
  }
}

module.exports = { loadMachineConfig };
