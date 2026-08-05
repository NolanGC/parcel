//// Drop subtrees the recipient would never see.
////
//// This does double duty. It removes preheader spacer junk that would
//// otherwise open every converted email, and it is the hidden-text
//// prompt-injection defense: DOMPurify passes `display:none` straight
//// through, because invisible text is not malicious markup — it is just
//// invisible. If this module is skipped, hidden instructions land in the
//// Markdown and from there into whatever model consumes it.

import email_to_markdown/dom.{type Node, Element, Text}
import email_to_markdown/style
import gleam/dict.{type Dict}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

/// Off-canvas positioning threshold, in CSS pixels.
const off_canvas_px = -1000.0

/// Remove every invisible subtree. `None` when the node itself is hidden.
pub fn strip(node: Node) -> Option(Node) {
  case node {
    Text(_) -> Some(node)
    Element(tag:, attrs:, children:) ->
      case is_hidden(node) {
        True -> None
        False -> Some(Element(tag, attrs, list.filter_map(children, keep)))
      }
  }
}

fn keep(node: Node) -> Result(Node, Nil) {
  case strip(node) {
    Some(kept) -> Ok(kept)
    None -> Error(Nil)
  }
}

/// Would this element render as invisible to the recipient?
fn is_hidden(node: Node) -> Bool {
  case node {
    Text(_) -> False
    Element(tag:, attrs:, ..) -> {
      let styles = styles_of(attrs)

      dict.has_key(attrs, "hidden")
      || style.is_any(styles, "display", ["none"])
      || style.is_any(styles, "visibility", ["hidden", "collapse"])
      || zero_style(styles, "opacity")
      || zero_style(styles, "max-height")
      || is_off_canvas(styles)
      || is_indented_away(styles)
      || is_clipped(styles)
      || is_scaled_to_nothing(styles)
      || is_collapsed_box(tag, attrs, styles)
      || is_zeroed_text(node, styles)
      || is_unreadable_colour(node, styles)
    }
  }
}

fn styles_of(attrs: Dict(String, String)) -> Dict(String, String) {
  case dict.get(attrs, "style") {
    Ok(value) -> style.parse(value)
    Error(_) -> dict.new()
  }
}

fn zero_style(styles: Dict(String, String), property: String) -> Bool {
  case style.get(styles, property) {
    Some(value) -> style.is_zero_length(value)
    None -> False
  }
}

/// `font-size:0` is only *sometimes* a hiding technique.
///
/// It is also the standard Outlook image-gap fix, and MJML — one of the most
/// widely used email frameworks — emits `font-size:0px` on every text cell,
/// resetting the real size on an inner `<div>`. Treating that as hidden
/// silently eats the body of any MJML-built email.
///
/// So it only counts as hiding when nothing underneath restores it: no image
/// or link to lose, and no descendant declaring its own visible size.
///
/// `line-height:0` is deliberately NOT a signal here. It collapses the line
/// box but the glyphs still render, and it is the standard way to stop a
/// `<sup>` from stretching line spacing — honouring it ate the ® from
/// "Fidelity Mobile®".
fn is_zeroed_text(node: Node, styles: Dict(String, String)) -> Bool {
  case is_sub_visible_size(styles) {
    False -> False
    True ->
      !dom.has_descendant(node, "img")
      && !dom.has_descendant(node, "a")
      && !restores_font_size(node)
  }
}

/// Smallest font size that renders as readable text.
const min_readable_px = 4.0

/// Is the declared size too small to read?
///
/// Zero is the MJML / Outlook case the guards above exist for. Anything else
/// under a few pixels is nobody's typography — `font-size:1px` carries a
/// paragraph that only a parser will ever see.
///
/// The threshold applies to pixel values only. `style.px` hands back the bare
/// number, and `0.5em` is eight perfectly readable pixels at a default base.
fn is_sub_visible_size(styles: Dict(String, String)) -> Bool {
  case style.get(styles, "font-size") {
    None -> False
    Some(value) ->
      case style.px(value) {
        None -> False
        Some(size) ->
          size <=. 0.0 || { in_pixels(value) && size <. min_readable_px }
      }
  }
}

fn in_pixels(value: String) -> Bool {
  value |> string.trim |> string.lowercase |> string.ends_with("px")
}

/// Does any descendant declare a visible font size, overriding the zero?
fn restores_font_size(node: Node) -> Bool {
  case node {
    Text(_) -> False
    Element(children:, ..) ->
      list.any(children, fn(child) {
        declares_visible_size(child) || restores_font_size(child)
      })
  }
}

fn declares_visible_size(node: Node) -> Bool {
  let styles = style.parse(dom.attr_or_empty(node, "style"))

  case style.get(styles, "font-size") {
    Some(value) ->
      case style.length(value) {
        Some(size) -> size >=. min_readable_px
        None -> False
      }
    None -> False
  }
}

