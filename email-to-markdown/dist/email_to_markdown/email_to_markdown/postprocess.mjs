import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import * as $classify from "../email_to_markdown/classify.mjs";
import {
  Ok,
  Error,
  toList,
  Empty as $Empty,
  List$Empty$const as $List$Empty$const,
  prepend as listPrepend,
  CustomType as $CustomType,
  isEqual,
} from "../gleam.mjs";

class Code extends $CustomType {
  constructor(lines) {
    super();
    this.lines = lines;
  }
}

class Prose extends $CustomType {
  constructor(lines) {
    super();
    this.lines = lines;
  }
}

class Balance extends $CustomType {
  constructor(brackets, tags) {
    super();
    this.brackets = brackets;
    this.tags = tags;
  }
}

const url_terminators = /* @__PURE__ */ toList([
  " ",
  "\t",
  "\n",
  "<",
  ">",
  ")",
  "]",
  "\"",
  "'",
]);

function append_trailing_newline(text) {
  if (text === "") {
    return text;
  } else {
    return text + "\n";
  }
}

function is_list_line(line) {
  return $classify.is_list_item($string.trim_start(line));
}

function first_is_list_line(acc) {
  if (acc instanceof $Empty) {
    return false;
  } else {
    let line = acc.head;
    return is_list_line(line);
  }
}

function do_tighten(loop$lines, loop$acc) {
  while (true) {
    let lines = loop$lines;
    let acc = loop$acc;
    if (lines instanceof $Empty) {
      return acc;
    } else {
      let $ = lines.tail;
      if ($ instanceof $Empty) {
        let line = lines.head;
        let rest = $;
        loop$lines = rest;
        loop$acc = listPrepend(line, acc);
      } else {
        let $1 = lines.head;
        if ($1 === "") {
          let next = $.head;
          let rest = $.tail;
          let $2 = (is_list_line(next) && (!(acc instanceof $Empty))) && first_is_list_line(
            acc,
          );
          if ($2) {
            loop$lines = listPrepend(next, rest);
            loop$acc = acc;
          } else {
            loop$lines = listPrepend(next, rest);
            loop$acc = listPrepend("", acc);
          }
        } else {
          let line = $1;
          let rest = $;
          loop$lines = rest;
          loop$acc = listPrepend(line, acc);
        }
      }
    }
  }
}

/**
 * Join adjacent list items that ended up separated by a blank line.
 *
 * Emails build lists as sibling `<p>&bull; ...</p>` runs, which arrive here
 * as separate blocks. Rendered as a loose list they gain spurious spacing.
 * 
 * @ignore
 */
function tighten_lists(text) {
  let _pipe = text;
  let _pipe$1 = $string.split(_pipe, "\n");
  let _pipe$2 = do_tighten(_pipe$1, $List$Empty$const);
  let _pipe$3 = $list.reverse(_pipe$2);
  return $string.join(_pipe$3, "\n");
}

/**
 * Collapse 3+ consecutive newlines to exactly two.
 */
export function collapse_blank_lines(loop$text) {
  while (true) {
    let text = loop$text;
    let $ = $string.contains(text, "\n\n\n");
    if ($) {
      loop$text = $string.replace(text, "\n\n\n", "\n\n");
    } else {
      return text;
    }
  }
}

function walk_punctuation(loop$graphemes, loop$acc) {
  while (true) {
    let graphemes = loop$graphemes;
    let acc = loop$acc;
    if (graphemes instanceof $Empty) {
      return acc;
    } else {
      let current = graphemes.head;
      let rest = graphemes.tail;
      let next = $list.first(rest);
      let is_punctuation = $list.contains(toList([".", ",", ";"]), current);
      let _block;
      if (next instanceof Ok) {
        let following = next[0];
        _block = ($string.trim(following) === "") || (following === "|");
      } else {
        _block = true;
      }
      let token_ends = _block;
      let in_dot_run = (current === ".") && (isEqual(next, new Ok(".")));
      let _block$1;
      let $ = ((is_punctuation && token_ends) && !in_dot_run) && (isEqual(
        $list.first(acc),
        new Ok(" ")
      ));
      if ($) {
        _block$1 = listPrepend(current, $list.drop(acc, 1));
      } else {
        _block$1 = listPrepend(current, acc);
      }
      let acc$1 = _block$1;
      loop$graphemes = rest;
      loop$acc = acc$1;
    }
  }
}

function tidy_punctuation(line) {
  let $ = ($string.contains(line, " .") || $string.contains(line, " ,")) || $string.contains(
    line,
    " ;",
  );
  if ($) {
    let _pipe = line;
    let _pipe$1 = $string.to_graphemes(_pipe);
    let _pipe$2 = walk_punctuation(_pipe$1, $List$Empty$const);
    let _pipe$3 = $list.reverse(_pipe$2);
    return $string.concat(_pipe$3);
  } else {
    return line;
  }
}

