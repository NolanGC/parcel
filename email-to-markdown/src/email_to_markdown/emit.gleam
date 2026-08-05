//// Tree to Markdown.
////
//// Blocks are emitted separated by blank lines; consecutive inline children
//// are gathered into a single paragraph rather than becoming one block each.
////
//// Body text is escaped where it could name a link destination or open a
//// block at the start of a line — see `escape_text`. Emphasis markers are left
//// alone: over-escaping ordinary prose (`a \* b`, every `_` in a URL) costs
//// more in readability than a stray emphasis marker costs in fidelity, and `*`
//// cannot point anywhere.

import email_to_markdown/chars
import email_to_markdown/classify
import email_to_markdown/dom.{type Node, Element, Text}
import email_to_markdown/heading.{type Tiers}
import email_to_markdown/normalize
import email_to_markdown/style
import email_to_markdown/table
import gleam/dict
import gleam/float
import gleam/int
import gleam/list
import gleam/option.{None, Some}
import gleam/string

const block_tags = [
  "address", "article", "aside", "blockquote", "div", "dl", "dd", "dt",
  "fieldset", "figcaption", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]

/// Characters that occupy space without carrying content. Emails use these
/// as spacers — `&nbsp;` filler cells, `&zwnj;` preheader padding — and
/// `string.trim` does not treat them as whitespace, so a spacer block would
/// otherwise survive as a line containing one invisible character.
const blank_chars = ["\u{00a0}", "\u{200b}", "\u{200c}", "\u{200d}", "\u{feff}"]

/// Neutralize Markdown syntax in text taken verbatim from the email.
///
/// Two jobs, in order: inline syntax that could point somewhere (`escape_inline`),
/// then block syntax that could restructure a line (`escape_line_starts`).
fn escape_text(text: String) -> String {
  text
  |> escape_inline
  |> escape_line_starts
}

/// Inline Markdown syntax — the part that can name a destination.
///
/// Body text is not built by us, and that left a hole: `<p>Click
/// [here](javascript:alert(1))</p>` is perfectly ordinary HTML that DOMPurify
/// has no reason to touch, yet the text is already valid Markdown. Rendered, it
/// becomes a working link — one that never passed `safe_url`, defeating the
/// scheme allowlist along with the relative-URL and `data:` rules in a single
/// step.
///
/// Every link form — inline, reference, collapsed, shortcut, and image — needs
/// an active `]`, so escaping that one character closes all of them. `\` has to
/// go first: otherwise `[x\](javascript:alert(1))` becomes `[x\\](...)`, where
/// the doubled backslash is itself escaped and the `]` goes right back to being
/// live.
///
/// Backticks go too, for a subtler reason. Text carrying its own ``` opens a
/// fence, and the next code block's opening fence closes it — which drops that
/// block's contents into prose position, live link syntax and all. With
/// backticks escaped the only fences in the output are the ones we wrote.
///
/// Emphasis markers are deliberately left alone. `*` and `_` are noisy in
/// ordinary prose and cannot name a destination or open a block.
fn escape_inline(text: String) -> String {
  case needs_escaping(text) {
    False -> text
    True ->
      text
      |> string.replace("\\", "\\\\")
      |> string.replace("]", "\\]")
      |> string.replace("`", "\\`")
  }
}

fn needs_escaping(text: String) -> Bool {
  string.contains(text, "\\")
  || string.contains(text, "]")
  || string.contains(text, "`")
}