/// Absolutely positioned far outside the viewport — the classic
/// screen-reader-text / hidden-preheader trick.
fn is_off_canvas(styles: Dict(String, String)) -> Bool {
  case style.is_any(styles, "position", ["absolute", "fixed"]) {
    False -> False
    True -> is_far_negative(styles, "left") || is_far_negative(styles, "top")
  }
}

fn is_far_negative(styles: Dict(String, String), property: String) -> Bool {
  case style.get(styles, property) {
    Some(value) ->
      case style.length(value) {
        Some(number) -> number <=. off_canvas_px
        None -> False
      }
    None -> False
  }
}

/// Text pushed off-screen by a large negative indent — the old
/// image-replacement trick, and a tidy way to smuggle a paragraph.
fn is_indented_away(styles: Dict(String, String)) -> Bool {
  is_far_negative(styles, "text-indent")
}

/// Clipped to a zero-area rectangle: the `.sr-only` / visually-hidden recipe,
/// in both its old (`clip`) and current (`clip-path`) spellings.
///
/// Legitimate uses exist, but they exist precisely because the content is
/// invisible — which is the question this module is asking.
fn is_clipped(styles: Dict(String, String)) -> Bool {
  let clip = declared(styles, "clip")
  let path = declared(styles, "clip-path")

  string.replace(clip, " ", "") == "rect(0,0,0,0)"
  || string.replace(path, " ", "") == "inset(50%)"
  || string.replace(path, " ", "") == "inset(100%)"
}

/// `transform: scale(0)` renders the box at no size at all.
fn is_scaled_to_nothing(styles: Dict(String, String)) -> Bool {
  let transform = string.replace(declared(styles, "transform"), " ", "")

  list.any(["scale(0)", "scale(0,0)", "scale3d(0,0,0)", "scale(0%)"], fn(zero) {
    string.contains(transform, zero)
  })
}

/// Text painted in a colour that cannot be read against its own background.
///
/// White-on-white is the oldest hidden-text trick there is. Comparing the two
/// declarations on the *same* element keeps this tight: an element that sets
/// only `color` is inheriting its background from an ancestor, and guessing
/// what that resolved to is how false positives get made.
///
/// The descendant check is not optional, and is here for the same reason the
/// one in `is_zeroed_text` is. AvalonBay's footer `<td>` really does declare
/// `background-color:#ffffff;color:#ffffff`, and really is readable, because
/// a `<font color="#444444">` inside repaints it.
fn is_unreadable_colour(node: Node, styles: Dict(String, String)) -> Bool {
  case foreground_of(node, styles) {
    None -> False
    Some(foreground) ->
      {
        foreground == "transparent"
        || background_matches(node, styles, foreground)
      }
      && !restores_colour(node, foreground)
  }
}

fn foreground_of(node: Node, styles: Dict(String, String)) -> Option(String) {
  style.colour(declared(styles, "color"))
  |> option.lazy_or(fn() { style.colour(dom.attr_or_empty(node, "color")) })
}

fn background_matches(
  node: Node,
  styles: Dict(String, String),
  foreground: String,
) -> Bool {
  let declared_background =
    list.any(["background-color", "background"], fn(property) {
      style.colour(declared(styles, property)) == Some(foreground)
    })

  // `bgcolor` is the legacy spelling, and email uses it constantly — the
  // AvalonBay footer carries one.
  declared_background
  || style.colour(dom.attr_or_empty(node, "bgcolor")) == Some(foreground)
}

/// Does any descendant paint itself a different colour, overriding the
/// unreadable one it would otherwise inherit?
fn restores_colour(node: Node, hidden: String) -> Bool {
  case node {
    Text(_) -> False
    Element(children:, ..) ->
      list.any(children, fn(child) {
        declares_other_colour(child, hidden) || restores_colour(child, hidden)
      })
  }
}

fn declares_other_colour(node: Node, hidden: String) -> Bool {
  let styles = style.parse(dom.attr_or_empty(node, "style"))

  case foreground_of(node, styles) {
    Some(colour) -> colour != hidden
    None -> False
  }
}

fn declared(styles: Dict(String, String), property: String) -> String {
  case style.get(styles, property) {
    Some(value) -> value
    None -> ""
  }
}

/// A box collapsed to nothing via presentational attributes or CSS.
///
/// Restricted to tags actually used as spacers, so a zero dimension on a
/// text-bearing block is not over-eagerly dropped.
fn is_collapsed_box(
  tag: String,
  attrs: Dict(String, String),
  styles: Dict(String, String),
) -> Bool {
  case list.contains(["img", "td", "th", "table", "tr", "div", "span"], tag) {
    False -> False
    True ->
      zero_attr(attrs, "width")
      || zero_attr(attrs, "height")
      || zero_style(styles, "width")
      || zero_style(styles, "height")
  }
}

fn zero_attr(attrs: Dict(String, String), name: String) -> Bool {
  case dict.get(attrs, name) {
    Ok(value) -> style.is_zero_length(string.trim(value))
    Error(_) -> False
  }
}
