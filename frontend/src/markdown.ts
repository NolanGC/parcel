// Markdown → HTML, for both directions of mail.
//
// Outgoing: compose bodies are markdown. `renderMarkdownToEmailHtml` renders
// them to the HTML that goes out as the text/html alternative of a sent
// message (mime.ts), and to the compose panel's own preview — one function,
// so what you preview is the thing that is sent.
//
// Incoming: sync converts each message's HTML to markdown once and stores it
// (emailMarkdown.ts), and `renderEmailMarkdownToHtml` renders that on open.
//
// The two differ only in what they do with raw HTML in the source; see the
// `html` overrides below.
//
// NOTE: Email clients are not browsers. Stylesheets are commonly stripped,
// so the few styles that matter are inlined on the elements themselves, and
// the tag vocabulary stays to what has rendered everywhere for twenty years.

import { Marked, type Renderer } from "marked";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);

const QUOTE_STYLE =
  "margin:0 0 1em;padding:0 0 0 1em;border-left:3px solid #d1d5db;color:#4b5563";
const PRE_STYLE =
  "margin:0 0 1em;padding:12px;background:#f3f4f6;border-radius:6px;overflow-x:auto";
const CODE_STYLE =
  "padding:2px 4px;background:#f3f4f6;border-radius:4px;font-size:90%";
const BODY_STYLE =
  "font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937";

// NOTE: Instances rather than the module-level `marked`, whose `use` is
// global mutable state — two callers configuring it would silently fight.
const OPTIONS = {
  gfm: true,
  // A single newline is a line break. Mail is written like mail, not like a
  // document: nobody types the two trailing spaces CommonMark wants.
  breaks: true,
  async: false,
} as const;

const outgoing = new Marked({
  ...OPTIONS,
  renderer: {
    // NOTE: `function`, not an arrow: a blockquote renders its own children,
    // and the parser to do that with reaches the override as `this`.
    blockquote(this: Renderer, { tokens }) {
      return `<blockquote style="${QUOTE_STYLE}">${this.parser.parse(
        tokens,
      )}</blockquote>`;
    },
    code: ({ text }) =>
      `<pre style="${PRE_STYLE}"><code>${escapeHtml(text)}</code></pre>`,
    codespan: ({ text }) =>
      `<code style="${CODE_STYLE}">${escapeHtml(text)}</code>`,
    // Raw HTML in the source is rendered as the literal text it looks like,
    // never as markup. The body is composed locally, but it also reaches a
    // recipient's client verbatim, so passing tags through would make the
    // compose box an HTML injection surface pointed at other people's inboxes.
    html: ({ text }) => escapeHtml(text),
  },
});

// Bare tags, no inline styles, no wrapper — the opposite of outgoing, and for
// the opposite reason. This html never leaves the app: it goes into the mail
// body's shadow root (ui/mailBody.ts), whose stylesheet styles these tags by
// name and can therefore use `light-dark()` and follow the theme. An inlined
// colour here would win on specificity and pin every received message to light
// mode, which is exactly the bug this shape avoids.
const incoming = new Marked({
  ...OPTIONS,
  renderer: {
    // Passed through, unlike outgoing. The converter has no markdown syntax
    // for an image's width, so it emits `<img>` as HTML on purpose — escaping
    // it here would print every image in the mailbox as a visible tag.
    //
    // What makes that safe is not trust in the converter: its guard module
    // enforces that `<img>` and `<a>` are the only markup that can reach its
    // output, and `prepareBody` (sanitizeBody.ts) sanitizes what comes out of
    // here before anything is inserted into the document.
    html: ({ text }) => text,
  },
});

/** Markdown → the HTML alternative of an outgoing message. */
// NOTE: The cast is marked's type, not a shortcut: `parse` is declared
// `string | Promise<string>` because it can be configured either way, and
// `async: false` above is what settles it — at the type level it stays a
// union no matter what the options say.
export const renderMarkdownToEmailHtml = (markdown: string): string =>
  `<div style="${BODY_STYLE}">${outgoing.parse(markdown) as string}</div>`;

/** The markdown stored for a received message → the HTML shown on open.
 *
 *  Must be followed by `prepareBody`, which sanitizes the result and swaps
 *  cached image bytes in for their urls. */
export const renderEmailMarkdownToHtml = (markdown: string): string =>
  incoming.parse(markdown) as string;