/// Neutralize block syntax that only fires at the start of a line: an ATX
/// heading (`#`), a blockquote (`>`), or a `+` bullet.
///
/// A paragraph reading `# Sale ends today` or a support reply quoting
/// `> your earlier message` is plain prose in the source, but rendered — or fed
/// to a model — the leading marker turns it into a heading or a quote and the
/// meaning shifts. Escaping the marker keeps it literal.
///
/// `-`, `*`, and the numbered forms (`1.`, `1)`, `(1)`) are intentionally left
/// alone: `classify` promotes those to real list items, since email routinely
/// builds lists as bullet-prefixed prose with no `<ul>`. `+` is not among them,
/// so it stays a hazard rather than a feature. Escaping mid-line is harmless —
/// `\#`, `\>`, and `\+` all render as the bare character — so the occasional
/// false positive on a non-leading run costs a backslash and nothing else.
fn escape_line_starts(text: String) -> String {
  case has_line_marker(text) {
    False -> text
    True ->
      text
      |> string.split("\n")
      |> list.map(guard_line_start)
      |> string.join("\n")
  }
}

fn has_line_marker(text: String) -> Bool {
  string.contains(text, "#")
  || string.contains(text, ">")
  || string.contains(text, "+")
}

/// Up to three leading spaces still open a block in CommonMark; beyond that the
/// line is indented code and the marker is inert.
fn guard_line_start(line: String) -> String {
  let indent = leading_spaces(line, 0)
  let rest = string.drop_start(line, indent)
  case indent <= 3 && opens_block(rest) {
    True -> string.repeat(" ", indent) <> "\\" <> rest
    False -> line
  }
}

fn leading_spaces(line: String, count: Int) -> Int {
  case string.starts_with(line, " ") {
    True -> leading_spaces(string.drop_start(line, 1), count + 1)
    False -> count
  }
}

fn opens_block(rest: String) -> Bool {
  string.starts_with(rest, ">")
  || string.starts_with(rest, "+ ")
  || opens_heading(rest)
}

/// An ATX heading is one to six `#` followed by a space or the line's end.
fn opens_heading(rest: String) -> Bool {
  case string.starts_with(rest, "#") {
    False -> False
    True -> {
      let hashes = leading_hashes(rest, 0)
      let after = string.drop_start(rest, hashes)
      hashes <= 6 && { after == "" || string.starts_with(after, " ") }
    }
  }
}

fn leading_hashes(rest: String, count: Int) -> Int {
  case string.starts_with(rest, "#") {
    True -> leading_hashes(string.drop_start(rest, 1), count + 1)
    False -> count
  }
}

/// Is this text visually empty?
fn is_blank(text: String) -> Bool {
  blank_chars
  |> list.fold(text, fn(acc, char) { string.replace(acc, char, " ") })
  |> string.trim
  == ""
}

/// Render a normalized tree as Markdown, using `tiers` to recognize headings
/// that the source expressed only as font size.
pub fn run(node: Node, tiers: Tiers) -> String {
  node
  |> blocks(tiers)
  |> list.filter(fn(block) { !is_blank(block) })
  |> string.join("\n\n")
}

// ── Block level ──────────────────────────────────────────────────────

fn blocks(node: Node, tiers: Tiers) -> List(String) {
  case node {
    Text(content:) ->
      case string.trim(content) {
        "" -> []
        text -> [escape_text(text)]
      }
    Element(tag:, children:, ..) ->
      case tag {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" -> [
          tagged_heading(tag, children),
        ]
        "p" -> paragraph(node, children, tiers)
        "br" -> []
        "hr" -> ["---"]
        "ul" | "ol" -> [list_block(node, tag, tiers)]
        "li" -> group_children(children, tiers)
        "pre" -> [code_block(node)]
        "blockquote" -> [quote_block(node, tiers)]
        "table" -> [table_block(node)]
        "img" -> image_block(node)
        _ -> group_children_of(node, children, tiers)
      }
  }
}

/// Split a child list into runs: consecutive inline nodes become one
/// paragraph, block nodes are emitted in place.
fn group_children(children: List(Node), tiers: Tiers) -> List(String) {
  do_group(children, [], [], tiers, 0)
}

/// Same, but an inline run directly inside `node` inherits that element's
/// font size — which is how a styled `<div>` becomes a heading.
fn group_children_of(
  node: Node,
  children: List(Node),
  tiers: Tiers,
) -> List(String) {
  do_group(children, [], [], tiers, level_of(node, tiers))
}

