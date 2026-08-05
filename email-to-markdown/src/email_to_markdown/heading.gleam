//// Heading inference from font size.
////
//// Ported from `pdf-inspector/src/markdown/analysis.rs`
//// (`calculate_font_stats_from_items`, `compute_heading_tiers`,
//// `detect_header_level`).
////
//// This is the one piece of pdf-inspector's semantic-reconstruction
//// machinery that genuinely carries over. Email throws away `<h1>`–`<h6>`
//// exactly the way a PDF renderer does — the real messages measured here
//// contain **zero** heading tags and express hierarchy purely as font size.
//// So the same inference is needed, one layer up: sizes come from resolved
//// CSS rather than from glyph metrics.

import email_to_markdown/chars
import email_to_markdown/dom.{type Node, Element, Text}
import email_to_markdown/style
import gleam/dict.{type Dict}
import gleam/float
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

/// Text below this size is chrome (legal fine print, footers) and must not
/// set the body baseline. `analysis.rs` uses 9.0pt; this is its px analogue.
const min_body_px = 11.0

/// A size must exceed the body baseline by this ratio to be a heading.
const heading_ratio = 1.2

/// Bold text only slightly larger than body, used when nothing clears the
/// main gate.
const bold_fallback_ratio = 1.05

/// Sizes within this many px collapse into one tier.
const tier_tolerance = 1.0

/// Inference beyond H4 is noise; `analysis.rs` caps at 4 tiers too.
const max_tiers = 4

/// The size text resolves to when nothing declares one — every browser's
/// default, and the root of the inheritance chain.
const default_px = 16.0

/// Synthetic attributes holding typography resolved through inheritance.
/// Prefixed so they cannot collide with a real attribute — the FFI's
/// allowlist would never emit these names.
const size_attr = "data-etm-size"

const bold_attr = "data-etm-bold"

/// Discovered heading sizes, largest first. Index 0 is H1.
pub type Tiers {
  Tiers(body_px: Float, sizes: List(Float))
}

// ── Inheritance ──────────────────────────────────────────────────────

/// Push `font-size` and boldness down to every element.
///
/// Email sets `font-size` on a wrapper `<td>` and leaves the text inside
/// bare, so without resolving inheritance almost nothing declares a size.
/// Must run before `normalize`, which discards the wrappers.
pub fn resolve(node: Node) -> Node {
  go(node, default_px, False)
}

fn go(node: Node, inherited: Float, bold: Bool) -> Node {
  case node {
    Text(_) -> node
    Element(tag:, attrs:, children:) -> {
      let styles = styles_of(attrs)
      let size = case style.get(styles, "font-size") {
        Some(value) ->
          case style.length(value) {
            Some(px) if px >. 0.0 -> px
            _ -> inherited
          }
        None -> inherited
      }
      let bold = bold || style.is_bold(styles) || is_bold_tag(tag)

      let attrs =
        attrs
        |> dict.insert(size_attr, float.to_string(size))
        |> dict.insert(bold_attr, case bold {
          True -> "1"
          False -> "0"
        })

      Element(tag, attrs, list.map(children, go(_, size, bold)))
    }
  }
}

fn styles_of(attrs: Dict(String, String)) -> Dict(String, String) {
  case dict.get(attrs, "style") {
    Ok(value) -> style.parse(value)
    Error(_) -> dict.new()
  }
}

fn is_bold_tag(tag: String) -> Bool {
  tag == "b" || tag == "strong"
}

