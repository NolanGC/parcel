//// Shared string helpers.
////
//// All three of these replaced a `string.to_graphemes` fold, so the cases
//// that matter are the ones where segmenting and not segmenting could
//// disagree: astral characters, combining marks, and scripts without case.

import email_to_markdown/chars

// ── squeeze_spaces ───────────────────────────────────────────────────

pub fn single_spaces_are_left_alone_test() {
  assert chars.squeeze_spaces("a b c") == "a b c"
}

pub fn runs_collapse_to_one_test() {
  assert chars.squeeze_spaces("a    b") == "a b"
}

/// Each pass halves a run, so an odd-length one must not settle a pass early.
pub fn odd_length_runs_collapse_fully_test() {
  assert chars.squeeze_spaces("a       b") == "a b"
  assert chars.squeeze_spaces("a" <> string_of_spaces(31) <> "b") == "a b"
}

fn string_of_spaces(count: Int) -> String {
  case count {
    0 -> ""
    _ -> " " <> string_of_spaces(count - 1)
  }
}

pub fn leading_and_trailing_runs_collapse_test() {
  assert chars.squeeze_spaces("   a   ") == " a "
}

// ── collapse_whitespace ──────────────────────────────────────────────

pub fn newlines_and_tabs_become_spaces_test() {
  assert chars.collapse_whitespace("a\n\tb") == "a b"
}

pub fn mixed_whitespace_runs_collapse_test() {
  assert chars.collapse_whitespace("a \n \t\r b") == "a b"
}

/// The set has to match what `string.trim` recognizes, or text that survives
/// one is destroyed by the other.
pub fn exotic_whitespace_is_recognized_test() {
  assert chars.collapse_whitespace("a\u{0085}b") == "a b"
  assert chars.collapse_whitespace("a\u{2028}b") == "a b"
  assert chars.collapse_whitespace("a\u{2029}b") == "a b"
  assert chars.collapse_whitespace("a\u{000b}\u{000c}b") == "a b"
}

/// `&nbsp;` is not whitespace to `string.trim`, and callers rely on that —
/// `normalize` maps it to a space itself, deliberately and separately.
pub fn non_breaking_space_is_not_whitespace_test() {
  assert chars.collapse_whitespace("a\u{00a0}b") == "a\u{00a0}b"
}

pub fn empty_input_is_unchanged_test() {
  assert chars.collapse_whitespace("") == ""
}

// ── has_letter ───────────────────────────────────────────────────────

pub fn plain_words_have_letters_test() {
  assert chars.has_letter("Yes")
  assert chars.has_letter("a")
}

pub fn digits_and_punctuation_do_not_test() {
  assert chars.has_letter("1") == False
  assert chars.has_letter("$3,584.73") == False
  assert chars.has_letter("2024-01-15") == False
  assert chars.has_letter("") == False
  assert chars.has_letter("— • ›") == False
}

/// One cased character anywhere is enough, which is what the per-grapheme
/// version this replaced was checking.
pub fn one_letter_among_symbols_counts_test() {
  assert chars.has_letter("$5 a")
  assert chars.has_letter("•\u{00a0}x")
}

/// Scripts without case must not register, or every price and date in a
/// CJK email would be eligible for promotion to a heading.
pub fn uncased_scripts_do_not_count_test() {
  assert chars.has_letter("日本語") == False
  assert chars.has_letter("العربية") == False
  assert chars.has_letter("😀🎉") == False
}

/// Cased letters outside the Basic Multilingual Plane still count, and this
/// is where a naive per-code-unit check would go wrong.
pub fn astral_cased_letters_count_test() {
  assert chars.has_letter("\u{10428}")
}

/// `ß` uppercases to two characters, so the string changes length. Whole-
/// string case mapping has to stay equivalent to the per-character test.
pub fn length_changing_case_mapping_counts_test() {
  assert chars.has_letter("straße")
  assert chars.has_letter("ß")
}
