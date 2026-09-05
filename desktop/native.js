const { execFile } = require("node:child_process");

function runHelper(binary, args, signal) {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout: 2500, maxBuffer: 32 * 1024, windowsHide: true, signal },
      (error, stdout) => {
        let result;
        try {
          result = JSON.parse(stdout.trim());
        } catch {
          result = null;
        }
        resolve({ error, result });
      }
    );
  });
}

function createNative({
  binary,
  clipboard,
  run = runHelper,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let queue = Promise.resolve();
  async function captureTarget() {
    const { error, result } = await run(binary, ["--frontmost"]);
    if (error || !Number.isInteger(result?.pid) || result.pid <= 0 || result.pid === process.pid)
      return null;
    return {
      pid: result.pid,
      bundleId: typeof result.bundleId === "string" ? result.bundleId : "",
    };
  }
  function snapshotClipboard() {
    try {
      const formats = clipboard.availableFormats();
      // Electron's typed readers translate standard MIME names to macOS types.
      // Unsupported custom formats cannot be faithfully restored with this API.
      const supported = new Set([
        "text/plain",
        "text/html",
        "text/rtf",
        "image/png",
        "image/jpeg",
        "image/tiff",
      ]);
      if (formats.some((format) => !supported.has(format))) return null;
      const data = {};
      if (formats.includes("text/plain")) data.text = clipboard.readText();
      if (formats.includes("text/html")) data.html = clipboard.readHTML();
      if (formats.includes("text/rtf")) data.rtf = clipboard.readRTF();
      let bytes = Object.values(data).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
      if (formats.some((format) => format.startsWith("image/"))) {
        data.image = clipboard.readImage();
        if (data.image.isEmpty()) return null;
        bytes += data.image.toPNG().length;
      }
      if (bytes > 8 * 1024 * 1024) return null;
      return data;
    } catch {
      return null;
    }
  }
  async function deliver({ text, target, signal }) {
    const operation = queue
      .catch(() => {})
      .then(async () => {
        if (signal?.aborted) return { delivery: "cancelled" };
        const original = snapshotClipboard();
        clipboard.writeText(text);
        if (!target)
          return {
            delivery: "clipboard-only",
            warning: "Text copied. Choose a text field and paste it.",
          };
        if (signal?.aborted) return { delivery: "cancelled" };
        // The helper rechecks the frontmost PID immediately before dispatch.
        const { error, result } = await run(
          binary,
          ["--paste", String(target.pid), target.bundleId],
          signal
        );
        if (result?.status === "dispatched") {
          await delay(180);
          if (original && clipboard.readText() === text) {
            try {
              // A single write preserves all supported formats atomically.
              if (Object.keys(original).length) clipboard.write(original);
              else clipboard.clear();
            } catch {
              /* Delivery already occurred; restoration failure never triggers another paste. */
            }
          }
          return { delivery: "dispatched" };
        }
        if (
          result?.status === "target-changed" ||
          result?.status === "permission-required" ||
          error?.code === "ENOENT"
        ) {
          return {
            delivery: "clipboard-only",
            warning:
              result?.status === "permission-required"
                ? "Text copied. Enable Accessibility to paste automatically."
                : "Text copied. The original app is no longer focused; paste when ready.",
          };
        }
        // A timeout/error can follow an emitted keystroke. Never automatically retry.
        return {
          delivery: "uncertain",
          warning:
            "Paste could not be confirmed. Text is on the clipboard; check the target before pasting again.",
        };
      });
    queue = operation.catch(() => {});
    return operation;
  }
  return { captureTarget, deliver };
}

module.exports = { createNative, runHelper };
