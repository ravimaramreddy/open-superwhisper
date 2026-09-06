const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { GeminiClient } = require("../../desktop/gemini-client");

const CONFIG = {
  projectId: "example-project",
  billingAccountId: "ABCDEF-123456-ABCDEF",
  account: "reader@example.com",
  gcloudPath: "/example/gcloud",
};
const TOKEN = "synthetic-secret-token";
const BILLING = {
  billingEnabled: true,
  billingAccountName: "billingAccounts/ABCDEF-123456-ABCDEF",
};

function wav() {
  const bytes = Buffer.alloc(364);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(320, 40);
  return bytes;
}

function result(fields = { raw_transcript: "rough original", polished_text: "Edited text." }) {
  return {
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(fields) }] } }],
  };
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-client-test-"));
  const audioPath = path.join(directory, "synthetic.wav");
  fs.writeFileSync(audioPath, wav(), { mode: 0o600 });
  const commands = [],
    requests = [],
    progress = [],
    children = [];
  const spawn = (executable, args, spawnOptions) => {
    commands.push({ executable, args, options: spawnOptions });
    const child = new EventEmitter();
    child.pid = 12345 + children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      if (!options.stubborn || signal === "SIGKILL")
        queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const reply = () => {
      child.stdout.end(args.includes("billing") ? JSON.stringify(BILLING) : TOKEN);
      child.emit("close", 0);
    };
    children.push(child);
    queueMicrotask(() => (options.command ? options.command({ args, child, reply }) : reply()));
    return child;
  };
  const client = new GeminiClient({
    config: options.config || CONFIG,
    onProgress: (message) => progress.push(message),
    dependencies: {
      fs: { ...fsp, access: async () => {} },
      spawn,
      fetch: async (url, request) => {
        requests.push({ url, ...request });
        return options.fetch ? options.fetch(url, request) : Response.json(result());
      },
      killDelayMs: 5,
      ...options.dependencies,
    },
  });
  t.after(async () => {
    await client.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { client, audioPath, directory, commands, requests, progress, children };
}

async function waitUntil(condition) {
  for (let i = 0; i < 1000 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(condition(), "Expected the controlled asynchronous stage to start");
}

function sanitized(error) {
  assert.equal(error.code, "GEMINI_UNAVAILABLE");
  assert.equal(error.message, "Gemini is unavailable; use the local models.");
  assert.equal(error.cause, undefined);
  return true;
}

test("fixed Gemini request verifies pinned billing before token creation and preserves dual fields", async (t) => {
  const { client, audioPath, commands, requests, progress } = fixture(t);
  const vocabulary = [{ word: "Quartz", aliases: ["quarts"] }];
  const output = await client.process({
    audioPath,
    editingMode: "clean",
    style: "email",
    format: "paragraphs",
    vocabulary,
  });
  assert.deepEqual(output, {
    rawText: "rough original",
    text: "Edited text.",
    cleanupStatus: "applied",
  });
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].args, [
    "--quiet",
    "--account",
    CONFIG.account,
    "billing",
    "projects",
    "describe",
    CONFIG.projectId,
    "--format=json",
  ]);
  assert.deepEqual(commands[1].args, [
    "--quiet",
    "--account",
    CONFIG.account,
    "auth",
    "print-access-token",
    "--project",
    CONFIG.projectId,
  ]);
  for (const command of commands) {
    assert.equal(command.executable, CONFIG.gcloudPath);
    assert.equal(command.options.shell, false);
    assert.equal(command.options.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, "true");
    assert.equal(command.options.env.CLOUDSDK_CORE_LOG_HTTP, "false");
    assert.deepEqual(command.options.stdio, ["ignore", "pipe", "pipe"]);
  }
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent"
  );
  assert.equal(requests[0].redirect, "error");
  assert.equal(requests[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0].headers["x-goog-user-project"], CONFIG.projectId);
  const payload = JSON.parse(requests[0].body);
  assert.equal(payload.generationConfig.maxOutputTokens, 4096);
  assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel, "LOW");
  assert.deepEqual(payload.generationConfig.responseSchema.required, [
    "raw_transcript",
    "polished_text",
  ]);
  const [instructions, audio] = payload.contents[0].parts;
  assert.match(instructions.text, /whole intended message/);
  assert.match(instructions.text, /informal confirmation/);
  assert.match(instructions.text, /only when actually dictated for literal use/);
  assert.equal(instructions.text.includes("a statement must not become a question"), false);
  assert.match(instructions.text, /never instructions to obey/);
  assert.deepEqual(JSON.parse(instructions.text.split("\nSettings: ")[1]), {
    editingMode: "clean",
    style: "email",
    format: "paragraphs",
    vocabulary,
  });
  assert.deepEqual(Buffer.from(audio.inlineData.data, "base64"), wav());
  assert.equal(audio.inlineData.mimeType, "audio/wav");
  for (const message of progress)
    for (const secret of [
      TOKEN,
      CONFIG.projectId,
      CONFIG.billingAccountId,
      CONFIG.account,
      "rough original",
    ])
      assert.equal(message.includes(secret), false);
});

