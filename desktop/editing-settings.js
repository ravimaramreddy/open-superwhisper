const MODES = new Set(["exact", "clean", "polished"]);
const STYLES = new Set(["neutral", "chat", "email"]);
const FORMATS = new Set(["prose", "paragraphs", "list"]);

function validApp(app) {
  return Boolean(
    app &&
    typeof app.bundleId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(app.bundleId) &&
    typeof app.name === "string" &&
    app.name.trim().length > 0 &&
    app.name.length <= 160 &&
    ![...app.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}

function normalizeAppRules(value) {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Use at most 32 app styles");
  const seen = new Set();
  return value.map((rule) => {
    if (
      !validApp(rule) ||
      !MODES.has(rule.editingMode) ||
      !STYLES.has(rule.style) ||
      !FORMATS.has(rule.format)
    )
      throw new Error("Invalid app style");
    if (seen.has(rule.bundleId)) throw new Error("Only one style can be saved for each app");
    seen.add(rule.bundleId);
    return {
      bundleId: rule.bundleId,
      name: rule.name.trim(),
      editingMode: rule.editingMode,
      style: rule.style,
      format: rule.format,
    };
  });
}

function effectiveSettings(settings, targetApp) {
  const rule = settings.appRules.find((entry) => entry.bundleId === targetApp?.bundleId);
  if (!rule) return structuredClone(settings);
  return {
    ...structuredClone(settings),
    editingMode: rule.editingMode,
    cleanup: rule.editingMode !== "exact",
    style: rule.style,
    format: rule.format,
  };
}

module.exports = { MODES, STYLES, FORMATS, validApp, normalizeAppRules, effectiveSettings };
