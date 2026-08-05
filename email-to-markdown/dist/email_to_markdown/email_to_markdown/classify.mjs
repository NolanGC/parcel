import * as $int from "../../gleam_stdlib/gleam/int.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../../gleam_stdlib/gleam/option.mjs";
import * as $result from "../../gleam_stdlib/gleam/result.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import { Ok, toList, CustomType as $CustomType } from "../gleam.mjs";

/**
 * An unordered bullet of any glyph.
 */
export class Bullet extends $CustomType {}
export const Marker$Bullet$const = new Bullet();
export const Marker$Bullet = () => Marker$Bullet$const;
export const Marker$isBullet = (value) => value instanceof Bullet;

/**
 * An ordered marker, carrying its number as written.
 */
export class Ordered extends $CustomType {
  constructor(number) {
    super();
    this.number = number;
  }
}
export const Marker$Ordered = (number) => new Ordered(number);
export const Marker$isOrdered = (value) => value instanceof Ordered;
export const Marker$Ordered$number = (value) => value.number;
export const Marker$Ordered$0 = (value) => value.number;

const bullets = /* @__PURE__ */ toList([
  "•",
  "●",
  "○",
  "◦",
  "▪",
  "▫",
  "‣",
  "·",
  "*",
  "-",
  "–",
  "—",
]);

function starts_with_space(text) {
  let $ = $string.pop_grapheme(text);
  if ($ instanceof Ok) {
    let first = $[0][0];
    return $string.trim(first) === "";
  } else {
    return false;
  }
}

/**
 * Matches `1.`, `1)`, and `(1)`, each requiring trailing whitespace.
 * 
 * @ignore
 */
function ordered_marker(trimmed) {
  let _block;
  let $1 = $string.starts_with(trimmed, "(");
  if ($1) {
    _block = [$string.drop_start(trimmed, 1), toList([")"])];
  } else {
    _block = [trimmed, toList([".", ")"])];
  }
  let $ = _block;
  let body = $[0];
  let closers = $[1];
  let _block$1;
  let _pipe = body;
  let _pipe$1 = $string.to_graphemes(_pipe);
  let _pipe$2 = $list.take_while(
    _pipe$1,
    (g) => { return $result.is_ok($int.parse(g)); },
  );
  _block$1 = $string.concat(_pipe$2);
  let digits = _block$1;
  let $2 = digits === "";
  if ($2) {
    return Option$None$const;
  } else {
    let after = $string.drop_start(body, $string.length(digits));
    let $3 = $string.pop_grapheme(after);
    if ($3 instanceof Ok) {
      let closer = $3[0][0];
      let rest = $3[0][1];
      let $4 = $list.contains(closers, closer) && starts_with_space(rest);
      if ($4) {
        let $5 = $int.parse(digits);
        if ($5 instanceof Ok) {
          let number = $5[0];
          return new Some([new Ordered(number), $string.trim_start(rest)]);
        } else {
          return Option$None$const;
        }
      } else {
        return Option$None$const;
      }
    } else {
      return Option$None$const;
    }
  }
}

function bullet_marker(trimmed) {
  let $ = $string.pop_grapheme(trimmed);
  if ($ instanceof Ok) {
    let first = $[0][0];
    let rest = $[0][1];
    let $1 = $list.contains(bullets, first) && starts_with_space(rest);
    if ($1) {
      return new Some($string.trim_start(rest));
    } else {
      return Option$None$const;
    }
  } else {
    return Option$None$const;
  }
}

/**
 * Split a leading list marker from its content.
 *
 * Requires whitespace after the marker, so "1.5 million" and "e.g. this"
 * are not mistaken for list items.
 */
export function list_marker(text) {
  let trimmed = $string.trim_start(text);
  let $ = bullet_marker(trimmed);
  if ($ instanceof Some) {
    let rest = $[0];
    return new Some([Marker$Bullet$const, rest]);
  } else {
    return ordered_marker(trimmed);
  }
}

/**
 * Does this text open with a literal list marker?
 */
export function is_list_item(text) {
  return $option.is_some(list_marker(text));
}

/**
 * Rewrite a literal list line as Markdown, or return it unchanged.
 */
export function format_list_item(text) {
  let $ = list_marker(text);
  if ($ instanceof Some) {
    let $1 = $[0][0];
    if ($1 instanceof Bullet) {
      let rest = $[0][1];
      return "- " + rest;
    } else {
      let rest = $[0][1];
      let number = $1.number;
      return ($int.to_string(number) + ". ") + rest;
    }
  } else {
    return text;
  }
}

function is_alphanumeric(grapheme) {
  return $result.is_ok($int.parse(grapheme)) || ($string.lowercase(grapheme) !== $string.uppercase(
    grapheme,
  ));
}

/**
 * `A.` / `a)` / `(b)` / `12.` — a label followed by a closing mark.
 * 
 * @ignore
 */
function is_labelled_marker(trimmed) {
  let _block;
  let $ = $string.starts_with(trimmed, "(");
  if ($) {
    _block = $string.drop_start(trimmed, 1);
  } else {
    _block = trimmed;
  }
  let body = _block;
  let $1 = $string.pop_grapheme(body);
  if ($1 instanceof Ok) {
    let first = $1[0][0];
    let rest = $1[0][1];
    return is_alphanumeric(first) && $list.contains(
      toList([".", ")"]),
      $string.trim(rest),
    );
  } else {
    return false;
  }
}

/**
 * Is this text *entirely* a list marker?
 *
 * Used when a marker occupies its own table cell, where the "e.g." ambiguity
 * that rules out letter markers in prose cannot arise. Accepts `A.`, `a)`,
 * `(b)` and numeric forms in addition to bullets.
 */
export function is_standalone_marker(text) {
  let trimmed = $string.trim(text);
  let $ = $string.length(trimmed);
  if ($ === 0) {
    return false;
  } else {
    let length = $;
    if (length > 4) {
      return false;
    } else {
      return ($list.contains(bullets, trimmed) || is_labelled_marker(trimmed)) || $option.is_some(
        list_marker(trimmed + " x"),
      );
    }
  }
}
