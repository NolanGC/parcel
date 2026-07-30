// The sets a sender laid out as sets.
//
// A newsletter's "recent articles" strip is two cards side by side, each a
// thumbnail over a headline over a summary over a link. A receipt is seven fare
// lines, each a label beside an amount. Both are *sets*: a run of units built to
// the same shape, meant to be read as one thing.
//
// The walk dissolves them. Layout tables come apart a row at a time, which is
// right — the grid was scaffolding — but it leaves two cards as twelve loose
// blocks with nothing recording that they were ever two of anything. That is
// what makes a converted newsletter read as an undifferentiated column: not the
// missing grid, the missing grouping. A reader can't see where one card ends.
//
// So the run is reported, exactly the way quotes and boilerplate are reported:
// line ranges over markdown that is not itself changed. A consumer that ignores
// groups gets the whole message in reading order; one that reads them can lay
// the units out side by side, or as cards, or as a table. Markdown stays a
// linear document, which is the only thing it knows how to be, and the shape
// lives where shape belongs.
//
// The bar is high on purpose, for the usual asymmetry: a set that isn't
// reported reads exactly as it does today, while prose wrongly cut into "units"
// reads as a bug.

import { attr, children, type DomElement, isElement, tagOf } from "./dom.ts";
import { cellsOf, rowsOf } from "./tables.ts";

/** How the units sat relative to each other. A row of cells was side by side
 *  on the page and can be laid out that way again; a column of stacked tables
 *  was a list, and a renderer that turns it sideways invents something the
 *  sender didn't write. */
export type GroupAxis = "row" | "column";

/** One unit of a set. Identity matters as much as the fields: the serializer
 *  groups adjacent lines by the mark object they came from, the same way quote
 *  marks work, so every block of one card has to carry the very same mark. */
export type GroupMark = Readonly<{
  /** Which set this unit belongs to. */
  id: number;
  /** Position within the set, in reading order. */
  index: number;
  /** How many units the set has, so a renderer can choose a layout before it
   *  has seen the last one. */
  size: number;
  axis: GroupAxis;
}>;

const textOf = (element: DomElement): string =>
  (element.textContent ?? "").replace(/\s+/g, " ").trim();

const elementsIn = (element: DomElement): ReadonlyArray<DomElement> => {
  const out: Array<DomElement> = [];
  const visit = (node: DomElement): void => {
    for (const child of children(node)) {
      if (!isElement(child)) continue;
      out.push(child);
      visit(child);
    }
  };
  visit(element);
  return out;
};

const HEADING = /^h[1-6]$/;

/** Long enough that the unit says something, rather than being a spacer or a
 *  stray bullet character in its own cell. */
const MIN_UNIT_TEXT = 12;

/** Past this a unit is prose, which is a different kind of thing from a label. */
const RICH_TEXT = 60;

/** What a unit is made of, coarsely. Two units belong to the same set when
 *  these agree.
 *
 *  Coarse on purpose. An exact tag sequence would be brittle in the one way
 *  that matters most: senders decorate some units and not others — four of
 *  seven Uber fare lines carry a little "what is this?" info icon and the rest
 *  don't — and a signature that noticed would split one receipt into four sets
 *  of one. What has to match is the kind of thing each unit is, not its
 *  punctuation. */
const signatureOf = (element: DomElement): string => {
  const inside = elementsIn(element);
  const has = (predicate: (tag: string) => boolean): boolean =>
    inside.some((child) => predicate(tagOf(child)));

  const parts: Array<string> = [];
  if (has((tag) => tag === "img")) parts.push("image");
  if (has(HEADING.test.bind(HEADING))) parts.push("heading");
  if (has((tag) => tag === "ul" || tag === "ol")) parts.push("list");
  if (has((tag) => tag === "a")) parts.push("link");

  const length = textOf(element).length;
  parts.push(
    length >= RICH_TEXT ? "prose" : length >= MIN_UNIT_TEXT ? "label" : "bare",
  );
  return parts.join("+");
};

/** Something a reader would recognise as a card rather than a line of text: a
 *  picture, a heading or a list of its own. Links alone are deliberately not
 *  enough — a footer's "Help · Privacy · Terms" is three matching cells and is
 *  furniture, not a set worth drawing. */
