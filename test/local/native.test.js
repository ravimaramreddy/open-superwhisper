const test = require("node:test");
const assert = require("node:assert/strict");
const { createNative } = require("../../desktop/native");

function fixture(paste) {
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
  return { native: createNative({ clipboard, bridge }), clipboard };
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

test("dispatch leaves text for a delayed target and never overwrites a newer copy", async () => {
  const { native, clipboard } = fixture(() => ({ status: "dispatched" }));
  assert.equal((await native.deliver({ text: "result", target })).delivery, "dispatched");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    clipboard.readText(),
    "result",
    "a busy app consumes the dictation, not old clipboard data"
  );
  clipboard.writeText("new user copy");
  await new Promise((resolve) => setTimeout(resolve, 200));
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

test("queued cancellation prevents a second paste and retains first text", async () => {
  let calls = 0;
  const { native, clipboard } = fixture(() => {
    calls++;
    return { status: "dispatched" };
  });
  const one = native.deliver({ text: "one", target });
  const abort = new AbortController();
  const two = native.deliver({ text: "two", target, signal: abort.signal });
  abort.abort();
  await one;
  assert.equal((await two).delivery, "cancelled");
  assert.equal(calls, 1);
  assert.equal(clipboard.readText(), "one");
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

test("delivery never reads or snapshots unrelated clipboard content", async () => {
  let text;
  const clipboard = {
    availableFormats: () => assert.fail("must not inspect clipboard"),
    readText: () => assert.fail("must not read clipboard"),
    writeText: (value) => {
      text = value;
    },
  };
  const native = createNative({ clipboard, bridge: { paste: () => ({ status: "dispatched" }) } });
  await native.deliver({ text: "dictated", target });
  assert.equal(text, "dictated");
});
