const test = require("node:test");
const assert = require("node:assert/strict");
const { shortcutFromEvent } = require("../../local-ui/shortcut.ts");
const { normalizeSettings } = require("../../desktop/controller");
const key = (patch) => ({
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

test("renderer and main agree on function keys and macOS Option combinations", () => {
  const cases = [
    [key({ key: "F4", code: "F4" }), "F4"],
    [key({ key: "˚", code: "KeyK", altKey: true }), "Alt+K"],
    [key({ key: "¡", code: "Digit1", altKey: true }), "Alt+1"],
    [key({ key: " ", code: "Space", ctrlKey: true, altKey: true }), "Control+Alt+Space"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(shortcutFromEvent(input), expected);
    assert.equal(normalizeSettings({ hotkey: expected }).hotkey, expected);
  }
});

test("unsupported and unmodified letter shortcuts remain rejected", () => {
  for (const input of [
    key({ key: "a", code: "KeyA" }),
    key({ key: "F25", code: "F25" }),
    key({ key: "Enter", code: "Enter", altKey: true }),
  ]) {
    assert.equal(shortcutFromEvent(input), null);
  }
  for (const hotkey of ["A", "F25", "Alt+Enter"])
    assert.throws(() => normalizeSettings({ hotkey }));
});
