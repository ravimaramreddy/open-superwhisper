function loadBridge(binary) {
  try {
    return require(binary);
  } catch {
    // Recording and clipboard recovery remain available if the addon cannot load.
    return null;
  }
}

function createNative({
  binary,
  clipboard,
  bridge = loadBridge(binary),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let queue = Promise.resolve();
  function accessibility() {
    try {
      return bridge?.accessibility() === true;
    } catch {
      return false;
    }
  }
  async function captureTarget() {
    let result;
    try {
      result = bridge?.captureTarget();
    } catch {
      return null;
    }
    if (!Number.isInteger(result?.pid) || result.pid <= 0 || result.pid === process.pid)
      return null;
    if (typeof result.bundleId !== "string") return null;
    return { pid: result.pid, bundleId: result.bundleId };
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
        if (!bridge)
          return {
            delivery: "clipboard-only",
            warning:
              "Text copied. The automatic paste component could not load. Reinstall the app.",
          };
        if (!target)
          return {
            delivery: "clipboard-only",
            warning: "Text copied. Choose a text field and paste it.",
          };
        if (signal?.aborted) return { delivery: "cancelled" };
        let result;
        try {
          // Runs in the permission-owning app process, with a final native target check.
          // The short synchronous call sends one complete key pair without retries.
          result = bridge.paste(target.pid, target.bundleId);
        } catch {
          // An exception could follow a dispatched key. Preserve text and never retry.
          result = null;
        }
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
          result?.status === "unavailable"
        ) {
          return {
            delivery: "clipboard-only",
            warning:
              result?.status === "permission-required"
                ? "Text copied. Enable Accessibility to paste automatically."
                : result?.status === "unavailable"
                  ? "Text copied. Automatic paste is unavailable; paste when ready."
                  : "Text copied. The original app is no longer focused; paste when ready.",
          };
        }
        // An unknown result can follow an emitted keystroke. Never automatically retry.
        return {
          delivery: "uncertain",
          warning:
            "Paste could not be confirmed. Text is on the clipboard; check the target before pasting again.",
        };
      });
    queue = operation.catch(() => {});
    return operation;
  }
  return { accessibility, captureTarget, deliver };
}

module.exports = { createNative };
