// Everything done to a received html body between the database and the DOM:
// sanitizing it, pointing its images at local blobs, and making its links
// behave. One parse serves all three. The element that renders the result is
// ui/mailBody.ts.
//
// Why sanitize at all, when the body used to go into a sandboxed iframe: it
// no longer does. The body is rendered in a shadow root in this document
// (ui/mailBody.ts), because a shadow root scopes the mail's own `<style>`
// without any of Gmail's selector-prefixing machinery, and because an element
// in this document has a height instead of needing to be measured for one.
//
// What that costs is stated plainly, because it is the whole risk of the
// design: the iframe held TWO independent defenses — a sandbox without
// `allow-scripts`, and a `default-src 'none'` content policy — and either one
// alone was enough. A shadow root is NOT a security boundary; scripts inside
// one run exactly as they would anywhere else on the page. So this module is
// now the only thing standing between a hostile message and script execution,
// with the document's own content policy as the sole backstop behind it. That
// is why the config below is a deny-list on top of a deny-list, and why
// sanitizeBody.test.ts is not optional.

import DOMPurify from "dompurify";

// Tags dropped beyond what DOMPurify already refuses.
//
// `base` is the one that must never survive. The iframe carried a
// `<base target="_blank">` of our own, so a mail's own `<base href>` was
// scoped to a document we controlled and threw away. In this document it
// would repoint every relative url on the page — the app's, not the mail's.
//
// The form controls are in DOMPurify's default allow-list and are not wanted
// here: a message cannot be interacted with, so a text input inside one is
// only ever a credential prompt wearing a sender's logo.
const FORBID_TAGS = [
  "base",
  // Harmless in a `<head>` and not in a shadow root, where there is no head
  // for it to be invisible in — it would simply render the sender's document
  // title as the first line of the message.
  "title",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "meta",
  "link",
  "iframe",
  "object",
  "embed",
];

// http(s) and mailto are the mail; blob is what the image rewrite below
// produces; cid is an inline attachment we failed to resolve, left alone so
// it renders as a broken image rather than vanishing. The trailing branches
// are DOMPurify's own spelling for "relative url, no scheme at all".
//
// NOTE: `data:` is deliberately absent and still works for images. DOMPurify
// permits data uris on img/audio/video/source regardless of this pattern, so
// leaving it out here bans `data:text/html` on an anchor without also banning
// the inline images that half of all mail is made of.
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|blob|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

const PURIFY_CONFIG = {
  FORBID_TAGS,
  ALLOWED_URI_REGEXP,
  // `style` is not in DOMPurify's default allow-list, and putting it back is
  // the single most consequential line here. cure53's own advice for
  // untrusted css is to forbid it, because a stylesheet in a normal page can
  // deface the page and read state out of it through attribute selectors.
  //
  // It is added back because this is mail, and mail without its stylesheet is
  // not a downgrade — it is a pile of unstyled table cells. What makes it
  // affordable is the shadow root it lands in (ui/mailBody.ts): the selectors
  // cannot reach the app, and there is nothing inside the root to read but
  // the message the sender wrote. The two things scoping does NOT cover are
  // handled explicitly — `@import` below, `position: fixed` by containment on
  // the host.
  ADD_TAGS: ["style"],
  // `target` is not in the default allow-list and every anchor is about to be
  // given one; `background` is the 1997 spelling of a background image and is
  // still how a great deal of mail paints a table cell.
  ADD_ATTR: ["target", "background"],
  ALLOW_DATA_ATTR: false,
  // NOTE: Required, and not for the reason the name suggests. Mail bodies are
  // whole documents, so the parser hoists `<style>` into a `<head>` — and
  // without this DOMPurify returns the body only and the sender's entire
  // stylesheet is silently dropped. It happens even for a fragment that
  // merely STARTS with a `<style>`, which is most newsletters. The head and
  // body wrappers this leaves behind are flattened away below.
  WHOLE_DOCUMENT: true,
};

// Attributes that name an image.
const URL_ATTRIBUTES = ["src", "background"];

// A url inside an inline `style`, which is where a background image lives in
// mail written this century.
const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

// Swap a url for its local blob, or leave it exactly as it was.
//
// NOTE: "leave it" is load-bearing rather than lazy. An image we never cached
// still loads from its origin, so a cold thread reads as the mail it is
// instead of a grid of broken icons. Which also means a lookup miss is a
// tolerable outcome, and that is what makes the entity-decoding mismatch with
// images.ts (which decodes `&amp;` only, where the html parser decodes
// everything) a cosmetic difference and not a bug.
const localize = (
  url: string,
  localUrls: ReadonlyMap<string, string>,
): string => localUrls.get(url) ?? url;

