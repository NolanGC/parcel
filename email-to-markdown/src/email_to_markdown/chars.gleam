//// Small string helpers shared across stages.
////
//// Each of these was written twice or more before landing here. They are the
//// operations that turn out to be needed wherever text is handled, and all of
//// them avoid `string.to_graphemes`: segmenting a document's worth of text is
//// far more expensive than a handful of native replaces, and these sit on the
//// hot path.

import gleam/list
import gleam/string

/// The characters `string.trim` treats as whitespace.
///
/// Hardcoded because callers have to agree with `trim` exactly and there is
/// no way to ask it. Space itself is omitted — it is the character the others
/// are folded onto.
const whitespace = [
  "\u{0009}", "\u{000a}", "\u{000b}", "\u{000c}", "\u{000d}", "\u{0085}",
  "\u{2028}", "\u{2029}",
]

/// Collapse runs of two or more spaces into one.
///
/// Halves every run per pass, so this settles in log2(longest run) passes of
/// a native replace.
pub fn squeeze_spaces(text: String) -> String {
  case string.contains(text, "  ") {
    True -> squeeze_spaces(string.replace(text, "  ", " "))
    False -> text
  }
}

/// Collapse every run of whitespace — of any kind — into a single space.
pub fn collapse_whitespace(text: String) -> String {
  whitespace
  |> list.fold(text, fn(acc, character) { string.replace(acc, character, " ") })
  |> squeeze_spaces
}

/// Does this text contain anything cased, as opposed to only digits,
/// punctuation and symbols?
///
/// Used to keep `$5.00` and `2024-01-15` from being promoted to headings, and
/// to tell `alt="Yes"` from `alt="1"`. Case-mapping is the cheapest test that
/// works across scripts.
pub fn has_letter(text: String) -> Bool {
  string.lowercase(text) != string.uppercase(text)
}
