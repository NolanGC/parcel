// What to throw away before the mail is worth reading.
//
// A marketing email is mostly not content. Half of it is a stylesheet, a
// chunk is Outlook-only markup fenced off in conditional comments, and near
// the top sits a preheader — the line that shows in the inbox preview, hidden
// in the body with `display:none` and padded out with invisible characters so
// the preview stops where the sender wants it to. None of that is text a
// person is meant to see, and all of it survives a naive html-to-markdown
// pass as garbage at the top of the message.
//
// Everything here is a predicate over an element. Dropping means the walker
// never descends into it (see convert.ts), so the caller's document is never
// mutated and there's no ordering hazard between cleaning and converting.

import { attr, type DomElement, tagOf } from "./dom.ts";

/** Elements that carry no readable content at all. `head` and its children
 *  are here because email html is frequently a fragment rather than a full
 *  document, and a stray `<title>` at the top of the body is not a heading. */
const DROPPED_TAGS: ReadonlySet<string> = new Set([
  "head",
  "iframe",
  "link",
  "map",
  "meta",
  "noscript",
  "object",
  "script",
  "style",
  "svg",
  "title",
]);

// Invisible characters senders pad preheaders with, so the inbox preview cuts
// off where they want it to. One real message in this mailbox carried 108 of
// them. Spelled as escapes because that is the only way the next reader can
// see what's being stripped. Kept in sync with frontend/src/snippet.ts.
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

export const stripInvisible = (text: string): string =>
  text.replace(INVISIBLE_PADDING, "");

// Ways of saying "don't paint this" that appear in real preheaders. Matched on
// the inline style attribute rather than computed style because there is no
// layout here to compute against — and because email css is inline by
// necessity anyway, since most clients strip <style>.
//
// Two plausible-looking signals are deliberately absent. `font-size:0` is the
// standard trick for killing the whitespace between inline-block cells, so
// it's on the *container* of most newsletter content — treating it as hidden
// empties the message. And `mso-hide:all` hides only in Outlook, which means
// it usually marks the copy every other client is meant to show.
const HIDDEN_STYLE_PATTERNS: ReadonlyArray<RegExp> = [
  /display\s*:\s*none/i,
  /visibility\s*:\s*hidden/i,
  /opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/i,
  // A zero or near-zero box that also hides its overflow. Both halves are
  // required: `max-height:0` alone shows up on collapsible layout wrappers
  // whose content is meant to be read.
  /max-height\s*:\s*0/i,
];

const isHiddenByStyle = (element: DomElement): boolean => {
  const style = attr(element, "style");
  if (style === undefined) return false;
  const hidden = HIDDEN_STYLE_PATTERNS.some((pattern) => pattern.test(style));
  if (!hidden) return false;
  // `overflow:hidden; max-height:0` on a wrapper is the preheader idiom, but
  // `max-height:0` on its own also appears on real content in clients that
  // animate it open. Only the unambiguous spellings drop without corroboration.
  return /max-height\s*:\s*0/i.test(style)
    ? /overflow\s*:\s*hidden/i.test(style) || /display\s*:\s*none/i.test(style)
    : true;
};

// `aria-hidden` is deliberately not consulted. It hides content from assistive
// technology while leaving it on screen, which is the opposite of what we're
// looking for — and senders reach for it on decorative wrappers. One real
// message in this mailbox puts `aria-hidden="true"` on the table containing the
// entire body; honouring it converted a 36 KB mail to nothing.
const isHiddenByAttribute = (element: DomElement): boolean =>
  element.getAttribute("hidden") !== null;

// Open-tracker endpoints: they record a read and hand back a redirect or a
// transparent 1x1. Ported from frontend/src/images.ts, where the same list
// keeps the background prefetch from turning "never opened" into a read
// receipt. Here the stakes are only cosmetic — a stray broken image in the
// markdown — so the list can stay just as narrow.
const TRACKER_PATTERNS: ReadonlyArray<RegExp> = [
  /\/wf\/open\b/i, // SendGrid, Sailthru
  /\/track(?:ing)?\/open/i, // Mailchimp and friends
  /\bopen\?upn=/i,
  /\/e\/o\//i, // Marketo
  /\/brand-views\b/i, // Glassdoor impression beacon
  /\/imp\?/i, // generic impression beacon
  /\bbeacon\b/i,
  /\/pixel[/?.]/i,
  /[?&]pixel=/i,
  /\bpixel\.(?:gif|png|jpe?g)\b/i,
];

const isTrackerUrl = (url: string): boolean =>
  TRACKER_PATTERNS.some((pattern) => pattern.test(url));

/** Anything declared this small is a spacer or a beacon, and neither is worth
 *  a line in the output. */
const TRACKING_DIMENSION_PX = 2;

const declaredDimension = (
  element: DomElement,
  name: "width" | "height",
): number | undefined => {
  const attribute = attr(element, name);
  if (attribute !== undefined) {
    const parsed = Number.parseInt(attribute, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const style = attr(element, "style");
  const match =
    style === undefined
      ? null
      : new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(\\d+)`, "i").exec(style);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const isTrackingImage = (element: DomElement): boolean => {
  const src = attr(element, "src");
  if (src !== undefined && isTrackerUrl(src)) return true;
  const width = declaredDimension(element, "width");
  const height = declaredDimension(element, "height");
  return (
    (width !== undefined && width <= TRACKING_DIMENSION_PX) ||
    (height !== undefined && height <= TRACKING_DIMENSION_PX)
  );
};

/** Should the walker skip this element and everything under it? */
export const shouldDrop = (element: DomElement): boolean => {
  const tag = tagOf(element);
  if (DROPPED_TAGS.has(tag)) return true;
  if (tag === "img" && isTrackingImage(element)) return true;
  return isHiddenByStyle(element) || isHiddenByAttribute(element);
};

// MSO conditional comments — `<!--[if mso]> … <![endif]-->` — hold a whole
// parallel rendering of the mail for Outlook. Parsers keep them as comment
// nodes, so the walker skips all comments and this never has to run. Exported
// anyway because the hillclimb's "before" pane wants to show what was dropped.
export const isConditionalComment = (text: string): boolean =>
  /\[if\s|\[endif\]|\bmso\b/i.test(text);

// The "bulletproof button" pattern wraps its real, non-Outlook markup in a
// *downlevel-revealed* conditional comment — `<!--[if !mso]><!-->…content…
// <!--<![endif]-->` — which real browsers treat as ordinary content (the
// tokenizer closes the opening comment at the embedded `-->` and everything
// up to the matching close is live html). happy-dom's html parser doesn't
// close the comment there: it reads straight through to the final `-->` and
// swallows the button — link, label and all — as one inert comment node. One
// real Google mail in this mailbox loses all three of its "Continue" buttons
// this way.
//
// Stripped as a raw-string pass before parsing, because by the time it's a
// comment node the content is already gone — there is no DOM to recover it
// from. Removing the two delimiter comments is a no-op for a spec-compliant
// parser (the content was already live), so this is safe to run unconditionally
// rather than only under happy-dom.
const DOWNLEVEL_OPEN = /<!--\[if\s+!mso\]>\s*<!-->/gi;
const DOWNLEVEL_CLOSE = /<!--\s*<!\[endif\]-->/gi;

export const revealDownlevelComments = (html: string): string =>
  html.replace(DOWNLEVEL_OPEN, "").replace(DOWNLEVEL_CLOSE, "");
