//// String-level Markdown cleanup.
////
//// Ported from `pdf-inspector/src/markdown/postprocess.rs`, in the same order
//// its `clean_markdown` applies them. The PDF-only passes are deliberately
//// absent: `fix_hyphenation` repairs line-break artifacts, and
//// `remove_page_numbers` / `collapse_dot_leaders` strip page furniture and
//// table-of-contents leaders. None of those exist in email HTML.

import email_to_markdown/classify
import gleam/list
import gleam/string

/// Apply the full cleanup chain.
///
/// Fenced code blocks are passed through untouched. Every pass here is
/// whitespace- or punctuation-destructive, and inside a fence that is
/// corruption: collapsing runs of spaces silently destroys the alignment of
/// compiler output, diffs, and ASCII tables.
pub fn run(text: String) -> String {
  text
  |> segments
  |> list.map(clean_segment)
  |> string.join("\n")
  |> string.trim
  |> append_trailing_newline
}

/// A run of lines that is either inside a fenced code block or outside it.
type Segment {
  Code(lines: List(String))
  Prose(lines: List(String))
}

fn clean_segment(segment: Segment) -> String {
  case segment {
    Code(lines:) -> string.join(lines, "\n")
    Prose(lines:) ->
      lines
      |> string.join("\n")
      |> format_urls
      |> collapse_consecutive_spaces
      |> remove_spaces_before_closing_brackets
      |> remove_spaces_before_sentence_punctuation
      |> collapse_blank_lines
      |> tighten_lists
  }
}

/// Join adjacent list items that ended up separated by a blank line.
///
/// Emails build lists as sibling `<p>&bull; ...</p>` runs, which arrive here
/// as separate blocks. Rendered as a loose list they gain spurious spacing.
fn tighten_lists(text: String) -> String {
  text
  |> string.split("\n")
  |> do_tighten([])
  |> list.reverse
  |> string.join("\n")
}

fn do_tighten(lines: List(String), acc: List(String)) -> List(String) {
  case lines {
    [] -> acc
    // A blank line between two list items is dropped.
    ["", next, ..rest] ->
      case is_list_line(next) && acc != [] && first_is_list_line(acc) {
        True -> do_tighten([next, ..rest], acc)
        False -> do_tighten([next, ..rest], ["", ..acc])
      }
    [line, ..rest] -> do_tighten(rest, [line, ..acc])
  }
}

fn first_is_list_line(acc: List(String)) -> Bool {
  case acc {
    [line, ..] -> is_list_line(line)
    [] -> False
  }
}

fn is_list_line(line: String) -> Bool {
  classify.is_list_item(string.trim_start(line))
}

fn segments(text: String) -> List(Segment) {
  text
  |> string.split("\n")
  |> split_segments(False, [], [])
}

fn split_segments(
  lines: List(String),
  in_fence: Bool,
  current: List(String),
  acc: List(Segment),
) -> List(Segment) {
  case lines {
    [] -> list.reverse(close(in_fence, current, acc))
    [line, ..rest] ->
      case string.starts_with(string.trim_start(line), "```") {
        // The fence line itself belongs to the code segment on both sides.
        True ->
          case in_fence {
            False ->
              split_segments(rest, True, [line], close(False, current, acc))
            True ->
              split_segments(
                rest,
                False,
                [],
                close(True, [line, ..current], acc),
              )
          }
        False -> split_segments(rest, in_fence, [line, ..current], acc)
      }
  }
}

fn close(
  in_fence: Bool,
  current: List(String),
  acc: List(Segment),
) -> List(Segment) {
  case current {
    [] -> acc
    _ -> {
      let lines = list.reverse(current)
      case in_fence {
        True -> [Code(lines), ..acc]
        False -> [Prose(lines), ..acc]
      }
    }
  }
}

fn append_trailing_newline(text: String) -> String {
  case text {
    "" -> ""
    _ -> text <> "\n"
  }
}

