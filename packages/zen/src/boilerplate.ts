// The part of the message nobody wrote to you.
//
// A marketing email is mostly not a message. Under the offer sits the card
// issuer's disclosure, the state money-transmitter licences, the MCC codes
// excluded from the promotion, the physical address, the unsubscribe link —
// and often a block of template placeholder text the sender forgot to fill in.
// One real Venmo mail in this mailbox is fifty lines long and says what it has
// to say in three of them.
//
// None of it is deleted. It's genuinely there, some of it is legally required
// to be, and a reader who wants the terms is entitled to find them — so this
// works exactly the way quote detection does: report line ranges and let the
// renderer fold them. What that buys is the difference between a message you
// read and a document you scroll past.
//
// The bar for calling something boilerplate is deliberately high, because the
// cost is asymmetric. Folding one paragraph of real content is a bug the reader
// notices immediately; leaving one paragraph of legalese unfolded is a bad
// afternoon for nobody.

import { Schema as S } from "effect";

export const BoilerplateKind = S.Literals([
  "footer", // the administrative tail: legal, licences, unsubscribe
  "placeholder", // lorem ipsum, "Headline goes here", unfilled merge tags
]);
export type BoilerplateKind = typeof BoilerplateKind.Type;

export const BoilerplateRegion = S.Struct({
  kind: BoilerplateKind,
  startLine: S.Number,
  endLine: S.Number,
});
export type BoilerplateRegion = typeof BoilerplateRegion.Type;

// Phrases that only ever appear in an administrative footer. Each is a thing a
// sender is obliged to say rather than a thing they wanted to say, which is
// what makes it safe to treat as the boundary.
//
// Three plausible-looking phrases are deliberately absent, because they are
// header idioms at least as often as footer ones. "View in browser" sits at the
// top of most newsletters — anchoring on it folded 160 of 167 lines of a Kalshi
// mail, six lines in, leaving the title and nothing else. "Add us to your
// address book" belongs to the same top band, and a "Privacy" link is common in
// a masthead nav. A real footer always says something else as well.
const FOOTER_MARKERS: ReadonlyArray<RegExp> = [
  /\bunsubscribe\b/i,
  /\bopt[-\s]?out\b/i,
  /manage (your )?(e-?mail )?preferences/i,
  /update your (e-?mail )?(preferences|profile)/i,
  /^this is an advertisement/i,
  /do(n'?t| not) reply to this (message|e-?mail)/i,
  /notification[-\s]only/i,
  /all rights reserved/i,
  /(©|\(c\))\s*\d{4}/,
  /you'?re receiving this|you are receiving this|received this (e-?mail|message) because/i,
  /^\\?\*?\s*terms (and|&) conditions\b/i,
  /\bNMLS\b|\bMember FDIC\b/,
];

const PLACEHOLDER_MARKERS: ReadonlyArray<RegExp> = [
  /lorem ipsum dolor/i,
  // "Main Headline goes here." — the shape every unfilled template block takes.
  /\b(headline|header|title|subtitle|copy|text|body|content|cta)\s+goes\s+here\b/i,
  // Merge tags the sending platform never substituted: Handlebars, Mailchimp,
  // Braze, Salesforce. A reader seeing one is looking at a mistake.
  /\{\{[^}]{1,60}\}\}|%%[^%]{1,60}%%|\*\|[^|]{1,60}\|\*|\[\[[^\]]{1,60}\]\]/,
];

const matches = (line: string, patterns: ReadonlyArray<RegExp>): boolean =>
  patterns.some((pattern) => pattern.test(line));

// A footer is only a footer if there was a message in front of it. Without
// that guard, a mail whose subject *is* your subscription — "here's how to
// manage your preferences" — folds away the thing it came to say, and so does
// any marketing mail that opens with "View in browser".
//
// This replaced a rule about being past the halfway mark, which sounded
// equivalent and wasn't: dropping four decorative images from the Venmo mail
// moved a line across the 50% boundary and the entire legal tail sprang back
// open. Counting what's above is stable under edits that don't change what the
// message says.
const MIN_PROSE_LINES_ABOVE = 3;

/** Long enough to be a sentence rather than a label or a link. */
const PROSE_MIN_CHARS = 25;

