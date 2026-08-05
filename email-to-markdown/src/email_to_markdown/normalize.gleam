//// Tree normalization — the bulk of the work.
////
//// Runs bottom-up: children are normalized before their parent, so nested
//// layout tables and stacked wrappers resolve in a single pass with no
//// fixpoint iteration.
////
//// The goal is *semantic* fidelity, not visual. A marketing email's visual
//// structure is a 6-deep table grid; faithfully preserving it would produce
//// unreadable Markdown. Most of this module exists to destroy layout.

import email_to_markdown/chars
import email_to_markdown/classify
import email_to_markdown/dom.{type Node, Element, Text}
import email_to_markdown/heading
import email_to_markdown/style
import email_to_markdown/table
import gleam/dict
import gleam/list
import gleam/option
import gleam/string

/// Container classes mail clients use to mark a quoted reply chain.
const quote_classes = [
  "gmail_quote", "yahoo_quoted", "moz-cite-prefix", "outlookmessageheader",
  "gmail_extra", "protonmail_quote",
]

/// Tags whose only purpose is presentational grouping.
const unwrap_tags = [
  "font",
  "center",
  "tbody",
  "thead",
  "tfoot",
  "colgroup",
  "col",
  "figure",
]

/// Normalize a parsed, visibility-filtered tree.
pub fn run(node: Node) -> Node {
  go(node, False)
}

fn go(node: Node, in_pre: Bool) -> Node {
  case node {
    Text(content:) ->
      case in_pre {
        True -> node
        False -> Text(collapse_whitespace(content))
      }
    Element(tag:, attrs:, children:) -> {
      let nested_pre = in_pre || tag == "pre"
      let children =
        children
        |> list.flat_map(fn(child) { expand(child, nested_pre) })
        |> drop_noise
      rewrite(Element(tag, attrs, children))
    }
  }
}

/// Normalize a child, then decide whether it survives as its own node or is
/// spliced into its parent's child list.
fn expand(child: Node, in_pre: Bool) -> List(Node) {
  let normalized = go(child, in_pre)

  case normalized {
    Text(_) -> [normalized]
    Element(tag:, children:, ..) ->
      case should_unwrap(tag, normalized) {
        // Unwrapping discards the element's CSS, so a gap expressed only as
        // padding or margin has to become a real space or adjacent words
        // fuse ("HiNolan,").
        True ->
          case separates_neighbours(normalized) {
            True -> list.append(children, [Text(" ")])
            False -> children
          }
        False -> [normalized]
      }
  }
}

fn separates_neighbours(node: Node) -> Bool {
  node
  |> dom.attr_or_empty("style")
  |> style.parse
  |> style.has_horizontal_gap
}

fn should_unwrap(tag: String, node: Node) -> Bool {
  list.contains(unwrap_tags, tag)
  || { tag == "span" && !carries_inline_style(node) }
  // A wrapper div holding exactly one block child adds nothing.
  || { tag == "div" && is_redundant_wrapper(node) }
}

/// A `<span>` earns its existence only when it encodes formatting. Emails
/// express bold and italic through inline CSS far more often than through
/// `<strong>` / `<em>`, so those spans must survive to the emitter.
pub fn carries_inline_style(node: Node) -> Bool {
  let styles = style.parse(dom.attr_or_empty(node, "style"))

  style.is_bold(styles) || style.is_italic(styles) || style.is_decorated(styles)
}

fn is_redundant_wrapper(node: Node) -> Bool {
  case node {
    Element(attrs:, children: [Element(tag: child_tag, ..)], ..) ->
      dict.size(attrs) == 0 && is_block_tag(child_tag)
    _ -> False
  }
}

fn is_block_tag(tag: String) -> Bool {
  list.contains(
    [
      "div", "p", "table", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3",
      "h4", "h5", "h6", "section", "article",
    ],
    tag,
  )
}

// ── Per-node rewrites ────────────────────────────────────────────────

fn rewrite(node: Node) -> Node {
  case node {
    Text(_) -> node
    Element(tag: "table", ..) -> rewrite_table(node)
    _ ->
      case is_quote_container(node) {
        True -> as_blockquote(node)
        False -> node
      }
  }
}

/// A data table stays a table, structure intact. A layout table collapses
/// into a plain block container whose rows and cells become blocks in
/// document order.
///
/// The table's own `tr` / `td` are only flattened here, never in the generic
/// bottom-up pass — rewriting them earlier would dismantle a data table
/// before `is_data_table` could recognize it.
fn rewrite_table(node: Node) -> Node {
  case table.is_data_table(node) {
    True -> node
    False -> Element("div", dict.new(), flatten_grid(node))
  }
}

