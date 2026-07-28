import { expect, test } from "bun:test";

import { convert, markdown } from "./helpers.ts";

test("paragraphs and inline emphasis", async () => {
  expect(
    await markdown(
      "<p>Hello <b>there</b>, <i>friend</i>.</p><p>Second thought.</p>",
    ),
  ).toBe("Hello **there**, *friend*.\n\nSecond thought.");
});

test("headings keep their level", async () => {
  expect(await markdown("<h1>Title</h1><h3>Sub</h3>")).toBe(
    "# Title\n\n### Sub",
  );
});

test("divs are paragraph boundaries, spans are not", async () => {
  expect(
    await markdown("<div>one <span>and a half</span></div><div>two</div>"),
  ).toBe("one and a half\n\ntwo");
});

test("br becomes a hard break inside one paragraph", async () => {
  expect(await markdown("<p>Ada Lovelace<br>1 Main St<br>London</p>")).toBe(
    "Ada Lovelace  \n1 Main St  \nLondon",
  );
});

test("links carry their destination", async () => {
  const result = await convert(
    '<p>See <a href="https://x.dev/a">the docs</a>.</p>',
  );
  expect(result.markdown).toBe("See [the docs](https://x.dev/a).");
  expect(result.links).toEqual([
    { href: "https://x.dev/a", text: "the docs", line: 0 },
  ]);
});

test("a link wrapping a whole paragraph puts the url after the prose", async () => {
  const long = "word ".repeat(40).trim();
  expect(await markdown(`<p><a href="https://x.dev/a">${long}</a></p>`)).toBe(
    `${long} (https://x.dev/a)`,
  );
});

test("images are reported with their source kind", async () => {
  const result = await convert(
    '<p><img src="cid:logo@1" alt="Acme"><img src="https://cdn.x/a.png" alt="Hero"></p>',
  );
  expect(result.images.map((image) => image.kind)).toEqual([
    "inline",
    "remote",
  ]);
  expect(result.markdown).toBe(
    "![Acme](cid:logo@1)![Hero](https://cdn.x/a.png)",
  );
});

test("lists nest", async () => {
  expect(
    await markdown("<ul><li>one</li><li>two<ul><li>deeper</li></ul></li></ul>"),
  ).toBe("- one\n- two\n\n  - deeper");
});

test("ordered lists number themselves", async () => {
  expect(await markdown("<ol><li>first</li><li>second</li></ol>")).toBe(
    "1. first\n2. second",
  );
});

test("markdown characters in mail text are escaped", async () => {
  expect(await markdown("<p>Save 50% on * everything * [today]</p>")).toBe(
    "Save 50% on \\* everything \\* \\[today\\]",
  );
});

test("a line that would read as a list marker is escaped", async () => {
  expect(await markdown("<p>- not a list</p>")).toBe("\\- not a list");
});

test("style and script never reach the output", async () => {
  expect(
    await markdown(
      "<style>p{color:red}</style><p>Visible</p><script>alert(1)</script>",
    ),
  ).toBe("Visible");
});

test("hidden preheader text is dropped", async () => {
  expect(
    await markdown(
      '<div style="display:none;max-height:0;overflow:hidden">Your order shipped! ‌‌‌‌</div><p>Real content</p>',
    ),
  ).toBe("Real content");
});

// A real message in this mailbox puts aria-hidden="true" on the table holding
// the entire body. It hides from screen readers, not from eyes.
test("aria-hidden content is still visible content", async () => {
  expect(
    await markdown(
      '<table aria-hidden="true"><tr><td><p>Real body</p></td></tr></table>',
    ),
  ).toBe("Real body");
});

test("the hidden attribute does hide", async () => {
  expect(await markdown("<p>Shown</p><div hidden><p>Not shown</p></div>")).toBe(
    "Shown",
  );
});

test("tracking pixels and beacons are dropped", async () => {
  const result = await convert(
    '<p>Body</p><img src="https://t.example/wf/open?upn=1" width="1" height="1">' +
      '<img src="https://cdn.x/spacer.gif" width="1">',
  );
  expect(result.images).toEqual([]);
  expect(result.markdown).toBe("Body");
});