/// The resolved typography of a node, as attributes.
///
/// `normalize` rebuilds flattened table cells as fresh `<div>`s; without
/// carrying these across, the font size that made an element a heading is
/// discarded before `analyze` ever sees it.
pub fn carried_attrs(node: Node) -> Dict(String, String) {
  case node {
    Text(_) -> dict.new()
    Element(attrs:, ..) ->
      [size_attr, bold_attr]
      |> list.filter_map(fn(key) {
        case dict.get(attrs, key) {
          Ok(value) -> Ok(#(key, value))
          Error(_) -> Error(Nil)
        }
      })
      |> dict.from_list
  }
}

/// The resolved font size on an element, once `resolve` has run.
pub fn size_of(node: Node) -> Option(Float) {
  case node {
    Text(_) -> None
    Element(attrs:, ..) ->
      case dict.get(attrs, size_attr) {
        Ok(value) -> option.from_result(float.parse(value))
        Error(_) -> None
      }
  }
}

fn bold_of(node: Node) -> Bool {
  dom.attr_or_empty(node, bold_attr) == "1"
}

// ── Analysis ─────────────────────────────────────────────────────────

/// Measure a resolved document: find the body size, then the tiers above it.
pub fn analyze(root: Node) -> Tiers {
  let samples = collect(root, [])
  let body = body_size(samples)
  Tiers(body_px: body, sizes: tiers(samples, body))
}

/// A run of text with the typography it resolved to.
type Sample {
  Sample(size: Float, bold: Bool, alphabetic: Bool)
}

fn collect(node: Node, acc: List(Sample)) -> List(Sample) {
  case node {
    Text(_) -> acc
    Element(children:, ..) -> {
      let size = size_of(node) |> option.unwrap(default_px)
      let bold = bold_of(node)

      // Only count text sitting directly in this element, so a size is
      // credited once rather than at every ancestor.
      let direct =
        children
        |> list.filter_map(fn(child) {
          case child {
            Text(content:) ->
              case string.trim(content) {
                "" -> Error(Nil)
                text -> Ok(text)
              }
            Element(..) -> Error(Nil)
          }
        })
        |> string.join(" ")

      let acc = case direct {
        "" -> acc
        _ -> [Sample(size, bold, chars.has_letter(direct)), ..acc]
      }

      list.fold(children, acc, fn(acc, child) { collect(child, acc) })
    }
  }
}

/// The most common size, counted by how many text runs use it.
///
/// Counts runs, not characters, matching `analysis.rs`. Weighting by
/// character count looks reasonable and is wrong: Fidelity's legal footer is
/// 617 characters at 12px against 413 characters of 16px body copy, so the
/// baseline came out as 12px and every ordinary paragraph then cleared the
/// 1.2x gate and became a heading. A long disclaimer is one stylistic
/// region, not the document's body.
fn body_size(samples: List(Sample)) -> Float {
  let counts =
    samples
    |> list.filter(fn(sample) { sample.size >=. min_body_px })
    |> list.fold(dict.new(), fn(acc, sample) {
      let key = sample.size |> float.round |> int.to_float
      let running = dict.get(acc, key) |> result_or(0)
      dict.insert(acc, key, running + 1)
    })

  counts
  |> dict.to_list
  |> list.fold(#(default_px, 0), fn(best, entry) {
    let #(_, best_weight) = best
    let #(size, weight) = entry
    // Ties resolve to the smaller size, matching analysis.rs.
    case weight > best_weight || { weight == best_weight && size <. best.0 } {
      True -> #(size, weight)
      False -> best
    }
  })
  |> fn(best) { best.0 }
}

fn result_or(result: Result(Int, Nil), default: Int) -> Int {
  case result {
    Ok(value) -> value
    Error(_) -> default
  }
}

fn tiers(samples: List(Sample), body: Float) -> List(Float) {
  let found =
    samples
    // Digit-only runs (dates, amounts, prices) must not define a tier.
    |> list.filter(fn(sample) { sample.alphabetic })
    |> list.filter(fn(sample) { sample.size /. body >=. heading_ratio })
    |> list.map(fn(sample) { sample.size })
    |> sort_desc
    |> cluster

  case found {
    // Nothing cleared the gate — fall back to bold text modestly above body,
    // so documents setting headings only slightly larger still get an H1.
    [] ->
      samples
      |> list.filter(fn(sample) { sample.alphabetic && sample.bold })
      |> list.filter(fn(sample) { sample.size /. body >=. bold_fallback_ratio })
      |> list.map(fn(sample) { sample.size })
      |> sort_desc
      |> cluster
      |> list.take(max_tiers)
    _ -> list.take(found, max_tiers)
  }
}

fn sort_desc(sizes: List(Float)) -> List(Float) {
  list.sort(sizes, fn(a, b) { float.compare(b, a) })
}

fn cluster(sizes: List(Float)) -> List(Float) {
  sizes
  |> list.fold([], fn(acc, size) {
    case list.any(acc, fn(tier) { near(tier, size) }) {
      True -> acc
      False -> [size, ..acc]
    }
  })
  |> list.reverse
}

fn near(a: Float, b: Float) -> Bool {
  float.absolute_value(a -. b) <. tier_tolerance
}

// ── Application ──────────────────────────────────────────────────────

/// Which heading level, if any, does this size correspond to?
pub fn level_for(tiers: Tiers, size: Float) -> Option(Int) {
  case matching_tier(tiers.sizes, size, 1) {
    Some(level) -> Some(level)
    None ->
      // Above body but matching no tier: place it after the last one.
      case size /. tiers.body_px >=. heading_ratio {
        True -> Some(int.min(list.length(tiers.sizes) + 1, max_tiers))
        False -> None
      }
  }
}

fn matching_tier(sizes: List(Float), size: Float, level: Int) -> Option(Int) {
  case sizes {
    [] -> None
    [tier, ..rest] ->
      case near(tier, size) {
        True -> Some(level)
        False -> matching_tier(rest, size, level + 1)
      }
  }
}