const isCardShape = (signature: string): boolean =>
  /image|heading|list/.test(signature) && !signature.endsWith("bare");

/** Cells of one layout row that are each the same kind of card.
 *
 *  This is the "two article cards side by side" case, and the axis is `row`
 *  because that is literally where they were. */
export const isCardRow = (cells: ReadonlyArray<DomElement>): boolean => {
  if (cells.length < 2) return false;
  const signatures = cells.map(signatureOf);
  const first = signatures[0];
  if (first === undefined) return false;
  if (signatures.some((signature) => signature !== first)) return false;
  return isCardShape(first);
};

/** A table holding one short row of values, and what shape that row is — the
 *  unit a receipt is built out of. Undefined for anything else, which is what
 *  breaks a run. */
const scalarShape = (element: DomElement): string | undefined => {
  if (tagOf(element) !== "table") return undefined;
  const rows = rowsOf(element);
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (row === undefined) return undefined;
  const cells = cellsOf(row);
  if (cells.length < 2) return undefined;

  // A cell holding a picture, a heading or another table is a region of a page,
  // not a value — the same judgement tables.ts makes about data cells.
  for (const cell of cells) {
    const nested = elementsIn(cell).map(tagOf);
    if (nested.some((tag) => tag === "table" || HEADING.test(tag))) {
      return undefined;
    }
    if (textOf(cell).length > RICH_TEXT) return undefined;
  }
  if (textOf(element).length < MIN_UNIT_TEXT) return undefined;

  // Counted by cells that say something, not by cells. Senders decorate some
  // units and not others, and the decoration gets its own cell: four of the
  // seven fare lines on a real Uber receipt carry a little "what is this?"
  // icon in a third cell and the rest have two cells, which read as two
  // different shapes and split one receipt into a run of four and three
  // strays. A cell with no words in it was never a value.
  const values = cells.filter((cell) => textOf(cell) !== "").length;
  if (values < 2) return undefined;

  return `scalar:${values}`;
};

/** Fewer than this and a "run" is a coincidence. Two adjacent one-row tables
 *  are how a great many newsletters draw a banner and the line under it; three
 *  built identically is somebody itemising something. */
const MIN_COLUMN_RUN = 3;

export type Run = Readonly<{
  /** Index into the element list this was found in. */
  start: number;
  /** Inclusive. */
  end: number;
  axis: GroupAxis;
}>;

/** Past this a unit is a section of the message rather than a card, and two
 *  sections that happen to be built alike are not a set anybody laid out. */
const MAX_CARD_TEXT = 600;

/** How many units a run needs, by how it was laid out.
 *
 *  A pair is only trusted when the sender *said* the two sat side by side, with
 *  a float or an `align` — that is a deliberate act, and two article cards is
 *  the single most common set in mail. Stacked, a pair is just "two blocks in a
 *  row", which is every message ever written: a scan of 400 real messages
 *  grouped a chess newsletter's content card with the social-icon bar under it,
 *  and a LinkedIn digest's headline block with the "this email was intended
 *  for" line, purely because each pair happened to hold a picture, a link and
 *  some words. Three of a shape, stacked, is somebody repeating a template. */
const MIN_RUN: Readonly<Record<GroupAxis, number>> = { row: 2, column: 3 };

/** Did the sender put this beside its neighbour rather than under it?
 *
 *  Mail cannot use flexbox, so side-by-side is always one of these two spellings
 *  — the `align` attribute Outlook honours, or a float for everyone else. Both
 *  Providence blog cards carry both. Absent either, the units were stacked, and
 *  saying otherwise would invent a layout the sender didn't write. */
/** How far apart in size two units of one set may be.
 *
 *  A set is a template filled in more than once, so its units are comparable in
 *  length: two article cards in the Providence mail run 231 and 257 characters.
 *  Without this the same rule matches one level too high, where the "make an
 *  appointment" block and the entire "recent blog articles" section are also
 *  two sibling tables that each hold a picture, a heading and some prose — and
 *  because a unit's insides are never searched for sets of their own, grouping
 *  the sections is not merely wrong, it hides the two real cards inside one of
 *  them. */
const MAX_SIZE_RATIO = 2.5;

