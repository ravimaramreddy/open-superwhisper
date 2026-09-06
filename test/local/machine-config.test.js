const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadMachineConfig } = require("../../desktop/machine-config");
const { GeminiClient } = require("../../desktop/gemini-client");

const MAX_BYTES = 64 * 1024;
const WARNING =
  "Machine settings could not be loaded. Default local connections are available; Gemini is unavailable. Check machine.json and restart.";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "machine-config-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "machine.json") };
}

test("missing machine configuration keeps local defaults without a warning", async (t) => {
  const { directory } = fixture(t);
  const result = loadMachineConfig(directory);
  assert.deepEqual(result, { config: {}, warning: null });
  const gemini = new GeminiClient({ config: result.config.gemini });
  assert.equal(await gemini.check(), "unconfigured");
  await gemini.shutdown();
});

test("valid machine configuration preserves all local and Gemini settings", (t) => {
  const { directory, file } = fixture(t);
  const config = {
    studioSshTarget: "example-studio",
    uvPath: "/example/bin/uv",
    seedQwen: "/example/models/qwen",
    gemini: {
      projectId: "example-project",
      billingAccountId: "ABCDEF-123456-ABCDEF",
      account: "reader@example.com",
      gcloudPath: "/example/bin/gcloud",
    },
  };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(loadMachineConfig(directory), { config, warning: null });
});

test("malformed and nonobject machine settings return only defaults and a generic warning", async (t) => {
  const { directory, file } = fixture(t);
  for (const input of [
    '{"private-project-marker":',
    "",
    "null",
    "[]",
    "42",
    "true",
    '"private-account-marker@example.com"',
  ]) {
    fs.writeFileSync(file, input, { mode: 0o600 });
    const result = loadMachineConfig(directory);
    assert.deepEqual(result, { config: {}, warning: WARNING });
    assert.equal(fs.readFileSync(file, "utf8"), input);
    const gemini = new GeminiClient({ config: result.config.gemini });
    assert.equal(await gemini.check(), "unconfigured");
    await gemini.shutdown();
  }
});

test("machine settings allow the byte boundary and reject oversized files", (t) => {
  const { directory, file } = fixture(t);
  const content = '{"studioSshTarget":"example-studio"}';
  fs.writeFileSync(file, content.padEnd(MAX_BYTES, " "));
  assert.deepEqual(loadMachineConfig(directory), {
    config: { studioSshTarget: "example-studio" },
    warning: null,
  });
  fs.appendFileSync(file, " ");
  assert.deepEqual(loadMachineConfig(directory), { config: {}, warning: WARNING });
  // A file that grows after its size check is still bounded and rejected.
  assert.deepEqual(
    loadMachineConfig(directory, {
      ...fs,
      fstatSync: () => ({ isFile: () => true, size: content.length }),
    }),
    { config: {}, warning: WARNING }
  );
});

test("unreadable or nonfile machine configuration cannot expose filesystem diagnostics", (t) => {
  const { directory, file } = fixture(t);
  fs.mkdirSync(file);
  assert.deepEqual(loadMachineConfig(directory), { config: {}, warning: WARNING });
  assert.deepEqual(
    loadMachineConfig(directory, {
      ...fs,
      openSync: () => {
        throw Object.assign(new Error("private-path-marker and provider diagnostics"), {
          code: "EACCES",
        });
      },
    }),
    { config: {}, warning: WARNING }
  );
});
