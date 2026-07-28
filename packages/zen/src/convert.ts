// The walk: html in, a tree of blocks and inlines out.
//
// The intermediate tree is the load-bearing decision in this package. Writing
// markdown straight out of a DOM walk is what every quick converter does, and
// it's why they all struggle with the same three things: knowing whether a
// space is needed before you know what follows, escaping a character
// differently depending on where in a line it lands, and reporting *where* in
// the output something ended up. A tree separates "what does this mean" from
// "how does it get written", so the walker can be about email semantics and
// the serializer can be about markdown syntax, and neither has to guess at the
// other's problem.
//
// Unknown elements are transparent: mail is full of tags that carry no meaning
// (`<font>`, `<center>`, custom junk from a template engine), and recursing
// through them keeps their content instead of dropping it.

import {
  attr,
  children,
  type DomElement,
  type DomNode,
  isComment,
  isElement,
  isText,
  tagOf,
} from "./dom.ts";
import { backgroundImage, declaredSize, isChromeImage } from "./chrome.ts";
import { shouldDrop, stripInvisible } from "./preclean.ts";
import { domQuoteMark, type QuoteMark } from "./quotes.ts";
import { cellsOf, classifyTable, rowsOf } from "./tables.ts";
import type { ZenOptions } from "./types.ts";

export type Inline =
  | Readonly<{ _tag: "text"; text: string }>
  | Readonly<{ _tag: "strong"; children: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "em"; children: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "strike"; children: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "code"; text: string }>
  | Readonly<{ _tag: "link"; href: string; children: ReadonlyArray<Inline> }>
  | Readonly<{
      _tag: "image";
      src: string;
      alt: string;
      width?: number;
      height?: number;
    }>
  | Readonly<{ _tag: "break" }>;

export type Block =
  | Readonly<{
      _tag: "paragraph";
      inlines: ReadonlyArray<Inline>;
      quote: QuoteMark | undefined;
    }>
  | Readonly<{
      _tag: "heading";
      level: number;
      inlines: ReadonlyArray<Inline>;
      quote: QuoteMark | undefined;
    }>
  | Readonly<{
      _tag: "list";
      ordered: boolean;
      items: ReadonlyArray<ReadonlyArray<Block>>;
      quote: QuoteMark | undefined;
    }>
  | Readonly<{
      _tag: "table";
      header: ReadonlyArray<ReadonlyArray<Inline>> | undefined;
      rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Inline>>>;
      quote: QuoteMark | undefined;
    }>
  | Readonly<{
      _tag: "blockquote";
      children: ReadonlyArray<Block>;
      quote: QuoteMark | undefined;
    }>
  | Readonly<{ _tag: "rule"; quote: QuoteMark | undefined }>
  | Readonly<{
      _tag: "code";
      text: string;
      quote: QuoteMark | undefined;
    }>;

const HEADINGS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/** Tags that don't interrupt a line of text. Everything not listed and not
 *  handled explicitly below is treated as a block boundary, which is the safer
 *  default: a missing paragraph break reads as run-on prose, while a spurious
 *  one is just a blank line. */
const INLINE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "big",
  "cite",
  "code",
  "del",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "nobr",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);

/** Container tags whose only job is grouping. Walked through as if they
 *  weren't there, except that they close the paragraph they interrupt. */
const BLOCK_CONTAINERS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "body",
  "center",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "html",
  "main",
  "nav",
  "p",
  "section",
  "summary",
]);

const isBlank = (text: string): boolean => text.trim() === "";

/** Collapse whitespace the way html layout would, so a source formatted across
 *  five indented lines becomes one line of prose. Non-breaking spaces become
 *  ordinary ones: they're used for indentation in mail far more often than for
 *  their actual meaning, and they defeat every downstream trim. */
const collapse = (text: string): string =>
  stripInvisible(text).replaceAll(" ", " ").replace(/\s+/g, " ");

const isUsableHref = (href: string): boolean =>
  !href.startsWith("#") && !/^javascript:/i.test(href) && !/^\s*$/.test(href);

/** Above this, an image is a picture the message is about, not a mark next
 *  to a label — a hero photo above a headline is meant to stay above it. A
 *  card icon sitting beside its heading is reliably smaller than this; the
 *  Providence "Convenient care" icons that motivated this rule declare 120. */
const ICON_MERGE_MAX_PX = 160;

/** A block that is nothing but one image — the shape a `<td>` or a lone
 *  `<table>` collapses to when it exists only to hold an icon. */
