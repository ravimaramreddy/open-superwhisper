const { applyVocabulary, literalSpans, phrasePattern } = require("./vocabulary");

const SMALL = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES = { hundred: 100, thousand: 1000, million: 1000000 };
const numberWords = new RegExp(
  `\\b(?:${Object.keys({ ...SMALL, ...SCALES }).join("|")})(?:[ -]+(?:and[ -]+)?(?:${Object.keys({ ...SMALL, ...SCALES }).join("|")}))*\\b`,
  "gi"
);

function normalizeNumbers(text) {
  return text
    .toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s+(hundred|thousand|million)\b/g, (_match, number, scale) =>
      String(Number(number) * SCALES[scale])
    )
    .replace(numberWords, (phrase) => {
      let total = 0,
        group = 0,
        previous = null;
      for (const word of phrase.split(/[ -]+/).filter((word) => word !== "and")) {
        if (Object.hasOwn(SMALL, word)) {
          const value = SMALL[word];
          // A spoken digit sequence is ambiguous; retain individual values.
          if (previous !== null && (previous < 20 || value >= 10))
            return phrase
              .split(/[ -]+/)
              .map((word) => SMALL[word] ?? word)
              .join(" ");
          group += value;
          previous = value;
        } else if (word === "hundred") {
          group = (group || 1) * 100;
          previous = null;
        } else {
          total += (group || 1) * SCALES[word];
          group = 0;
          previous = null;
        }
      }
      return String(total + group);
    })
    .replace(/\b(minus|negative)\s+(?=\d)/g, "-")
    .replace(
      /\b(\d+)\s+point\s+(\d+(?:\s+\d)*)\b/g,
      (_match, whole, decimal) => `${whole}.${decimal.replace(/\s/g, "")}`
    )
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "");
}

function numberTokens(text) {
  return normalizeNumbers(text.replace(/^\s*\d+[.)]\s+/gm, "")).match(/-?\d+(?:\.\d+)?/g) || [];
}
function counts(values) {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) || 0) + 1);
  return map;
}
function sameCounts(left, right) {
  const a = counts(left),
    b = counts(right);
  return a.size === b.size && [...a].every(([key, count]) => b.get(key) === count);
}
function negations(text) {
  return (
    text
      .toLowerCase()
      .replace(/’/g, "'")
      .replace(/\bno\s+(?:sorry|wait)\b/g, "")
      .replace(/\b(?:can't|cannot)\b/g, "can not")
      .replace(/\bwon't\b/g, "will not")
      .replace(/n't\b/g, " not")
      .match(/\b(?:not|never|without|neither|nor|no)\b/g) || []
  );
}

function resolveNumericCorrections(text) {
  return normalizeNumbers(text)
    .replace(
      /(?<!\w)-?\d+(?:\.\d+)?\s+([\p{L}]+)\s*,?\s*(?:no(?:\s+(?:sorry|wait))?|actually|i mean|make that|sorry)\s*,?\s*(-?\d+(?:\.\d+)?)\s+\1\b/gu,
      "$2 $1"
    )
    .replace(
      /(?<!\w)-?\d+(?:\.\d+)?\s*,?\s*(?:no(?:\s+(?:sorry|wait))?|actually|i mean|make that|sorry)\s*,?\s*(-?\d+(?:\.\d+)?)\b/g,
      "$1"
    );
}

function reviewEdit(original, edited, vocabulary = []) {
  const baseline = applyVocabulary(original, vocabulary);
  const candidate = applyVocabulary(edited, vocabulary);
  if (baseline === candidate) return { text: candidate };
  const reasons = [];
  const originalLiterals = literalSpans(baseline).map(({ text }) => text);
  const editedLiterals = literalSpans(candidate).map(({ text }) => text);
  if (!sameCounts(originalLiterals, editedLiterals))
    reasons.push("Quoted wording or technical text changed.");
  const comparable = resolveNumericCorrections(baseline);
  const a = numberTokens(comparable),
    b = numberTokens(candidate);
  if (!sameCounts(a, b)) {
    reasons.push("A number or amount may have changed.");
  }
  if (!sameCounts(negations(comparable), negations(candidate)))
    reasons.push("A negative or exclusion may have changed.");
  for (const { word } of vocabulary) {
    const pattern = phrasePattern([word]);
    if ([...baseline.matchAll(pattern)].length !== [...candidate.matchAll(pattern)].length) {
      reasons.push("A saved name or term may have changed.");
      break;
    }
  }
  if (reasons.length)
    return {
      text: original,
      candidateText: candidate,
      reviewReasons: reasons,
      warning: "Original kept: review the suggested edit before using it.",
    };
  return { text: candidate };
}

module.exports = { reviewEdit, normalizeNumbers };
