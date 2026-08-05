import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $int from "../../gleam_stdlib/gleam/int.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import * as $dom from "../email_to_markdown/dom.mjs";
import { Element, Text } from "../email_to_markdown/dom.mjs";
import * as $style from "../email_to_markdown/style.mjs";
import {
  Ok,
  Error,
  toList,
  Empty as $Empty,
  List$Empty$const as $List$Empty$const,
  prepend as listPrepend,
  CustomType as $CustomType,
} from "../gleam.mjs";

export class Cell extends $CustomType {
  constructor(content, header, colspan, rowspan, align) {
    super();
    this.content = content;
    this.header = header;
    this.colspan = colspan;
    this.rowspan = rowspan;
    this.align = align;
  }
}
export const Cell$Cell = (content, header, colspan, rowspan, align) =>
  new Cell(content, header, colspan, rowspan, align);
export const Cell$isCell = (value) => value instanceof Cell;
export const Cell$Cell$content = (value) => value.content;
export const Cell$Cell$0 = (value) => value.content;
export const Cell$Cell$header = (value) => value.header;
export const Cell$Cell$1 = (value) => value.header;
export const Cell$Cell$colspan = (value) => value.colspan;
export const Cell$Cell$2 = (value) => value.colspan;
export const Cell$Cell$rowspan = (value) => value.rowspan;
export const Cell$Cell$3 = (value) => value.rowspan;
export const Cell$Cell$align = (value) => value.align;
export const Cell$Cell$4 = (value) => value.align;

export class AlignDefault extends $CustomType {}
export const Align$AlignDefault$const = new AlignDefault();
export const Align$AlignDefault = () => Align$AlignDefault$const;
export const Align$isAlignDefault = (value) => value instanceof AlignDefault;

export class AlignLeft extends $CustomType {}
export const Align$AlignLeft$const = new AlignLeft();
export const Align$AlignLeft = () => Align$AlignLeft$const;
export const Align$isAlignLeft = (value) => value instanceof AlignLeft;

export class AlignCenter extends $CustomType {}
export const Align$AlignCenter$const = new AlignCenter();
export const Align$AlignCenter = () => Align$AlignCenter$const;
export const Align$isAlignCenter = (value) => value instanceof AlignCenter;

export class AlignRight extends $CustomType {}
export const Align$AlignRight$const = new AlignRight();
export const Align$AlignRight = () => Align$AlignRight$const;
export const Align$isAlignRight = (value) => value instanceof AlignRight;

/**
 * Longest a cell's text can be before the table reads as layout, not data.
 * 
 * @ignore
 */
const max_data_cell_length = 200;

/**
 * Alignment from the `align` attribute, falling back to `text-align`.
 * 
 * @ignore
 */
function cell_align(node) {
  let _block;
  let $ = $string.lowercase($dom.attr_or_empty(node, "align"));
  if ($ === "") {
    let styles = $style.parse($dom.attr_or_empty(node, "style"));
    let $1 = $style.get(styles, "text-align");
    if ($1 instanceof $option.Some) {
      let value = $1[0];
      _block = value;
    } else {
      _block = "";
    }
  } else {
    _block = $;
  }
  let declared = _block;
  if (declared === "center") {
    return Align$AlignCenter$const;
  } else if (declared === "right") {
    return Align$AlignRight$const;
  } else if (declared === "end") {
    return Align$AlignRight$const;
  } else if (declared === "left") {
    return Align$AlignLeft$const;
  } else if (declared === "start") {
    return Align$AlignLeft$const;
  } else {
    return Align$AlignDefault$const;
  }
}

function span_attr(node, name) {
  let $ = $int.parse($dom.attr_or_empty(node, name));
  if ($ instanceof Ok) {
    let value = $[0];
    if (value > 0) {
      return $int.min(value, 100);
    } else {
      return 1;
    }
  } else {
    return 1;
  }
}

function to_cell(node) {
  if (node instanceof Element) {
    let tag = node.tag;
    let children = node.children;
    if (tag === "td") {
      return new Ok(
        new Cell(
          children,
          tag === "th",
          span_attr(node, "colspan"),
          span_attr(node, "rowspan"),
          cell_align(node),
        ),
      );
    } else if (tag === "th") {
      return new Ok(
        new Cell(
          children,
          tag === "th",
          span_attr(node, "colspan"),
          span_attr(node, "rowspan"),
          cell_align(node),
        ),
      );
    } else {
      return new Error(undefined);
    }
  } else {
    return new Error(undefined);
  }
}

