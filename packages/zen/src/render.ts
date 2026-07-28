// Zen's markdown, back to html.
//
// A general markdown library would work here, and would be more forgiving —
// which is the reason not to use one. This renderer accepts exactly the
// dialect serialize.ts emits and nothing else, so the two are inverses and a
// mistake in either shows up as visibly wrong output rather than being quietly
// absorbed. On the hillclimb dashboard that property *is* the tool: the right
// pane shows what Zen believes it wrote, so a serializer bug is something you
// can see instead of something you have to go looking for.
//
// It also has to be safe. The markdown came from an untrusted email, so every
// character of text is escaped on the way out and every url is checked before
// it lands in an attribute.

const ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
];

const escapeHtml = (text: string): string =>
  ESCAPES.reduce((escaped, [from, to]) => escaped.replaceAll(from, to), text);

/** Schemes that can't execute. Anything else — `javascript:`, `vbscript:`, a
 *  bare `data:text/html` — becomes a dead link rather than a live one. */
const SAFE_URL = /^(?:https?:|mailto:|cid:|data:image\/|[/?#])/i;

/** Check a url that has *already* been escaped, and don't escape it again.
 *
 *  Every url reaching here was extracted from text that went through
 *  escapeHtml, so its `&` is already `&amp;` and its quotes are already
 *  `&quot;` — escaping a second time writes `&amp;amp;` into the attribute and
 *  the browser requests a url with a literal "amp;" in it. Mail links are
 *  nothing but query strings, so that broke very nearly every link in a
 *  message while still looking perfectly fine on the page. */
const safeUrl = (escapedUrl: string): string => {
  const url = escapedUrl.trim();
  // Undo the escaping only to test the scheme; what gets written back out is
  // the escaped form, which is what belongs in an attribute.
  const scheme = url.replaceAll("&amp;", "&");
  return SAFE_URL.test(scheme) ? url : "#";
};

/** Undo serialize.ts's escaping, and turn the inline markers back into tags.
 *  Order matters: backslash escapes are pulled out first so an escaped
 *  asterisk can't open emphasis, and put back last so the tags can't be
 *  matched inside a placeholder. */
// NUL fences the stashed escapes. It is the one character a message cannot
// forge: the walker collapses whitespace and control characters out of every
// text node upstream, so nothing reaching here contains one.
const FENCE = "\u0000";

const inline = (text: string): string => {
  const escaped: Array<string> = [];
  const stashed = text.replace(/\\([\\`*[\]_])/g, (_, char: string) => {
    escaped.push(char);
    return `${FENCE}${escaped.length - 1}${FENCE}`;
  });

  const rendered = escapeHtml(stashed)
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+?)(?:\s+=(\d*)x(\d*))?\)/g,
      (_, alt: string, src: string, width?: string, height?: string) => {
        // Attributes, not inline style: with `height:auto` in every reading
        // pane's stylesheet, width+height give the browser the aspect ratio
        // and let it scale down a wide image while still rendering a small
        // one — like a logo declared 150×40 — at the size the sender meant.
        const dims = [
          width ? ` width="${width}"` : "",
          height ? ` height="${height}"` : "",
        ].join("");
        return `<img alt="${alt}" src="${safeUrl(src)}"${dims} loading="lazy">`;
      },
    )
    .replace(
      /\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_, label: string, href: string) =>
        `<a href="${safeUrl(href)}" target="_blank" rel="noreferrer">${label}</a>`,
    )
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // Split rather than match: a regex over a control character is both a lint
  // error and less obvious than "every other piece is an index".
  return rendered
    .split(FENCE)
    .map((piece, index) =>
      index % 2 === 1 ? escapeHtml(escaped[Number(piece)] ?? "") : piece,
    )
    .join("");
};

const TABLE_RULE = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;

const cellsOf = (line: string): ReadonlyArray<string> =>
  line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

type Cursor = { index: number };

const isBlank = (line: string | undefined): boolean =>
  line === undefined || line.trim() === "";

/** One block, consumed from the cursor. Returns the html for it. */
const block = (lines: ReadonlyArray<string>, at: Cursor): string => {
  const line = lines[at.index] ?? "";

  if (/^ {0,3}(?:---|\*\*\*|___)\s*$/.test(line)) {
    at.index += 1;
    return "<hr>";
  }

  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading?.[1] !== undefined) {
    at.index += 1;
    return `<h${heading[1].length}>${inline(heading[2] ?? "")}</h${heading[1].length}>`;
  }

  if (line.startsWith("```")) {
    at.index += 1;
    const body: Array<string> = [];
    while (
      at.index < lines.length &&
      !(lines[at.index] ?? "").startsWith("```")
    ) {
      body.push(lines[at.index] ?? "");
      at.index += 1;
    }
    at.index += 1;
    return `<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`;
  }

  if (line.startsWith(">")) {
    const inner: Array<string> = [];
    while (at.index < lines.length && (lines[at.index] ?? "").startsWith(">")) {
      inner.push((lines[at.index] ?? "").replace(/^>\s?/, ""));
      at.index += 1;
    }
    return `<blockquote>${blocks(inner)}</blockquote>`;
  }

  const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (bullet !== null) {
    const ordered = /\d/.test(bullet[2] ?? "");
    const items: Array<Array<string>> = [];
    while (at.index < lines.length) {
      const current = lines[at.index] ?? "";
      const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(current);
      if (match !== null && /\d/.test(match[2] ?? "") === ordered) {
        items.push([match[3] ?? ""]);
        at.index += 1;
        continue;
      }
      // A continuation line: indented, and we're already inside an item.
      const item = items[items.length - 1];
      if (
        item !== undefined &&
        (/^\s{2,}\S/.test(current) || isBlank(current))
      ) {
        // A blank line only continues the item if more indented content follows.
        if (isBlank(current) && !/^\s{2,}\S/.test(lines[at.index + 1] ?? ""))
          break;
        item.push(current.replace(/^\s{2,}/, ""));
        at.index += 1;
        continue;
      }
      break;
    }
    const tag = ordered ? "ol" : "ul";
    return `<${tag}>${items
      .map((item) => `<li>${blocks(item)}</li>`)
      .join("")}</${tag}>`;
  }

  if (line.startsWith("|") && TABLE_RULE.test(lines[at.index + 1] ?? "")) {
    const header = cellsOf(line);
    at.index += 2;
    const rows: Array<ReadonlyArray<string>> = [];
    while (at.index < lines.length && (lines[at.index] ?? "").startsWith("|")) {
      rows.push(cellsOf(lines[at.index] ?? ""));
      at.index += 1;
    }
    const head = header.map((cell) => `<th>${inline(cell)}</th>`).join("");
    const body = rows
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`,
      )
      .join("");
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // Paragraph: everything up to the next blank line or block opener.
  const paragraph: Array<string> = [];
  while (at.index < lines.length) {
    const current = lines[at.index] ?? "";
    if (isBlank(current)) break;
    if (
      paragraph.length > 0 &&
      /^(#{1,6}\s|>|```|\||\s*[-*+]\s|\s*\d+[.)]\s)/.test(current)
    ) {
      break;
    }
    paragraph.push(current);
    at.index += 1;
  }
  if (paragraph.length === 0) {
    at.index += 1;
    return "";
  }
  // Two trailing spaces are the hard break the serializer emits.
  return `<p>${paragraph
    .map((text) => inline(text.replace(/ {2,}$/, "")))
    .join("<br>")}</p>`;
};

const blocks = (lines: ReadonlyArray<string>): string => {
  const at: Cursor = { index: 0 };
  const out: Array<string> = [];
  while (at.index < lines.length) {
    if (isBlank(lines[at.index])) {
      at.index += 1;
      continue;
    }
    out.push(block(lines, at));
  }
  return out.join("");
};

/** Render Zen's markdown to html. Safe to insert: text is escaped and urls are
 *  restricted to schemes that cannot execute. */
export const renderMarkdown = (markdown: string): string =>
  blocks(markdown.split("\n"));