test("a layout table is flattened into its cells", async () => {
  expect(
    await markdown(
      '<table role="presentation"><tr><td><h1>Welcome</h1></td><td><p>Sidebar</p></td></tr>' +
        "<tr><td><p>Body copy</p></td></tr></table>",
    ),
  ).toBe("# Welcome\n\nSidebar\n\nBody copy");
});

test("a data table survives as a table", async () => {
  expect(
    await markdown(
      "<table><tr><th>Item</th><th>Price</th></tr>" +
        "<tr><td>Coffee</td><td>$4</td></tr>" +
        "<tr><td>Tea</td><td>$3</td></tr></table>",
    ),
  ).toBe(
    "| Item   | Price |\n| ------ | ----- |\n| Coffee | $4    |\n| Tea    | $3    |",
  );
});

test("nested layout tables do not become a grid", async () => {
  const html =
    '<table role="presentation"><tr><td>' +
    '<table role="presentation"><tr><td><p>Deep</p></td></tr></table>' +
    "</td></tr></table>";
  expect(await markdown(html)).toBe("Deep");
});

test("an unmarked two-column table of prose is layout, not data", async () => {
  const prose = "This is a full sentence of newsletter copy that runs on. ";
  const html =
    `<table><tr><td>${prose}</td><td>${prose}</td></tr>` +
    `<tr><td>${prose}</td><td>${prose}</td></tr></table>`;
  expect(await markdown(html)).not.toContain("|");
});

test("blockquotes are quoted", async () => {
  expect(await markdown("<blockquote><p>Quoted words</p></blockquote>")).toBe(
    "> Quoted words",
  );
});

test("unknown tags keep their content", async () => {
  expect(await markdown("<custom-thing>kept</custom-thing>")).toBe("kept");
});

test("an empty body converts to empty markdown", async () => {
  expect(await markdown("<html><body></body></html>")).toBe("");
});

test("entities and non-breaking spaces read as plain text", async () => {
  expect(await markdown("<p>Tom&nbsp;&amp;&nbsp;Jerry &lt;3</p>")).toBe(
    "Tom & Jerry <3",
  );
});

// Card layouts draw an icon beside its heading as two side-by-side table
// cells, or as two floated sibling tables that share no cell at all — a real
// Providence mail uses the latter, and the walk hands the icon and the
// heading back as consecutive blocks either way. Left alone, the icon lands
// on its own line above the text it was drawn beside.
test("a small declared-size icon merges onto the same line as the heading after it", async () => {
  const html =
    '<table><tr><td><img src="https://x.dev/icon.png" width="120"></td></tr></table>' +
    "<p><b>Convenient care</b></p>";
  expect(await markdown(html)).toBe(
    "![](https://x.dev/icon.png =120x) **Convenient care**",
  );
});

test("an undeclared-size image does not merge — it might be the hero the heading is about", async () => {
  const html =
    '<table><tr><td><img src="https://x.dev/hero.jpg"></td></tr></table>' +
    "<h2>Headline</h2>";
  const result = await markdown(html);
  expect(result).toContain("![](https://x.dev/hero.jpg)\n\n## Headline");
});

test("a large declared photo stays above the heading, not beside it", async () => {
  const html =
    '<table><tr><td><img src="https://x.dev/hero.jpg" width="600" height="300"></td></tr></table>' +
    "<h2>Headline</h2>";
  const result = await markdown(html);
  expect(result).toContain("=600x300)\n\n## Headline");
});

// The "bulletproof button" pattern: a VML fallback for Outlook inside a real
// MSO conditional comment, followed by the actual button wrapped in a
// downlevel-revealed comment meant to be live content everywhere else.
// happy-dom's comment tokenizer reads straight through the embedded `-->` in
// `<!--[if !mso]><!-->` and swallows the real button as inert comment text —
// this is the bug behind three missing "Continue" buttons in a real Google
// mail.
test("a bulletproof button's real markup survives the mso fallback", async () => {
  const html =
    `<!--[if mso]><a href="https://x.dev/vml">VML Continue</a><![endif]-->` +
    `<!--[if !mso]><!--><a href="https://x.dev/btn">Continue</a><!--<![endif]-->`;
  expect(await markdown(html)).toBe("[Continue](https://x.dev/btn)");
});
