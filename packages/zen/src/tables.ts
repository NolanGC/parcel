// Telling a table apart from a page.
//
// This is the single decision that most determines whether the output reads
// like an email or like a spreadsheet accident. Email predates flexbox by two
// decades and clients still don't agree on it, so newsletters are built out of
// nested `<table>` — sometimes eight deep — where every cell is a column, a
// gutter, or a spacer. Rendered as GFM tables that becomes an unreadable grid
// of pipes. But a receipt, an invoice, a schedule: those are genuinely tabular
// and flattening them destroys the alignment that carries the meaning.
//
// So: a table is data only when it looks like data. The heuristics below run
// cheapest-and-most-certain first, and the fallback is "layout", because a
// real table flattened is merely plainer while a layout table preserved is
// unreadable.

import {
  attr,
  children,
  descendants,
  type DomElement,
  isElement,
  tagOf,
} from "./dom.ts";

export type TableKind = "layout" | "data";

/** Content that has no business inside a data cell. A cell holding a nested
 *  table or a heading is a region of a page, not a value. */
const BLOCK_IN_CELL: ReadonlySet<string> = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "ol",
  "table",
  "ul",
]);

// Past these lengths a cell is prose, and prose in a grid is a layout column.
// Two thresholds because the failure modes differ: one long cell among short
// ones is a note on a real table, while a table whose cells are *typically*
// sentence-length is a newsletter's two-column body copy.
const MAX_DATA_CELL_LENGTH = 80;
const MAX_MEAN_CELL_LENGTH = 40;

export const rowsOf = (table: DomElement): ReadonlyArray<DomElement> => {
  // Ownership has to be established before rows can be filtered by it, and
  // callers reach rowsOf by more than one path (classification, then the
  // layout walk). Claiming is guarded per row, so running it twice is free.
  claimRows(table);
  return descendants(table, (element) => tagOf(element) === "tr").filter(
    // Rows belonging to a nested table are that table's problem, not ours.
    (row) => nearestTable(row) === table,
  );
};

export const cellsOf = (row: DomElement): ReadonlyArray<DomElement> =>
  children(row).filter(
    (child): child is DomElement =>
      isElement(child) && (tagOf(child) === "td" || tagOf(child) === "th"),
  );

// `descendants` gives no parent pointers, so ownership is resolved by walking
// down from the table and remembering what we passed through. Cheap enough:
// this runs once per table, over that table's own subtree.
const tableOwners = new WeakMap<DomElement, DomElement>();

const nearestTable = (row: DomElement): DomElement | undefined =>
  tableOwners.get(row);

const claimRows = (table: DomElement): void => {
  const visit = (node: DomElement): void => {
    for (const child of children(node)) {
      if (!isElement(child)) continue;
      const tag = tagOf(child);
      // Stop at a nested table; its own claimRows pass will take those rows.
      if (tag === "table") continue;
      if (tag === "tr" && !tableOwners.has(child))
        tableOwners.set(child, table);
      visit(child);
    }
  };
  visit(table);
};

const hasBorder = (table: DomElement): boolean => {
  const border = attr(table, "border");
  return border !== undefined && Number.parseInt(border, 10) >= 1;
};

const cellText = (cell: DomElement): string =>
  (cell.textContent ?? "").replace(/\s+/g, " ").trim();

const cellHoldsBlock = (cell: DomElement): boolean =>
  descendants(cell, (element) => BLOCK_IN_CELL.has(tagOf(element))).length > 0;

export const classifyTable = (table: DomElement): TableKind => {
  claimRows(table);

  // Senders who mean "this is layout" say so, and they say it far more often
  // than they mark up a real table correctly. Trust it.
  const role = attr(table, "role")?.toLowerCase();
  if (role === "presentation" || role === "none") return "layout";

  const rows = rowsOf(table);
  const cells = rows.map(cellsOf);

  const hasHeaderCell = cells.some((row) =>
    row.some((cell) => tagOf(cell) === "th"),
  );
  const hasCaption =
    descendants(table, (element) => tagOf(element) === "caption").length > 0;
  if (hasHeaderCell || hasCaption || hasBorder(table)) return "data";

  const columns = Math.max(0, ...cells.map((row) => row.length));
  // One row is a banner, one column is a stack. Neither needs a grid.
  if (rows.length < 2 || columns < 2) return "layout";

  const everyCell = cells.flat();
  if (everyCell.some(cellHoldsBlock)) return "layout";

  const lengths = everyCell.map((cell) => cellText(cell).length);
  if (lengths.some((length) => length > MAX_DATA_CELL_LENGTH)) return "layout";
  const mean =
    lengths.length === 0
      ? 0
      : lengths.reduce((total, length) => total + length, 0) / lengths.length;
  if (mean > MAX_MEAN_CELL_LENGTH) return "layout";

  // A grid of short text in a consistent shape. Ragged rows are the tell for
  // a layout built with colspans, so require most rows to agree on width.
  const consistent =
    cells.filter((row) => row.length === columns).length >= rows.length - 1;
  return consistent ? "data" : "layout";
};