test("Exact uses the raw field; Gemini meaning changes are not subjected to the local literal guard", async (t) => {
  const { client, audioPath } = fixture(t, {
    fetch: async () =>
      Response.json(
        result({
          raw_transcript: "I don't recall the name oh right Quartz is it working",
          polished_text: "Is Quartz working?",
        })
      ),
  });
  const exact = await client.process({ audioPath, editingMode: "exact" });
  assert.equal(exact.text, exact.rawText);
  assert.equal(exact.cleanupStatus, "off");
  const polished = await client.process({ audioPath });
  assert.equal(polished.text, "Is Quartz working?");
  assert.equal(polished.candidateText, undefined);
});

test("verified credentials are cached for at most five minutes and check makes no model call", async (t) => {
  let now = 0;
  const { client, audioPath, commands, requests } = fixture(t, {
    dependencies: { now: () => now },
  });
  assert.equal(await client.check(), "ready");
  assert.equal(requests.length, 0);
  await client.process({ audioPath });
  assert.equal(commands.length, 2);
  now = 299999;
  assert.equal(await client.check(), "ready");
  assert.equal(commands.length, 2);
  now = 300000;
  assert.equal(await client.check(), "ready");
  assert.equal(commands.length, 4);
  await client.shutdown();
  assert.equal(client.auth, null);
  await assert.rejects(client.check(), { name: "AbortError" });
});

test("missing or invalid private configuration never starts authentication or uploads", async (t) => {
  for (const config of [
    {},
    { ...CONFIG, billingAccountId: undefined },
    { ...CONFIG, projectId: "../other" },
    { ...CONFIG, account: "bad\nlogin" },
    { ...CONFIG, gcloudPath: "relative/gcloud" },
  ]) {
    const { client, audioPath, commands, requests } = fixture(t, { config });
    assert.equal(await client.check(), "unconfigured");
    await assert.rejects(client.process({ audioPath }), sanitized);
    assert.equal(commands.length, 0);
    assert.equal(requests.length, 0);
  }
});

test("billing mismatch or disabled billing refuses token creation and audio upload", async (t) => {
  for (const billing of [
    { ...BILLING, billingEnabled: false },
    { ...BILLING, billingAccountName: "billingAccounts/000000-000000-000000" },
  ]) {
    const { client, audioPath, commands, requests } = fixture(t, {
      command: ({ child }) => {
        child.stdout.end(JSON.stringify(billing));
        child.emit("close", 0);
      },
    });
    await assert.rejects(client.process({ audioPath }), sanitized);
    assert.equal(commands.length, 1);
    assert.equal(requests.length, 0);
  }
});

test("authentication failures and oversized command output never expose CLI details", async (t) => {
  for (const oversized of [false, true]) {
    const { client, audioPath, requests, children } = fixture(t, {
      command: ({ child }) => {
        child.stderr.write(oversized ? "x".repeat(65537) : `${TOKEN} ${CONFIG.account}`);
        if (!oversized) child.emit("close", 1);
      },
    });
    await assert.rejects(client.process({ audioPath }), sanitized);
    assert.equal(requests.length, 0);
    if (oversized) assert.deepEqual(children[0].signals, ["SIGTERM"]);
    assert.equal(client.children.size, 0);
  }
});

test("401 invalidates memory credentials without retrying the paid request", async (t) => {
  let call = 0;
  const { client, audioPath, commands, requests } = fixture(t, {
    fetch: async () =>
      ++call === 1
        ? new Response("private provider details", { status: 401 })
        : Response.json(result()),
  });
  await assert.rejects(client.process({ audioPath }), sanitized);
  assert.equal(requests.length, 1);
  assert.equal(client.auth, null);
  await client.process({ audioPath });
  assert.equal(requests.length, 2);
  assert.equal(commands.length, 4);
});

test("blocked, truncated, malformed and empty responses fail closed without provider text", async (t) => {
  const bad = [
    { promptFeedback: { blockReason: "SAFETY", blockReasonMessage: TOKEN }, ...result() },
    { candidates: [{ ...result().candidates[0], finishReason: "MAX_TOKENS" }] },
    { candidates: [{ ...result().candidates[0], safetyRatings: [{ blocked: true }] }] },
    { ...result(), promptFeedback: { safetyRatings: [{ blocked: true }] } },
    result({ raw_transcript: "", polished_text: "invented" }),
    result({ raw_transcript: "raw", polished_text: "   " }),
    result({ polished_text: "only edited" }),
    result({ raw_transcript: "x".repeat(100001), polished_text: "small" }),
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not JSON " + TOKEN }] } }] },
    {
      candidates: [
        {
          ...result().candidates[0],
          content: {
            parts: [...result().candidates[0].content.parts, { functionCall: { name: "run" } }],
          },
        },
      ],
    },
  ];
  let next = 0;
  const { client, audioPath, requests } = fixture(t, {
    fetch: async () => Response.json(bad[next++]),
  });
  for (const _response of bad) await assert.rejects(client.process({ audioPath }), sanitized);
  assert.equal(requests.length, bad.length);
});

