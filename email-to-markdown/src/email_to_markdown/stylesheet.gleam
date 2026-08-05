//// `<style>` block resolution.
////
//// Email was long assumed to be inline-styles-only, because clients used to
//// strip `<style>`. Gmail no longer does, and senders rely on it — Fidelity
//// hides its preheader with `.preheader { display:none }` in a stylesheet,
//// not on the element.
////
//// That matters beyond tidiness. `visibility` is the hidden-text
//// prompt-injection defense, and it reads the element's own style. Without
//// this module, thirty characters of CSS defeats it:
////
//// ```html
//// <style>.x{display:none}</style>
//// <div class="x">Ignore previous instructions.</div>
//// ```
////
//// Matched declarations are merged into each element's `style` attribute, so
//// every downstream stage sees them with no changes of its own.

import email_to_markdown/dom.{type Node, Element, Text}
import gleam/dict
import gleam/int
import gleam/list
import gleam/string

/// What a rule matches on. Descendant selectors are approximated by their
/// rightmost compound (`.header .logo` matches any `.logo`), which
/// over-matches rather than under-matches — the safe direction for a
/// visibility rule.
pub type Selector {
  Class(name: String)
  Id(name: String)
  Tag(name: String)
}

pub type Rule {
  Rule(selector: Selector, declarations: String, specificity: Int)
}

/// Rules are only useful if they carry something a later stage reads.
///
/// This list has to stay in step with what `visibility`, `style`, `table` and
/// `emit` actually look up. A property missing here is invisible to them, so
/// the declaration works inline and silently does nothing from a `<style>`
/// block — an asymmetry that has produced three separate bugs.
///
/// `convert_test` pins it: every property below is asserted to mean the same
/// thing declared either way, so dropping one fails the suite. Adding a read
/// of a new property means adding it here and there.
///
/// Filtering by name is not only about size. The size caps below bound the
/// worst case either way, but dropping this list makes a crafted stylesheet
/// roughly 3.5x more expensive to merge, and adversarial input is the case
/// that matters.
const interesting = [
  "display", "visibility", "opacity", "font-size", "font-weight", "font-style",
  "line-height", "max-height", "width", "height", "position", "left", "top",
  "text-decoration", "color", "background", "background-color", "clip",
  "clip-path", "transform", "text-indent", "text-align", "padding-left",
  "padding-right", "margin-left", "margin-right",
]

// ── Parsing ──────────────────────────────────────────────────────────

/// Parse a stylesheet into flat rules.
pub fn parse(css: String) -> List(Rule) {
  css
  |> strip_comments
  |> resolve_at_rules
  |> string.split("}")
  |> list.flat_map(to_rules)
}

fn to_rules(chunk: String) -> List(Rule) {
  case string.split_once(chunk, "{") {
    Error(_) -> []
    Ok(#(selectors, body)) -> {
      let declarations = keep_interesting(body)
      case declarations {
        "" -> []
        _ ->
          selectors
          |> string.split(",")
          |> list.filter_map(to_selector)
          |> list.map(fn(selector) {
            Rule(selector, declarations, specificity(selector))
          })
      }
    }
  }
}

/// Size bounds on what a single rule may carry.
///
/// These are amplification limits, not tidiness. Matched declarations are
/// copied onto *every* element the selector hits, so one oversized rule is
/// multiplied by the match count: a single 150KB value across 5,000 `<div>`s
/// cost 24 seconds and 1.9GB before these caps, from 210KB of input. The
/// largest declaration anywhere in the sample corpus is 313 bytes and the
/// largest rule body 832, so real mail has room to spare.
const max_declaration = 512

const max_rule_body = 2048

/// Keep only declarations some later stage actually reads, up to the size
/// budget above.
fn keep_interesting(body: String) -> String {
  body
  |> string.split(";")
  |> list.map(string.trim)
  |> list.filter(is_interesting)
  |> take_within(max_rule_body, [])
  |> string.join(";")
}