const loneImage = (
  block: Block,
): Extract<Inline, { _tag: "image" }> | undefined => {
  if (block._tag !== "paragraph" || block.inlines.length !== 1)
    return undefined;
  const only = block.inlines[0];
  return only?._tag === "image" ? only : undefined;
};

/** Email templates routinely draw an icon-and-heading card as two side-by-side
 *  table cells, or even two floated sibling tables that share no cell at all —
 *  the Providence "Convenient care" block motivating this is the latter. Either
 *  way the walk hands back the icon and the heading as consecutive blocks, and
 *  a naive render stacks them: an icon-sized image, alone on its own line,
 *  above the text it was drawn beside.
 *
 *  Only a *declared* small image qualifies — an image with no size to read
 *  might be the hero photo the heading is about, and stacking that above the
 *  heading is correct. Merging is refused across a quote boundary so a signature
 *  icon can't reach backwards into a person's authored line. */
const mergeLeadingIcons = (blocks: ReadonlyArray<Block>): ReadonlyArray<Block> => {
  const out: Array<Block> = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const next = blocks[index + 1];
    const image = block === undefined ? undefined : loneImage(block);
    const edge = Math.max(image?.width ?? 0, image?.height ?? 0);

    if (
      block !== undefined &&
      image !== undefined &&
      edge > 0 &&
      edge <= ICON_MERGE_MAX_PX &&
      next !== undefined &&
      (next._tag === "paragraph" || next._tag === "heading") &&
      next.quote === block.quote
    ) {
      out.push({ ...next, inlines: [image, { _tag: "text", text: " " }, ...next.inlines] });
      index += 1;
      continue;
    }
    if (block !== undefined) out.push(block);
  }
  return out;
};

/** Accumulates a run of inline content and closes it into a paragraph at the
 *  first block boundary. This is what lets `text <b>bold</b> text` inside a
 *  `<div>` come out as one paragraph rather than three. */
class Builder {
  readonly blocks: Array<Block> = [];
  private pending: Array<Inline> = [];

  constructor(private readonly quote: QuoteMark | undefined) {}

  inline(node: Inline): void {
    // Never open a paragraph with whitespace; past that, the same
    // double-space rule the inline walk uses.
    if (
      node._tag === "text" &&
      this.pending.length === 0 &&
      isBlank(node.text)
    ) {
      return;
    }
    appendInline(this.pending, node);
  }

  block(node: Block): void {
    this.flush();
    this.blocks.push(node);
  }

  flush(): void {
    const inlines = trimEdges(this.pending);
    this.pending = [];
    if (inlines.length > 0) {
      this.blocks.push({ _tag: "paragraph", inlines, quote: this.quote });
    }
  }

  done(): ReadonlyArray<Block> {
    this.flush();
    return mergeLeadingIcons(this.blocks);
  }
}

/** Drop leading and trailing whitespace and line breaks from an inline run.
 *  The tree carries meaning, not layout, so an inline run's edges are always
 *  the serializer's business. */
const trimEdges = (inlines: ReadonlyArray<Inline>): ReadonlyArray<Inline> => {
  const isEdgeNoise = (node: Inline | undefined): boolean =>
    node !== undefined &&
    (node._tag === "break" || (node._tag === "text" && isBlank(node.text)));

  let start = 0;
  let end = inlines.length;
  while (start < end && isEdgeNoise(inlines[start])) start += 1;
  while (end > start && isEdgeNoise(inlines[end - 1])) end -= 1;

  // Both edges are rewritten through `result`, never through a copy taken
  // before: when the run is a single text node — which is most of them, every
  // `<b>word</b>` and every link label — the first and last node are the same
  // one, and reading the original twice makes the second write undo the first.
  const result = inlines.slice(start, end);

  const first = result[0];
  if (first?._tag === "text") {
    result[0] = { _tag: "text", text: first.text.replace(/^ +/, "") };
  }

  const lastIndex = result.length - 1;
  const last = result[lastIndex];
  if (last?._tag === "text") {
    result[lastIndex] = { _tag: "text", text: last.text.replace(/ +$/, "") };
  }

  return result.filter((node) => !(node._tag === "text" && node.text === ""));
};

/** Is there anything here a reader would see? Whitespace and hard breaks are
 *  layout, not content — an inline run made only of those is an empty box. */
const hasVisibleContent = (inlines: ReadonlyArray<Inline>): boolean =>
  inlines.some((node) => {
    switch (node._tag) {
      case "text":
        return !isBlank(node.text);
      case "break":
        return false;
      case "image":
        return true;
      case "code":
        return !isBlank(node.text);
      case "link":
        return hasVisibleContent(node.children);
      default:
        return hasVisibleContent(node.children);
    }
  });

