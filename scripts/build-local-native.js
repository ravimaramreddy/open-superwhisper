const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "darwin") {
  console.log("Native helper compilation is only needed on macOS.");
  process.exit(0);
}
const root = path.join(__dirname, "..");
const source = path.join(root, "resources", "macos-local-paste.swift");
const output = path.join(root, "resources", "bin", "macos-local-paste");
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync("xcrun", ["swiftc", "-O", source, "-o", output], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
