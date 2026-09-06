function loadBridge(binary) {
  try {
    return require(binary);
  } catch {
    // Recording and clipboard recovery remain available if the addon cannot load.
    return null;
  }
}

function createNative({ binary, clipboard, bridge = loadBridge(binary) }) {
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
    return {
      pid: result.pid,
      bundleId: result.bundleId,
      ...(typeof result.name === "string" &&
      result.name.length <= 160 &&
      ![...result.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
        ? { name: result.name }
        : {}),
    };
  }
  async function deliver({ text, target, signal }) {
    const operation = queue
      .catch(() => {})
      .then(async () => {
        if (signal?.aborted) return { delivery: "cancelled" };
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
          // Posted keys do not acknowledge consumption. Keep text available to slow targets
          // and for manual recovery; never overwrite a later user copy on a timer.
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
