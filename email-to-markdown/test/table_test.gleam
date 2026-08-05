import email_to_markdown/dom
import email_to_markdown/table
import gleam/dict
import gleam/list
import gleam/string

fn element(tag: String, attrs: List(#(String, String)), children) {
  dom.Element(tag, dict.from_list(attrs), children)
}

fn cell(tag: String, attrs: List(#(String, String)), text: String) {
  element(tag, attrs, [dom.Text(text)])
}

fn row(cells) {
  element("tr", [], cells)
}

fn grid(attrs: List(#(String, String)), rows) {
  element("table", attrs, [element("tbody", [], rows)])
}

fn render(nodes) {
  nodes |> list.map(dom.text_content) |> string.concat
}

// ── is_data_table ────────────────────────────────────────────────────

pub fn header_cells_make_a_data_table_test() {
  let node =
    grid([], [
      row([cell("th", [], "Date"), cell("th", [], "Amount")]),
      row([cell("td", [], "Oct 3"), cell("td", [], "$49")]),
    ])

  assert table.is_data_table(node)
}

pub fn role_presentation_is_never_a_data_table_test() {
  let node =
    grid([#("role", "presentation")], [
      row([cell("th", [], "Date"), cell("th", [], "Amount")]),
      row([cell("td", [], "Oct 3"), cell("td", [], "$49")]),
    ])

  assert table.is_data_table(node) == False
}

pub fn single_column_is_not_a_data_table_test() {
  let node = grid([], [row([cell("td", [], "a")]), row([cell("td", [], "b")])])

  assert table.is_data_table(node) == False
}

pub fn single_row_is_not_a_data_table_test() {
  let node = grid([], [row([cell("td", [], "a"), cell("td", [], "b")])])

  assert table.is_data_table(node) == False
}

pub fn short_headerless_grid_is_a_data_table_test() {
  let node =
    grid([], [
      row([cell("td", [], "Plan"), cell("td", [], "Price")]),
      row([cell("td", [], "Pro"), cell("td", [], "$49")]),
    ])

  assert table.is_data_table(node)
}

pub fn nested_table_marks_it_as_layout_test() {
  let inner = grid([], [row([cell("td", [], "x"), cell("td", [], "y")])])
  let node =
    grid([], [
      row([element("td", [], [inner]), cell("td", [], "b")]),
      row([cell("td", [], "c"), cell("td", [], "d")]),
    ])

  assert table.is_data_table(node) == False
}

pub fn block_content_in_cells_marks_it_as_layout_test() {
  let node =
    grid([], [
      row([
        element("td", [], [element("p", [], [dom.Text("Body copy")])]),
        cell("td", [], "b"),
      ]),
      row([cell("td", [], "c"), cell("td", [], "d")]),
    ])

  assert table.is_data_table(node) == False
}

pub fn long_cell_text_marks_it_as_layout_test() {
  let long = string.repeat("word ", 60)
  let node =
    grid([], [
      row([cell("td", [], long), cell("td", [], "b")]),
      row([cell("td", [], "c"), cell("td", [], "d")]),
    ])

  assert table.is_data_table(node) == False
}

// ── span expansion ───────────────────────────────────────────────────

pub fn colspan_fills_continuation_cells_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([cell("th", [], "A"), cell("th", [], "B"), cell("th", [], "C")]),
        row([cell("td", [#("colspan", "2")], "wide"), cell("td", [], "z")]),
      ]),
    )

  assert table.expand(rows, render) == [["A", "B", "C"], ["wide", "", "z"]]
}

pub fn rowspan_carries_into_following_rows_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([cell("td", [#("rowspan", "2")], "tall"), cell("td", [], "b")]),
        row([cell("td", [], "c")]),
      ]),
    )

  assert table.expand(rows, render) == [["tall", "b"], ["", "c"]]
}

pub fn rows_are_padded_to_equal_width_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([cell("td", [], "a"), cell("td", [], "b"), cell("td", [], "c")]),
        row([cell("td", [], "d")]),
      ]),
    )

  assert table.expand(rows, render) == [["a", "b", "c"], ["d", "", ""]]
}

// ── emission ─────────────────────────────────────────────────────────

pub fn to_markdown_emits_compact_grid_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([cell("th", [], "Date"), cell("th", [], "Amount")]),
        row([cell("td", [], "Oct 3"), cell("td", [], "$49")]),
      ]),
    )

  assert table.to_markdown(rows, render)
    == "|Date|Amount|\n|---|---|\n|Oct 3|$49|\n"
}

pub fn pipes_in_cells_are_escaped_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([cell("th", [], "A"), cell("th", [], "B")]),
        row([cell("td", [], "x|y"), cell("td", [], "z")]),
      ]),
    )

  assert string.contains(table.to_markdown(rows, render), "x\\|y")
}

pub fn entirely_blank_spacer_columns_are_dropped_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([cell("th", [], "A"), cell("th", [], ""), cell("th", [], "B")]),
        row([cell("td", [], "1"), cell("td", [], ""), cell("td", [], "2")]),
      ]),
    )

  assert table.to_markdown(rows, render) == "|A|B|\n|---|---|\n|1|2|\n"
}

// ── Column alignment ─────────────────────────────────────────────────

/// Unlike image size, alignment is something Markdown *can* express — GFM
/// encodes it in the separator row — so discarding `align` was pure loss.
pub fn align_attribute_becomes_separator_markers_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([
          cell("th", [#("align", "center")], "A"),
          cell("th", [], "B"),
          cell("th", [#("align", "right")], "C"),
        ]),
        row([
          cell("td", [], "1"),
          cell("td", [], "2"),
          cell("td", [], "3"),
        ]),
      ]),
    )

  assert table.to_markdown(rows, render)
    == "|A|B|C|\n|:---:|---|---:|\n|1|2|3|\n"
}

pub fn text_align_style_is_honoured_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([
          cell("th", [#("style", "text-align:left")], "A"),
          cell("th", [#("style", "text-align:right")], "B"),
        ]),
        row([cell("td", [], "1"), cell("td", [], "2")]),
      ]),
    )

  assert table.to_markdown(rows, render) == "|A|B|\n|:---|---:|\n|1|2|\n"
}

/// A body cell's alignment applies when the header declares none.
pub fn alignment_falls_through_from_body_cells_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([cell("th", [], "A"), cell("th", [], "B")]),
        row([
          cell("td", [], "1"),
          cell("td", [#("align", "right")], "2"),
        ]),
      ]),
    )

  assert table.to_markdown(rows, render) == "|A|B|\n|---|---:|\n|1|2|\n"
}

/// Dropped spacer columns must not shift the alignment list out of step.
pub fn alignment_survives_empty_column_pruning_test() {
  let rows =
    table.rows_of(
      grid([], [
        row([
          cell("th", [], "A"),
          cell("th", [], ""),
          cell("th", [#("align", "right")], "C"),
        ]),
        row([cell("td", [], "1"), cell("td", [], ""), cell("td", [], "3")]),
      ]),
    )

  assert table.to_markdown(rows, render) == "|A|C|\n|---|---:|\n|1|3|\n"
}