// ── Space collapsing ─────────────────────────────────────────────────

/// Collapse runs of 2+ spaces to one, per line, preserving indentation.
pub fn collapse_consecutive_spaces(text: String) -> String {
  case string.contains(text, "  ") {
    False -> text
    True ->
      text
      |> string.split("\n")
      |> list.map(collapse_line)
      |> string.join("\n")
  }
}

fn collapse_line(line: String) -> String {
  let body = string.trim_start(line)
  case squeeze_spaces(body) {
    squeezed if squeezed == body -> line
    // `body` starts with a non-whitespace grapheme, so it cannot also occur
    // inside the indent — replacing it only touches the suffix.
    squeezed -> string.replace(line, body, squeezed)
  }
}

/// Halves every space run per pass, so this settles in log2(longest run)
/// passes of a native replace.
fn squeeze_spaces(text: String) -> String {
  case string.contains(text, "  ") {
    False -> text
    True -> squeeze_spaces(string.replace(text, "  ", " "))
  }
}

// ── Punctuation tidying ──────────────────────────────────────────────

/// `[kg/m3 ]` -> `[kg/m3]`. One space only: runs are already collapsed by the
/// time this pass runs.
pub fn remove_spaces_before_closing_brackets(text: String) -> String {
  string.replace(text, " ]", "]")
}

/// `word .` -> `word.`, only when the punctuation ends its token.
///
/// The `|` token-end case matters: table cells otherwise keep the stray space.
/// Runs of dots are never touched, so ellipses survive.
/// Lines are independent here — a newline is neither a space nor punctuation —
/// so the grapheme walk only runs on the few lines that can be affected.
pub fn remove_spaces_before_sentence_punctuation(text: String) -> String {
  text
  |> string.split("\n")
  |> list.map(tidy_punctuation)
  |> string.join("\n")
}

fn tidy_punctuation(line: String) -> String {
  case
    string.contains(line, " .")
    || string.contains(line, " ,")
    || string.contains(line, " ;")
  {
    False -> line
    True ->
      line
      |> string.to_graphemes
      |> walk_punctuation([])
      |> list.reverse
      |> string.concat
  }
}

fn walk_punctuation(
  graphemes: List(String),
  acc: List(String),
) -> List(String) {
  case graphemes {
    [] -> acc
    [current, ..rest] -> {
      let next = list.first(rest)
      let is_punctuation = list.contains([".", ",", ";"], current)
      let token_ends = case next {
        Ok(following) -> string.trim(following) == "" || following == "|"
        Error(_) -> True
      }
      let in_dot_run = current == "." && next == Ok(".")

      let acc = case
        is_punctuation
        && token_ends
        && !in_dot_run
        && list.first(acc) == Ok(" ")
      {
        True -> [current, ..list.drop(acc, 1)]
        False -> [current, ..acc]
      }
      walk_punctuation(rest, acc)
    }
  }
}

// ── Blank lines ──────────────────────────────────────────────────────

/// Collapse 3+ consecutive newlines to exactly two.
pub fn collapse_blank_lines(text: String) -> String {
  case string.contains(text, "\n\n\n") {
    True -> collapse_blank_lines(string.replace(text, "\n\n\n", "\n\n"))
    False -> text
  }
}

// ── URL linking ──────────────────────────────────────────────────────

/// Wrap bare `http(s)://` URLs as Markdown links.
///
/// Skips URLs already serving as a link target (`](...`) or sitting inside
/// link text (`[...]`), so existing links are never double-wrapped.
pub fn format_urls(text: String) -> String {
  walk_urls(text, "", Balance(brackets: 0, tags: 0))
}

/// Unclosed `[` and `<` in the text emitted so far. Counting these from the
/// whole accumulator once per URL is what made this pass quadratic; every
/// chunk is now counted exactly once, as it is appended.
type Balance {
  Balance(brackets: Int, tags: Int)
}

