import { expect, test } from "bun:test";

import { convert } from "./helpers.ts";

/** The lines a region covers, which is what a renderer actually collapses. */
const quoted = (
  markdown: string,
  region: { startLine: number; endLine: number },
) =>
  markdown
    .split("\n")
    .slice(region.startLine, region.endLine + 1)
    .join("\n");

test("a gmail reply chain is marked but not removed", async () => {
  const result = await convert(
    "<div>Sounds good, thanks!</div>" +
      '<div class="gmail_quote">' +
      "<div>On Mon, Jul 20, 2026 at 9:04 AM Ada &lt;ada@x.dev&gt; wrote:</div>" +
      '<blockquote class="gmail_quote"><p>Are we still on for Thursday?</p></blockquote>' +
      "</div>",
  );

  expect(result.quotes).toHaveLength(1);
  expect(result.quotes[0]?.kind).toBe("gmail");
  expect(result.markdown).toContain("Sounds good, thanks!");
  expect(result.markdown).toContain("Are we still on for Thursday?");
  expect(quoted(result.markdown, result.quotes[0]!)).not.toContain(
    "Sounds good",
  );
  expect(quoted(result.markdown, result.quotes[0]!)).toContain("Thursday");
});

test("blockquote type=cite is a quote region", async () => {
  const result = await convert(
    '<p>Agreed.</p><blockquote type="cite"><p>Original point</p></blockquote>',
  );
  expect(result.quotes.map((region) => region.kind)).toEqual(["cite"]);
  expect(quoted(result.markdown, result.quotes[0]!)).toBe("> Original point");
});

test("a bare attribution line quotes everything after it", async () => {
  const result = await convert(
    "<p>Yes, that works.</p>" +
      "<p>On Tue, Jul 21, 2026, Grace Hopper &lt;grace@x.dev&gt; wrote:</p>" +
      "<p>Can you review the draft?</p>" +
      "<p>Thanks</p>",
  );

  expect(result.quotes).toHaveLength(1);
  expect(result.quotes[0]?.kind).toBe("attribution");
  expect(result.quotes[0]?.attribution).toContain("Grace Hopper");
  expect(quoted(result.markdown, result.quotes[0]!)).toContain(
    "Can you review the draft?",
  );
  expect(result.markdown.split("\n")[0]).toBe("Yes, that works.");
});

test("an Outlook reply header block is a quote region", async () => {
  const result = await convert(
    "<p>Approved.</p><hr>" +
      "<p><b>From:</b> Ada &lt;ada@x.dev&gt;<br>" +
      "<b>Sent:</b> Monday, July 20, 2026 9:04 AM<br>" +
      "<b>To:</b> Team<br>" +
      "<b>Subject:</b> Budget</p>" +
      "<p>Please approve the budget.</p>",
  );

  expect(result.quotes[0]?.kind).toBe("outlook");
  expect(quoted(result.markdown, result.quotes[0]!)).toContain(
    "Please approve the budget.",
  );
});

// Outlook's own marker wraps only the From:/Sent:/To: header; the mail being
// replied to follows it as siblings. Collapsing just the header would leave
// the quoted message in the open, which is the thing the reader didn't ask for.
test("a structural Outlook marker quotes everything after it", async () => {
  const result = await convert(
    "<p>Approved.</p>" +
      '<div id="divRplyFwdMsg"><p><b>From:</b> Ada &lt;ada@x.dev&gt;</p></div>' +
      "<p>Please approve the budget.</p>" +
      "<p>Thanks, Ada</p>",
  );

  expect(result.quotes).toHaveLength(1);
  expect(result.quotes[0]?.kind).toBe("outlook");
  const lines = result.markdown.split("\n");
  expect(result.quotes[0]?.endLine).toBe(lines.length - 1);
  expect(quoted(result.markdown, result.quotes[0]!)).toContain("Thanks, Ada");
  expect(lines[0]).toBe("Approved.");
});

test("a signature delimiter starts a signature region", async () => {
  const result = await convert(
    "<p>See you then.</p><p>--</p><p>Ada Lovelace<br>Analytical Engines Ltd</p>",
  );
  expect(result.quotes[0]?.kind).toBe("signature");
  expect(quoted(result.markdown, result.quotes[0]!)).toContain("Ada Lovelace");
});

test("a mobile footer is a signature", async () => {
  const result = await convert("<p>On my way</p><p>Sent from my iPhone</p>");
  expect(result.quotes[0]?.kind).toBe("signature");
});

test("a forwarded message marker is its own kind", async () => {
  const result = await convert(
    "<p>FYI</p><p>---------- Forwarded message ----------</p><p>Original body</p>",
  );
  expect(result.quotes[0]?.kind).toBe("forward");
});

test("a lone Subject: line is not a quote boundary", async () => {
  const result = await convert(
    "<p>Subject: what should we call the project?</p><p>Ideas welcome.</p>",
  );
  expect(result.quotes).toEqual([]);
});

test("detectQuotes off reports only structural regions", async () => {
  const result = await convert(
    "<p>Sure.</p><p>On Tue, Ada wrote:</p><p>Question?</p>",
    { detectQuotes: false },
  );
  expect(result.quotes).toEqual([]);
});

test("a mail with no quoting has no regions", async () => {
  const result = await convert(
    "<p>Just a note.</p><p>Nothing quoted here.</p>",
  );
  expect(result.quotes).toEqual([]);
});

test("region line numbers survive postprocessing", async () => {
  const result = await convert(
    '<div>Hi</div><div style="display:none">hidden</div>' +
      '<table role="presentation"><tr><td></td></tr></table>' +
      '<div class="gmail_quote"><p>Quoted body</p></div>',
  );
  expect(quoted(result.markdown, result.quotes[0]!)).toBe("Quoted body");
});