function cells_of(row) {
  if (row instanceof Element) {
    let children = row.children;
    return $list.filter_map(children, to_cell);
  } else {
    return $List$Empty$const;
  }
}

/**
 * Rows live either directly under `<table>` or one level down inside a
 * section element. Anything deeper belongs to a nested table's own grid.
 * 
 * @ignore
 */
function section_rows(node) {
  if (node instanceof Element) {
    let tag = node.tag;
    let children = node.children;
    if (tag === "tr") {
      return toList([node]);
    } else if (tag === "tbody") {
      return $list.filter(
        children,
        (child) => {
          if (child instanceof Element) {
            let $ = child.tag;
            if ($ === "tr") {
              return true;
            } else {
              return false;
            }
          } else {
            return false;
          }
        },
      );
    } else if (tag === "thead") {
      return $list.filter(
        children,
        (child) => {
          if (child instanceof Element) {
            let $ = child.tag;
            if ($ === "tr") {
              return true;
            } else {
              return false;
            }
          } else {
            return false;
          }
        },
      );
    } else if (tag === "tfoot") {
      return $list.filter(
        children,
        (child) => {
          if (child instanceof Element) {
            let $ = child.tag;
            if ($ === "tr") {
              return true;
            } else {
              return false;
            }
          } else {
            return false;
          }
        },
      );
    } else {
      return $List$Empty$const;
    }
  } else {
    return $List$Empty$const;
  }
}

function collect_rows(node) {
  if (node instanceof Element) {
    let tag = node.tag;
    let children = node.children;
    if (tag === "table") {
      return $list.flat_map(children, section_rows);
    } else {
      return $List$Empty$const;
    }
  } else {
    return $List$Empty$const;
  }
}

/**
 * Extract rows from a `<table>`, descending through `<tbody>`, `<thead>`
 * and `<tfoot>` (jsdom inserts a `<tbody>` even when the source omits it).
 */
export function rows_of(node) {
  let _pipe = node;
  let _pipe$1 = collect_rows(_pipe);
  return $list.map(_pipe$1, cells_of);
}

function is_block_node(node) {
  if (node instanceof Element) {
    let tag = node.tag;
    return $list.contains(
      toList(["div", "p", "table", "ul", "ol", "blockquote"]),
      tag,
    );
  } else {
    return false;
  }
}

/**
 * The negative signals: nesting and block-level or long-form cell content
 * are what layout tables do and data tables do not.
 * 
 * @ignore
 */
function looks_tabular(rows) {
  let cells = $list.flatten(rows);
  let nested = $list.any(
    cells,
    (cell) => {
      return $list.any(
        cell.content,
        (_capture) => { return $dom.has_descendant(_capture, "table"); },
      );
    },
  );
  let blocky = $list.any(
    cells,
    (cell) => { return $list.any(cell.content, is_block_node); },
  );
  let long = $list.any(
    cells,
    (cell) => {
      return (() => {
        let _pipe = cell.content;
        let _pipe$1 = $list.map(_pipe, $dom.text_content);
        let _pipe$2 = $string.concat(_pipe$1);
        let _pipe$3 = $string.trim(_pipe$2);
        return $string.length(_pipe$3);
      })() > max_data_cell_length;
    },
  );
  return (!nested && !blocky) && !long;
}

function has_header_cell(rows) {
  return $list.any(
    rows,
    (_capture) => {
      return $list.any(_capture, (cell) => { return cell.header; });
    },
  );
}

function max_columns(rows) {
  let _pipe = rows;
  let _pipe$1 = $list.map(
    _pipe,
    (row) => {
      return $list.fold(
        row,
        0,
        (total, cell) => { return total + $int.max(cell.colspan, 1); },
      );
    },
  );
  return $list.fold(_pipe$1, 0, $int.max);
}

/**
 * Is this `<table>` presenting data, rather than doing layout?
 *
 * True when all of:
 *   1. `role` is neither `presentation` nor `none`, and
 *   2. there are at least 2 rows and at least 2 columns, and
 *   3. either a `<th>` is present, or the grid looks tabular — no nested
 *      table, no block-level content inside cells, and no cell long enough
 *      to be a body-copy column.
 */