fn level_of(node: Node, tiers: Tiers) -> Int {
  case heading.size_of(node) {
    Some(size) ->
      case heading.level_for(tiers, size) {
        Some(level) -> level
        None -> 0
      }
    None -> 0
  }
}

fn do_group(
  children: List(Node),
  pending: List(Node),
  acc: List(String),
  tiers: Tiers,
  level: Int,
) -> List(String) {
  case children {
    [] -> list.reverse(flush(pending, acc, level))
    [child, ..rest] ->
      case is_block(child) {
        True -> {
          let acc = flush(pending, acc, level)
          let acc = list.fold(blocks(child, tiers), acc, fn(a, b) { [b, ..a] })
          do_group(rest, [], acc, tiers, level)
        }
        False -> do_group(rest, [child, ..pending], acc, tiers, level)
      }
  }
}

fn flush(pending: List(Node), acc: List(String), level: Int) -> List(String) {
  case pending {
    [] -> acc
    _ -> {
      let text = pending |> list.reverse |> inline_all |> tidy_lines
      case is_blank(text) {
        True -> acc
        False -> [as_heading(maybe_list_item(text), level), ..acc]
      }
    }
  }
}

/// Longest an inline run can be and still plausibly be a heading. Beyond
/// this it is body copy that merely happens to be set large.
const max_heading_length = 120

/// Promote an inline run to a heading when its font size named a tier.
///
/// A `<br>`-split masthead ("Heard at<br>Goldman Sachs") is still one
/// heading, so short multi-line runs are folded onto a single line rather
/// than rejected. List items are never promoted.
fn as_heading(text: String, level: Int) -> String {
  let folded = text |> string.replace("\n", " ") |> chars.squeeze_spaces

  case
    level > 0
    && !is_list_line(text)
    && string.length(folded) <= max_heading_length
    // Prices, dates and amounts are often the largest text on the page.
    && chars.has_letter(folded)
  {
    True -> string.repeat("#", level) <> " " <> folded
    False -> text
  }
}

fn is_list_line(text: String) -> Bool {
  classify.is_list_item(text) || string.starts_with(text, "- ")
}

/// A paragraph that opens with a literal bullet is a list item the author
/// built without `<ul>`. Common in `<td>`-based email layouts.
fn maybe_list_item(text: String) -> String {
  case classify.is_list_item(text) {
    True -> classify.format_list_item(text)
    False -> text
  }
}

/// Trim each line of an inline run. A `<br>` is followed by the source's own
/// indentation, which would otherwise survive as a stray leading space.
fn tidy_lines(text: String) -> String {
  text
  |> string.split("\n")
  |> list.map(string.trim)
  |> string.join("\n")
  |> string.trim
}

fn is_block(node: Node) -> Bool {
  case node {
    Text(_) -> False
    Element(tag:, ..) ->
      list.contains(block_tags, tag)
      && !is_icon_only(node)
      && !is_laid_inline(node)
  }
}

/// Is this element laid out beside its siblings by CSS?
///
/// `table-cell` always means side-by-side. `inline-block` does NOT: MJML
/// sets it on full-width column wrappers, and a 100%-wide inline-block still
/// occupies its own line. Treating those as inline collapsed an entire
/// newsletter into one paragraph, so a partial width is required as evidence
/// that the box actually shares a line.
fn is_laid_inline(node: Node) -> Bool {
  let styles = style.parse(dom.attr_or_empty(node, "style"))

  case style.is_any(styles, "display", ["table-cell"]) {
    True -> True
    False ->
      style.is_any(styles, "display", ["inline", "inline-block"])
      && is_partial_width(styles)
  }
}

fn is_partial_width(styles: dict.Dict(String, String)) -> Bool {
  case style.get(styles, "width") {
    Some(value) ->
      case style.px(value) {
        // A pixel width narrower than a typical email body can share a line.
        Some(px) -> px >. 0.0 && px <. 400.0
        // Percentages: anything short of full width.
        None -> value != "100%" && string.contains(value, "%")
      }
    None -> False
  }
}

