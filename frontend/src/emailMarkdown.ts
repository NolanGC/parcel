// The one import site of the vendored converter (../../email-to-markdown).
//
// That package is written in Gleam and compiles to plain ESM; `dist/` is the
// committed browser build (`email-to-markdown/build.sh` regenerates it). It
// is the browser FFI variant, so the host's own DOMParser does the parsing
// and jsdom stays out of the bundle. DOMParser does not exist in a worker,
// which is why conversion runs on the main thread with the rest of the sync
// engine.
//
// The output is Markdown and must be rendered as Markdown — never inserted
// as HTML. `renderEmailMarkdownToHtml` (markdown.ts) is that renderer, and
// `prepareBody` (sanitizeBody.ts) still runs over what it produces.

import { convert_string } from "../../email-to-markdown/dist/email_to_markdown/email_to_markdown.mjs";

/**
 * Email HTML → Markdown.
 *
 * Total: never throws, whatever the message contains. An empty result means
 * nothing convertible was found, which callers read as "no markdown" and fall
 * back to the stored HTML rather than showing a blank message.
 */
export const emailHtmlToMarkdown = (html: string): string =>
  convert_string(html);
