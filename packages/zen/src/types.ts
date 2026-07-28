// The shape Zen hands back, and the options that steer it.
//
// The result is deliberately not a bare string. A renderer needs to know which
// lines are quoted reply chain (so it can collapse them the way Gmail does),
// which images the mail wanted (so it can decide what to load), and where the
// links went (so it can warn on mismatched anchor text). All of that is known
// during conversion and unrecoverable afterwards — parsing it back out of
// markdown would be a second, worse converter.

import { Schema as S } from "effect";

import { BoilerplateRegion } from "./boilerplate.ts";

/** Why a region was judged to be quoted rather than authored.
 *
 *  Kept distinct rather than collapsed to a boolean because the renderer's
 *  summary line differs: a reply chain collapses to "…", a signature to the
 *  sender's name, and getting that wrong reads as a bug even when the region
 *  boundaries are right. */
export const QuoteKind = S.Literals([
  "gmail", // div.gmail_quote and friends
  "cite", // <blockquote type="cite">
  "outlook", // #divRplyFwdMsg, or the <hr> + "From:" header block
  "attribution", // a bare "On <date>, <person> wrote:" line
  "forward", // "---------- Forwarded message ----------"
  "signature", // "-- " sig delimiter, or "Sent from my iPhone"
]);
export type QuoteKind = typeof QuoteKind.Type;

/** A run of quoted lines, as a closed interval into `markdown.split("\n")`.
 *
 *  Line ranges rather than a nested tree: the markdown is the source of truth
 *  and stays byte-for-byte what a plain markdown renderer would accept, so a
 *  consumer that ignores `quotes` entirely still shows the whole mail. */
export const QuoteRegion = S.Struct({
  kind: QuoteKind,
  startLine: S.Number,
  endLine: S.Number,
  /** The "On Tuesday, Ada wrote:" line, when there was one to read. Renderers
   *  use it as the collapsed summary. */
  attribution: S.optional(S.String),
});
export type QuoteRegion = typeof QuoteRegion.Type;

/** Where an image's bytes have to come from. `inline` is a cid: reference to
 *  an attachment on the same message, `remote` needs the network (or a cache),
 *  `data` is already carrying its own payload. */
export const ImageKind = S.Literals(["inline", "remote", "data"]);
export type ImageKind = typeof ImageKind.Type;

export const ZenImage = S.Struct({
  src: S.String,
  alt: S.String,
  kind: ImageKind,
  line: S.Number,
  /** The size the sender declared, in the html — not the image's natural
   *  pixel dimensions. Markdown has no sizing syntax of its own, so without
   *  this a 40×40 logo and a full-width hero photo serialize identically and
   *  a renderer has no way to tell them apart. */
  width: S.optional(S.Number),
  height: S.optional(S.Number),
});
export type ZenImage = typeof ZenImage.Type;

export const ZenLink = S.Struct({
  href: S.String,
  text: S.String,
  line: S.Number,
});
export type ZenLink = typeof ZenLink.Type;

export const ZenResult = S.Struct({
  markdown: S.String,
  quotes: S.Array(QuoteRegion),
  /** Legal tails, unsubscribe footers and unfilled template blocks, as line
   *  ranges the renderer can fold. Same contract as `quotes`: nothing is
   *  removed from the markdown, so a consumer that ignores this still shows a
   *  complete message. */
  boilerplate: S.Array(BoilerplateRegion),
  images: S.Array(ZenImage),
  links: S.Array(ZenLink),
});
export type ZenResult = typeof ZenResult.Type;

export type ZenOptions = Readonly<{
  /** Find and mark quoted replies and signatures. Off gives you the whole mail
   *  as one authored region, which is what you want when converting a message
   *  you already know is a first send. */
  detectQuotes: boolean;
  /** Keep tables that look like data as GFM tables. Off flattens every table,
   *  which is the right call for a narrow phone column where even a real
   *  three-column table is unreadable. */
  keepDataTables: boolean;
  /** Anchor text longer than this is emitted as a bare paragraph followed by
   *  the link, rather than wrapping the whole thing in brackets. Newsletters
   *  routinely link entire paragraphs, and `[three sentences](url)` is worse
   *  to read than either half alone. */
  maxLinkTextLength: number;
  /** Images to keep before giving up on the mail being about its pictures.
   *  Matches the frontend's own ceiling (frontend/src/images.ts). */
  maxImages: number;
  /** Find the administrative tail — legal text, licences, unsubscribe — and
   *  the template blocks a sender forgot to fill in. Reported, never removed. */
  detectBoilerplate: boolean;
  /** Drop the furniture: notification badges, reaction glyphs, avatars, spacer
   *  strips. On by default because markdown has no sizes, so a 16px icon and a
   *  hero photo arrive the same width — see chrome.ts. Turn it off to convert
   *  a message exactly as sent. */
  dropChrome: boolean;
}>;

export const defaultOptions: ZenOptions = {
  detectQuotes: true,
  detectBoilerplate: true,
  keepDataTables: true,
  maxLinkTextLength: 120,
  maxImages: 60,
  dropChrome: true,
};

/** The html could not be parsed into a document at all. Rare enough to be
 *  interesting: every mail engine in the wild accepts broken markup, so this
 *  usually means the body wasn't html in the first place. */
export class ZenParseError extends S.TaggedErrorClass<ZenParseError>()(
  "ZenParseError",
  { message: S.String },
) {}