fn flatten_grid(node: Node) -> List(Node) {
  case node {
    Text(_) -> [node]
    Element(tag:, children:, ..) ->
      case tag {
        "table" | "tbody" | "thead" | "tfoot" ->
          list.flat_map(children, flatten_grid)
        "tr" -> flatten_row(children)
        "td" | "th" -> [as_block(node, children)]
        _ -> [node]
      }
  }
}

/// Flatten one layout row.
///
/// Emitting a block per cell severs pairs that only read correctly side by
/// side: `<td>•</td><td>text…</td>` orphans the bullet on its own line, and a
/// row of social icons becomes a vertical stack. When the row is inline-ish,
/// its cells are joined into a single block instead.
fn flatten_row(children: List(Node)) -> List(Node) {
  // Source formatting puts whitespace text nodes between `</td>` and `<td>`,
  // so a row's children are not its cells. Anything that is not a cell is
  // dropped before counting.
  let cells = list.filter(children, is_cell)
  let contents = list.map(cells, cell_children)

  case marker_row(cells, contents) {
    // The marker must be pushed *inside* the content cell's first block.
    // Emitting it as a sibling leaves it stranded on its own line, which is
    // exactly the orphaned-bullet bug.
    Ok(#(marker, content)) -> [
      Element("div", dict.new(), prepend_marker(marker, content)),
    ]
    Error(_) ->
      case row_is_inline(cells, contents) {
        True -> [Element("div", dict.new(), join_inline(contents))]
        False ->
          list.map2(cells, contents, fn(cell, content) {
            as_block(cell, content)
          })
      }
  }
}

/// Rebuild a cell as a block, carrying its resolved typography across so the
/// heading analysis can still see the font size it was set in.
fn as_block(source: Node, children: List(Node)) -> Node {
  Element("div", heading.carried_attrs(source), children)
}

