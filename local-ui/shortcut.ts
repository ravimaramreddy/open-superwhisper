type KeyInput = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export function shortcutFromEvent(event: KeyInput): string | null {
  const modifiers = [
    ...(event.metaKey ? ["Command"] : []),
    ...(event.ctrlKey ? ["Control"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
  ];
  // Option changes event.key to symbols on macOS; code preserves the key.
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code)
      ? event.code.slice(5)
      : event.code === "Space" || event.key === " "
        ? "Space"
        : event.key;
  const functionKey = /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key);
  if (!functionKey && (!modifiers.length || !/^(?:[A-Z0-9]|Space)$/.test(key))) return null;
  return [...modifiers, key].join("+");
}