/// A container holding nothing but small icons is treated as inline, so a
/// run of them collapses onto one line instead of stacking vertically. This
/// is the only lever Markdown gives us over image layout.
fn is_icon_only(node: Node) -> Bool {
  let images = collect_images(node, [])

  images != []
  && list.all(images, is_icon)
  && string.trim(dom.text_content(node)) == ""
}

fn collect_images(node: Node, acc: List(Node)) -> List(Node) {
  case node {
    Text(_) -> acc
    Element(tag: "img", ..) -> [node, ..acc]
    Element(children:, ..) ->
      list.fold(children, acc, fn(acc, child) { collect_images(child, acc) })
  }
}

fn tagged_heading(tag: String, children: List(Node)) -> String {
  let level = case int.parse(string.drop_start(tag, 1)) {
    Ok(value) -> value
    Error(_) -> 1
  }
  let text = children |> inline_all |> string.trim

  case text {
    "" -> ""
    _ -> string.repeat("#", level) <> " " <> text
  }
}

fn paragraph(node: Node, children: List(Node), tiers: Tiers) -> List(String) {
  let text = children |> inline_all |> tidy_lines
  case is_blank(text) {
    True -> []
    False -> [as_heading(maybe_list_item(text), level_of(node, tiers))]
  }
}

fn image_block(node: Node) -> List(String) {
  case image(node) {
    "" -> []
    markdown -> [markdown]
  }
}

/// Widest an image can declare and still be an icon rather than content.
const icon_max_px = 64.0

/// Is this a small inline icon (social badge, app-store button, glyph)?
///
/// Markdown cannot express dimensions, so the only size signal that survives
/// is *placement*: icons stay inline on one line, content images get their
/// own block. Callers cap actual display size with CSS.
fn is_icon(node: Node) -> Bool {
  case declared_size(node) {
    Some(size) -> size <=. icon_max_px
    None -> False
  }
}

/// Width if it is declared, else height. Either one is enough to tell an icon
/// from a photograph; neither means the image said nothing about its size.
fn declared_size(node: Node) -> option.Option(Float) {
  declared_px(node, "width")
  |> option.lazy_or(fn() { declared_px(node, "height") })
}

/// The size the image actually renders at, in CSS pixels.
///
/// CSS wins over the `width` attribute. On retina assets the attribute is the
/// *file's* natural width while the CSS carries the display size — Venmo
/// ships a 106px logo shown at 53px — so reading the attribute first doubles
/// every such image.
fn declared_px(node: Node, name: String) -> option.Option(Float) {
  styled_dimension(node, name)
  |> style.px
  |> option.lazy_or(fn() { style.px(dom.attr_or_empty(node, name)) })
}

fn styled_dimension(node: Node, name: String) -> String {
  case style.get(style.parse(dom.attr_or_empty(node, "style")), name) {
    Some(value) -> value
    None -> ""
  }
}

// ── Lists ────────────────────────────────────────────────────────────

fn list_block(node: Node, tag: String, tiers: Tiers) -> String {
  let items = case node {
    Element(children:, ..) ->
      list.filter(children, fn(child) {
        case child {
          Element(tag: "li", ..) -> True
          _ -> False
        }
      })
    Text(_) -> []
  }

  let start = case int.parse(dom.attr_or_empty(node, "start")) {
    Ok(value) -> value
    Error(_) -> 1
  }

  items
  |> list.index_map(fn(item, index) {
    let marker = case tag {
      "ol" -> int.to_string(start + index) <> ". "
      _ -> "- "
    }
    render_item(item, marker, tiers)
  })
  |> string.join("\n")
}

