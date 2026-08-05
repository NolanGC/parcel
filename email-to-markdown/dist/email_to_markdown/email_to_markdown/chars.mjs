import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import { toList } from "../gleam.mjs";

/**
 * The characters `string.trim` treats as whitespace.
 *
 * Hardcoded because callers have to agree with `trim` exactly and there is
 * no way to ask it. Space itself is omitted — it is the character the others
 * are folded onto.
 * 
 * @ignore
 */
const whitespace = /* @__PURE__ */ toList([
  "\u{0009}",
  "\u{000a}",
  "\u{000b}",
  "\u{000c}",
  "\u{000d}",
  "\u{0085}",
  "\u{2028}",
  "\u{2029}",
]);

/**
 * Collapse runs of two or more spaces into one.
 *
 * Halves every run per pass, so this settles in log2(longest run) passes of
 * a native replace.
 */
export function squeeze_spaces(loop$text) {
  while (true) {
    let text = loop$text;
    let $ = $string.contains(text, "  ");
    if ($) {
      loop$text = $string.replace(text, "  ", " ");
    } else {
      return text;
    }
  }
}

/**
 * Collapse every run of whitespace — of any kind — into a single space.
 */
export function collapse_whitespace(text) {
  let _pipe = whitespace;
  let _pipe$1 = $list.fold(
    _pipe,
    text,
    (acc, character) => { return $string.replace(acc, character, " "); },
  );
  return squeeze_spaces(_pipe$1);
}

/**
 * Does this text contain anything cased, as opposed to only digits,
 * punctuation and symbols?
 *
 * Used to keep `$5.00` and `2024-01-15` from being promoted to headings, and
 * to tell `alt="Yes"` from `alt="1"`. Case-mapping is the cheapest test that
 * works across scripts.
 */
export function has_letter(text) {
  return $string.lowercase(text) !== $string.uppercase(text);
}
