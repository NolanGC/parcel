//// Table handling: the layout-vs-data decision, span expansion, and the
//// Markdown emission shape ported from `pdf-inspector/src/tables/format.rs`.
////
//// Email uses `<table>` for layout far more often than for data, so the one
//// unavoidable judgement in this pipeline lives here. It is a single pure
//// predicate over observable DOM signals — not a classifier, and not a
//// routing layer. Layout tables get unwrapped by `normalize`; data tables
//// come through `to_markdown`.

import email_to_markdown/dom.{type Node, Element, Text}
import email_to_markdown/style
import gleam/dict.{type Dict}
import gleam/int
import gleam/list
import gleam/option
import gleam/string

/// A cell in the source grid, before span expansion.
pub type Cell {
  Cell(
    content: List(Node),
    header: Bool,
    colspan: Int,
    rowspan: Int,
    align: Align,
  )
}

/// Column alignment. Unlike image size, this is something Markdown *can*
/// express — GFM encodes it in the separator row — so discarding the
/// source's `align` / `text-align` was pure loss.
pub type Align {
  AlignDefault
  AlignLeft
  AlignCenter
  AlignRight
}

/// Longest a cell's text can be before the table reads as layout, not data.
const max_data_cell_length = 200

/// Renders a cell's inline content. Supplied by the emitter so this module
/// does not have to depend on it.
pub type RenderCell =
  fn(List(Node)) -> String

// ── Structure extraction ─────────────────────────────────────────────

/// Extract rows from a `<table>`, descending through `<tbody>`, `<thead>`
/// and `<tfoot>` (jsdom inserts a `<tbody>` even when the source omits it).
pub fn rows_of(node: Node) -> List(List(Cell)) {
  node
  |> collect_rows
  |> list.map(cells_of)
}

fn collect_rows(node: Node) -> List(Node) {
  case node {
    Text(_) -> []
    Element(tag:, children:, ..) ->
      case tag {
        "table" -> list.flat_map(children, section_rows)
        _ -> []
      }
  }
}

/// Rows live either directly under `<table>` or one level down inside a
/// section element. Anything deeper belongs to a nested table's own grid.
fn section_rows(node: Node) -> List(Node) {
  case node {
    Text(_) -> []
    Element(tag:, children:, ..) ->
      case tag {
        "tr" -> [node]
        "tbody" | "thead" | "tfoot" ->
          list.filter(children, fn(child) {
            case child {
              Element(tag: "tr", ..) -> True
              _ -> False
            }
          })
        _ -> []
      }
  }
}

fn cells_of(row: Node) -> List(Cell) {
  case row {
    Text(_) -> []
    Element(children:, ..) -> list.filter_map(children, to_cell)
  }
}

fn to_cell(node: Node) -> Result(Cell, Nil) {
  case node {
    Text(_) -> Error(Nil)
    Element(tag:, children:, ..) ->
      case tag {
        "td" | "th" ->
          Ok(Cell(
            content: children,
            header: tag == "th",
            colspan: span_attr(node, "colspan"),
            rowspan: span_attr(node, "rowspan"),
            align: cell_align(node),
          ))
        _ -> Error(Nil)
      }
  }
}

/// Alignment from the `align` attribute, falling back to `text-align`.
fn cell_align(node: Node) -> Align {
  let declared = case string.lowercase(dom.attr_or_empty(node, "align")) {
    "" -> {
      let styles = style.parse(dom.attr_or_empty(node, "style"))
      case style.get(styles, "text-align") {
        option.Some(value) -> value
        option.None -> ""
      }
    }
    value -> value
  }

  case declared {
    "center" -> AlignCenter
    "right" | "end" -> AlignRight
    "left" | "start" -> AlignLeft
    _ -> AlignDefault
  }
}

fn span_attr(node: Node, name: String) -> Int {
  case int.parse(dom.attr_or_empty(node, name)) {
    Ok(value) if value > 0 -> int.min(value, 100)
    _ -> 1
  }
}

// ── The decision ─────────────────────────────────────────────────────