type Context = Readonly<{
  options: ZenOptions;
  quote: QuoteMark | undefined;
  /** Mutable across the whole walk: the image budget is per message, not per
   *  branch, and a newsletter's hundredth sliced-layout image is not what
   *  makes the mail readable. */
  budget: { images: number };
}>;

/** A css background picture on this element, if it is carrying one, counted
 *  against the message's image budget. Called from exactly one place per
 *  element — the inline walk or the block walk, never both — so an element
 *  can't contribute its background twice. */
const backgroundInline = (
  element: DomElement,
  ctx: Context,
): Inline | undefined => {
  const src = backgroundImage(element);
  if (src === undefined || ctx.budget.images >= ctx.options.maxImages) {
    return undefined;
  }
  ctx.budget.images += 1;
  const { width, height } = declaredSize(element);
  return {
    _tag: "image",
    src,
    alt: collapse(attr(element, "aria-label") ?? "").trim(),
    width,
    height,
  };
};

/** Append one inline, without letting two collapsed runs meet as a double
 *  space. Layout markup puts whitespace between every tag, so a name and a job
 *  title in adjacent cells arrive as several separate blank text nodes — and
 *  they arrive from different branches of the walk, so the check has to live at
 *  the one place everything is appended rather than in any single caller. */
const appendInline = (out: Array<Inline>, node: Inline): void => {
  if (node._tag !== "text") {
    out.push(node);
    return;
  }
  const last = out[out.length - 1];
  if (last?._tag === "text" && last.text.endsWith(" ")) {
    const joined = node.text.replace(/^ +/, "");
    if (joined !== "") out.push({ _tag: "text", text: joined });
    return;
  }
  out.push(node);
};

const inlinesOf = (
  nodes: ReadonlyArray<DomNode>,
  ctx: Context,
): Array<Inline> => {
  const out: Array<Inline> = [];
  for (const node of nodes) {
    if (isComment(node)) continue;
    if (isText(node)) {
      const text = collapse(node.textContent ?? "");
      if (text !== "") appendInline(out, { _tag: "text", text });
      continue;
    }
    if (!isElement(node) || shouldDrop(node)) continue;
    for (const inline of inlineElement(node, ctx)) appendInline(out, inline);
  }
  return out;
};

const inlineElement = (
  element: DomElement,
  ctx: Context,
): ReadonlyArray<Inline> => {
  // A card whose thumbnail is a css background, wrapped in a link — the shape
  // every "watch this video" block in a digest arrives in.
  const background = backgroundInline(element, ctx);
  const inlines = inlineElementBody(element, ctx);
  return background === undefined ? inlines : [background, ...inlines];
};

const inlineElementBody = (
  element: DomElement,
  ctx: Context,
): ReadonlyArray<Inline> => {
  const tag = tagOf(element);
  const kids = children(element);

  switch (tag) {
    case "br":
      return [{ _tag: "break" }];

    case "img": {
      if (ctx.options.dropChrome && isChromeImage(element)) return [];
      if (ctx.budget.images >= ctx.options.maxImages) return [];
      const src = attr(element, "src");
      if (src === undefined) return [];
      ctx.budget.images += 1;
      const { width, height } = declaredSize(element);
      return [
        {
          _tag: "image",
          src,
          alt: collapse(attr(element, "alt") ?? "").trim(),
          width,
          height,
        },
      ];
    }

    case "a": {
      const href = attr(element, "href");
      const inner = trimEdges(inlinesOf(kids, ctx));
      if (href === undefined || !isUsableHref(href)) return inner;
      // An anchor whose only content was an icon is left holding nothing once
      // the icon goes. `[](url)` is not a link a reader can use, and a header
      // bar of them is the worst thing a digest can turn into.
      return hasVisibleContent(inner)
        ? [{ _tag: "link", href, children: inner }]
        : [];
    }

    case "b":
    case "strong":
      return wrap("strong", inlinesOf(kids, ctx));

    case "i":
    case "em":
    case "cite":
    case "var":
      return wrap("em", inlinesOf(kids, ctx));

    case "s":
    case "del":
    case "strike":
      return wrap("strike", inlinesOf(kids, ctx));

    case "code":
    case "kbd":
    case "samp":
    case "tt": {
      const text = collapse(element.textContent ?? "");
      return text.trim() === "" ? [] : [{ _tag: "code", text }];
    }

    default:
      return inlinesOf(kids, ctx);
  }
};

