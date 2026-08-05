//// Recognizing list markers written as literal text.
////
//// Ported from `pdf-inspector/src/markdown/classify.rs`. Emails routinely
//// build "lists" as `<td>` or `<p>` runs that begin with a literal bullet
//// and no `<ul>` in sight, so the marker has to be recognized from the text.
////
//// Deviation from the Rust original: single-letter markers (`a.`, `b)`) are
//// NOT recognized. In a PDF they are unambiguous; in email prose they fire on
//// every "e.g." and "i.e.". Real lettered lists arrive as `<ol type="a">`,
//// which the emitter handles structurally.

import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string

const bullets = ["•", "●", "○", "◦", "▪", "▫", "‣", "·", "*", "-", "–", "—"]

/// A recognized leading list marker.
pub type Marker {
  /// An unordered bullet of any glyph.
  Bullet
  /// An ordered marker, carrying its number as written.
  Ordered(number: Int)
}

/// Does this text open with a literal list marker?
pub fn is_list_item(text: String) -> Bool {
  option.is_some(list_marker(text))
}

/// Split a leading list marker from its content.
///
/// Requires whitespace after the marker, so "1.5 million" and "e.g. this"
/// are not mistaken for list items.
pub fn list_marker(text: String) -> Option(#(Marker, String)) {
  let trimmed = string.trim_start(text)

  case bullet_marker(trimmed) {
    Some(rest) -> Some(#(Bullet, rest))
    None -> ordered_marker(trimmed)
  }
}

/// Rewrite a literal list line as Markdown, or return it unchanged.
pub fn format_list_item(text: String) -> String {
  case list_marker(text) {
    Some(#(Bullet, rest)) -> "- " <> rest
    Some(#(Ordered(number), rest)) -> int.to_string(number) <> ". " <> rest
    None -> text
  }
}

fn bullet_marker(trimmed: String) -> Option(String) {
  case string.pop_grapheme(trimmed) {
    Ok(#(first, rest)) ->
      case list.contains(bullets, first) && starts_with_space(rest) {
        True -> Some(string.trim_start(rest))
        False -> None
      }
    Error(_) -> None
  }
}

/// Matches `1.`, `1)`, and `(1)`, each requiring trailing whitespace.
fn ordered_marker(trimmed: String) -> Option(#(Marker, String)) {
  let #(body, closers) = case string.starts_with(trimmed, "(") {
    True -> #(string.drop_start(trimmed, 1), [")"])
    False -> #(trimmed, [".", ")"])
  }

  let digits =
    body
    |> string.to_graphemes
    |> list.take_while(fn(g) { result.is_ok(int.parse(g)) })
    |> string.concat

  case digits == "" {
    True -> None
    False -> {
      let after = string.drop_start(body, string.length(digits))
      case string.pop_grapheme(after) {
        Ok(#(closer, rest)) ->
          case list.contains(closers, closer) && starts_with_space(rest) {
            True ->
              case int.parse(digits) {
                Ok(number) -> Some(#(Ordered(number), string.trim_start(rest)))
                Error(_) -> None
              }
            False -> None
          }
        Error(_) -> None
      }
    }
  }
}

/// Is this text *entirely* a list marker?
///
/// Used when a marker occupies its own table cell, where the "e.g." ambiguity
/// that rules out letter markers in prose cannot arise. Accepts `A.`, `a)`,
/// `(b)` and numeric forms in addition to bullets.
pub fn is_standalone_marker(text: String) -> Bool {
  let trimmed = string.trim(text)

  case string.length(trimmed) {
    0 -> False
    length if length > 4 -> False
    _ ->
      list.contains(bullets, trimmed)
      || is_labelled_marker(trimmed)
      || option.is_some(list_marker(trimmed <> " x"))
  }
}

/// `A.` / `a)` / `(b)` / `12.` — a label followed by a closing mark.
fn is_labelled_marker(trimmed: String) -> Bool {
  let body = case string.starts_with(trimmed, "(") {
    True -> string.drop_start(trimmed, 1)
    False -> trimmed
  }

  case string.pop_grapheme(body) {
    Ok(#(first, rest)) ->
      is_alphanumeric(first) && list.contains([".", ")"], string.trim(rest))
    Error(_) -> False
  }
}

fn is_alphanumeric(grapheme: String) -> Bool {
  result.is_ok(int.parse(grapheme))
  || string.lowercase(grapheme) != string.uppercase(grapheme)
}

fn starts_with_space(text: String) -> Bool {
  case string.pop_grapheme(text) {
    Ok(#(first, _)) -> string.trim(first) == ""
    Error(_) -> False
  }
}
