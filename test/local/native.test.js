const test = require("node:test");
const assert = require("node:assert/strict");
const { createNative } = require("../../desktop/native");

function fixture(paste, delay = async () => {}) {
  let text = "previous clipboard";
  const clipboard = {
    availableFormats: () => ["text/plain"],
    readText: () => text,
    writeText: (value) => {
      text = value;
    },
    clear: () => {
      text = "";
    },
    write: (value) => {
      text = value.text || "";
    },
  };
  const bridge = paste ? { paste, accessibility: () => true } : null;
  return { native: createNative({ clipboard, bridge, delay }), clipboard };
}
const target = { pid: 123, bundleId: "com.example.editor" };

test("target change leaves text on clipboard without fallback or second paste", async () => {
  const calls = [];
  const { native, clipboard } = fixture((...args) => {
    calls.push(args);
    return { status: "target-changed" };
  });
  const outcome = await native.deliver({ text: "result", target });
  assert.equal(outcome.delivery, "clipboard-only");
  assert.equal(clipboard.readText(), "result");
  assert.deepEqual(calls, [[123, "com.example.editor"]]);
});

test("unexpected native exception is uncertain and never retried", async () => {
  let calls = 0;
  const { native, clipboard } = fixture(() => {
    calls++;
    throw new Error("failure after possible dispatch");
  });
  assert.equal((await native.deliver({ text: "result", target })).delivery, "uncertain");
  assert.equal(calls, 1);
  assert.equal(clipboard.readText(), "result");
});

test("successful dispatch restores clipboard, but preserves a user's newer copy", async () => {
  const first = fixture(() => ({ status: "dispatched" }));
  assert.equal((await first.native.deliver({ text: "result", target })).delivery, "dispatched");
  assert.equal(first.clipboard.readText(), "previous clipboard");
  let clipboard;
  const second = fixture(
    () => ({ status: "dispatched" }),
    async () => clipboard.writeText("new user copy")
  );
  clipboard = second.clipboard;
  await second.native.deliver({ text: "result", target });
  assert.equal(clipboard.readText(), "new user copy");
});

test("pre-cancelled request cannot mutate clipboard or send keystrokes", async () => {
  let calls = 0;
  const { native, clipboard } = fixture(() => {
    calls++;
    return {};
  });
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    (await native.deliver({ text: "result", target, signal: abort.signal })).delivery,
    "cancelled"
  );
  assert.equal(calls, 0);
  assert.equal(clipboard.readText(), "previous clipboard");
});

test("missing target or missing native component gives manual copy without keyboard fallback", async () => {
  const { native, clipboard } = fixture(null);
  const captured = await native.captureTarget();
  assert.equal(captured, null);
  const uncaptured = await native.deliver({ text: "result", target: captured });
  assert.equal(uncaptured.delivery, "clipboard-only");
  assert.match(uncaptured.warning, /component could not load/);
  const result = await native.deliver({ text: "result", target });
  assert.equal(result.delivery, "clipboard-only");
  assert.match(result.warning, /component could not load/);
  assert.equal(clipboard.readText(), "result");
  assert.equal(native.accessibility(), false);
});

test("queued cancellation prevents a second paste and preserves restored clipboard", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { native, clipboard } = fixture(
    () => {
      calls++;
      return { status: "dispatched" };
    },
    () => gate
  );
  const one = native.deliver({ text: "one", target });
  await new Promise((resolve) => setImmediate(resolve));
  const abort = new AbortController();
  const two = native.deliver({ text: "two", target, signal: abort.signal });
  abort.abort();
  assert.equal(calls, 1);
  release();
  await one;
  assert.equal((await two).delivery, "cancelled");
  assert.equal(calls, 1);
  assert.equal(clipboard.readText(), "previous clipboard");
});

test("permission denial and allocation failure preserve text without retries", async () => {
  for (const status of ["permission-required", "unavailable"]) {
    let calls = 0;
    const { native, clipboard } = fixture(() => {
      calls++;
      return { status };
    });
    assert.equal((await native.deliver({ text: "result", target })).delivery, "clipboard-only");
    assert.equal(calls, 1);
    assert.equal(clipboard.readText(), "result");
  }
});

test("readiness and target capture use the same in-process bridge as paste", async () => {
  let permitted = false;
  let result = target;
  const native = createNative({
    clipboard: {},
    bridge: {
      accessibility: () => permitted,
      captureTarget: () => result,
    },
  });
  assert.equal(native.accessibility(), false);
  permitted = true;
  assert.equal(native.accessibility(), true);
  assert.deepEqual(await native.captureTarget(), target);
  result = { pid: process.pid, bundleId: "self" };
  assert.equal(await native.captureTarget(), null);
  result = { pid: 0, bundleId: "invalid" };
  assert.equal(await native.captureTarget(), null);
  result = { pid: 123 };
  assert.equal(await native.captureTarget(), null);
});

test("text and HTML are restored together with atomic replacement semantics", async () => {
  const original = {
    text: "Original words",
    html: "<b>Original words</b>",
    rtf: "{\\rtf1 Original words}",
  };
  let data = { ...original };
  let writes = 0;
  const clipboard = {
    availableFormats: () => ["text/plain", "text/html", "text/rtf"],
    readText: () => data.text || "",
    readHTML: () => data.html || "",
    readRTF: () => data.rtf || "",
    writeText: (text) => {
      data = { text };
    },
    write: (value) => {
      writes++;
      data = { ...value };
    },
    clear: () => {
      data = {};
    },
    writeBuffer: () => {
      assert.fail("per-format writes destroy earlier formats");
    },
  };
  const native = createNative({
    clipboard,
    bridge: { paste: () => ({ status: "dispatched" }) },
    delay: async () => {},
  });
  assert.equal((await native.deliver({ text: "dictated", target })).delivery, "dispatched");
  assert.deepEqual(data, original);
  assert.equal(writes, 1);
});