/** How far back the footer may reach from its anchor, over the logo-and-links
 *  band that usually sits just above the legal text. */
const MAX_BACKWARD_LINES = 15;

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;

/** The words a line actually shows. Images contribute nothing — their alt text
 *  isn't read aloud on the page — while a link contributes its label. Links are
 *  unwrapped repeatedly because a logo is `[![alt](src)](href)`: an image
 *  inside a link, which leaves a second layer behind after the first pass. */
const visibleText = (line: string): string => {
  let text = line.replace(IMAGE, " ");
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(LINK, " $1 ");
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`>#|~[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/** Nothing here but images and links — no prose of its own. */
const isLinkOnly = (line: string): boolean =>
  line
    .replace(IMAGE, " ")
    .replace(LINK, " ")
    .replace(/[\s*_`>#|~-]/g, "") === "";

/** A short label in a bar of links: "Help Center", "Contact us", "Privacy".
 *  Kept well under the length of a real call to action — "Get the Venmo Debit
 *  Card" is 24 characters, and folding that would be a bug. */
const FURNITURE_LABEL_MAX = 20;

const isBlank = (line: string | undefined): boolean =>
  line === undefined || line.trim() === "";

/** Lines the footer may absorb on its way backwards: the logo, a divider, the
 *  row of small print links — furniture that belongs to the footer but says
 *  nothing that would identify it as one on its own. */
const isFooterFurniture = (line: string): boolean => {
  if (isBlank(line)) return true;
  const text = visibleText(line);
  if (text.length < 3) return true;
  return isLinkOnly(line) && text.length <= FURNITURE_LABEL_MAX;
};

const contiguousRegions = (
  lines: ReadonlyArray<string>,
  hit: (line: string) => boolean,
  kind: BoilerplateKind,
): ReadonlyArray<BoilerplateRegion> => {
  const regions: Array<BoilerplateRegion> = [];
  let start: number | undefined;
  let end = 0;

  lines.forEach((line, index) => {
    if (hit(line)) {
      start = start ?? index;
      end = index;
      return;
    }
    // Blank lines and bare images sit between the parts of one unfinished
    // template block, so they don't close it — real words do.
    if (start !== undefined && !isFooterFurniture(line)) {
      regions.push({ kind, startLine: start, endLine: end });
      start = undefined;
    }
  });

  if (start !== undefined)
    regions.push({ kind, startLine: start, endLine: end });
  return regions;
};

/** Where the message stops and the small print starts. */
const footerRegion = (
  lines: ReadonlyArray<string>,
): BoilerplateRegion | undefined => {
  const lastLine = lines.length - 1;

  let prose = 0;
  let anchor = -1;
  for (const [index, line] of lines.entries()) {
    if (prose >= MIN_PROSE_LINES_ABOVE && matches(line, FOOTER_MARKERS)) {
      anchor = index;
      break;
    }
    if (visibleText(line).length >= PROSE_MIN_CHARS) prose += 1;
  }
  if (anchor === -1) return undefined;

  // Reach back over the logo-and-links band. The walk stops of its own accord
  // at the first line with something to say, so it can't eat into the message.
  let start = anchor;
  while (
    start - 1 >= 0 &&
    anchor - start < MAX_BACKWARD_LINES &&
    isFooterFurniture(lines[start - 1] ?? "")
  ) {
    start -= 1;
  }

  // Don't leave a stray blank line outside the fold.
  while (start < anchor && isBlank(lines[start])) start += 1;

  return { kind: "footer", startLine: start, endLine: lastLine };
};

export const detectBoilerplate = (
  lines: ReadonlyArray<string>,
): ReadonlyArray<BoilerplateRegion> => {
  if (lines.length === 0) return [];

  const footer = footerRegion(lines);
  const placeholders = contiguousRegions(
    lines,
    (line) => matches(line, PLACEHOLDER_MARKERS),
    "placeholder",
  ).filter(
    // A placeholder inside the footer is already folded; reporting it twice
    // would make the renderer draw a fold inside a fold.
    (region) => footer === undefined || region.endLine < footer.startLine,
  );

  return footer === undefined ? placeholders : [...placeholders, footer];
};