/// Is this `<table>` presenting data, rather than doing layout?
///
/// True when all of:
///   1. `role` is neither `presentation` nor `none`, and
///   2. there are at least 2 rows and at least 2 columns, and
///   3. either a `<th>` is present, or the grid looks tabular — no nested
///      table, no block-level content inside cells, and no cell long enough
///      to be a body-copy column.
pub fn is_data_table(node: Node) -> Bool {
  let rows = rows_of(node)
  let role = string.lowercase(dom.attr_or_empty(node, "role"))

  let semantic_role = role != "presentation" && role != "none"
  let enough_rows = list.length(rows) >= 2
  let enough_columns = max_columns(rows) >= 2

  semantic_role
  && enough_rows
  && enough_columns
  && { has_header_cell(rows) || looks_tabular(rows) }
}

fn max_columns(rows: List(List(Cell))) -> Int {
  rows
  |> list.map(fn(row) {
    list.fold(row, 0, fn(total, cell) { total + int.max(cell.colspan, 1) })
  })
  |> list.fold(0, int.max)
}

fn has_header_cell(rows: List(List(Cell))) -> Bool {
  list.any(rows, list.any(_, fn(cell) { cell.header }))
}

/// The negative signals: nesting and block-level or long-form cell content
/// are what layout tables do and data tables do not.
fn looks_tabular(rows: List(List(Cell))) -> Bool {
  let cells = list.flatten(rows)

  let nested =
    list.any(cells, fn(cell) {
      list.any(cell.content, dom.has_descendant(_, "table"))
    })
  let blocky =
    list.any(cells, fn(cell) { list.any(cell.content, is_block_node) })
  let long =
    list.any(cells, fn(cell) {
      cell.content
      |> list.map(dom.text_content)
      |> string.concat
      |> string.trim
      |> string.length
      > max_data_cell_length
    })

  !nested && !blocky && !long
}

fn is_block_node(node: Node) -> Bool {
  case node {
    Text(_) -> False
    Element(tag:, ..) ->
      list.contains(["div", "p", "table", "ul", "ol", "blockquote"], tag)
  }
}

// ── Span expansion ───────────────────────────────────────────────────

/// Expand `colspan` / `rowspan` into a dense rectangular grid of strings.
///
/// Content lands in the span's first cell; continuation cells are empty,
/// which keeps a spanned header from being repeated across columns.
pub fn expand(
  rows: List(List(Cell)),
  render: RenderCell,
) -> List(List(String)) {
  let grid = expand_rows(rows, dict.new(), [], render)
  let width = grid |> list.map(list.length) |> list.fold(0, int.max)
  list.map(grid, pad_to(_, width))
}

fn expand_rows(
  rows: List(List(Cell)),
  carry: Dict(Int, Int),
  acc: List(List(String)),
  render: RenderCell,
) -> List(List(String)) {
  case rows {
    [] -> list.reverse(acc)
    [row, ..rest] -> {
      let #(cells, next_carry) =
        expand_row(row, carry, 0, [], dict.new(), render)
      expand_rows(rest, next_carry, [cells, ..acc], render)
    }
  }
}

fn expand_row(
  cells: List(Cell),
  carry: Dict(Int, Int),
  column: Int,
  out: List(String),
  next_carry: Dict(Int, Int),
  render: RenderCell,
) -> #(List(String), Dict(Int, Int)) {
  case dict.get(carry, column) {
    // A rowspan from an earlier row occupies this column.
    Ok(remaining) -> {
      let next_carry = case remaining > 1 {
        True -> dict.insert(next_carry, column, remaining - 1)
        False -> next_carry
      }
      expand_row(cells, carry, column + 1, ["", ..out], next_carry, render)
    }
    Error(_) ->
      case cells {
        [] -> #(list.reverse(out), next_carry)
        [cell, ..rest] -> {
          let width = int.max(cell.colspan, 1)
          let height = int.max(cell.rowspan, 1)
          let text = clean_cell(render(cell.content))
          let placed = [text, ..list.repeat("", width - 1)]

          let next_carry = case height > 1 {
            True ->
              range(column, column + width - 1)
              |> list.fold(next_carry, fn(acc, index) {
                dict.insert(acc, index, height - 1)
              })
            False -> next_carry
          }

          expand_row(
            rest,
            carry,
            column + width,
            list.append(list.reverse(placed), out),
            next_carry,
            render,
          )
        }
      }
  }
}

