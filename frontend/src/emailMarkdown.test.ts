// @vitest-environment jsdom
//
// NOTE: jsdom, against the project's happy-dom default, for the same reason
// as sanitizeBody.test.ts — the converter sanitizes with DOMPurify, which
// strips every element under happy-dom.
//
// Two things are under test here. The conversion itself is covered by the
// vendored package's own Gleam suite (`gleam test` in email-to-markdown), so
// these check the seam instead: that the browser build loads and runs at all
// under a host DOM, and that the whole open path — convert, render, prepare —
// preserves what the app depends on and drops what it must.

import { describe, expect, it } from "vitest";

import { emailHtmlToMarkdown } from "./emailMarkdown";
import { renderEmailMarkdownToHtml } from "./markdown";
import { prepareBody } from "./sanitizeBody";

const NO_URLS: ReadonlyMap<string, string> = new Map();

/** Everything loadThread does to a stored html body, in order. */
const open = (
  html: string,
  localUrls: ReadonlyMap<string, string> = NO_URLS,
): string =>
  prepareBody(renderEmailMarkdownToHtml(emailHtmlToMarkdown(html)), localUrls);

describe("conversion", () => {
  it("converts structure to markdown", () => {
    const markdown = emailHtmlToMarkdown(
      `<h1>Receipt</h1><p>Thanks for your <b>order</b>.</p>`,
    );
    expect(markdown).toContain("# Receipt");
    expect(markdown).toContain("**order**");
  });

  it("keeps links as markdown", () => {
    expect(emailHtmlToMarkdown(`<a href="https://x.test/a">track it</a>`)).toBe(
      "[track it](https://x.test/a)\n",
    );
  });

  // Total by contract — callers store the result without a try/catch, and a
  // throw here would fail the sync of an entire chunk of threads.
  it.each([
    ["empty", ""],
    ["not html", "just some words"],
    ["truncated tag", "<div><p>hello"],
    ["angle bracket soup", "<<<>&#x; >"],
    ["deeply nested", `${"<div>".repeat(5000)}deep${"</div>".repeat(5000)}`],
  ])("never throws on %s", (_name, html) => {
    expect(() => emailHtmlToMarkdown(html)).not.toThrow();
  });

  it("returns empty for input with nothing convertible", () => {
    expect(emailHtmlToMarkdown("")).toBe("");
  });
});

// An empty conversion is the ONLY thing that still makes a message open as the
// sender's own html (loadThread converts on the spot otherwise), so what lands
// in that bucket decides how often anyone sees the old rendering. These pin
// the two directions of that: mail with content always converts, and the cases
// that come back empty are ones with nothing to show anyway.
describe("what falls back to html", () => {
  it.each([
    ["a one-line reply", "<body><p>Sounds good, thanks!</p></body>"],
    [
      "an image-only message",
      `<body><img src="https://c.test/h.jpg" alt="Sale ends today" width="600"></body>`,
    ],
    [
      "a button-only message",
      `<body><a href="https://x.test/go" style="display:block">View order</a></body>`,
    ],
    [
      "a table-laid-out newsletter",
      `<body><table><tr><td><h1>Hello</h1><p>Body copy.</p></td></tr></table></body>`,
    ],
  ])("converts %s", (_name, html) => {
    expect(emailHtmlToMarkdown(html)).not.toBe("");
  });

  it.each([
    ["an empty body", "<html><body></body></html>"],
    [
      "a tracking pixel alone",
      `<body><img src="https://t.test/o.gif" width="1" height="1"></body>`,
    ],
    ["whitespace alone", "<body><p>&nbsp;</p></body>"],
    ["an empty layout table", "<body><table><tr><td></td></tr></table></body>"],
    [
      "a hidden preheader alone",
      `<body><div style="display:none">preheader</div></body>`,
    ],
  ])("has nothing to say about %s", (_name, html) => {
    expect(emailHtmlToMarkdown(html)).toBe("");
  });
});

describe("image urls survive to the rendered body", () => {
  // The whole reason the image cache still works: the markdown carries the
  // sender's original urls, so the same rewrite that ran against the html
  // finds them here.
  it("keeps remote urls, and localizes them when cached", () => {
    const html = `<img src="https://x.test/hero.png" alt="the hero" width="600">`;

    expect(open(html)).toContain(`src="https://x.test/hero.png"`);
    expect(
      open(html, new Map([["https://x.test/hero.png", "blob:local"]])),
    ).toContain(`src="blob:local"`);
  });

  // `cid:` is on the converter's scheme allowlist for this and nothing else —
  // dropping it would silently lose every inline image in mail sent with
  // attachments. See email-to-markdown/src/email_to_markdown/emit.gleam.
  it("keeps cid: references, and localizes them when cached", () => {
    const html = `<img src="cid:part1@mail" alt="the signature" width="400">`;

    expect(open(html)).toContain(`src="cid:part1@mail"`);
    expect(open(html, new Map([["cid:part1@mail", "blob:inline"]]))).toContain(
      `src="blob:inline"`,
    );
  });
});

describe("the open path stays safe", () => {
  it("drops javascript: hrefs", () => {
    const result = open(`<a href="javascript:alert(1)">click</a>`);
    expect(result).not.toContain("javascript:");
    expect(result).toContain("click");
  });

  it("drops scripts and event handlers", () => {
    const result = open(
      `<p>hi</p><script>alert(1)</script><img src="https://x.test/a.png" alt="a picture" width="600" onerror="alert(2)">`,
    );
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert(1)");
    expect(result).not.toContain("onerror");
  });

  // Tag-shaped *text* — `&lt;script&gt;` in a message body decodes to markup
  // during extraction. The converter escapes it; the renderer must not undo
  // that by passing raw html through, which is the one thing the incoming
  // renderer does differently from the outgoing one.
  it("renders tag-shaped body text as text", () => {
    const result = open(`<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`);
    expect(result).not.toContain("<script");
    expect(result).toContain("alert(1)");
  });

  it("hardens every link", () => {
    const result = open(`<a href="https://x.test/a">go</a>`);
    expect(result).toContain(`target="_blank"`);
    expect(result).toContain(`rel="noopener noreferrer"`);
  });
});
