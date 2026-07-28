// Telling the message apart from the furniture around it.
//
// This is a different question from the one preclean.ts answers. There, the
// test is "would a person ever see this" — hidden preheaders, tracking pixels,
// stylesheets. Here everything is genuinely visible, and the test is whether
// it's part of what the sender is *saying*. A notification badge, a reaction
// emoji, a 72px avatar next to a name that's already written out beside it: all
// visible, none of it content.
//
// It matters more in markdown than it does in html, because markdown has no
// sizes. On screen a 16px reaction icon occupies 16px. Converted naively it
// becomes a paragraph-level image, and a LinkedIn digest turns into a column of
// enormous disembodied thumbs-up icons with the actual writing scattered
// between them. The information that made it bearable — how big it was — is
// exactly the information markdown throws away, so the decision has to be made
// here or not at all.
//
// The good news is that senders declare it. Email clients don't reliably
// support css sizing, so images carry `width`/`height` attributes and inline
// `style` dimensions; the LinkedIn digest that motivated this file declares a
// size on all 22 of its images. That's a real measurement, not a guess.

import { attr, type DomElement } from "./dom.ts";

/** At or below this on either edge, it's an icon. Real icon sets are drawn at
 *  16, 24 and 32; nothing a message is *about* is 24 pixels tall. This also
 *  catches the horizontal rules and spacer gifs that email layouts are held
 *  together with. */
const ICON_EDGE_PX = 32;

/** At or below this on *both* edges, it's a badge, an avatar or a button
 *  glyph. Two edges are required because image-sliced newsletter layouts are
 *  full of wide, short strips — 600×40 — that really do carry the content.
 *  Something small in both directions next to text is decorating the text. */
const BADGE_BOX_PX = 100;

/** Drawn list markers — the numerals down the side of a features block — are
 *  bigger than an icon but still small, and they're only ever this: a number
 *  in a circle. */
const LIST_MARKER_MAX_PX = 64;

const dimensionFrom = (
  element: DomElement,
  name: "width" | "height",
): number | undefined => {
  const attribute = attr(element, name);
  if (attribute !== undefined) {
    const parsed = Number.parseInt(attribute, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  // `(?:^|;)` so that `max-width` and `min-height` don't read as a declared
  // size — they're constraints on a box whose real size is set elsewhere.
  const style = attr(element, "style");
  const match =
    style === undefined
      ? null
      : new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(\\d+)`, "i").exec(style);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

export const declaredSize = (
  element: DomElement,
): { width: number | undefined; height: number | undefined } => ({
  width: dimensionFrom(element, "width"),
  height: dimensionFrom(element, "height"),
});

// Alt text that describes the widget rather than the picture. Senders write
// these for screen readers, and they're the same admission: "Messaging icon",
// "LIKE", "Play video". Only a corroborator — an undeclared image with a
// generic alt stays, because the alt is all we'd have to go on.
const CHROME_ALT =
  /^(?:.*\bicons?|like|love|praise|empathy|insightful|funny|celebrate|support|play video|view image|logo)$/i;

const decodeUrl = (url: string): string =>
  url
    .replaceAll("&quot;", "")
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .trim();

const IMAGE_URL = /^(?:https?:|cid:|data:image\/)/i;

/** A picture delivered as a css background rather than an `<img>`.
 *
 *  Email uses this constantly for anything that has to be cropped — video
 *  thumbnails, hero banners, card art — because `background-size: cover` is the
 *  only cropping tool that works across clients. A converter that only reads
 *  `<img>` silently loses them: the LinkedIn digest that motivated this file
 *  carries all three of its video thumbnails this way, on empty `<td>`s.
 *
 *  Two independent signals are required, because the same property is also how
 *  page textures and gradients are applied. The element must declare a size
 *  that isn't icon-sized, and it must not be a repeating tile. */
export const backgroundImage = (element: DomElement): string | undefined => {
  const style = attr(element, "style");
  if (style === undefined || !/background-image\s*:/i.test(style)) {
    return undefined;
  }

  const match = /background-image\s*:\s*url\(\s*(?:&quot;|"|')?([^)"']+)/i.exec(
    style,
  );
  const url = match?.[1] === undefined ? undefined : decodeUrl(match[1]);
  if (url === undefined || !IMAGE_URL.test(url)) return undefined;

  if (/background-repeat\s*:\s*repeat/i.test(style)) return undefined;

  const { width, height } = declaredSize(element);
  // With no declared size there's nothing to tell a photograph from the
  // background colour of the page, and guessing wrong puts a body texture in
  // the middle of the message.
  if (width === undefined && height === undefined) return undefined;
  return isChromeImage(element) ? undefined : url;
};

/** Is this image furniture rather than content? */
export const isChromeImage = (element: DomElement): boolean => {
  const { width, height } = declaredSize(element);
  const edge = Math.min(width ?? Infinity, height ?? Infinity);
  if (edge <= ICON_EDGE_PX) return true;
  if (
    width !== undefined &&
    height !== undefined &&
    width <= BADGE_BOX_PX &&
    height <= BADGE_BOX_PX
  ) {
    return true;
  }
  // Undeclared images are kept: with no size to read, alt text alone is too
  // thin a reason to drop a picture that might be the whole message.
  if (width === undefined && height === undefined) return false;

  const alt = (attr(element, "alt") ?? "").trim();
  // A small picture whose alt text is a bare number is a drawn list marker —
  // the "1 2 3 4" down the side of a features block. It says what it is, and
  // what it is isn't a picture.
  const edgeMax = Math.max(width ?? 0, height ?? 0);
  if (/^\d{1,2}[.)]?$/.test(alt) && edgeMax <= LIST_MARKER_MAX_PX) return true;

  return CHROME_ALT.test(alt);
};