fn render_item(item: Node, marker: String, tiers: Tiers) -> String {
  let parts = case item {
    Element(children:, ..) -> group_children(children, tiers)
    Text(content:) -> [escape_text(content)]
  }

  // Nesting is applied by the enclosing item's `indent_block`, so an item
  // never indents itself — doing both is what produced four spaces a level.
  let continuation = string.repeat(" ", string.length(marker))

  case parts {
    [] -> ""
    [first, ..rest] -> {
      let head = marker <> first
      let tail = list.map(rest, fn(part) { indent_block(part, continuation) })
      string.join([head, ..tail], "\n")
    }
  }
}

fn indent_block(block: String, prefix: String) -> String {
  block
  |> string.split("\n")
  |> list.map(fn(line) { prefix <> line })
  |> string.join("\n")
}

// ── Other blocks ─────────────────────────────────────────────────────

/// Longest fence worth building. Content with a longer backtick run than this
/// is not code anyone typed, so it degrades to escaped prose.
const max_fence_length = 16

fn code_block(node: Node) -> String {
  case node |> dom.text_content |> string.trim {
    "" -> ""
    content ->
      case fence_for(content, "```") {
        Some(fence) -> fence <> "\n" <> content <> "\n" <> fence
        None -> escape_text(content)
      }
  }
}

/// The shortest fence the content cannot close.
///
/// A fenced block ends at the first fence of equal or greater length, so a
/// `<pre>` whose own text contains ``` used to break straight out of it —
/// and everything after landed in prose position, where Markdown link syntax
/// is live and the URL allowlist no longer applies. Growing the fence past
/// the longest run in the content makes it unclosable.
fn fence_for(content: String, fence: String) -> option.Option(String) {
  case string.length(fence) > max_fence_length {
    True -> None
    False ->
      case string.contains(content, fence) {
        True -> fence_for(content, fence <> "`")
        False -> Some(fence)
      }
  }
}

fn quote_block(node: Node, tiers: Tiers) -> String {
  let inner = case node {
    Element(children:, ..) ->
      children
      |> group_children(tiers)
      |> list.filter(fn(block) { !is_blank(block) })
      |> string.join("\n\n")
    Text(content:) -> escape_text(content)
  }

  case string.trim(inner) {
    "" -> ""
    text ->
      text
      |> string.split("\n")
      |> list.map(fn(line) {
        case line {
          "" -> ">"
          _ -> "> " <> line
        }
      })
      |> string.join("\n")
  }
}

fn table_block(node: Node) -> String {
  node
  |> table.rows_of
  |> table.to_markdown(fn(content) { inline_all(content) })
  |> string.trim
}

// ── Inline level ─────────────────────────────────────────────────────

fn inline_all(nodes: List(Node)) -> String {
  nodes
  |> list.map(inline)
  |> string.concat
}

fn inline(node: Node) -> String {
  case node {
    Text(content:) -> escape_text(content)
    Element(tag:, children:, ..) ->
      case tag {
        "br" -> "\n"
        "img" -> image(node)
        "a" -> link(node, children)
        "strong" | "b" -> wrap(children, "**")
        "em" | "i" -> wrap(children, "*")
        "code" -> wrap(children, "`")
        "s" | "strike" | "del" -> wrap(children, "~~")
        "u" | "ins" -> inline_all(children)
        "span" -> styled_span(node, children)
        // A block-level element reached in inline position — either an
        // icon-only container being merged, or malformed markup. Keep its
        // content, but padded so neighbours do not fuse.
        _ ->
          case list.contains(block_tags, tag) {
            True -> " " <> inline_all(children) <> " "
            False -> inline_all(children)
          }
      }
  }
}

/// Emails express emphasis through inline CSS far more often than through
/// `<strong>` / `<em>`, so styled spans are honoured here.
fn styled_span(node: Node, children: List(Node)) -> String {
  let inner = inline_all(children)
  let styles = style.parse(dom.attr_or_empty(node, "style"))

  case normalize.carries_inline_style(node) {
    False -> inner
    True ->
      case string.trim(inner) {
        "" -> inner
        _ -> {
          let inner = case style.is_italic(styles) {
            True -> hug(inner, "*")
            False -> inner
          }
          case style.is_bold(styles) {
            True -> hug(inner, "**")
            False -> inner
          }
        }
      }
  }
}

