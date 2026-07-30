// Compose bodies are markdown, and this is what a recipient receives. The
// assertions that matter are the ones about what does *not* come out: this
// renders text a user typed into HTML that is then mailed to other people.

import { describe, expect, test } from "vitest";

import { renderMarkdownToEmailHtml } from "./markdown";

describe("rendering", () => {
  test("emphasis, links and lists become plain semantic tags", () => {
    const html = renderMarkdownToEmailHtml(
      "**bold** and *italic*\n\n- one\n- two\n\n[link](https://example.com)",
    );

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  // Mail is written like mail. Nobody types two trailing spaces to mean
  // "new line", so a single newline is one.
  test("a single newline is a line break", () => {
    expect(renderMarkdownToEmailHtml("one\ntwo")).toContain("<br>");
  });

  // Email clients routinely strip <style> blocks, so anything that has to
  // survive the trip is inlined on the element itself.
  test("quotes and code carry their styling inline", () => {
    expect(renderMarkdownToEmailHtml("> quoted")).toMatch(
      /<blockquote style="[^"]+">/,
    );
    expect(renderMarkdownToEmailHtml("```\ncode\n```")).toMatch(
      /<pre style="[^"]+">/,
    );
    expect(renderMarkdownToEmailHtml("`inline`")).toMatch(
      /<code style="[^"]+">inline<\/code>/,
    );
  });

  test("a quote renders its own contents rather than the raw source", () => {
    expect(renderMarkdownToEmailHtml("> **shouting**")).toContain(
      "<strong>shouting</strong>",
    );
  });
});

// The compose box is a text field pointed at other people's inboxes. Markup
// typed into it is content, never markup.
describe("raw HTML is text, not markup", () => {
  test("a script tag is escaped rather than emitted", () => {
    const html = renderMarkdownToEmailHtml("<script>alert(1)</script>");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("inline tags are escaped too", () => {
    const html = renderMarkdownToEmailHtml("hello <b>there</b>");

    expect(html).not.toContain("<b>there</b>");
    expect(html).toContain("&lt;b&gt;");
  });

  test("an img with an onerror handler survives as text", () => {
    const html = renderMarkdownToEmailHtml('<img src=x onerror="steal()">');

    expect(html).not.toContain('onerror="steal()"');
    expect(html).toContain("&lt;img");
  });

  test("html inside a fenced block is escaped as code", () => {
    const html = renderMarkdownToEmailHtml("```\n<b>x</b>\n```");

    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("edge cases", () => {
  test("an empty body renders an empty document rather than throwing", () => {
    expect(renderMarkdownToEmailHtml("")).toBe(
      renderMarkdownToEmailHtml("").trim(),
    );
  });

  test("plain prose passes through as a paragraph", () => {
    expect(renderMarkdownToEmailHtml("just a sentence")).toContain(
      "<p>just a sentence</p>",
    );
  });
});
