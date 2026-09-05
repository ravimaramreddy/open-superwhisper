const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

test("quit cancels the renderer, waits for owned cleanup and drains work before exit", async () => {
  const events = [];
  let release;
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  let finished;
  const exited = new Promise((resolve) => {
    finished = resolve;
  });
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    setPath() {},
    getPath: () => "/unused",
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    quit: () => {
      assert.fail("must not re-enter cancellable quit");
    },
    exit: (code) => {
      assert.equal(code, 0);
      events.push("exit");
      finished();
    },
  });
  const electron = { app, globalShortcut: { unregisterAll: () => events.push("shortcuts") } };
  const desktop = path.resolve(__dirname, "../../desktop");
  const context = {
    require: (id) =>
      id === "electron"
        ? electron
        : id.startsWith("./")
          ? require(path.join(desktop, id))
          : require(id),
    __dirname: desktop,
    process,
    __test: {
      controller: {
        cancel: async () => {
          events.push("cancel");
        },
        drain: async () => {
          events.push("drain");
        },
      },
      inference: {
        shutdown: async () => {
          events.push("shutdown");
          await cleanup;
        },
      },
      window: {
        isDestroyed: () => false,
        webContents: { send: (_channel, value) => events.push("renderer:" + value) },
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(desktop, "main.js"), "utf8") +
      "\ncontroller=__test.controller; inference=__test.inference; window=__test.window; rendererReady=true;",
    context
  );
  app.emit("before-quit", { preventDefault: () => events.push("prevent") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["prevent", "renderer:cancel", "shortcuts", "cancel", "shutdown"]);
  release();
  await exited;
  assert.deepEqual(events.slice(-2), ["drain", "exit"]);
});
