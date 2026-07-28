// Finding the part of the message that isn't the message.
//
// A reply carries its whole ancestry: the mail you're reading is three lines
// on top of four rounds of everything already said, plus two signatures and a
// mobile-client footer. Every mail client hides that behind a "…" and the
// reason is that showing it is close to useless — the new content is the whole
// point and it's a fifth of the bytes.
//
// Detection happens twice because the evidence arrives twice. Some clients
// mark quoted content structurally (`div.gmail_quote`, `blockquote type=cite`,
// Outlook's reply header div) and that's caught during the walk. The rest —
// senders whose client wrote a plain paragraph reading "On Tuesday, Ada
// wrote:" — is only visible once the text exists, so a second pass reads the
// serialized lines.
//
// Nothing here rewrites the markdown. Regions are reported as line ranges and
// the renderer decides whether to collapse them, so a consumer that ignores
// quotes entirely still shows a complete message.

import { attr, type DomElement, tagOf } from "./dom.ts";
import type { QuoteKind, QuoteRegion } from "./types.ts";

/** A quote signal found on an element, carried down to every block inside it. */
export type QuoteMark = Readonly<{
  kind: QuoteKind;
  attribution?: string;
}>;

const classList = (element: DomElement): ReadonlyArray<string> =>
  (attr(element, "class") ?? "").toLowerCase().split(/\s+/);

/** Structural quote markers, read during the walk.
 *
 *  Only the first mark on a path matters: a `gmail_quote` containing a
 *  `blockquote type=cite` containing another `gmail_quote` is one quoted
 *  region three clients deep, and the outermost signal is the true boundary. */
export const domQuoteMark = (element: DomElement): QuoteMark | undefined => {
  const tag = tagOf(element);
  const classes = classList(element);

  if (
    classes.includes("gmail_quote") ||
    classes.includes("gmail_quote_container")
  ) {
    return { kind: "gmail" };
  }
  if (tag === "blockquote" && attr(element, "type")?.toLowerCase() === "cite") {
    return { kind: "cite" };
  }

  const id = attr(element, "id")?.toLowerCase();
  // Outlook's own reply scaffolding. `divRplyFwdMsg` holds the "From:/Sent:"
  // header block; `appendonsend` is the empty marker Outlook inserts directly
  // above everything it is about to quote.
  if (id === "divrplyfwdmsg" || id === "appendonsend")
    return { kind: "outlook" };
  if (classes.includes("moz-cite-prefix")) return { kind: "cite" };
  if (classes.includes("yahoo_quoted") || classes.includes("ydp-quoted")) {
    return { kind: "cite" };
  }

  return undefined;
};

// "On <when>, <who> wrote:" — the near-universal attribution line, in the
// handful of spellings that show up in a real mailbox. Bounded in length so a
// paragraph that happens to begin with "On" and end in a colon doesn't swallow
// the rest of the mail.
const ATTRIBUTION_PATTERNS: ReadonlyArray<RegExp> = [
  /^On\b.{4,200}\bwrote\s*:\s*$/i,
  /^Le\b.{4,200}\ba écrit\s*:\s*$/i,
  /^Am\b.{4,200}\bschrieb\b.*:\s*$/i,
  /^El\b.{4,200}\bescribió\s*:\s*$/i,
  /^.{0,80}\bwrote\s*:\s*$/i,
];

const FORWARD_PATTERNS: ReadonlyArray<RegExp> = [
  /^-{2,}\s*Forwarded message\s*-{2,}$/i,
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^Begin forwarded message\s*:?\s*$/i,
];

// Outlook and several webmail clients quote with a header block rather than an
// attribution sentence: a rule, then From:/Sent:/To:/Subject: lines.
const OUTLOOK_HEADER = /^\*{0,2}(From|Sent|To|Subject|Date)\*{0,2}\s*:/i;

// RFC 3676's signature delimiter, plus the mobile-client footers that serve
// the same purpose without following the standard.
const SIGNATURE_PATTERNS: ReadonlyArray<RegExp> = [
  /^-{2}\s*$/,
  /^_{2,}\s*$/,
  /^Sent from my \w+/i,
  /^Get Outlook for (iOS|Android)\b/i,
];

/** Strip the markdown decoration a line may have picked up, so text patterns
 *  match whether or not the source wrapped the attribution in a blockquote or
 *  bolded it. */
