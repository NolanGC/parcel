// Gmail's snippet, as something worth showing.
//
// Two problems, both in the data rather than the CSS. Senders pad preheader
// text with invisible characters — U+034F (combining grapheme joiner), zero
// width non-joiner, bidi marks — to push the preview out of the inbox row;
// one real message carried 108 of them. They have layout width, so
// `text-overflow: ellipsis` renders them as a blank gap before the "…".
// Gmail also returns the snippet HTML-escaped, so `we&#39;ve` reaches us
// literally.
//
// Applied where a stored row is decoded (decodeThreadRows), not in the view.
// It is pure over a field that never changes after the row is read, and the
// view runs on every message: at ~30 visible rows that was three regex passes
// per row per render, for a result identical every time. Decoding is also the
// one place both the list and the palette pass through, so they cannot drift.
//
// Written as escapes on purpose: these are literally invisible, so spelling
// them out is the only way the next reader can tell what is being stripped.
const INVISIBLE_PADDING = new RegExp(
  "[" +
    [
      "\\u00AD", // soft hyphen
      "\\u034F", // combining grapheme joiner — the common preheader padding
      "\\u200B-\\u200F", // zero-width space/non-joiner/joiner, LRM, RLM
      "\\u2028\\u2029", // line and paragraph separators
      "\\u202A-\\u202E", // bidi embedding and overrides
      "\\u2060", // word joiner
      "\\uFEFF", // zero-width no-break space (BOM)
    ].join("") +
    "]",
  "gu",
);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export const cleanSnippet = (snippet: string): string =>
  snippet
    .replace(INVISIBLE_PADDING, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number(entity.slice(1)));
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    })
    // After entity decoding, because &nbsp; becomes one of these.
    .replace(/\s+/g, " ")
    .trim();