export function is_data_table(node) {
  let rows = rows_of(node);
  let role = $string.lowercase($dom.attr_or_empty(node, "role"));
  let semantic_role = (role !== "presentation") && (role !== "none");
  let enough_rows = $list.length(rows) >= 2;
  let enough_columns = max_columns(rows) >= 2;
  return ((semantic_role && enough_rows) && enough_columns) && (has_header_cell(
    rows,
  ) || looks_tabular(rows));
}

function pad_to(row, width) {
  return $list.append(row, $list.repeat("", width - $list.length(row)));
}

/**
 * `list.range` left gleam_stdlib v1; an inclusive ascending range is all we
 * need here.
 * 
 * @ignore
 */
function range(from, to) {
  let $ = from > to;
  if ($) {
    return $List$Empty$const;
  } else {
    return listPrepend(from, range(from + 1, to));
  }
}

/**
 * A cell may not contain a raw pipe or newline without breaking the table.
 * 
 * @ignore
 */
function clean_cell(text) {
  let _pipe = text;
  let _pipe$1 = $string.replace(_pipe, "\n", " ");
  let _pipe$2 = $string.replace(_pipe$1, "|", "\\|");
  return $string.trim(_pipe$2);
}

function expand_row(
  loop$cells,
  loop$carry,
  loop$column,
  loop$out,
  loop$next_carry,
  loop$render
) {
  while (true) {
    let cells = loop$cells;
    let carry = loop$carry;
    let column = loop$column;
    let out = loop$out;
    let next_carry = loop$next_carry;
    let render = loop$render;
    let $ = $dict.get(carry, column);
    if ($ instanceof Ok) {
      let remaining = $[0];
      let _block;
      let $1 = remaining > 1;
      if ($1) {
        _block = $dict.insert(next_carry, column, remaining - 1);
      } else {
        _block = next_carry;
      }
      let next_carry$1 = _block;
      loop$cells = cells;
      loop$carry = carry;
      loop$column = column + 1;
      loop$out = listPrepend("", out);
      loop$next_carry = next_carry$1;
      loop$render = render;
    } else {
      if (cells instanceof $Empty) {
        return [$list.reverse(out), next_carry];
      } else {
        let cell = cells.head;
        let rest = cells.tail;
        let width = $int.max(cell.colspan, 1);
        let height = $int.max(cell.rowspan, 1);
        let text = clean_cell(render(cell.content));
        let placed = listPrepend(text, $list.repeat("", width - 1));
        let _block;
        let $1 = height > 1;
        if ($1) {
          let _pipe = range(column, (column + width) - 1);
          _block = $list.fold(
            _pipe,
            next_carry,
            (acc, index) => { return $dict.insert(acc, index, height - 1); },
          );
        } else {
          _block = next_carry;
        }
        let next_carry$1 = _block;
        loop$cells = rest;
        loop$carry = carry;
        loop$column = column + width;
        loop$out = $list.append($list.reverse(placed), out);
        loop$next_carry = next_carry$1;
        loop$render = render;
      }
    }
  }
}

function expand_rows(loop$rows, loop$carry, loop$acc, loop$render) {
  while (true) {
    let rows = loop$rows;
    let carry = loop$carry;
    let acc = loop$acc;
    let render = loop$render;
    if (rows instanceof $Empty) {
      return $list.reverse(acc);
    } else {
      let row = rows.head;
      let rest = rows.tail;
      let $ = expand_row(row, carry, 0, $List$Empty$const, $dict.new$(), render);
      let cells = $[0];
      let next_carry = $[1];
      loop$rows = rest;
      loop$carry = next_carry;
      loop$acc = listPrepend(cells, acc);
      loop$render = render;
    }
  }
}

/**
 * Expand `colspan` / `rowspan` into a dense rectangular grid of strings.
 *
 * Content lands in the span's first cell; continuation cells are empty,
 * which keeps a spanned header from being repeated across columns.
 */
export function expand(rows, render) {
  let grid = expand_rows(rows, $dict.new$(), $List$Empty$const, render);
  let _block;
  let _pipe = grid;
  let _pipe$1 = $list.map(_pipe, $list.length);
  _block = $list.fold(_pipe$1, 0, $int.max);
  let width = _block;
  return $list.map(grid, (_capture) => { return pad_to(_capture, width); });
}