fn pad_to(row: List(String), width: Int) -> List(String) {
  list.append(row, list.repeat("", width - list.length(row)))
}

/// A cell may not contain a raw pipe or newline without breaking the table.
fn clean_cell(text: String) -> String {
  text
  |> string.replace("\n", " ")
  |> string.replace("|", "\\|")
  |> string.trim
}

// ── Emission ─────────────────────────────────────────────────────────

/// Render a data table as Markdown.
///
/// Ported shape from `format.rs`: compact, no padding, separator after the
/// first row. Token efficiency over visual alignment — the consumer is a
/// model, not a human reading raw source.
pub fn to_markdown(rows: List(List(Cell)), render: RenderCell) -> String {
  let full = rows |> expand(render) |> drop_empty_rows
  let keep = kept_columns(full)
  let grid = list.map(full, fn(row) { list.map(keep, at(row, _)) })
  let source_aligns = column_aligns(rows)
  let aligns = list.map(keep, at_align(source_aligns, _))

  case grid {
    [] -> ""
    [_, ..] -> {
      let separator =
        "|" <> { aligns |> list.map(marker) |> string.concat } <> "\n"

      grid
      |> list.index_map(fn(row, index) {
        let line = "|" <> string.join(row, "|") <> "|\n"
        case index {
          0 -> line <> separator
          _ -> line
        }
      })
      |> string.concat
    }
  }
}

fn marker(align: Align) -> String {
  case align {
    AlignDefault -> "---|"
    AlignLeft -> ":---|"
    AlignCenter -> ":---:|"
    AlignRight -> "---:|"
  }
}

/// The alignment of each source column, taken from the first cell that
/// declares one. Colspan is honoured so offsets stay correct.
fn column_aligns(rows: List(List(Cell))) -> List(Align) {
  list.fold(rows, [], fn(acc, row) {
    let #(_, found) =
      list.fold(row, #(0, acc), fn(state, cell) {
        let #(column, acc) = state
        let width = int.max(cell.colspan, 1)
        #(column + width, put_align(acc, column, cell.align))
      })
    found
  })
}

/// Record an alignment at `column`, extending the list and never overwriting
/// one already established.
fn put_align(aligns: List(Align), column: Int, align: Align) -> List(Align) {
  case aligns, column {
    [], 0 -> [align]
    [], _ -> [AlignDefault, ..put_align([], column - 1, align)]
    [first, ..rest], 0 ->
      case first {
        AlignDefault -> [align, ..rest]
        _ -> [first, ..rest]
      }
    [first, ..rest], _ -> [first, ..put_align(rest, column - 1, align)]
  }
}

fn at_align(aligns: List(Align), index: Int) -> Align {
  case list.drop(aligns, index) {
    [value, ..] -> value
    [] -> AlignDefault
  }
}

fn drop_empty_rows(grid: List(List(String))) -> List(List(String)) {
  list.filter(grid, fn(row) { list.any(row, fn(cell) { cell != "" }) })
}

/// Which column indices survive. Layout scaffolding frequently leaves
/// entirely blank spacer columns; the alignment list is filtered by the same
/// indices so the two cannot drift apart.
fn kept_columns(grid: List(List(String))) -> List(Int) {
  case grid {
    [] -> []
    [first, ..] ->
      case list.length(first) {
        0 -> []
        width ->
          range(0, width - 1)
          |> list.filter(fn(index) {
            list.any(grid, fn(row) { at(row, index) != "" })
          })
      }
  }
}

fn at(row: List(String), index: Int) -> String {
  case list.drop(row, index) {
    [value, ..] -> value
    [] -> ""
  }
}

/// `list.range` left gleam_stdlib v1; an inclusive ascending range is all we
/// need here.
fn range(from: Int, to: Int) -> List(Int) {
  case from > to {
    True -> []
    False -> [from, ..range(from + 1, to)]
  }
}
