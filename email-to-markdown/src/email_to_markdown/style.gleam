//// Inline `style` attribute parsing.
////
//// Email styling is overwhelmingly inline, because mail clients strip
//// `<style>` blocks. Parsing it here rather than in the FFI keeps the
//// visibility rules testable.

import gleam/dict.{type Dict}
import gleam/float
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string

/// Parse a `style` attribute into normalized property/value pairs.
///
/// Keys and values are lowercased and trimmed. Values keep internal
/// structure, so `url(...)` and multi-part values survive intact.
pub fn parse(style_attr: String) -> Dict(String, String) {
  style_attr
  |> string.split(";")
  |> list.filter_map(parse_declaration)
  |> dict.from_list
}

fn parse_declaration(declaration: String) -> Result(#(String, String), Nil) {
  // Split on the *first* colon only — values legitimately contain colons
  // (`background:url(http://...)`).
  case string.split_once(declaration, ":") {
    Ok(#(property, value)) -> {
      let property = property |> string.trim |> string.lowercase
      let value = value |> string.trim |> string.lowercase |> drop_important
      case property == "" {
        True -> Error(Nil)
        False -> Ok(#(property, value))
      }
    }
    Error(_) -> Error(Nil)
  }
}

/// Strip a trailing `!important`.
///
/// Email CSS is saturated with it — Fidelity hides its preheader with
/// `display:none !important` — and leaving it attached makes the value
/// compare unequal to `none`, silently defeating every visibility rule.
fn drop_important(value: String) -> String {
  case string.split_once(value, "!") {
    Ok(#(before, rest)) ->
      case string.trim(rest) == "important" {
        True -> string.trim(before)
        False -> value
      }
    Error(_) -> value
  }
}

/// Look up a declared property.
pub fn get(styles: Dict(String, String), property: String) -> Option(String) {
  styles |> dict.get(property) |> option.from_result
}

/// Is a property declared with one of the given values?
pub fn is_any(
  styles: Dict(String, String),
  property: String,
  values: List(String),
) -> Bool {
  case get(styles, property) {
    Some(actual) -> list.contains(values, actual)
    None -> False
  }
}

/// Parse a CSS length to a float, tolerating units (`px`, `pt`, `em`, `%`).
/// `None` when the value is not a number with an optional unit suffix.
pub fn length(value: String) -> Option(Float) {
  case take_number(string.trim(value), "") {
    "" -> None
    numeric -> option.from_result(to_float(numeric))
  }
}

/// The leading numeric run: digits, with an optional sign and decimal point.
///
/// Matched as string prefixes rather than by segmenting into graphemes. This
/// runs for nearly every styled element in the document, and `to_graphemes`
/// invokes the Unicode segmenter even on a value as short as `12px`.
fn take_number(value: String, acc: String) -> String {
  case value {
    "0" <> rest -> take_number(rest, acc <> "0")
    "1" <> rest -> take_number(rest, acc <> "1")
    "2" <> rest -> take_number(rest, acc <> "2")
    "3" <> rest -> take_number(rest, acc <> "3")
    "4" <> rest -> take_number(rest, acc <> "4")
    "5" <> rest -> take_number(rest, acc <> "5")
    "6" <> rest -> take_number(rest, acc <> "6")
    "7" <> rest -> take_number(rest, acc <> "7")
    "8" <> rest -> take_number(rest, acc <> "8")
    "9" <> rest -> take_number(rest, acc <> "9")
    "." <> rest -> take_number(rest, acc <> ".")
    "-" <> rest -> take_number(rest, acc <> "-")
    _ -> acc
  }
}

/// `float.parse` rejects integer-looking input such as `"0"`, which is exactly
/// what a collapsed email spacer declares. Fall back to integer parsing.
fn to_float(raw: String) -> Result(Float, Nil) {
  case float.parse(raw) {
    Ok(number) -> Ok(number)
    Error(_) -> int.parse(raw) |> result.map(int.to_float)
  }
}

/// A length in CSS pixels. `None` for percentages and keywords.
///
/// `length` happily reads "100%" as 100.0, which is meaningless as a pixel
/// count — a full-width image and a 100px one are very different things.
pub fn px(value: String) -> Option(Float) {
  case string.contains(value, "%") {
    True -> None
    False -> length(value)
  }
}

/// Is the declared length effectively zero?
pub fn is_zero_length(value: String) -> Bool {
  case length(value) {
    Some(number) -> number <=. 0.0
    None -> False
  }
}

// ── Colour ───────────────────────────────────────────────────────────

/// Keywords that name no particular colour, so two of them being equal says
/// nothing about whether anything is readable.
const non_colours = [
  "inherit", "initial", "unset", "revert", "currentcolor", "auto", "none", "",
]

/// Colour names worth resolving. The full CSS table is 148 entries and buys
/// nothing here: identical names already compare equal as written, so only
/// the ones that get spelled several different ways need normalizing — which
/// in practice means white and black.
const named_colours = [
  #("white", "#ffffff"),
  #("black", "#000000"),
  #("transparent", "transparent"),
]

/// Normalize a colour so notations compare equal — `#fff`, `#ffffff`, `white`
/// and `rgb(255, 255, 255)` all become `#ffffff`.
///
/// `None` when the value names no single colour: a keyword like `inherit`, or
/// a `background` shorthand carrying an image or gradient, where whatever is
/// underneath decides readability rather than the declared colour.
pub fn colour(value: String) -> Option(String) {
  let value = value |> string.trim |> string.lowercase

  case list.contains(non_colours, value) || string.contains(value, "url(") {
    True -> None
    False ->
      case value {
        "#" <> digits -> from_hex(digits)
        "rgb(" <> rest | "rgba(" <> rest -> from_rgb(rest)
        _ ->
          case list.key_find(named_colours, value) {
            Ok(resolved) -> Some(resolved)
            // An unrecognised keyword still compares equal to itself, which
            // is all the caller needs.
            Error(_) -> Some(value)
          }
      }
  }
}

fn from_hex(digits: String) -> Option(String) {
  case string.to_graphemes(digits) {
    [r, g, b] -> Some("#" <> r <> r <> g <> g <> b <> b)
    [_, _, _, _, _, _] -> Some("#" <> digits)
    _ -> None
  }
}

fn from_rgb(rest: String) -> Option(String) {
  let parts =
    rest
    |> string.replace(")", "")
    |> string.replace("/", ",")
    |> string.split(",")
    |> list.map(string.trim)

  case parts {
    // A fully transparent colour paints nothing, whatever its channels say.
    [_, _, _, alpha] if alpha == "0" || alpha == "0.0" -> Some("transparent")
    [red, green, blue, ..] ->
      case channel(red), channel(green), channel(blue) {
        Some(r), Some(g), Some(b) -> Some("#" <> r <> g <> b)
        _, _, _ -> None
      }
    _ -> None
  }
}

fn channel(raw: String) -> Option(String) {
  case int.parse(raw) {
    Ok(number) if number >= 0 && number <= 255 -> Some(hex_byte(number))
    _ -> None
  }
}

fn hex_byte(number: Int) -> String {
  let digits = int.to_base16(number) |> string.lowercase
  case string.length(digits) {
    1 -> "0" <> digits
    _ -> digits
  }
}

// ── Emphasis ─────────────────────────────────────────────────────────
//
// Email expresses emphasis through inline CSS far more often than through
// `<strong>` / `<em>`, so both the normalizer and the emitter need these.

/// `font-weight: bold`, `bolder`, or a numeric weight of 600+.
pub fn is_bold(styles: Dict(String, String)) -> Bool {
  case get(styles, "font-weight") {
    Some(value) ->
      value == "bold"
      || value == "bolder"
      || case length(value) {
        Some(weight) -> weight >=. 600.0
        None -> False
      }
    None -> False
  }
}

/// `font-style: italic` or `oblique`.
pub fn is_italic(styles: Dict(String, String)) -> Bool {
  is_any(styles, "font-style", ["italic", "oblique"])
}

/// `text-decoration: underline` or `line-through`.
pub fn is_decorated(styles: Dict(String, String)) -> Bool {
  is_any(styles, "text-decoration", ["underline", "line-through"])
}

/// Does this element push its neighbours apart horizontally?
///
/// Emails routinely separate words with CSS alone —
/// `<span style="padding-right:5px">Hi</span><span>Nolan</span>` contains no
/// whitespace whatsoever, yet reads as two words. This is the same inference
/// pdf-inspector makes from geometric gaps, one layer up.
pub fn has_horizontal_gap(styles: Dict(String, String)) -> Bool {
  positive(styles, "padding-right")
  || positive(styles, "padding-left")
  || positive(styles, "margin-right")
  || positive(styles, "margin-left")
}

fn positive(styles: Dict(String, String), property: String) -> Bool {
  case get(styles, property) {
    Some(value) ->
      case length(value) {
        Some(number) -> number >. 0.0
        None -> False
      }
    None -> False
  }
}
