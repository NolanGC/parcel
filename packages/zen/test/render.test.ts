import { expect, test } from "bun:test";

import { renderMarkdown } from "../src/index.ts";
import { markdown } from "./helpers.ts";

test("paragraphs and emphasis", () => {
  expect(renderMarkdown("Hello **there**, *friend*.")).toBe(
    "<p>Hello <strong>there</strong>, <em>friend</em>.</p>",
  );
});

test("headings", () => {
  expect(renderMarkdown("# Title\n\n### Sub")).toBe(
    "<h1>Title</h1><h3>Sub</h3>",
  );
});

test("hard breaks stay inside one paragraph", () => {
  expect(renderMarkdown("Ada  \n1 Main St")).toBe("<p>Ada<br>1 Main St</p>");
});

test("links open away from the page", () => {
  expect(renderMarkdown("[docs](https://x.dev/a)")).toBe(
    '<p><a href="https://x.dev/a" target="_blank" rel="noreferrer">docs</a></p>',
  );
});

test("lists", () => {
  expect(renderMarkdown("- one\n- two")).toBe(
    "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
  );
  expect(renderMarkdown("1. one\n2. two")).toBe(
    "<ol><li><p>one</p></li><li><p>two</p></li></ol>",
  );
});

test("tables", () => {
  expect(renderMarkdown("| Item | Price |\n| --- | --- |\n| Tea | $3 |")).toBe(
    "<table><thead><tr><th>Item</th><th>Price</th></tr></thead>" +
      "<tbody><tr><td>Tea</td><td>$3</td></tr></tbody></table>",
  );
});

test("blockquotes nest their blocks", () => {
  expect(renderMarkdown("> Quoted words")).toBe(
    "<blockquote><p>Quoted words</p></blockquote>",
  );
});

test("escaped markdown characters come back as themselves", () => {
  expect(renderMarkdown("Save 50% on \\* everything \\*")).toBe(
    "<p>Save 50% on * everything *</p>",
  );
});

test("html in the markdown is inert", () => {
  expect(renderMarkdown("<script>alert(1)</script>")).toBe(
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
});

test("urls that can execute are defused", () => {
  expect(renderMarkdown("[click](javascript:alert(1))")).toContain('href="#"');
  expect(renderMarkdown("![x](data:text/html;base64,PHNjcmlwdD4=)")).toContain(
    'src="#"',
  );
});

test("cid and data image sources survive, because the app resolves them", () => {
  expect(renderMarkdown("![logo](cid:logo@1)")).toContain('src="cid:logo@1"');
});

// The renderer accepts exactly the dialect the serializer emits, so a message
// converted and then rendered should never leave markdown syntax on screen.
test("converted mail renders without leaking syntax", async () => {
  const html =
    "<h2>Receipt</h2><p>Thanks, <b>Ada</b>. Your <i>order</i> shipped.</p>" +
    "<ul><li>Coffee</li><li>Tea</li></ul>" +
    "<table><tr><th>Item</th><th>Price</th></tr><tr><td>Tea</td><td>$3</td></tr></table>" +
    '<p><a href="https://x.dev/track">Track it</a></p>' +
    "<blockquote><p>Quoted</p></blockquote>";

  const rendered = renderMarkdown(await markdown(html));

  expect(rendered).toContain("<h2>Receipt</h2>");
  expect(rendered).toContain("<strong>Ada</strong>");
  expect(rendered).toContain("<table>");
  expect(rendered).toContain("<blockquote>");
  expect(rendered).not.toContain("**");
  expect(rendered).not.toContain("](");
});

// Mail links are nothing but query strings. Escaping a url twice writes
// `&amp;amp;` into the attribute and the browser then requests a url with a
// literal "amp;" in it — every tracking link in a message, broken, while the
// page still looks perfectly fine.
test("a url with query parameters is escaped exactly once", () => {
  const html = renderMarkdown("[go](https://x.dev/a?e=1&v=beta&t=xyz)");
  expect(html).toContain('href="https://x.dev/a?e=1&amp;v=beta&amp;t=xyz"');
  expect(html).not.toContain("&amp;amp;");
});

test("an image url with query parameters survives too", () => {
  const html = renderMarkdown("![](https://x.dev/i.jpg?e=1&v=beta)");
  expect(html).toContain('src="https://x.dev/i.jpg?e=1&amp;v=beta"');
});

// Without a size attribute, a 150×40 logo and a full-width hero photo become
// the same bare <img> tag, and the logo renders at whatever resolution its
// file happens to be — the "small logos loading massively" bug.
test("a declared size survives to the img tag", () => {
  const html = renderMarkdown("![Acme](https://x.dev/logo.png =150x40)");
  expect(html).toContain('width="150"');
  expect(html).toContain('height="40"');
});

test("a partial declared size only writes the attribute it has", () => {
  expect(renderMarkdown("![](https://x.dev/thumb.jpg =x252)")).toContain(
    'height="252"',
  );
  expect(renderMarkdown("![](https://x.dev/thumb.jpg =252x)")).toContain(
    'width="252"',
  );
});

test("an undeclared size writes no size attributes", () => {
  const html = renderMarkdown("![](https://x.dev/i.jpg)");
  expect(html).not.toContain("width=");
  expect(html).not.toContain("height=");
});

test("a url that can execute is still defused after the escaping change", () => {
  expect(renderMarkdown("[x](javascript:alert(1))")).toContain('href="#"');
});
