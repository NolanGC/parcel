// The tree, written out as markdown.
//
// Everything about markdown syntax lives here and nowhere else: escaping,
// blank lines between blocks, how a table's pipes line up, what a hard break
// looks like. The walker upstream never sees a character of it.
//
// The serializer also produces the only record of *where* things landed. Line
// numbers are what let quote regions be reported as ranges and what lets the
// hillclimb dashboard point at an image that came out wrong, and they're only
// knowable while writing. Recovering them afterwards would mean parsing the
// markdown back — a second converter, with new bugs.

import type { Block, Inline } from "./convert.ts";
import type { QuoteMark } from "./quotes.ts";
import type { ZenImage, ZenLink, ZenOptions } from "./types.ts";

/** A run of lines produced under one quote signal, before overlapping runs are
 *  merged into regions. */
export type QuoteSpan = Readonly<{
  mark: QuoteMark;
  startLine: number;
  endLine: number;
}>;

export type Serialized = Readonly<{
  lines: ReadonlyArray<string>;
  images: ReadonlyArray<ZenImage>;
  links: ReadonlyArray<ZenLink>;
  spans: ReadonlyArray<QuoteSpan>;
}>;

// Characters that would otherwise start something. `_` is deliberately absent:
// it's syntax only between word boundaries, and escaping every underscore
// turns file_name_here into a thicket of backslashes for no benefit — that
// case is handled below.
const ESCAPED = /[\\`*[\]]/g;

const escapeInline = (text: string): string =>
  text
    .replace(ESCAPED, (match) => `\\${match}`)
    // An underscore flanked by whitespace can open emphasis; one inside a word
    // cannot, which is exactly the common case in mail (urls, identifiers).
    .replace(/(^|\s)_/g, "$1\\_")
    .replace(/_(\s|$)/g, "\\_$1");

// A line that begins with one of these reads as a block marker. Only the first
// line of a paragraph is at risk — a continuation line is inside the paragraph
// already.
const escapeLineStart = (line: string): string =>
  line.replace(/^(\s*)([#>+-]|\d+[.)])(\s)/, "$1\\$2$3");

const escapeCell = (text: string): string => text.replaceAll("|", "\\|");

type Sink = {
  readonly images: Array<ZenImage>;
  readonly links: Array<ZenLink>;
};

type InlineContext = {
  readonly sink: Sink;
  readonly options: ZenOptions;
  /** Table cells are one line by definition, so hard breaks become spaces. */
  readonly inTable: boolean;
  line: number;
};

const plainText = (inlines: ReadonlyArray<Inline>): string =>
  inlines
    .map((node) => {
      switch (node._tag) {
        case "text":
          return node.text;
        case "code":
          return node.text;
        case "image":
          return node.alt;
        case "break":
          return " ";
        default:
          return plainText(node.children);
      }
    })
    .join("");

const writeInlines = (
  inlines: ReadonlyArray<Inline>,
  ctx: InlineContext,
): string => {
  let out = "";
  const append = (text: string): void => {
    out += text;
  };

  for (const node of inlines) {
    switch (node._tag) {
      case "text":
        append(escapeInline(node.text));
        break;

      case "break":
        if (ctx.inTable) {
          append(" ");
        } else {
          // Two trailing spaces: the hard break every markdown dialect agrees
          // on, and the one thing that keeps an address block from collapsing
          // into a single run-on line.
          append("  \n");
          ctx.line += 1;
        }
        break;

      case "code":
        append(`\`${node.text.replaceAll("`", "")}\``);
        break;

      case "strong":
        append(`**${writeInlines(node.children, ctx)}**`);
        break;

      case "em":
        append(`*${writeInlines(node.children, ctx)}*`);
        break;

      case "strike":
        append(`~~${writeInlines(node.children, ctx)}~~`);
        break;

      case "image": {
        ctx.sink.images.push({
          src: node.src,
          alt: node.alt,
          kind: node.src.startsWith("cid:")
            ? "inline"
            : node.src.startsWith("data:")
              ? "data"
              : "remote",
          line: ctx.line,
          width: node.width,
          height: node.height,
        });
        // `=WxH` is not standard markdown, but this dialect only has one
        // reader (render.ts), and without it every image loses its declared
        // size on the way to html — a 40×40 logo and a hero photo become the
        // same bare `<img>` tag, and the logo renders at whatever resolution
        // the file happens to be.
        const size =
          node.width === undefined && node.height === undefined
            ? ""
            : ` =${node.width ?? ""}x${node.height ?? ""}`;
        append(`![${escapeInline(node.alt)}](${node.src}${size})`);
        break;
      }

      case "link": {
        const text = writeInlines(node.children, ctx);
        ctx.sink.links.push({
          href: node.href,
          text: plainText(node.children).trim(),
          line: ctx.line,
        });
        // A link wrapped around three sentences — the newsletter idiom — is
        // more readable as the sentences followed by the destination than as
        // one enormous bracketed span.
        append(
          plainText(node.children).length > ctx.options.maxLinkTextLength
            ? `${text} (${node.href})`
            : `[${text}](${node.href})`,
        );
        break;
      }
    }
  }

  return out;
};

