const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
async function run() {
  const native = spawn(process.execPath, [path.join(__dirname, "build-local-native.js")], {
    cwd: root,
    stdio: "inherit",
  });
  children.push(native);
  const code = await new Promise((resolve, reject) => {
    native.once("exit", resolve);
    native.once("error", reject);
  });
  if (code !== 0) return stop(1);
  const vite = spawn(
    process.execPath,
    [path.join(root, "node_modules/vite/bin/vite.js"), "--config", "vite.local.config.mjs"],
    { cwd: root, stdio: "inherit" }
  );
  children.push(vite);
  vite.on("exit", (exitCode) => stop(exitCode ?? 1));
  vite.on("error", () => stop(1));
  const url = "http://127.0.0.1:5173";
  let ready = false;
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    try {
      ready = (await fetch(url)).ok;
    } catch {
      /* Vite is still opening its listener. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready || stopping) return stop(1);
  const electron = spawn(require("electron"), ["."], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, LOCAL_WHISPR_DEV_URL: url },
  });
  children.push(electron);
  electron.on("exit", (exitCode) => stop(exitCode ?? 0));
  electron.on("error", () => stop(1));
}
run().catch((error) => {
  console.error(error.message);
  stop(1);
});