function marker(align) {
  if (align instanceof AlignDefault) {
    return "---|";
  } else if (align instanceof AlignLeft) {
    return ":---|";
  } else if (align instanceof AlignCenter) {
    return ":---:|";
  } else {
    return "---:|";
  }
}

function at_align(aligns, index) {
  let $ = $list.drop(aligns, index);
  if ($ instanceof $Empty) {
    return Align$AlignDefault$const;
  } else {
    let value = $.head;
    return value;
  }
}

/**
 * Record an alignment at `column`, extending the list and never overwriting
 * one already established.
 * 
 * @ignore
 */
function put_align(aligns, column, align) {
  if (aligns instanceof $Empty) {
    if (column === 0) {
      return toList([align]);
    } else {
      return listPrepend(
        Align$AlignDefault$const,
        put_align($List$Empty$const, column - 1, align),
      );
    }
  } else if (column === 0) {
    let first = aligns.head;
    let rest = aligns.tail;
    if (first instanceof AlignDefault) {
      return listPrepend(align, rest);
    } else {
      return listPrepend(first, rest);
    }
  } else {
    let first = aligns.head;
    let rest = aligns.tail;
    return listPrepend(first, put_align(rest, column - 1, align));
  }
}

/**
 * The alignment of each source column, taken from the first cell that
 * declares one. Colspan is honoured so offsets stay correct.
 * 
 * @ignore
 */
function column_aligns(rows) {
  return $list.fold(
    rows,
    $List$Empty$const,
    (acc, row) => {
      let $ = $list.fold(
        row,
        [0, acc],
        (state, cell) => {
          let column = state[0];
          let acc$1 = state[1];
          let width = $int.max(cell.colspan, 1);
          return [column + width, put_align(acc$1, column, cell.align)];
        },
      );
      let found = $[1];
      return found;
    },
  );
}

function at(row, index) {
  let $ = $list.drop(row, index);
  if ($ instanceof $Empty) {
    return "";
  } else {
    let value = $.head;
    return value;
  }
}

/**
 * Which column indices survive. Layout scaffolding frequently leaves
 * entirely blank spacer columns; the alignment list is filtered by the same
 * indices so the two cannot drift apart.
 * 
 * @ignore
 */
function kept_columns(grid) {
  if (grid instanceof $Empty) {
    return grid;
  } else {
    let first = grid.head;
    let $ = $list.length(first);
    if ($ === 0) {
      return $List$Empty$const;
    } else {
      let width = $;
      let _pipe = range(0, width - 1);
      return $list.filter(
        _pipe,
        (index) => {
          return $list.any(grid, (row) => { return at(row, index) !== ""; });
        },
      );
    }
  }
}

function drop_empty_rows(grid) {
  return $list.filter(
    grid,
    (row) => { return $list.any(row, (cell) => { return cell !== ""; }); },
  );
}

/**
 * Render a data table as Markdown.
 *
 * Ported shape from `format.rs`: compact, no padding, separator after the
 * first row. Token efficiency over visual alignment — the consumer is a
 * model, not a human reading raw source.
 */
export function to_markdown(rows, render) {
  let _block;
  let _pipe = rows;
  let _pipe$1 = expand(_pipe, render);
  _block = drop_empty_rows(_pipe$1);
  let full = _block;
  let keep = kept_columns(full);
  let grid = $list.map(
    full,
    (row) => {
      return $list.map(keep, (_capture) => { return at(row, _capture); });
    },
  );
  let source_aligns = column_aligns(rows);
  let aligns = $list.map(
    keep,
    (_capture) => { return at_align(source_aligns, _capture); },
  );
  if (grid instanceof $Empty) {
    return "";
  } else {
    let separator = ("|" + (() => {
      let _pipe$2 = aligns;
      let _pipe$3 = $list.map(_pipe$2, marker);
      return $string.concat(_pipe$3);
    })()) + "\n";
    let _pipe$2 = grid;
    let _pipe$3 = $list.index_map(
      _pipe$2,
      (row, index) => {
        let line = ("|" + $string.join(row, "|")) + "|\n";
        if (index === 0) {
          return line + separator;
        } else {
          return line;
        }
      },
    );
    return $string.concat(_pipe$3);
  }
}