const bare = (line: string): string =>
  line
    .replace(/^[>\s]+/, "")
    .replaceAll("**", "")
    .replaceAll("\\", "")
    .trim();

type Found = Readonly<{ kind: QuoteKind; line: number; attribution?: string }>;

/** Where quoting starts, judged from the serialized text alone. */
const textualStarts = (lines: ReadonlyArray<string>): ReadonlyArray<Found> => {
  const found: Array<Found> = [];
  lines.forEach((raw, index) => {
    const line = bare(raw);
    if (line === "") return;
    if (FORWARD_PATTERNS.some((pattern) => pattern.test(line))) {
      found.push({ kind: "forward", line: index });
      return;
    }
    if (ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(line))) {
      found.push({ kind: "attribution", line: index, attribution: line });
      return;
    }
    if (SIGNATURE_PATTERNS.some((pattern) => pattern.test(line))) {
      found.push({ kind: "signature", line: index });
      return;
    }
    // A run of Outlook header lines, which only counts as a quote boundary
    // when at least two of them agree — a single "Subject:" line is ordinary
    // prose in plenty of mail about mail.
    if (OUTLOOK_HEADER.test(line)) {
      const next = bare(lines[index + 1] ?? "");
      const after = bare(lines[index + 2] ?? "");
      if (OUTLOOK_HEADER.test(next) || OUTLOOK_HEADER.test(after)) {
        found.push({ kind: "outlook", line: index });
      }
    }
  });
  return found;
};

const overlapping = (a: QuoteRegion, b: QuoteRegion): boolean =>
  a.startLine <= b.endLine + 1 && b.startLine <= a.endLine + 1;

/** Merge overlapping and adjacent regions, keeping the outermost boundary and
 *  the first attribution — which is the one nearest the reader. */
const merge = (
  regions: ReadonlyArray<QuoteRegion>,
): ReadonlyArray<QuoteRegion> => {
  const sorted = [...regions].sort((a, b) => a.startLine - b.startLine);
  return sorted.reduce<Array<QuoteRegion>>((merged, region) => {
    const last = merged[merged.length - 1];
    if (last !== undefined && overlapping(last, region)) {
      merged[merged.length - 1] = {
        kind: last.kind,
        startLine: last.startLine,
        endLine: Math.max(last.endLine, region.endLine),
        ...(last.attribution === undefined
          ? region.attribution === undefined
            ? {}
            : { attribution: region.attribution }
          : { attribution: last.attribution }),
      };
      return merged;
    }
    merged.push(region);
    return merged;
  }, []);
};

/** Combine the structural regions found during the walk with the textual ones
 *  found here.
 *
 *  A textual marker quotes everything after it: no client writes "On Tuesday,
 *  Ada wrote:" and then returns to new content, and a signature delimiter
 *  means the same. That makes the region's end the end of the message, which
 *  is also why the first marker wins — later ones fall inside it and merge. */
export const detectQuoteRegions = (
  lines: ReadonlyArray<string>,
  structural: ReadonlyArray<QuoteRegion>,
): ReadonlyArray<QuoteRegion> => {
  const lastLine = Math.max(0, lines.length - 1);
  const insideStructural = (line: number): boolean =>
    structural.some(
      (region) => line >= region.startLine && line <= region.endLine,
    );

  const textual = textualStarts(lines)
    .filter((start) => !insideStructural(start.line))
    .slice(0, 1)
    .map(
      (start): QuoteRegion => ({
        kind: start.kind,
        startLine: start.line,
        endLine: lastLine,
        ...(start.attribution === undefined
          ? {}
          : { attribution: start.attribution }),
      }),
    );

  // Outlook's marker is a boundary, not a container: `divRplyFwdMsg` holds
  // only the From:/Sent:/To: header, and the message being replied to follows
  // it as siblings. Collapsing the header alone leaves the quoted mail sitting
  // in the open, which is the one thing the reader didn't ask for. Gmail's and
  // Thunderbird's markers really do wrap their content, so they keep the
  // bounds the walk found.
  const bounded = structural.map((region) =>
    region.kind === "outlook" ? { ...region, endLine: lastLine } : region,
  );

  return merge([...bounded, ...textual]).filter(
    (region) => region.endLine >= region.startLine,
  );
};