fn wrap(children: List(Node), marker: String) -> String {
  hug(inline_all(children), marker)
}

/// Apply an emphasis marker so it touches the text.
///
/// `** bold **` is not bold — Markdown requires the marker to be adjacent to
/// the content, so any surrounding whitespace has to move outside it.
fn hug(inner: String, marker: String) -> String {
  case string.trim(inner) {
    "" -> inner
    trimmed ->
      leading_space(inner)
      <> marker
      <> trimmed
      <> marker
      <> trailing_space(inner)
  }
}

fn leading_space(text: String) -> String {
  case string.starts_with(text, " ") {
    True -> " "
    False -> ""
  }
}

fn trailing_space(text: String) -> String {
  case string.ends_with(text, " ") {
    True -> " "
    False -> ""
  }
}

fn link(node: Node, children: List(Node)) -> String {
  let href = safe_url(dom.attr_or_empty(node, "href"))

  let text = children |> inline_all |> string.trim

  case href, text {
    "", _ -> text
    _, "" -> ""
    // Nesting would emit `[[a](x)](y)`, which is not a link at all. The inner
    // one already names a destination, so it wins.
    _, _ ->
      case contains_link(text) {
        True -> text
        False ->
          case string.starts_with(text, "<img ") {
            // Markdown link syntax around raw HTML is not portable.
            True -> "<a href=\"" <> escape_attr(href) <> "\">" <> text <> "</a>"
            False -> "[" <> text <> "](" <> encode_url(href) <> ")"
          }
      }
  }
}

