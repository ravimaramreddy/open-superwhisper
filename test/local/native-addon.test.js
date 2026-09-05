const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const addonPath = path.join(__dirname, "../../resources/bin/macos-local-paste.node");
const skip = process.platform !== "darwin" || !fs.existsSync(addonPath);

test(
  "native addon rejects malformed targets before checking permission or posting events",
  { skip },
  () => {
    const addon = require(addonPath);
    for (const args of [
      [],
      [1],
      [1, "com.example.invalid", "extra"],
      ["1", "com.example.invalid"],
      [0, "com.example.invalid"],
      [-1, "com.example.invalid"],
      [1.5, "com.example.invalid"],
      [NaN, "com.example.invalid"],
      [Infinity, "com.example.invalid"],
      [2 ** 31, "com.example.invalid"],
      [1, null],
      [1, "embedded\0nul"],
      [1, "x".repeat(4097)],
    ]) {
      assert.throws(() => addon.paste(...args), TypeError);
    }
    assert.throws(() => addon.captureTarget("extra"), TypeError);
    assert.throws(() => addon.accessibility("extra"), TypeError);
  }
);

test("native addon permission and impossible-target probe never emit keystrokes", { skip }, () => {
  const addon = require(addonPath);
  assert.equal(typeof addon.accessibility(), "boolean");
  const target = addon.captureTarget();
  if (target !== null) {
    assert.equal(Number.isInteger(target.pid) && target.pid > 0, true);
    assert.equal(typeof target.bundleId, "string");
  }
  // PID 1 is launchd, never the frontmost GUI app. This cannot paste anywhere.
  const result = addon.paste(1, "fyi.rlab.opensuperwhisper.invalid-target");
  assert.ok(["permission-required", "target-changed", "unavailable"].includes(result.status));
});

test("native addon refuses calls from a worker thread", { skip }, async () => {
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const addon = require(workerData);
       const errors = ["accessibility", "captureTarget", "paste"].map((name) => {
         try { addon[name](...(name === "paste" ? [1, "invalid"] : [])); return null; }
         catch (error) { return error.message; }
       });
       parentPort.postMessage(errors);`,
      { eval: true, workerData: addonPath }
    );
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Native probe worker exited with ${code}`));
    });
  });
  assert.deepEqual(result, Array(3).fill("Native dictation must run on the main thread"));
});