const wrap = (
  tag: "strong" | "em" | "strike",
  inner: ReadonlyArray<Inline>,
): ReadonlyArray<Inline> => {
  const trimmed = trimEdges(inner);
  // `<b></b>` around a spacer image is everywhere in newsletters; emitting
  // `****` for it would be worse than emitting nothing.
  return trimmed.length === 0 ? [] : [{ _tag: tag, children: trimmed }];
};

const listItems = (
  element: DomElement,
  ctx: Context,
): ReadonlyArray<ReadonlyArray<Block>> =>
  children(element)
    .filter(
      (child): child is DomElement => isElement(child) && tagOf(child) === "li",
    )
    .map((item) => blocksOf(children(item), ctx))
    .filter((blocks) => blocks.length > 0);

const dataTable = (element: DomElement, ctx: Context): Block => {
  const rows = rowsOf(element).map((row) =>
    cellsOf(row).map((cell) => trimEdges(inlinesOf(children(cell), ctx))),
  );
  const headerRow = rowsOf(element)[0];
  const hasHeader =
    headerRow !== undefined &&
    cellsOf(headerRow).some((cell) => tagOf(cell) === "th");

  return {
    _tag: "table",
    header: hasHeader ? rows[0] : undefined,
    rows: hasHeader ? rows.slice(1) : rows,
    quote: ctx.quote,
  };
};

const blocksOf = (
  nodes: ReadonlyArray<DomNode>,
  ctx: Context,
): ReadonlyArray<Block> => {
  const builder = new Builder(ctx.quote);
  walk(nodes, ctx, builder);
  return builder.done();
};

const textLength = (inlines: ReadonlyArray<Inline>): number =>
  inlines.reduce((total, node) => {
    switch (node._tag) {
      case "text":
      case "code":
        return total + node.text.length;
      case "image":
        return total + node.alt.length;
      case "break":
        return total + 1;
      default:
        return total + textLength(node.children);
    }
  }, 0);

/** A row of a layout table, short enough that it was a line on screen. */
const ROW_JOIN_MAX_CHARS = 120;

/** Try to read one layout row as the single line it was.
 *
 *  A `<tr>` in a layout table is a row of columns sitting side by side: an
 *  action bar, a stat row, a footer of links. Emitting each cell as its own
 *  paragraph turns "149 · 115 Comments" into three stacked lines, and a nav bar
 *  into a column. Joining is only safe when every cell holds a single short run
 *  of inline content — the moment one holds a heading, a list or a paragraph of
 *  prose, the row is a page layout and its cells really are separate blocks. */
const joinedRow = (
  cells: ReadonlyArray<ReadonlyArray<Block>>,
  quote: QuoteMark | undefined,
): Block | undefined => {
  const paragraphs: Array<Extract<Block, { _tag: "paragraph" }>> = [];
  for (const blocks of cells) {
    if (blocks.length === 0) continue;
    const only = blocks[0];
    if (blocks.length > 1 || only?._tag !== "paragraph") return undefined;
    paragraphs.push(only);
  }

  if (paragraphs.length < 2) return undefined;
  const total = paragraphs.reduce(
    (sum, paragraph) => sum + textLength(paragraph.inlines),
    0,
  );
  if (total > ROW_JOIN_MAX_CHARS) return undefined;

  // Joined with a plain space: the columns were separated visually, and
  // inventing a bullet or a pipe would be adding punctuation the sender never
  // wrote. Senders who wanted a separator put one in its own cell, and that
  // cell comes through as itself.
  const gap: Inline = { _tag: "text", text: " " };
  const inlines = paragraphs.flatMap(
    (paragraph, index): ReadonlyArray<Inline> =>
      index === 0 ? paragraph.inlines : [gap, ...paragraph.inlines],
  );
  return { _tag: "paragraph", inlines, quote };
};

/** One layout cell's blocks, including a picture the cell is carrying itself.
 *
 *  The cell's own element never reaches walkElement on this path — the row walk
 *  goes straight to its children — and a `background-size: cover` thumbnail
 *  lives on an otherwise empty `<td>`, so it has to be collected here or it is
 *  lost with the grid. */
const cellBlocks = (cell: DomElement, ctx: Context): ReadonlyArray<Block> => {
  const blocks = blocksOf(children(cell), ctx);
  const background = backgroundInline(cell, ctx);
  return background === undefined
    ? blocks
    : [
        { _tag: "paragraph", inlines: [background], quote: ctx.quote },
        ...blocks,
      ];
};

