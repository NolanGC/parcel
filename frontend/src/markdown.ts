// Compose bodies are markdown. This renders them to the HTML that goes out
// as the text/html alternative of a sent message (mime.ts), and to the
// compose panel's own preview — one function, so what you preview is the
// thing that is sent.
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

// NOTE: An instance rather than the module-level `marked`, whose `use` is
// global mutable state — two callers configuring it would silently fight.
const renderer = new Marked({
  gfm: true,
  // A single newline is a line break. Mail is written like mail, not like a
  // document: nobody types the two trailing spaces CommonMark wants.
  breaks: true,
  async: false,
  renderer: {
    // Raw HTML in the source is rendered as the literal text it looks like,
    // never as markup. The body is composed locally, but it also reaches a
    // recipient's client verbatim, so passing tags through would make the
    // compose box an HTML injection surface pointed at other people's inboxes.
    html: ({ text }) => escapeHtml(text),
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
  },
});

/** Markdown → the HTML alternative of an outgoing message. */
// NOTE: The cast is marked's type, not a shortcut: `parse` is declared
// `string | Promise<string>` because it can be configured either way, and
// `async: false` above is what settles it — at the type level it stays a
// union no matter what the options say.
export const renderMarkdownToEmailHtml = (markdown: string): string =>
  `<div style="${BODY_STYLE}">${renderer.parse(markdown) as string}</div>`;