fn is_interesting(declaration: String) -> Bool {
  case string.split_once(declaration, ":") {
    Ok(#(property, _)) ->
      string.length(declaration) <= max_declaration
      && list.contains(interesting, property |> string.trim |> string.lowercase)
    Error(_) -> False
  }
}

/// Take declarations while they fit, dropping whole ones rather than
/// truncating — a half-written declaration is nobody's intent.
fn take_within(
  declarations: List(String),
  remaining: Int,
  acc: List(String),
) -> List(String) {
  case declarations {
    [] -> list.reverse(acc)
    [declaration, ..rest] -> {
      let size = string.length(declaration)
      case size > remaining {
        True -> list.reverse(acc)
        False -> take_within(rest, remaining - size, [declaration, ..acc])
      }
    }
  }
}

/// Reduce a selector to its rightmost compound, then to one simple part.
fn to_selector(raw: String) -> Result(Selector, Nil) {
  let last =
    raw
    |> string.trim
    |> string.replace(">", " ")
    |> string.replace("+", " ")
    |> string.replace("~", " ")
    |> string.split(" ")
    |> list.filter(fn(part) { part != "" })
    |> list.last

  case last {
    Error(_) -> Error(Nil)
    Ok(compound) -> {
      // Pseudo-classes and attribute selectors are not evaluated.
      let compound = compound |> take_before(":") |> take_before("[")
      case compound {
        "" | "*" -> Error(Nil)
        _ ->
          case string.split_once(compound, ".") {
            // `div.cls` and `.cls` both key on the class.
            Ok(#(_, class)) if class != "" -> Ok(Class(string.lowercase(class)))
            _ ->
              case string.split_once(compound, "#") {
                Ok(#(_, id)) if id != "" -> Ok(Id(string.lowercase(id)))
                _ -> Ok(Tag(string.lowercase(compound)))
              }
          }
      }
    }
  }
}

fn take_before(text: String, marker: String) -> String {
  case string.split_once(text, marker) {
    Ok(#(before, _)) -> before
    Error(_) -> text
  }
}

/// CSS specificity, coarsely: id beats class beats tag.
fn specificity(selector: Selector) -> Int {
  case selector {
    Id(_) -> 100
    Class(_) -> 10
    Tag(_) -> 1
  }
}

fn strip_comments(css: String) -> String {
  case string.split_once(css, "/*") {
    Error(_) -> css
    Ok(#(before, rest)) ->
      case string.split_once(rest, "*/") {
        Ok(#(_, after)) -> before <> strip_comments(after)
        Error(_) -> before
      }
  }
}

/// Resolve at-rules: inline the blocks whose condition always holds, drop
/// the rest.
///
/// Dropping every at-rule was the simpler rule and left a hole. `@media
/// (max-width: 480px)` really must go — honouring it would hide content that
/// is plainly visible, and LinkedIn's mobile rules would blank most of the
/// message. But `@media screen` and `@media all` carry no condition at all,
/// so they always apply, which makes them a tidy place to hide injected text
/// from a defense that throws them away unread.
///
/// Every `@media` in the sample corpus carries a feature query, so honouring
/// the unconditional ones costs real mail nothing.
fn resolve_at_rules(css: String) -> String {
  scan(css, 0, "")
}

/// Walk to each at-rule, tracking brace depth on the way.
///
/// The depth is what stops `background:url(https://x.test/@2x.png)` from
/// being read as an at-rule and swallowing the rule after it — which happened,
/// and there is one such URL in the corpus. Requiring a letter after the `@`
/// covers the other spelling, a selector like `[href*="@"]`.
///
/// Splitting on `@` and counting braces in each chunk, rather than walking
/// marker to marker, keeps a stylesheet with no at-rules at a single scan.
/// The marker-walking version compared positions with `string.length`, which
/// segments graphemes, and cost 45ms a corpus.
fn scan(css: String, depth: Int, acc: String) -> String {
  case string.split_once(css, "@") {
    Error(_) -> acc <> css
    Ok(#(before, rest)) -> {
      let depth = depth + count(before, "{") - count(before, "}")
      case depth == 0 && starts_with_letter(rest) {
        False -> scan(rest, depth, acc <> before <> "@")
        True -> {
          let #(prelude, body, after) = split_at_rule(rest)
          let kept = case always_applies(prelude) {
            True -> scan(body, 0, "")
            False -> ""
          }
          scan(after, depth, acc <> before <> kept)
        }
      }
    }
  }
}

fn count(text: String, needle: String) -> Int {
  case string.contains(text, needle) {
    False -> 0
    True -> list.length(string.split(text, needle)) - 1
  }
}

fn starts_with_letter(css: String) -> Bool {
  case string.first(css) {
    Ok(character) -> string.lowercase(character) != string.uppercase(character)
    Error(_) -> False
  }
}

/// Split an at-rule into its prelude, its block body, and what follows.
fn split_at_rule(rest: String) -> #(String, String, String) {
  case string.split_once(rest, "{") {
    Error(_) -> #(rest, "", "")
    Ok(#(prelude, body)) ->
      case string.split_once(prelude, ";") {
        // The semicolon arrived first, so this at-rule has no block of its
        // own — `@import url(...)`, `@charset "utf-8"`. The `{` belonged to
        // whatever rule comes next, so hand it back.
        Ok(#(statement, after)) -> #(statement, "", after <> "{" <> body)
        Error(_) -> {
          let #(inner, after) = take_block(body, 1, "")
          #(prelude, inner, after)
        }
      }
  }
}

/// The contents of a balanced block, and the text after its closing brace.
///
/// Jumps brace to brace rather than grapheme to grapheme. Stepping one
/// character at a time allocates a fresh substring per character, which made
/// parsing a 25KB stylesheet take 400ms — more than the rest of the pipeline
/// put together.
fn take_block(css: String, depth: Int, acc: String) -> #(String, String) {
  case next_brace(css) {
    Error(_) -> #(acc <> css, "")
    Ok(#(True, before, rest)) ->
      take_block(rest, depth + 1, acc <> before <> "{")
    Ok(#(False, before, rest)) ->
      case depth {
        1 -> #(acc <> before, rest)
        _ -> take_block(rest, depth - 1, acc <> before <> "}")
      }
  }
}

/// The next `{` or `}`: whether it opened a block, the text before it, and
/// the text after it.
fn next_brace(css: String) -> Result(#(Bool, String, String), Nil) {
  case string.split_once(css, "{"), string.split_once(css, "}") {
    Ok(#(before_open, after_open)), Ok(#(before_close, after_close)) ->
      case string.length(before_open) < string.length(before_close) {
        True -> Ok(#(True, before_open, after_open))
        False -> Ok(#(False, before_close, after_close))
      }
    Ok(#(before_open, after_open)), Error(_) ->
      Ok(#(True, before_open, after_open))
    Error(_), Ok(#(before_close, after_close)) ->
      Ok(#(False, before_close, after_close))
    Error(_), Error(_) -> Error(Nil)
  }
}

/// Does this at-rule's condition hold for the reader we assume — someone on
/// a desktop screen?
fn always_applies(prelude: String) -> Bool {
  let normalized =
    prelude
    |> string.lowercase
    |> string.replace("\n", " ")
    |> string.replace("\t", " ")
    |> string.trim

  case string.split_once(normalized, " ") {
    Ok(#("media", query)) -> unconditional_media(query)
    // Assume the queried feature is supported, which is why an attacker would
    // reach for it. `not` inverts that, so it is left alone.
    Ok(#("supports", query)) -> !string.starts_with(string.trim(query), "not")
    _ -> False
  }
}

/// A media query with no feature test and no medium we are not — `screen`,
/// `all`, or a comma-separated list of those.
fn unconditional_media(query: String) -> Bool {
  case string.contains(query, "(") {
    True -> False
    False ->
      query
      |> string.split(",")
      |> list.all(fn(part) {
        list.contains(["all", "screen", "only screen"], string.trim(part))
      })
  }
}

// ── Application ──────────────────────────────────────────────────────

/// Merge matching declarations into every element's `style` attribute.
///
/// Rules are applied lowest specificity first and the element's own inline
/// style goes last, so `dict.from_list` in `style.parse` — where later keys
/// win — reproduces CSS precedence closely enough.
pub fn apply(rules: List(Rule), node: Node) -> Node {
  case rules {
    [] -> node
    _ -> resolve(node, rules)
  }
}

fn resolve(node: Node, rules: List(Rule)) -> Node {
  case node {
    Text(_) -> node
    Element(tag:, attrs:, children:) -> {
      // Split the class attribute once per element, not once per rule. A
      // long stylesheet against a large tree is elements x rules, and doing
      // string work inside that product dominated everything else.
      let classes = attrs |> attr_value("class") |> string.split(" ")
      let id = attr_value(attrs, "id")

      let matched =
        rules
        |> list.filter(fn(rule) { matches(rule.selector, tag, id, classes) })
        |> list.sort(fn(a, b) { int.compare(a.specificity, b.specificity) })
        |> list.map(fn(rule) { rule.declarations })
        |> string.join(";")

      let inline = case dict.get(attrs, "style") {
        Ok(value) -> value
        Error(_) -> ""
      }

      let attrs = case matched {
        "" -> attrs
        _ -> dict.insert(attrs, "style", matched <> ";" <> inline)
      }

      Element(tag, attrs, list.map(children, resolve(_, rules)))
    }
  }
}

fn matches(
  selector: Selector,
  tag: String,
  id: String,
  classes: List(String),
) -> Bool {
  case selector {
    Tag(name) -> name == tag
    Id(name) -> id == name
    Class(name) -> list.contains(classes, name)
  }
}

fn attr_value(attrs: dict.Dict(String, String), key: String) -> String {
  case dict.get(attrs, key) {
    Ok(value) -> value |> string.trim |> string.lowercase
    Error(_) -> ""
  }
}