fn walk_urls(remaining: String, acc: String, balance: Balance) -> String {
  case next_url(remaining, "") {
    Error(_) -> acc <> remaining
    Ok(#(before, url, after)) -> {
      let balance = advance(balance, before)
      let linked = case already_linked(before, balance) {
        True -> url
        False -> "[" <> url <> "](" <> url <> ")"
      }
      walk_urls(after, acc <> before <> linked, advance(balance, linked))
    }
  }
}

fn advance(balance: Balance, chunk: String) -> Balance {
  Balance(
    brackets: balance.brackets
      + count_occurrences(chunk, "[")
      - count_occurrences(chunk, "]"),
    tags: balance.tags
      + count_occurrences(chunk, "<")
      - count_occurrences(chunk, ">"),
  )
}

/// Split at the next bare URL: text before it, the URL, and the remainder.
/// `skipped` carries the `http` occurrences that turned out not to be schemes.
///
/// Note what this does *not* do: rebuild `"http" <> rest`. That concatenation
/// is a rope, and every subsequent character operation on it forces the engine
/// to flatten the whole remaining document — once per URL, which is quadratic.
/// Matching the scheme as a prefix pattern keeps the tail a plain slice.
fn next_url(
  text: String,
  skipped: String,
) -> Result(#(String, String, String), Nil) {
  case string.split_once(text, "http") {
    Error(_) -> Error(Nil)
    Ok(#(before, rest)) ->
      case rest {
        "s://" <> tail -> {
          let #(url, after) = take_url("https://", tail)
          Ok(#(skipped <> before, url, after))
        }
        "://" <> tail -> {
          let #(url, after) = take_url("http://", tail)
          Ok(#(skipped <> before, url, after))
        }
        // Not a real scheme — keep scanning past this "http".
        _ -> next_url(rest, skipped <> before <> "http")
      }
  }
}

const url_terminators = [" ", "\t", "\n", "<", ">", ")", "]", "\"", "'"]

/// Take the URL running from the start of `tail`, and return it along with
/// whatever follows. Trailing punctuation is far more likely to be sentence
/// punctuation than part of the address, so it is trimmed back off.
///
/// `tail` runs to the end of the document, so nothing here may walk it: the
/// first fold cuts it down at the earliest terminator, and the body is then
/// located back in `tail` by prefix match, which yields the remainder as a
/// slice rather than a copy.
fn take_url(scheme: String, tail: String) -> #(String, String) {
  let body =
    url_terminators
    |> list.fold(tail, fn(rest, terminator) {
      case string.split_once(rest, terminator) {
        Ok(#(head, _)) -> head
        Error(_) -> rest
      }
    })
    |> trim_trailing_punctuation

  let after = case string.split_once(tail, body) {
    Ok(#(_, remainder)) -> remainder
    Error(_) -> ""
  }

  #(scheme <> body, after)
}

fn trim_trailing_punctuation(url: String) -> String {
  case string.last(url) {
    Ok(last) ->
      case list.contains([".", ",", ";", ":", "!", "?"], last) {
        True -> trim_trailing_punctuation(string.drop_end(url, 1))
        False -> url
      }
    Error(_) -> url
  }
}

/// `balance.tags` matters because images are emitted as HTML: a bare URL can
/// sit inside `src="..."` or `href="..."`, and wrapping that in Markdown link
/// syntax corrupts the tag.
///
/// Testing `before` rather than the whole accumulator is not a shortcut: a URL
/// never ends in `]` or `(` — both terminate it — so a `](` immediately ahead
/// of one always lies entirely within the chunk that precedes it.
fn already_linked(before: String, balance: Balance) -> Bool {
  string.ends_with(before, "](") || balance.brackets > 0 || balance.tags > 0
}

fn count_occurrences(text: String, needle: String) -> Int {
  // Most chunks contain none of these, and `contains` avoids building the
  // split list to find that out.
  case string.contains(text, needle) {
    False -> 0
    True -> list.length(string.split(text, needle)) - 1
  }
}