// Point every image at a local blob where we have one.
//
// NOTE: This is a DOM pass and its predecessor was `String.replaceAll` over
// the whole body. The difference is not tidiness. A url is a string that also
// appears in link text, in a `<pre>`, and in unrelated attributes, and a
// blind replaceAll rewrote all of them — visibly, in a message the sender
// wrote about urls. Matching an attribute VALUE can only ever hit an
// attribute.
//
// This runs once, on open. Its opposite number, `remoteImageUrls` in
// images.ts, runs over every body in the mailbox during sync and is a regex
// on purpose: `DOMParser` across ~22k documents is seconds of main thread.
// The two look like the same job and do not have the same budget — please
// don't "fix" that one to match this one.
const rewriteImages = (
  root: Element,
  localUrls: ReadonlyMap<string, string>,
): void => {
  for (const attribute of URL_ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[${attribute}]`)) {
      const url = element.getAttribute(attribute);
      if (url !== null) {
        element.setAttribute(attribute, localize(url, localUrls));
      }
    }
  }

  // Bounded to one attribute's value at a time, so this is a rewrite of a
  // css url and not of whatever else the document happens to contain.
  for (const element of root.querySelectorAll("[style]")) {
    const style = element.getAttribute("style");
    if (style === null || !style.includes("url(")) {
      continue;
    }
    element.setAttribute(
      "style",
      style.replaceAll(CSS_URL_PATTERN, (whole, quote: string, url: string) => {
        const local = localize(url, localUrls);
        return local === url ? whole : `url(${quote}${local}${quote})`;
      }),
    );
  }
};

// Every link opens a new tab, and cannot reach back through `window.opener`.
//
// NOTE: This replaces the `<base target="_blank">` the iframe document
// carried, and is not a nicety. Without it a link in a mail navigates the tab
// the app is running in, which discards unsaved compose state and reads as
// the app having crashed.
const hardenLinks = (root: Element): void => {
  for (const anchor of root.querySelectorAll("a")) {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  }
};

// The one thing a shadow root does not scope for free.
//
// A shadow root confines a mail's selectors, but `@import` is a fetch, not a
// selector: it would reach out to the sender's server the moment the message
// is opened, which is a read receipt with extra steps. `position: fixed` is
// the other classic escape and is handled where it belongs, by `contain` on
// the host element (ui/mailBody.ts) rather than by filtering css properties
// one at a time the way Gmail has to.
const IMPORT_PATTERN = /@import[^;]*;?/gi;

const stripImports = (root: Element): void => {
  for (const style of root.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    if (IMPORT_PATTERN.test(css)) {
      style.textContent = css.replaceAll(IMPORT_PATTERN, "");
    }
    IMPORT_PATTERN.lastIndex = 0;
  }
};

/** A received html body, ready to be assigned into a shadow root.
 *
 *  `localUrls` maps a url as it appears in the body — a `cid:` token for an
 *  inline attachment, or an http url we have cached bytes for — to the blob
 *  url standing in for it. */
export const prepareBody = (
  raw: string,
  localUrls: ReadonlyMap<string, string>,
): string => {
  // NOTE: `RETURN_DOM_FRAGMENT` here rather than in PURIFY_CONFIG. It is what
  // selects the overload that returns a fragment instead of a string, and a
  // property read out of a shared object has already widened to `boolean` by
  // the time the call sees it.
  const fragment = DOMPurify.sanitize(raw, {
    ...PURIFY_CONFIG,
    RETURN_DOM_FRAGMENT: true,
  });

  // A detached holder, because a fragment has no innerHTML of its own to
  // serialize. `WHOLE_DOCUMENT` hands back `<head>` and `<body>` elements;
  // they are unwrapped here rather than left for the parser to discard on
  // insertion, so what this returns is the same shape whatever it was given.
  //
  // NOTE: Drained rather than iterated. `childNodes` is live and appending a
  // node moves it, so walking the list while emptying it skips every second
  // child.
  const holder = document.createElement("div");
  while (fragment.firstChild !== null) {
    const node = fragment.firstChild;
    const isWrapper =
      node.nodeName === "HEAD" ||
      node.nodeName === "BODY" ||
      node.nodeName === "HTML";
    if (isWrapper) {
      holder.append(...node.childNodes);
      node.remove();
    } else {
      holder.append(node);
    }
  }

  rewriteImages(holder, localUrls);
  hardenLinks(holder);
  stripImports(holder);
  return holder.innerHTML;
};