/** What a unit of a set can be. Mail builds a card as its own `<table>` or
 *  `<div>`; a run of `<tr>` siblings is a table's own rows, which the layout
 *  walk already handles a row at a time, and calling those a set would report
 *  every two-row table in every message. */
const UNIT_TAGS: ReadonlySet<string> = new Set(["table", "div"]);

const isEvenlySized = (units: ReadonlyArray<DomElement>): boolean => {
  const lengths = units.map((unit) => textOf(unit).length);
  const smallest = Math.min(...lengths);
  const largest = Math.max(...lengths);
  if (smallest === 0) return false;
  return largest / smallest <= MAX_SIZE_RATIO;
};

const isBeside = (element: DomElement): boolean => {
  const align = attr(element, "align")?.toLowerCase();
  if (align === "left" || align === "right") return true;
  return /float\s*:\s*(left|right)/i.test(attr(element, "style") ?? "");
};

/** Runs of consecutive siblings that are each the same kind of card: a
 *  thumbnail over a headline over a summary over a link, twice.
 *
 *  The units are whole sibling elements rather than cells of a row because that
 *  is how mail builds a card strip — each card its own `<table>`, floated
 *  against the next — and at that point the two cards share no cell, no row and
 *  no table. Nothing in the walk can see they were ever two of anything. */
/** Is there a set somewhere below this element? Used only to let an inner set
 *  win over an outer one, so it stops at the first hit. */
const holdsRun = (element: DomElement): boolean => {
  const kids = children(element).filter(isElement);
  if (kids.length > 0) {
    if (cardRuns(kids).length > 0) return true;
    if (scalarRuns(kids).length > 0) return true;
  }
  return kids.some(holdsRun);
};

export const cardRuns = (
  elements: ReadonlyArray<DomElement>,
): ReadonlyArray<Run> => {
  const runs: Array<Run> = [];
  let start = 0;
  let shape: string | undefined;

  const shapeOf = (element: DomElement): string | undefined => {
    if (!UNIT_TAGS.has(tagOf(element))) return undefined;
    const text = textOf(element);
    if (text.length > MAX_CARD_TEXT) return undefined;
    const signature = signatureOf(element);
    return isCardShape(signature) ? signature : undefined;
  };

  const close = (end: number): void => {
    if (shape === undefined) return;
    const units = elements.slice(start, end + 1);
    const axis: GroupAxis = units.every(isBeside) ? "row" : "column";
    if (units.length < MIN_RUN[axis]) return;
    if (!isEvenlySized(units)) return;
    // Innermost wins. A unit holding a set of its own is a section, not a card,
    // and reporting the section would bury the cards: the walk stops looking
    // once it is inside a unit, so an outer set that swallows an inner one
    // doesn't merely mis-describe the message, it loses the real answer.
    if (units.some(holdsRun)) return;
    runs.push({ start, end, axis });
  };

  elements.forEach((element, index) => {
    const current = shapeOf(element);
    if (current !== undefined && current === shape) return;
    close(index - 1);
    shape = current;
    start = index;
  });
  close(elements.length - 1);

  return runs;
};

/** Runs of consecutive sibling tables that each state one short thing in the
 *  same shape: the fare lines of a receipt, the holdings of a statement.
 *
 *  Sibling tables rather than rows of one table because that is how the mail
 *  arrives — an ESP that puts every line in its own `<table>` is not doing
 *  anything unusual, and each such table, looked at alone, is correctly a
 *  layout table. The set only exists between them. */
export const scalarRuns = (
  elements: ReadonlyArray<DomElement>,
): ReadonlyArray<Run> => {
  const runs: Array<Run> = [];
  let start = 0;
  let shape: string | undefined;

  const close = (end: number): void => {
    if (shape !== undefined && end - start + 1 >= MIN_COLUMN_RUN) {
      runs.push({ start, end, axis: "column" });
    }
  };

  elements.forEach((element, index) => {
    const current = scalarShape(element);
    if (current !== undefined && current === shape) return;
    close(index - 1);
    shape = current;
    start = index;
  });
  close(elements.length - 1);

  return runs;
};

/** Hand out the marks for one set. */
export const marksFor = (
  id: number,
  size: number,
  axis: GroupAxis,
): ReadonlyArray<GroupMark> =>
  Array.from({ length: size }, (_, index) => ({ id, index, size, axis }));
