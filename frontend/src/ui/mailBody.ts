// The mail body: a shadow root holding a sanitized message (sanitizeBody.ts).
//
// Why an element rather than a view: a shadow root is imperative DOM, and the
// Model has no business holding one.
//
// Why a shadow root rather than the sandboxed iframe this replaces. Two
// reasons, and the second is the one that was actually costing something.
//
// CSS. Mail arrives with its own stylesheet, written for a whole document —
// `body { margin: 0 }`, `table { width: 100% }`, `a { color: … }`. Dropped
// into this document those rules restyle the app. Gmail solves it by
// rewriting the sender's stylesheet: every selector prefixed with the
// message's own generated class, every `class=` in the mail rewritten to
// match. A shadow root is that, as a browser primitive — nothing in here
// escapes, and nothing out there reaches in except inherited properties,
// which `:host` resets below.
//
// Height. An iframe has none of its own, so the old element had to measure
// one: collapse to zero, read `scrollHeight` across animation frames until
// two readings agreed or a 400ms budget ran out, reveal, then keep a
// `ResizeObserver` attached for images that arrived late. All of that existed
// to answer a question this element does not have to ask. A shadow host is
// laid out with the page, so its height is simply its content's, correct on
// the first frame and correct again when a late image lands.
//
// What is knowingly given up: `body { … }` and `html { … }` rules in the
// sender's stylesheet no longer match anything, because a shadow root has
// neither element. Gmail loses these too — prefixing turns `body` into
// `.m_123 body`, which matches nothing either — so mail is already written
// not to depend on them, and the alternative is parsing and rewriting
// untrusted css, which is the entire job the shadow root was adopted to
// avoid.

import { CustomElement } from "foldkit";
import { Schema as S } from "effect";

export const MAIL_BODY_TAG = "parcel-mail-body";

/**
 * Which of two things the message inside is, which is entirely a question of
 * whose colours are in it.
 *
 *   paper  The sender's own markup. Its colours are baked into the message and
 *          were written for white, so it gets white in both themes.
 *   app    Markdown we converted and rendered ourselves. The sender's
 *          stylesheet is gone, so nothing in it assumes a background and it
 *          can follow the theme like the rest of the window.
 */
export const MailSurface = S.Literals(["paper", "app"]);
export type MailSurface = typeof MailSurface.Type;

// NOTE: `:host` rules lose to rules in the outer document that target the
// host, which is exactly the division wanted here — the app keeps saying how
// big the box is and what colour it sits on (see the classes at the call
// site), while everything about the type inside it starts from scratch.
//
// `all: initial` is what stops the app's font, colour and line-height being
// inherited across the boundary; inheritance is the one thing a shadow root
// does not stop by itself. It also resets `display` to inline, so the
// declarations that follow it are not decoration — order is load-bearing.
//
// `contain: layout paint` is doing security work, not layout work. Layout
// containment makes the host a containing block for `position: fixed`
// descendants, so a message cannot pin an element over the app's own chrome —
// the one escape a shadow root does not close on its own, and the reason
// there is no css property allow-list here.
const HOST = `all:initial;display:block;contain:layout paint;`;
const TYPE = `font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:break-word`;

// Paper: the sender's message, on the white it was written for, in both
// themes.
// The padding is the card's own inset, which only this branch needs: the app
// branch sits inside the message card and inherits its padding, while paper is
// a card of its own drawn edge to edge.
const PAPER_STYLE =
  `<style>` +
  `:host{${HOST}padding:16px;${TYPE};color:#1f2937}` +
  `img{max-width:100%;height:auto}` +
  `</style>`;

