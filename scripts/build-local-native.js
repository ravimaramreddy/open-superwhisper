const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "darwin") {
  console.log("Native dictation compilation is only needed on macOS.");
  process.exit(0);
}
const root = path.join(__dirname, "..");
const source = path.join(root, "resources", "macos-local-paste.mm");
const output = path.join(root, "resources", "bin", "macos-local-paste.node");
// Node-API is ABI stable across Node/Electron versions. Pin its headers rather
// than depending on a developer's global Node installation or cache location.
const headerVersion = "24.18.0";
const headerCache = path.join(root, "node_modules", ".cache", "node-gyp");
const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// The lockfile-installed downloader checks the archive against Node's SHA256
// manifest; --ensure reuses a previously verified installation.
run(process.execPath, [
  nodeGyp,
  "install",
  `--target=${headerVersion}`,
  `--devdir=${headerCache}`,
  "--dist-url=https://nodejs.org/download/release",
  "--ensure",
]);
fs.mkdirSync(path.dirname(output), { recursive: true });
run("xcrun", [
  "clang++",
  "-std=c++20",
  "-O2",
  "-fobjc-arc",
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-DNAPI_VERSION=8",
  "-I",
  path.join(headerCache, headerVersion, "include", "node"),
  "-framework",
  "Cocoa",
  "-framework",
  "ApplicationServices",
  source,
  "-o",
  output,
]);
