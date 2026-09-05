const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeVocabulary,
  applyVocabulary,
  DEFAULT_VOCABULARY,
} = require("../../desktop/vocabulary");
const { reviewEdit } = require("../../desktop/edit-review");
const vocabulary = normalizeVocabulary([
  { word: "OpenSuperwhisper", aliases: ["open super whisper"] },
  { word: "Superwhisper", aliases: [] },
  { word: "Tailscale", aliases: ["tail scale"] },
]);

test("dictionary rejects collisions and invalid data without silently dropping entries", () => {
  for (const input of [
    null,
    {},
    [{ word: "hello", aliases: "hi" }],
    [{ word: "Superwhisper", aliases: ["superwhisper"] }],
    [
      { word: "first", aliases: ["second"] },
      { word: "SECOND", aliases: [] },
    ],
    [{ word: "bad\nword", aliases: [] }],
    [{ word: "x".repeat(81), aliases: [] }],
    Array.from({ length: 33 }, (_, i) => ({ word: `Word${i}`, aliases: [] })),
  ])
    assert.throws(() => normalizeVocabulary(input));
  assert.deepEqual(normalizeVocabulary([{ word: " Mac   Studio ", aliases: [] }]), [
    { word: "Mac Studio", aliases: [] },
  ]);
});

test("aliases match whole phrases once and preserve other canonical words", () => {
  assert.equal(
    applyVocabulary("open super whisper, Superwhisper and tail scale.", vocabulary),
    "OpenSuperwhisper, Superwhisper and Tailscale."
  );
  assert.equal(
    applyVocabulary("Superwhisperer and open super whispering", vocabulary),
    "Superwhisperer and open super whispering"
  );
  const overlapping = normalizeVocabulary([
    { word: "Studio", aliases: ["Mac"] },
    { word: "Mac Studio", aliases: [] },
  ]);
  assert.equal(applyVocabulary("Mac Studio and Mac", overlapping), "Mac Studio and Studio");
});

test("aliases preserve quotes, code, URLs, flags and paths", () => {
  const input =
    '"open super whisper" `tail scale` /tmp/Tailscale https://tail.scale/x --tail-scale and open super whisper';
  assert.equal(
    applyVocabulary(input, vocabulary),
    input.replace(/and open super whisper$/, "and OpenSuperwhisper")
  );
  assert.equal(
    applyVocabulary("“tail scale” and 'tail scale'", vocabulary),
    "“tail scale” and 'tail scale'"
  );
  for (const quoted of ["‘tail scale’", "'it's tail scale'", "‘it’s tail scale’"])
    assert.equal(applyVocabulary(quoted, vocabulary), quoted);
});

test("complete relative paths are protected from canonical casing and alias replacement", () => {
  for (const text of [
    "qwen/",
    "tailscale/",
    "qwen/models",
    "tailscale/config.json",
    "声/qwen",
    "./qwen/models",
    "~/qwen/models",
  ])
    assert.equal(applyVocabulary(text, DEFAULT_VOCABULARY), text);
  assert.equal(applyVocabulary("tail scale/config.json", vocabulary), "tail scale/config.json");
  assert.deepEqual(
    reviewEdit("open qwen/models folder", "Open qwen/models folder.", DEFAULT_VOCABULARY),
    { text: "Open qwen/models folder." }
  );
  const changed = reviewEdit(
    "open qwen/models folder",
    "Open Qwen/models folder.",
    DEFAULT_VOCABULARY
  );
  assert.equal(changed.text, "open qwen/models folder");
  assert.ok(changed.candidateText);
  assert.deepEqual(reviewEdit("open qwen/ folder", "Open qwen/ folder.", DEFAULT_VOCABULARY), {
    text: "Open qwen/ folder.",
  });
  assert.ok(
    reviewEdit("open qwen/ folder", "Open Qwen/ folder.", DEFAULT_VOCABULARY).candidateText
  );
});

test("meaning review permits grammar, numeric rendering and explicit numeric self-correction", () => {
  for (const [raw, output] of [
    ["i need twenty five copies", "I need 25 copies."],
    ["send fifteen no twenty copies", "Send 20 copies."],
    ["send two boxes, no, three boxes", "Send 3 boxes."],
    ["we need one point five liters", "We need 1.5 liters."],
    ["the cost is 5 million", "The cost is 5000000."],
    ["buy tea coffee and milk", "1. Tea\n2. Coffee\n3. Milk"],
    ["visit https://example.com", "Visit https://example.com."],
    ["use /tmp/report.json", "Use /tmp/report.json."],
    ["i can't deploy it", "I cannot deploy it."],
    ["use open super whisper with Superwhisper", "Use OpenSuperwhisper with Superwhisper."],
  ])
    assert.deepEqual(reviewEdit(raw, output, vocabulary), { text: output });
});

test("meaning review keeps original and reviewable candidate for changed facts/literals", () => {
  for (const [raw, output] of [
    ["send fifteen copies", "Send 50 copies."],
    ["pay minus five dollars", "Pay five dollars."],
    ["pay -5 dollars", "Pay five dollars."],
    ["do not deploy", "Deploy."],
    ["there are no errors", "There are errors."],
    ["use Superwhisper", "Use OpenSuperwhisper."],
    ["run `git status`", "Run `git push`."],
    ["visit https://example.com/a", "Visit https://example.com/b."],
    ['keep "exact wording"', 'Keep "different wording".'],
    ["sorry the team has 10 people and 20 tasks", "The team has 20 tasks."],
  ]) {
    const result = reviewEdit(raw, output, vocabulary);
    assert.equal(result.text, raw, raw);
    assert.equal(result.candidateText, output);
    assert.ok(result.reviewReasons.length);
  }
});