/// Does this already contain a Markdown *link*?
///
/// Image syntax has to be discounted first: `![alt](src)` also contains `](`,
/// and a linked image is perfectly valid — it is only link-inside-link that
/// cannot nest.
fn contains_link(text: String) -> Bool {
  case string.split(text, "![") {
    [] -> False
    [first, ..images] ->
      string.contains(first, "](")
      || list.any(images, fn(segment) {
        // Skip past this image's own `](src)` before looking further.
        case string.split_once(segment, ")") {
          Ok(#(_, after)) -> string.contains(after, "](")
          Error(_) -> False
        }
      })
  }
}

/// Render an image, or drop it.
///
/// Size alone is the wrong signal for what to discard. A 520px photo with no
/// alt is the article hero; a 51px graphic with `alt="1"` is a flourish next
/// to a heading. So the drop rule is *small AND uninformative*, which keeps
/// content photos and removes decoration.
fn image(node: Node) -> String {
  let src = dom.attr_or_empty(node, "src")
  let alt = node |> dom.attr_or_empty("alt") |> strip_controls |> string.trim

  case safe_url(src) {
    "" -> ""
    src ->
      case is_decorative(node, alt) {
        True -> ""
        False -> img_tag(src, alt, declared_px(node, "width"))
      }
  }
}

/// Markdown has no syntax for image dimensions, so images are emitted as
/// HTML.
///
/// `max-width:100%` keeps a 630px full-bleed image from overflowing a
/// narrower container. `vertical-align:middle` overrides the browser default
/// of `baseline`, which sits an inline icon's bottom edge on the text
/// baseline and leaves it visibly riding high next to the words beside it.
fn img_tag(src: String, alt: String, width: option.Option(Float)) -> String {
  let width_attr = case width {
    Some(px) -> " width=\"" <> int.to_string(float.round(px)) <> "\""
    None -> ""
  }

  "<img src=\""
  <> escape_attr(src)
  <> "\" alt=\""
  <> escape_attr(alt)
  <> "\""
  <> width_attr
  <> " style=\"max-width:100%;vertical-align:middle\">"
}

/// URL schemes allowed to reach the output.
///
/// An allowlist, not a blocklist. DOMPurify already removes `javascript:`
/// and friends, but it permits `data:image/svg+xml`, which is an attacker
/// controlled document embedded in the page — browsers do not script SVG in
/// an `<img>`, but nothing downstream is obliged to keep treating it as one.
///
/// `cid:` names a part of the message the reader already has. It fetches
/// nothing on its own: a client either substitutes the local attachment or
/// the image stays broken.
const safe_schemes = ["http", "https", "mailto", "tel", "cid"]

/// Reduce a URL to one that is safe to emit, or drop it.
///
/// An explicit allowed scheme is REQUIRED. Relative (`/api/logout`) and
/// protocol-relative (`//evil.test`) URLs are dropped: an email has no base
/// document, so a relative URL there is meaningless — but rendered inside a
/// webmail client it resolves against *that client's* origin, and the
/// browser fetches it with the user's cookies. Across the sample corpus all
/// 189 URLs carry an explicit scheme, so requiring one costs nothing.
fn safe_url(url: String) -> String {
  let url = strip_controls(url)

  case string.split_once(url, ":") {
    Error(_) -> ""
    Ok(#(scheme, _)) ->
      case
        string.contains(scheme, "/")
        || string.contains(scheme, "?")
        || string.contains(scheme, "#")
        || !list.contains(safe_schemes, string.lowercase(scheme))
      {
        True -> ""
        False -> url
      }
  }
}

/// Characters that must never appear inside an emitted attribute or URL.
///
/// A raw newline inside `src` splits the tag across lines and breaks the
/// Markdown block; the bidi overrides let `safe\u{202e}gnp.exe` render as
/// `safeexe.png`, which is display spoofing rather than a parser bug.
const control_chars = [
  "\n", "\r", "\t", "\u{0000}", "\u{000b}", "\u{000c}", "\u{007f}", "\u{202a}",
  "\u{202b}", "\u{202c}", "\u{202d}", "\u{202e}", "\u{2066}", "\u{2067}",
  "\u{2068}", "\u{2069}",
]

fn strip_controls(value: String) -> String {
  list.fold(control_chars, value, fn(acc, character) {
    string.replace(acc, character, "")
  })
}

/// Escape a value for use inside a double-quoted HTML attribute. `&` first,
/// or it would double-escape the entities introduced after it.
fn escape_attr(value: String) -> String {
  value
  |> strip_controls
  |> string.replace("&", "&amp;")
  |> string.replace("\"", "&quot;")
  |> string.replace("<", "&lt;")
  |> string.replace(">", "&gt;")
}

/// Uninformative alt, and no positive evidence the image is large.
///
/// Keyed on largeness rather than smallness because dividers and spacers
/// usually declare no dimensions at all, while real content images almost
/// always do. So "unknown size" falls on the decoration side.
fn is_decorative(node: Node, alt: String) -> Bool {
  !is_informative(alt) && !is_large(node)
}

fn is_large(node: Node) -> Bool {
  case declared_size(node) {
    Some(size) -> size >. icon_max_px
    None -> False
  }
}

/// Alt text that says something. `""` and `"1"` do not; `"Yes"` does.
fn is_informative(alt: String) -> Bool {
  alt != "" && chars.has_letter(alt)
}

/// Percent-encode the characters that would otherwise end a Markdown link
/// destination early.
///
/// The usual remedy — wrapping the destination in `<...>` — cannot be used
/// here, because `guard` escapes every `<` that does not open an `<img>` or
/// `<a>`. That turned `[t](<https://ok.test/a)[e](https://evil.test>)` into
/// `[t](&lt;https://ok.test/a)[e](https://evil.test>)`, where the trailing
/// `[e](...)` is a second, working link to the attacker's host.
///
/// `%` is deliberately left alone: email URLs are full of existing escapes,
/// and encoding it would turn every `%20` into `%2520`.
fn encode_url(url: String) -> String {
  url
  |> string.replace(" ", "%20")
  |> string.replace("(", "%28")
  |> string.replace(")", "%29")
  |> string.replace("<", "%3C")
  |> string.replace(">", "%3E")
}