/** Collects lines and remembers which block produced which, so quote spans can
 *  be expressed in the same coordinates the caller will see. */
class Writer {
  readonly lines: Array<string> = [];

  get next(): number {
    return this.lines.length;
  }

  /** One blank line between blocks, never at the start. */
  separate(): void {
    if (this.lines.length === 0) return;
    if (this.lines[this.lines.length - 1] === "") return;
    this.lines.push("");
  }

  push(text: string): void {
    for (const line of text.split("\n")) this.lines.push(line);
  }
}

const cellWidth = (text: string): number => Math.min(text.length, 40);

const writeTable = (
  block: Extract<Block, { _tag: "table" }>,
  writer: Writer,
  ctx: InlineContext,
): void => {
  const rows = block.rows.map((row) =>
    row.map((cell) =>
      escapeCell(writeInlines(cell, { ...ctx, inTable: true })).trim(),
    ),
  );
  // GFM has no headerless table. When the sender didn't mark one, the first
  // row is nearly always the labels anyway — and a table whose first row is
  // data still reads correctly, just with a rule under line one.
  const header =
    block.header === undefined
      ? rows.shift()
      : block.header.map((cell) =>
          escapeCell(writeInlines(cell, { ...ctx, inTable: true })).trim(),
        );
  if (header === undefined || header.length === 0) return;

  const columns = Math.max(header.length, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(
      3,
      cellWidth(header[index] ?? ""),
      ...rows.map((row) => cellWidth(row[index] ?? "")),
    ),
  );

  const line = (cells: ReadonlyArray<string>): string =>
    `| ${Array.from({ length: columns }, (_, index) =>
      (cells[index] ?? "").padEnd(widths[index] ?? 3),
    ).join(" | ")} |`;

  writer.push(line(header));
  writer.push(`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`);
  for (const row of rows) writer.push(line(row));
};

// Nested content (list items, blockquotes) is written into its own Writer and
// then prefixed line-for-line, so `offset` carries where that writer's line 0
// lands in the finished document. Without it every line number reported from
// inside a quoted list would be relative to the list.
const writeBlocks = (
  blocks: ReadonlyArray<Block>,
  writer: Writer,
  spans: Array<QuoteSpan>,
  sink: Sink,
  options: ZenOptions,
  offset: number,
): void => {
  for (const block of blocks) {
    writer.separate();
    const start = offset + writer.next;
    const ctx: InlineContext = {
      sink,
      options,
      inTable: false,
      line: start,
    };

    switch (block._tag) {
      case "paragraph":
        writer.push(escapeLineStart(writeInlines(block.inlines, ctx)));
        break;

      case "heading":
        writer.push(
          `${"#".repeat(block.level)} ${writeInlines(block.inlines, ctx)}`,
        );
        break;

      case "rule":
        writer.push("---");
        break;

      case "code":
        writer.push("```");
        writer.push(block.text);
        writer.push("```");
        break;

      case "list": {
        block.items.forEach((item, index) => {
          const marker = block.ordered ? `${index + 1}. ` : "- ";
          const indent = " ".repeat(marker.length);
          const inner = new Writer();
          writeBlocks(item, inner, spans, sink, options, offset + writer.next);
          inner.lines.forEach((line, lineIndex) => {
            if (lineIndex === 0) writer.push(`${marker}${line}`);
            else writer.push(line === "" ? "" : `${indent}${line}`);
          });
        });
        break;
      }

      case "blockquote": {
        const inner = new Writer();
        writeBlocks(
          block.children,
          inner,
          spans,
          sink,
          options,
          offset + writer.next,
        );
        for (const line of inner.lines) {
          writer.push(line === "" ? ">" : `> ${line}`);
        }
        break;
      }

      case "table":
        writeTable(block, writer, ctx);
        break;
    }

    const end = offset + writer.next - 1;
    if (block.quote !== undefined && end >= start) {
      spans.push({ mark: block.quote, startLine: start, endLine: end });
    }
  }
};

export const serialize = (
  blocks: ReadonlyArray<Block>,
  options: ZenOptions,
): Serialized => {
  const writer = new Writer();
  const spans: Array<QuoteSpan> = [];
  const sink: Sink = { images: [], links: [] };
  writeBlocks(blocks, writer, spans, sink, options, 0);
  return { lines: writer.lines, images: sink.images, links: sink.links, spans };
};
