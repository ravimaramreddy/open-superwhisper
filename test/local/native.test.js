const test = require("node:test");
const assert = require("node:assert/strict");
const { createNative } = require("../../desktop/native");

function fixture(run, delay = async () => {}) {
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
  return { native: createNative({ binary: "/fixed/helper", clipboard, run, delay }), clipboard };
}
const target = { pid: 123, bundleId: "com.example.editor" };

test("target change leaves text on clipboard without fallback or second paste", async () => {
  const calls = [];
  const { native, clipboard } = fixture(async (_binary, args) => {
    calls.push(args);
    return { result: { status: "target-changed" } };
  });
  const outcome = await native.deliver({ text: "result", target });
  assert.equal(outcome.delivery, "clipboard-only");
  assert.equal(clipboard.readText(), "result");
  assert.deepEqual(calls, [["--paste", "123", "com.example.editor"]]);
});

test("timeout is uncertain and never retried", async () => {
  let calls = 0;
  const { native } = fixture(async () => {
    calls++;
    return { error: { killed: true, code: null }, result: null };
  });
  assert.equal((await native.deliver({ text: "result", target })).delivery, "uncertain");
  assert.equal(calls, 1);
});

test("successful dispatch restores clipboard, but preserves a user's newer copy", async () => {
  const first = fixture(async () => ({ result: { status: "dispatched" } }));
  assert.equal((await first.native.deliver({ text: "result", target })).delivery, "dispatched");
  assert.equal(first.clipboard.readText(), "previous clipboard");
  let clipboard;
  const second = fixture(
    async () => ({ result: { status: "dispatched" } }),
    async () => clipboard.writeText("new user copy")
  );
  clipboard = second.clipboard;
  await second.native.deliver({ text: "result", target });
  assert.equal(clipboard.readText(), "new user copy");
});

test("pre-cancelled request cannot mutate clipboard or send keystrokes", async () => {
  let calls = 0;
  const { native, clipboard } = fixture(async () => {
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

test("missing target or missing helper gives manual copy without keyboard fallback", async () => {
  let calls = 0;
  const { native } = fixture(async () => {
    calls++;
    return { error: { code: "ENOENT" } };
  });
  assert.equal((await native.deliver({ text: "result", target: null })).delivery, "clipboard-only");
  assert.equal(calls, 0);
  assert.equal((await native.deliver({ text: "result", target })).delivery, "clipboard-only");
  assert.equal(calls, 1);
});

test("clipboard operations are serialized through restoration", async () => {
  let release;
  let first = true;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const { native } = fixture(
    async () => {
      calls.push("paste");
      return { result: { status: "dispatched" } };
    },
    async () => {
      if (first) {
        first = false;
        await gate;
      }
    }
  );
  const one = native.deliver({ text: "one", target });
  await new Promise((resolve) => setImmediate(resolve));
  const two = native.deliver({ text: "two", target });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  await Promise.all([one, two]);
  assert.equal(calls.length, 2);
});

test("cancel during helper startup interrupts it and keeps uncertain delivery without retry", async () => {
  const abort = new AbortController();
  let calls = 0;
  const { native, clipboard } = fixture(
    (_binary, _args, signal) =>
      new Promise((resolve) => {
        calls++;
        assert.equal(signal, abort.signal);
        signal.addEventListener(
          "abort",
          () => resolve({ error: { name: "AbortError" }, result: null }),
          { once: true }
        );
      })
  );
  const pending = native.deliver({ text: "result", target, signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  assert.equal((await pending).delivery, "uncertain");
  assert.equal(clipboard.readText(), "result");
  assert.equal(calls, 1);
});

test("real helper subprocess receives abort instead of running until its timeout", async () => {
  const { runHelper } = require("../../desktop/native");
  const abort = new AbortController();
  const pending = runHelper(process.execPath, ["-e", "setInterval(() => {}, 1000)"], abort.signal);
  abort.abort();
  const { error, result } = await pending;
  assert.equal(error.name, "AbortError");
  assert.equal(result, null);
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
    binary: "/helper",
    clipboard,
    run: async () => ({ result: { status: "dispatched" } }),
    delay: async () => {},
  });
  assert.equal((await native.deliver({ text: "dictated", target })).delivery, "dispatched");
  assert.deepEqual(data, original);
  assert.equal(writes, 1);
});
