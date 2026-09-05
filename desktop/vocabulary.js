const DEFAULT_VOCABULARY = Object.freeze(
  [
    "OpenSuperwhisper",
    "OpenWhispr",
    "Superwhisper",
    "Qwen",
    "Gemma",
    "Tailscale",
    "Codex",
    "Mac Studio",
  ].map((word) => Object.freeze({ word, aliases: Object.freeze([]) }))
);

function normalizeVocabulary(value) {
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("Keep your vocabulary to 32 words or phrases");
  const used = new Set();
  function term(value) {
    if (
      typeof value !== "string" ||
      value.length > 80 ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      throw new Error("Vocabulary terms must be single-line text, up to 80 characters");
    const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
    if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) throw new Error("Enter a word or phrase");
    const key = normalized.toLocaleLowerCase("en-US");
    if (used.has(key))
      throw new Error("A word or alias is already used by another vocabulary entry");
    used.add(key);
    return normalized;
  }
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !Array.isArray(entry.aliases) ||
      entry.aliases.length > 4
    )
      throw new Error("Each vocabulary word can have up to four aliases");
    return { word: term(entry.word), aliases: entry.aliases.map(term) };
  });
}

function escapePattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[ \\t]+");
}

function phrasePattern(terms) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${[...terms]
      .sort((a, b) => b.length - a.length)
      .map(escapePattern)
      .join("|")})(?![\\p{L}\\p{N}_])`,
    "giu"
  );
}

// Literal text and technical tokens are never targets of dictionary replacement.
const LITERALS =
  /```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)|"[^"\n]*(?:"|$)|“[^”\n]*(?:”|$)|‘[^\n]*?(?:’(?![\p{L}\p{N}])|$)|(?<![\p{L}\p{N}])'[^\n]*?(?:'(?![\p{L}\p{N}])|$)|(?:https?:\/\/|www\.|~\/|\.{1,2}\/|\/)[^\s<>"'`]+|(?<![\p{L}\p{N}_./~-])[\p{L}\p{N}_.~@+-]+(?:\/[^\s<>"'`]+)+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?<!\w)--?[a-z][\w-]*(?:=[^\s]+)?|\b[\w-]+(?:\.[\w-]+)+\b/giu;

function literalSpans(text) {
  return [...text.matchAll(LITERALS)]
    .filter((match) => !/^\d+(?:\.\d+)+$/.test(match[0]))
    .map((match) => {
      // Sentence punctuation is outside an unquoted URL/path. Quoted and code
      // spans stay exact, including any punctuation inside their delimiters.
      const literal = /^(?:https?:\/\/|www\.|~\/|\.{1,2}\/|\/|[^\s/]+\/)/i.test(match[0])
        ? match[0].replace(/[.,;:!?]+$/, "")
        : match[0];
      return { start: match.index, end: match.index + literal.length, text: literal };
    });
}

function applyVocabulary(text, vocabulary) {
  if (!vocabulary.length) return text;
  const protectedRanges = literalSpans(text);
  // Match canonical spellings too, so a shorter alias cannot rewrite part of one.
  const lookup = new Map(
    vocabulary.flatMap(({ word, aliases }) =>
      [word, ...aliases].map((value) => [value.toLocaleLowerCase("en-US"), word])
    )
  );
  const canonicalRanges = [...text.matchAll(phrasePattern(vocabulary.map(({ word }) => word)))].map(
    (match) => ({ start: match.index, end: match.index + match[0].length })
  );
  return text.replace(phrasePattern([...lookup.keys()]), (match, offset) => {
    const end = offset + match.length;
    if (protectedRanges.some((span) => offset < span.end && end > span.start)) return match;
    const key = match.toLocaleLowerCase("en-US").replace(/[ \t]+/g, " ");
    const word = lookup.get(key);
    const canonical = canonicalRanges.find((span) => offset < span.end && end > span.start);
    if (canonical && (offset !== canonical.start || end !== canonical.end)) return match;
    return word || match;
  });
}

module.exports = {
  DEFAULT_VOCABULARY,
  normalizeVocabulary,
  applyVocabulary,
  literalSpans,
  phrasePattern,
};