// App: our own rendering of the sender's words, so it follows the theme.
//
// NOTE: `color-scheme:inherit` is what makes `light-dark()` work in here at
// all. `all:initial` above resets `color-scheme` to `normal`, which pins every
// `light-dark()` below to its light branch no matter what the app is doing —
// and the reset has to stay, because inheritance is the one thing a shadow
// root does not stop by itself. Restoring this single property re-links the
// two: the app sets `color-scheme` on `<html>` (styles.css `:root`, `.light`,
// `.dark`), so the pinned appearance AND the System default both arrive here
// with nothing to keep in sync.
//
// The colours are the token values from styles.css rather than `var(--…)`,
// since custom properties do not cross into a shadow root that has reset
// inheritance. They are the same two ladders: foreground, muted-foreground,
// and a border/surface pair.
const APP_STYLE =
  `<style>` +
  `:host{${HOST}color-scheme:inherit;${TYPE};` +
  `color:light-dark(#171717,#f5f5f5)}` +
  `img{max-width:100%;height:auto}` +
  `a{color:light-dark(#1d4ed8,#93c5fd)}` +
  `blockquote{margin:0 0 1em;padding:0 0 0 1em;` +
  `border-left:3px solid light-dark(#d4d4d8,#3f3f46);` +
  `color:light-dark(#737373,#a3a3a3)}` +
  `pre{margin:0 0 1em;padding:12px;border-radius:6px;overflow-x:auto;` +
  `background:light-dark(#f4f4f5,#1e1e1e)}` +
  `code{padding:2px 4px;border-radius:4px;font-size:90%;` +
  `background:light-dark(#f4f4f5,#1e1e1e)}` +
  `pre code{padding:0;background:none}` +
  `hr{border:0;border-top:1px solid light-dark(#e4e4e7,#3f3f46)}` +
  `th,td{border:1px solid light-dark(#e4e4e7,#3f3f46);padding:4px 8px}` +
  `table{border-collapse:collapse}` +
  `</style>`;

/** The stylesheet a given surface renders behind the message. Exported so it
 *  can be looked at without standing up a shadow root. */
export const mailBodyStyle = (surface: MailSurface): string =>
  surface === "app" ? APP_STYLE : PAPER_STYLE;

class MailBody extends HTMLElement {
  #root: ShadowRoot | undefined;
  #body = "";
  #surface: MailSurface = "paper";
  #pending = false;

  // Set by the runtime as DOM properties, and diffed — an unchanged body is
  // never reparsed, so reopening a thread costs nothing.
  set body(value: string) {
    if (value === this.#body) {
      return;
    }
    this.#body = value;
    this.#invalidate();
  }

  get body(): string {
    return this.#body;
  }

  set surface(value: MailSurface) {
    if (value === this.#surface) {
      return;
    }
    this.#surface = value;
    this.#invalidate();
  }

  get surface(): MailSurface {
    return this.#surface;
  }

  connectedCallback(): void {
    if (this.#root !== undefined) {
      return;
    }
    // NOTE: `open`. A closed root would hide the message from the app's own
    // devtools and tests without hiding it from anything hostile — the body
    // is already sanitized by the time it arrives, and a closed root is not a
    // security property.
    this.#root = this.attachShadow({ mode: "open" });
    this.#invalidate();
  }

  // NOTE: Coalesced, because the properties arrive one at a time. Rendering
  // per setter parses a message twice on every open — once on `body`, again on
  // `surface` — and that parse is the cost this whole path exists to keep
  // small. A microtask runs before the frame is painted, so nothing is
  // deferred visibly.
  #invalidate(): void {
    if (this.#pending || this.#root === undefined) {
      return;
    }
    this.#pending = true;
    queueMicrotask(() => {
      this.#pending = false;
      this.#render();
    });
  }

  #render(): void {
    if (this.#root !== undefined) {
      this.#root.innerHTML = mailBodyStyle(this.#surface) + this.#body;
    }
  }
}

// NOTE: Guarded twice. `customElements` is absent under bun, which imports
// this module tree for the landing-page prerender (see sql.ts for the same
// shape), and `get` keeps an HMR re-evaluation from redefining a live tag,
// which throws.
if (
  typeof customElements !== "undefined" &&
  customElements.get(MAIL_BODY_TAG) === undefined
) {
  customElements.define(MAIL_BODY_TAG, MailBody);
}

export const mailBodySpec = CustomElement.define({
  tag: MAIL_BODY_TAG,
  properties: { body: S.String, surface: MailSurface },
  events: {},
});