/** Walk a table that turned out to be page layout rather than data. */
const layoutTable = (
  element: DomElement,
  ctx: Context,
  builder: Builder,
): void => {
  const rows = rowsOf(element);
  builder.flush();
  if (rows.length === 0) {
    walk(children(element), ctx, builder);
    return;
  }

  for (const row of rows) {
    const cells = cellsOf(row).map((cell) => cellBlocks(cell, ctx));
    const joined = joinedRow(cells, ctx.quote);
    if (joined !== undefined) {
      builder.block(joined);
      continue;
    }
    for (const blocks of cells)
      for (const block of blocks) builder.block(block);
  }
};

const walk = (
  nodes: ReadonlyArray<DomNode>,
  ctx: Context,
  builder: Builder,
): void => {
  for (const node of nodes) {
    if (isComment(node)) continue;

    if (isText(node)) {
      const text = collapse(node.textContent ?? "");
      if (text !== "") builder.inline({ _tag: "text", text });
      continue;
    }
    if (!isElement(node) || shouldDrop(node)) continue;

    walkElement(node, ctx, builder);
  }
};

const walkElement = (
  element: DomElement,
  parent: Context,
  builder: Builder,
): void => {
  const tag = tagOf(element);
  const kids = children(element);

  // A quote signal changes which builder the content belongs to, because a
  // builder stamps its quote onto every paragraph it closes. So a marked
  // subtree is converted on its own and its finished blocks are handed back —
  // which also gives the outermost signal on a path precedence, the behaviour
  // we want when a reply chain nests three clients' markers inside each other.
  if (parent.quote === undefined) {
    const mark = domQuoteMark(element);
    if (mark !== undefined) {
      builder.flush();
      for (const block of blocksOf([element], { ...parent, quote: mark })) {
        builder.block(block);
      }
      return;
    }
  }
  const ctx = parent;

  if (INLINE_TAGS.has(tag) || tag === "br" || tag === "img") {
    for (const inline of inlineElement(element, ctx)) builder.inline(inline);
    return;
  }

  // Past this point the element is a block, and inlineElement will never see
  // it — so this is where a background picture on a block gets collected.
  const background = backgroundInline(element, ctx);
  if (background !== undefined) builder.inline(background);

  const level = HEADINGS[tag];
  if (level !== undefined) {
    const inlines = trimEdges(inlinesOf(kids, ctx));
    if (inlines.length > 0) {
      builder.block({ _tag: "heading", level, inlines, quote: ctx.quote });
    }
    return;
  }

  switch (tag) {
    case "hr":
      builder.block({ _tag: "rule", quote: ctx.quote });
      return;

    case "pre": {
      const text = stripInvisible(element.textContent ?? "").replace(
        /\s+$/,
        "",
      );
      if (text.trim() !== "") {
        builder.block({ _tag: "code", text, quote: ctx.quote });
      }
      return;
    }

    case "ul":
    case "ol": {
      const items = listItems(element, ctx);
      if (items.length > 0) {
        builder.block({
          _tag: "list",
          ordered: tag === "ol",
          items,
          quote: ctx.quote,
        });
      }
      return;
    }

    case "blockquote": {
      const inner = blocksOf(kids, ctx);
      if (inner.length > 0) {
        builder.block({
          _tag: "blockquote",
          children: inner,
          quote: ctx.quote,
        });
      }
      return;
    }

    case "table": {
      if (ctx.options.keepDataTables && classifyTable(element) === "data") {
        const table = dataTable(element, ctx);
        if (table._tag === "table" && table.rows.length > 0) {
          builder.block(table);
          return;
        }
      }
      // Layout: the grid is scaffolding, so it comes apart — a row at a time,
      // because a row was a line.
      layoutTable(element, ctx, builder);
      return;
    }

    case "tbody":
    case "thead":
    case "tfoot":
    case "tr":
      walk(kids, ctx, builder);
      return;

    case "td":
    case "th":
    case "li":
      // Reached only inside a layout table (or a malformed list): each cell is
      // its own region, so it can't run into the next one.
      builder.flush();
      walk(kids, ctx, builder);
      builder.flush();
      return;

    default:
      if (BLOCK_CONTAINERS.has(tag)) {
        builder.flush();
        walk(kids, ctx, builder);
        builder.flush();
        return;
      }
      // Unknown tag: no opinion about it, so keep its content.
      walk(kids, ctx, builder);
      return;
  }
};

export const convert = (
  root: DomElement,
  options: ZenOptions,
): ReadonlyArray<Block> =>
  blocksOf(children(root), {
    options,
    quote: undefined,
    budget: { images: 0 },
  });