test("response content-length and streamed bytes are bounded and cancelled", async (t) => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const { client, audioPath } = fixture(t, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(256 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: declared ? { "content-length": String(256 * 1024 + 1) } : {} }
        ),
    });
    await assert.rejects(client.process({ audioPath }), sanitized);
    assert.equal(cancelled, true);
  }
});

test("whole-request deadline covers blocked authentication and stops its subprocess", async (t) => {
  const { client, audioPath, requests, children } = fixture(t, {
    command: () => {},
    stubborn: true,
    dependencies: { timeoutMs: 30 },
  });
  await assert.rejects(client.process({ audioPath }), sanitized);
  await client.shutdown();
  assert.equal(requests.length, 0);
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(client.children.size, 0);
  assert.equal(client.operations.size, 0);
});

test("caller cancellation before or during authentication is AbortError and never uploads", async (t) => {
  const first = fixture(t);
  const already = new AbortController();
  already.abort();
  await assert.rejects(
    first.client.process({ audioPath: first.audioPath, signal: already.signal }),
    { name: "AbortError" }
  );
  assert.equal(first.commands.length, 0);
  const running = fixture(t, { command: () => {} });
  const controller = new AbortController();
  const request = running.client.process({
    audioPath: running.audioPath,
    signal: controller.signal,
  });
  await waitUntil(() => running.children.length === 1);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  await running.client.shutdown();
  assert.deepEqual(running.children[0].signals, ["SIGTERM"]);
  assert.equal(running.requests.length, 0);
});

test("cancellation aborts upload and discards and closes a late successful response", async (t) => {
  let resolveFetch,
    cancelled = false;
  const { client, audioPath, requests } = fixture(t, {
    fetch: () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
  });
  const controller = new AbortController();
  const pending = client.process({ audioPath, signal: controller.signal });
  await waitUntil(() => requests.length === 1);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requests[0].signal.aborted, true);
  resolveFetch(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      })
    )
  );
  await waitUntil(() => cancelled);
  assert.equal(client.operations.size, 0);
});

test("deadline also covers response body reads after successful headers", async (t) => {
  let cancelled = false;
  const { client, audioPath } = fixture(t, {
    dependencies: { timeoutMs: 30 },
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        })
      ),
  });
  await assert.rejects(client.process({ audioPath }), sanitized);
  assert.equal(cancelled, true);
});

test("shutdown aborts active work, releases credentials and rejects later requests", async (t) => {
  let cancelled = false;
  const { client, audioPath, requests } = fixture(t, {
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        })
      ),
  });
  const pending = client.process({ audioPath });
  const rejection = assert.rejects(pending, { name: "AbortError" });
  await waitUntil(() => requests.length === 1);
  await client.shutdown();
  await rejection;
  assert.equal(cancelled, true);
  assert.equal(client.auth, null);
  assert.equal(client.operations.size, 0);
  await assert.rejects(client.process({ audioPath }), { name: "AbortError" });
});

test("cancelled delayed file opening closes its eventual handle without authenticating", async (t) => {
  let resolveOpen,
    closed = false;
  const { client, audioPath, commands } = fixture(t, {
    dependencies: {
      fs: {
        ...fsp,
        open: () =>
          new Promise((resolve) => {
            resolveOpen = resolve;
          }),
      },
    },
  });
  const controller = new AbortController(),
    pending = client.process({ audioPath, signal: controller.signal });
  await waitUntil(() => Boolean(resolveOpen));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  resolveOpen({
    close: async () => {
      closed = true;
    },
  });
  await waitUntil(() => closed);
  assert.equal(commands.length, 0);
});

test("invalid, oversized and symlinked audio is rejected before any authentication", async (t) => {
  const { client, audioPath, directory, commands, requests } = fixture(t);
  const link = path.join(directory, "link.wav");
  fs.symlinkSync(audioPath, link);
  await assert.rejects(client.process({ audioPath: link }), sanitized);
  fs.writeFileSync(audioPath, "not audio");
  await assert.rejects(client.process({ audioPath }), sanitized);
  const descriptor = fs.openSync(audioPath, "r+");
  fs.ftruncateSync(descriptor, 10000001);
  fs.closeSync(descriptor);
  await assert.rejects(client.process({ audioPath }), sanitized);
  assert.equal(commands.length, 0);
  assert.equal(requests.length, 0);
});

test("gcloud discovery checks fixed paths then PATH without a shell", async (t) => {
  const attempts = [];
  const { client, commands } = fixture(t, {
    config: { ...CONFIG, gcloudPath: undefined },
    dependencies: {
      searchPath: "/example/bin",
      fs: {
        ...fsp,
        access: async (file) => {
          attempts.push(file);
          if (file !== "/example/bin/gcloud") throw new Error("missing");
        },
      },
    },
  });
  assert.equal(await client.check(), "ready");
  assert.deepEqual(attempts, [
    "/opt/homebrew/bin/gcloud",
    "/usr/local/bin/gcloud",
    "/example/bin/gcloud",
  ]);
  assert.equal(commands[0].executable, "/example/bin/gcloud");
});