/**
 * `word .` -> `word.`, only when the punctuation ends its token.
 *
 * The `|` token-end case matters: table cells otherwise keep the stray space.
 * Runs of dots are never touched, so ellipses survive.
 * Lines are independent here — a newline is neither a space nor punctuation —
 * so the grapheme walk only runs on the few lines that can be affected.
 */
export function remove_spaces_before_sentence_punctuation(text) {
  let _pipe = text;
  let _pipe$1 = $string.split(_pipe, "\n");
  let _pipe$2 = $list.map(_pipe$1, tidy_punctuation);
  return $string.join(_pipe$2, "\n");
}

/**
 * `[kg/m3 ]` -> `[kg/m3]`. One space only: runs are already collapsed by the
 * time this pass runs.
 */
export function remove_spaces_before_closing_brackets(text) {
  return $string.replace(text, " ]", "]");
}

/**
 * Halves every space run per pass, so this settles in log2(longest run)
 * passes of a native replace.
 * 
 * @ignore
 */
function squeeze_spaces(loop$text) {
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

function collapse_line(line) {
  let body = $string.trim_start(line);
  let $ = squeeze_spaces(body);
  let squeezed = $;
  if (squeezed === body) {
    return line;
  } else {
    let squeezed = $;
    return $string.replace(line, body, squeezed);
  }
}

/**
 * Collapse runs of 2+ spaces to one, per line, preserving indentation.
 */
export function collapse_consecutive_spaces(text) {
  let $ = $string.contains(text, "  ");
  if ($) {
    let _pipe = text;
    let _pipe$1 = $string.split(_pipe, "\n");
    let _pipe$2 = $list.map(_pipe$1, collapse_line);
    return $string.join(_pipe$2, "\n");
  } else {
    return text;
  }
}

function count_occurrences(text, needle) {
  let $ = $string.contains(text, needle);
  if ($) {
    return $list.length($string.split(text, needle)) - 1;
  } else {
    return 0;
  }
}

function advance(balance, chunk) {
  return new Balance(
    (balance.brackets + count_occurrences(chunk, "[")) - count_occurrences(
      chunk,
      "]",
    ),
    (balance.tags + count_occurrences(chunk, "<")) - count_occurrences(
      chunk,
      ">",
    ),
  );
}

/**
 * `balance.tags` matters because images are emitted as HTML: a bare URL can
 * sit inside `src="..."` or `href="..."`, and wrapping that in Markdown link
 * syntax corrupts the tag.
 *
 * Testing `before` rather than the whole accumulator is not a shortcut: a URL
 * never ends in `]` or `(` — both terminate it — so a `](` immediately ahead
 * of one always lies entirely within the chunk that precedes it.
 * 
 * @ignore
 */
function already_linked(before, balance) {
  return ($string.ends_with(before, "](") || (balance.brackets > 0)) || (balance.tags > 0);
}

function trim_trailing_punctuation(loop$url) {
  while (true) {
    let url = loop$url;
    let $ = $string.last(url);
    if ($ instanceof Ok) {
      let last = $[0];
      let $1 = $list.contains(toList([".", ",", ";", ":", "!", "?"]), last);
      if ($1) {
        loop$url = $string.drop_end(url, 1);
      } else {
        return url;
      }
    } else {
      return url;
    }
  }
}

/**
 * Take the URL running from the start of `tail`, and return it along with
 * whatever follows. Trailing punctuation is far more likely to be sentence
 * punctuation than part of the address, so it is trimmed back off.
 *
 * `tail` runs to the end of the document, so nothing here may walk it: the
 * first fold cuts it down at the earliest terminator, and the body is then
 * located back in `tail` by prefix match, which yields the remainder as a
 * slice rather than a copy.
 * 
 * @ignore
 */
function take_url(scheme, tail) {
  let _block;
  let _pipe = url_terminators;
  let _pipe$1 = $list.fold(
    _pipe,
    tail,
    (rest, terminator) => {
      let $ = $string.split_once(rest, terminator);
      if ($ instanceof Ok) {
        let head = $[0][0];
        return head;
      } else {
        return rest;
      }
    },
  );
  _block = trim_trailing_punctuation(_pipe$1);
  let body = _block;
  let _block$1;
  let $ = $string.split_once(tail, body);
  if ($ instanceof Ok) {
    let remainder = $[0][1];
    _block$1 = remainder;
  } else {
    _block$1 = "";
  }
  let after = _block$1;
  return [scheme + body, after];
}

/**
 * Split at the next bare URL: text before it, the URL, and the remainder.
 * `skipped` carries the `http` occurrences that turned out not to be schemes.
 *
 * Note what this does *not* do: rebuild `"http" <> rest`. That concatenation
 * is a rope, and every subsequent character operation on it forces the engine
 * to flatten the whole remaining document — once per URL, which is quadratic.
 * Matching the scheme as a prefix pattern keeps the tail a plain slice.
 * 
 * @ignore
 */
function next_url(loop$text, loop$skipped) {
  while (true) {
    let text = loop$text;
    let skipped = loop$skipped;
    let $ = $string.split_once(text, "http");
    if ($ instanceof Ok) {
      let before = $[0][0];
      let rest = $[0][1];
      if (rest.startsWith("s://")) {
        let tail = rest.slice(4);
        let $1 = take_url("https://", tail);
        let url = $1[0];
        let after = $1[1];
        return new Ok([skipped + before, url, after]);
      } else if (rest.startsWith("://")) {
        let tail = rest.slice(3);
        let $1 = take_url("http://", tail);
        let url = $1[0];
        let after = $1[1];
        return new Ok([skipped + before, url, after]);
      } else {
        loop$text = rest;
        loop$skipped = (skipped + before) + "http";
      }
    } else {
      return new Error(undefined);
    }
  }
}

function walk_urls(loop$remaining, loop$acc, loop$balance) {
  while (true) {
    let remaining = loop$remaining;
    let acc = loop$acc;
    let balance = loop$balance;
    let $ = next_url(remaining, "");
    if ($ instanceof Ok) {
      let before = $[0][0];
      let url = $[0][1];
      let after = $[0][2];
      let balance$1 = advance(balance, before);
      let _block;
      let $1 = already_linked(before, balance$1);
      if ($1) {
        _block = url;
      } else {
        _block = ((("[" + url) + "](") + url) + ")";
      }
      let linked = _block;
      loop$remaining = after;
      loop$acc = (acc + before) + linked;
      loop$balance = advance(balance$1, linked);
    } else {
      return acc + remaining;
    }
  }
}

/**
 * Wrap bare `http(s)://` URLs as Markdown links.
 *
 * Skips URLs already serving as a link target (`](...`) or sitting inside
 * link text (`[...]`), so existing links are never double-wrapped.
 */
export function format_urls(text) {
  return walk_urls(text, "", new Balance(0, 0));
}

function clean_segment(segment) {
  if (segment instanceof Code) {
    let lines = segment.lines;
    return $string.join(lines, "\n");
  } else {
    let lines = segment.lines;
    let _pipe = lines;
    let _pipe$1 = $string.join(_pipe, "\n");
    let _pipe$2 = format_urls(_pipe$1);
    let _pipe$3 = collapse_consecutive_spaces(_pipe$2);
    let _pipe$4 = remove_spaces_before_closing_brackets(_pipe$3);
    let _pipe$5 = remove_spaces_before_sentence_punctuation(_pipe$4);
    let _pipe$6 = collapse_blank_lines(_pipe$5);
    return tighten_lists(_pipe$6);
  }
}

function close(in_fence, current, acc) {
  if (current instanceof $Empty) {
    return acc;
  } else {
    let lines = $list.reverse(current);
    if (in_fence) {
      return listPrepend(new Code(lines), acc);
    } else {
      return listPrepend(new Prose(lines), acc);
    }
  }
}

function split_segments(loop$lines, loop$in_fence, loop$current, loop$acc) {
  while (true) {
    let lines = loop$lines;
    let in_fence = loop$in_fence;
    let current = loop$current;
    let acc = loop$acc;
    if (lines instanceof $Empty) {
      return $list.reverse(close(in_fence, current, acc));
    } else {
      let line = lines.head;
      let rest = lines.tail;
      let $ = $string.starts_with($string.trim_start(line), "```");
      if ($) {
        if (in_fence) {
          loop$lines = rest;
          loop$in_fence = false;
          loop$current = $List$Empty$const;
          loop$acc = close(true, listPrepend(line, current), acc);
        } else {
          loop$lines = rest;
          loop$in_fence = true;
          loop$current = toList([line]);
          loop$acc = close(false, current, acc);
        }
      } else {
        loop$lines = rest;
        loop$in_fence = in_fence;
        loop$current = listPrepend(line, current);
        loop$acc = acc;
      }
    }
  }
}

function segments(text) {
  let _pipe = text;
  let _pipe$1 = $string.split(_pipe, "\n");
  return split_segments(_pipe$1, false, $List$Empty$const, $List$Empty$const);
}

/**
 * Apply the full cleanup chain.
 *
 * Fenced code blocks are passed through untouched. Every pass here is
 * whitespace- or punctuation-destructive, and inside a fence that is
 * corruption: collapsing runs of spaces silently destroys the alignment of
 * compiler output, diffs, and ASCII tables.
 */
export function run(text) {
  let _pipe = text;
  let _pipe$1 = segments(_pipe);
  let _pipe$2 = $list.map(_pipe$1, clean_segment);
  let _pipe$3 = $string.join(_pipe$2, "\n");
  let _pipe$4 = $string.trim(_pipe$3);
  return append_trailing_newline(_pipe$4);
}