/// A two-cell row whose first cell is nothing but a list marker.
fn marker_row(
  cells: List(Node),
  contents: List(List(Node)),
) -> Result(#(String, List(Node)), Nil) {
  case cells, contents {
    [_, _], [first, second] -> {
      let marker =
        first |> list.map(dom.text_content) |> string.concat |> string.trim

      case classify.is_standalone_marker(marker) && second != [] {
        True -> Ok(#(marker, second))
        False -> Error(Nil)
      }
    }
    _, _ -> Error(Nil)
  }
}

/// Insert the marker at the front of the first content-bearing node, so it
/// ends up on the same line as the text it labels.
fn prepend_marker(marker: String, content: List(Node)) -> List(Node) {
  case content {
    [] -> [Text(marker)]
    [first, ..rest] ->
      case string.trim(dom.text_content(first)) == "" {
        // Skip empty leading nodes (email is full of stray empty <p>s).
        True -> [first, ..prepend_marker(marker, rest)]
        False -> [inject(first, marker), ..rest]
      }
  }
}

fn inject(node: Node, marker: String) -> Node {
  case node {
    Text(content:) -> Text(marker <> " " <> string.trim_start(content))
    Element(tag:, attrs:, children:) ->
      Element(tag, attrs, [Text(marker <> " "), ..children])
  }
}

fn is_cell(node: Node) -> Bool {
  case node {
    Element(tag: "td", ..) | Element(tag: "th", ..) -> True
    _ -> False
  }
}

fn cell_children(cell: Node) -> List(Node) {
  case cell {
    Element(tag: "td", children:, ..) | Element(tag: "th", children:, ..) ->
      children
    _ -> [cell]
  }
}

/// Separate cells with a space so their text does not fuse when joined.
fn join_inline(contents: List(List(Node))) -> List(Node) {
  contents
  |> list.filter(fn(cell) { cell != [] })
  |> list.intersperse([Text(" ")])
  |> list.flatten
}

fn row_is_inline(cells: List(Node), contents: List(List(Node))) -> Bool {
  let has_block = list.any(contents, has_block_structure)

  case has_block || cells == [] {
    True -> False
    False ->
      is_icon_row(contents) || is_marker_row(contents) || is_short_row(contents)
  }
}

/// Every cell holds an image and nothing else — a social/app-badge strip.
fn is_icon_row(contents: List(List(Node))) -> Bool {
  list.length(contents) > 1
  && list.all(contents, fn(cell) {
    let text = cell |> list.map(dom.text_content) |> string.concat
    string.trim(text) == "" && list.any(cell, has_image)
  })
}

/// A short leading marker cell followed by its content — the two-column
/// bullet and lettered-option layouts email uses constantly.
fn is_marker_row(contents: List(List(Node))) -> Bool {
  case contents {
    [first, _] -> {
      let text = first |> list.map(dom.text_content) |> string.concat
      let trimmed = string.trim(text)
      string.length(trimmed) <= 4
      && trimmed != ""
      && classify.is_list_item(trimmed <> " x")
    }
    _ -> False
  }
}

/// Longest a flattened row can be and still read as a single line.
const max_inline_row_length = 120

/// A row short enough to read as one line.
///
/// Measured across the whole row rather than per cell. A preheader bar of
/// "Plus, June market recap…" (54 chars) beside "View in Browser" (15) reads
/// exactly like a 35/34 split does, but a per-cell limit rejects the first
/// and accepts the second purely because of where the boundary falls.
fn is_short_row(contents: List(List(Node))) -> Bool {
  let total =
    contents
    |> list.map(fn(cell) {
      cell |> list.map(dom.text_content) |> string.concat |> string.trim
    })
    |> string.join(" ")
    |> string.length

  list.length(contents) > 1 && total <= max_inline_row_length
}

/// Does this content carry real block *structure*, as opposed to a wrapper?
///
/// A lone `<div>` around inline content is not structure — email wraps
/// everything, and Fidelity's header is two cells each holding one such div.
/// What genuinely forces a vertical stack is a structural element, or two
/// block-level siblings in the same container.
fn has_block_structure(nodes: List(Node)) -> Bool {
  count_blocks(nodes) > 1
  || list.any(nodes, fn(node) {
    case node {
      Text(_) -> False
      Element(tag:, children:, ..) ->
        is_structural(tag) || has_block_structure(children)
    }
  })
}

fn count_blocks(nodes: List(Node)) -> Int {
  list.fold(nodes, 0, fn(total, node) {
    case node {
      Element(tag:, ..) ->
        case is_block_tag(tag) {
          True -> total + 1
          False -> total
        }
      Text(_) -> total
    }
  })
}

fn is_structural(tag: String) -> Bool {
  list.contains(
    [
      "table",
      "ul",
      "ol",
      "blockquote",
      "pre",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
    ],
    tag,
  )
}

fn has_image(node: Node) -> Bool {
  case node {
    Text(_) -> False
    Element(tag: "img", ..) -> True
    Element(children:, ..) -> list.any(children, has_image)
  }
}

fn as_blockquote(node: Node) -> Node {
  case node {
    Text(_) -> node
    Element(children:, ..) -> Element("blockquote", dict.new(), children)
  }
}

fn is_quote_container(node: Node) -> Bool {
  let classes =
    node
    |> dom.attr_or_empty("class")
    |> string.lowercase
    |> string.split(" ")

  list.any(classes, fn(class) { list.contains(quote_classes, class) })
}

// ── Noise removal ────────────────────────────────────────────────────

fn drop_noise(children: List(Node)) -> List(Node) {
  list.filter(children, fn(child) { !is_noise(child) })
}

fn is_noise(node: Node) -> Bool {
  case node {
    Text(_) -> False
    Element(tag: "img", ..) -> is_tracking_pixel(node)
    // Empty presentational containers are scaffolding. Table cells are
    // excluded — an empty `<td>` is a real column position, and dropping it
    // would shift every cell after it.
    Element(tag:, children:, ..) ->
      children == [] && list.contains(["div", "p", "span"], tag)
  }
}

/// 1×1 beacons, and images with no alt text and no usable source.
fn is_tracking_pixel(node: Node) -> Bool {
  let tiny =
    is_at_most_one(dom.attr_or_empty(node, "width"))
    && is_at_most_one(dom.attr_or_empty(node, "height"))

  let useless =
    dom.attr_or_empty(node, "alt") == "" && dom.attr_or_empty(node, "src") == ""

  tiny || useless
}

fn is_at_most_one(value: String) -> Bool {
  case style.length(value) {
    option.Some(number) -> number <=. 1.0
    option.None -> False
  }
}

// ── Whitespace ───────────────────────────────────────────────────────

/// Characters Gleam's `string.trim` does not treat as whitespace, but which
/// behave like it. Left in place they defeat every trim in the pipeline —
/// `<strong>…9:00PM.&nbsp;</strong>` emitted `**…9:00PM. **`, which Markdown
/// will not close because the marker no longer touches the text.
const space_like = ["\u{00a0}", "\u{2007}", "\u{202f}"]

/// Zero-width characters used purely as preheader padding.
const zero_width = ["\u{200b}", "\u{200c}", "\u{200d}", "\u{feff}"]

/// Collapse runs of whitespace to a single space, per the HTML inline
/// whitespace rules. `<pre>` subtrees bypass this.
fn collapse_whitespace(content: String) -> String {
  content |> normalize_spaces |> chars.collapse_whitespace
}

fn normalize_spaces(text: String) -> String {
  let text =
    list.fold(space_like, text, fn(acc, c) { string.replace(acc, c, " ") })
  list.fold(zero_width, text, fn(acc, c) { string.replace(acc, c, "") })
}
