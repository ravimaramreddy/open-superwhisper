const test = require("node:test");
const assert = require("node:assert/strict");
const { diffWords } = require("../../local-ui/diff.ts");

const reconstruct = (parts, omit) =>
  parts
    .filter((part) => part.kind !== omit)
    .map((part) => part.text)
    .join("");
const check = (before, after) => {
  const result = diffWords(before, after);
  assert.equal(reconstruct(result.parts, "add"), before);
  assert.equal(reconstruct(result.parts, "remove"), after);
  assert(
    result.parts.every(
      (part, index) => part.text && (!index || part.kind !== result.parts[index - 1].kind)
    )
  );
  return result;
};

test("word changes retain readable shared words, whitespace and exact copy sources", () => {
  const result = check("We was ready.\n", "We were ready.\n");
  assert.deepEqual(result.parts, [
    { kind: "same", text: "We " },
    { kind: "remove", text: "was" },
    { kind: "add", text: "were" },
    { kind: "same", text: " ready.\n" },
  ]);
  for (const pair of [
    ["", ""],
    ["", "hello"],
    ["hello", ""],
    ["same", "same"],
    ["<script>", "<script>alert(1)</script>"],
    ["a\t b\n", "a  b\r\n"],
  ])
    check(...pair);
});

test("Unicode and randomized edits reconstruct both source texts without loss", () => {
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const tokens = [
    "hello",
    " ",
    "  ",
    "\n",
    "café",
    "e\u0301",
    "你好",
    "👩🏽‍💻",
    "—",
    "15",
    "not",
    "<b>",
  ];
  const make = () =>
    Array.from(
      { length: Math.floor(random() * 30) },
      () => tokens[Math.floor(random() * tokens.length)]
    ).join("");
  for (let index = 0; index < 2000; index++) check(make(), make());
});

test("100k-character replacements use bounded comparison and preserve all text", () => {
  const result = check("a ".repeat(50_000), "b ".repeat(50_000));
  assert.equal(result.coarse, true);
  assert(result.parts.length <= 4);
  check("a".repeat(100_000), "a".repeat(99_999) + "b");
  check("prefix " + "a ".repeat(49_990) + " end", "prefix " + "b ".repeat(49_990) + " end");
  assert.equal(check("a".repeat(100_001), "b").coarse, true);
});
