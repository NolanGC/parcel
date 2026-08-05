import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $float from "../../gleam_stdlib/gleam/float.mjs";
import * as $int from "../../gleam_stdlib/gleam/int.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../../gleam_stdlib/gleam/option.mjs";
import * as $result from "../../gleam_stdlib/gleam/result.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import { Ok, Error, toList, Empty as $Empty } from "../gleam.mjs";

/**
 * Colour names worth resolving. The full CSS table is 148 entries and buys
 * nothing here: identical names already compare equal as written, so only
 * the ones that get spelled several different ways need normalizing — which
 * in practice means white and black.
 * 
 * @ignore
 */
const named_colours = /* @__PURE__ */ toList([
  ["white", "#ffffff"],
  ["black", "#000000"],
  ["transparent", "transparent"],
]);

/**
 * Keywords that name no particular colour, so two of them being equal says
 * nothing about whether anything is readable.
 * 
 * @ignore
 */
const non_colours = /* @__PURE__ */ toList([
  "inherit",
  "initial",
  "unset",
  "revert",
  "currentcolor",
  "auto",
  "none",
  "",
]);

/**
 * Strip a trailing `!important`.
 *
 * Email CSS is saturated with it — Fidelity hides its preheader with
 * `display:none !important` — and leaving it attached makes the value
 * compare unequal to `none`, silently defeating every visibility rule.
 * 
 * @ignore
 */
function drop_important(value) {
  let $ = $string.split_once(value, "!");
  if ($ instanceof Ok) {
    let before = $[0][0];
    let rest = $[0][1];
    let $1 = $string.trim(rest) === "important";
    if ($1) {
      return $string.trim(before);
    } else {
      return value;
    }
  } else {
    return value;
  }
}

function parse_declaration(declaration) {
  let $ = $string.split_once(declaration, ":");
  if ($ instanceof Ok) {
    let property = $[0][0];
    let value = $[0][1];
    let _block;
    let _pipe = property;
    let _pipe$1 = $string.trim(_pipe);
    _block = $string.lowercase(_pipe$1);
    let property$1 = _block;
    let _block$1;
    let _pipe$2 = value;
    let _pipe$3 = $string.trim(_pipe$2);
    let _pipe$4 = $string.lowercase(_pipe$3);
    _block$1 = drop_important(_pipe$4);
    let value$1 = _block$1;
    let $1 = property$1 === "";
    if ($1) {
      return new Error(undefined);
    } else {
      return new Ok([property$1, value$1]);
    }
  } else {
    return new Error(undefined);
  }
}

/**
 * Parse a `style` attribute into normalized property/value pairs.
 *
 * Keys and values are lowercased and trimmed. Values keep internal
 * structure, so `url(...)` and multi-part values survive intact.
 */
export function parse(style_attr) {
  let _pipe = style_attr;
  let _pipe$1 = $string.split(_pipe, ";");
  let _pipe$2 = $list.filter_map(_pipe$1, parse_declaration);
  return $dict.from_list(_pipe$2);
}

/**
 * Look up a declared property.
 */
export function get(styles, property) {
  let _pipe = styles;
  let _pipe$1 = $dict.get(_pipe, property);
  return $option.from_result(_pipe$1);
}

/**
 * Is a property declared with one of the given values?
 */
export function is_any(styles, property, values) {
  let $ = get(styles, property);
  if ($ instanceof Some) {
    let actual = $[0];
    return $list.contains(values, actual);
  } else {
    return false;
  }
}

/**
 * `float.parse` rejects integer-looking input such as `"0"`, which is exactly
 * what a collapsed email spacer declares. Fall back to integer parsing.
 * 
 * @ignore
 */
function to_float(raw) {
  let $ = $float.parse(raw);
  if ($ instanceof Ok) {
    return $;
  } else {
    let _pipe = $int.parse(raw);
    return $result.map(_pipe, $int.to_float);
  }
}

/**
 * The leading numeric run: digits, with an optional sign and decimal point.
 *
 * Matched as string prefixes rather than by segmenting into graphemes. This
 * runs for nearly every styled element in the document, and `to_graphemes`
 * invokes the Unicode segmenter even on a value as short as `12px`.
 * 
 * @ignore
 */
function take_number(loop$value, loop$acc) {
  while (true) {
    let value = loop$value;
    let acc = loop$acc;
    let $ = value.charCodeAt(0);
    if ($ === 48) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "0";
    } else if ($ === 49) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "1";
    } else if ($ === 50) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "2";
    } else if ($ === 51) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "3";
    } else if ($ === 52) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "4";
    } else if ($ === 53) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "5";
    } else if ($ === 54) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "6";
    } else if ($ === 55) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "7";
    } else if ($ === 56) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "8";
    } else if ($ === 57) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "9";
    } else if ($ === 46) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + ".";
    } else if ($ === 45) {
      let rest = value.slice(1);
      loop$value = rest;
      loop$acc = acc + "-";
    } else {
      return acc;
    }
  }
}

/**
 * Parse a CSS length to a float, tolerating units (`px`, `pt`, `em`, `%`).
 * `None` when the value is not a number with an optional unit suffix.
 */
export function length(value) {
  let $ = take_number($string.trim(value), "");
  if ($ === "") {
    return Option$None$const;
  } else {
    let numeric = $;
    return $option.from_result(to_float(numeric));
  }
}

/**
 * A length in CSS pixels. `None` for percentages and keywords.
 *
 * `length` happily reads "100%" as 100.0, which is meaningless as a pixel
 * count — a full-width image and a 100px one are very different things.
 */
export function px(value) {
  let $ = $string.contains(value, "%");
  if ($) {
    return Option$None$const;
  } else {
    return length(value);
  }
}

/**
 * Is the declared length effectively zero?
 */
export function is_zero_length(value) {
  let $ = length(value);
  if ($ instanceof Some) {
    let number = $[0];
    return number <= 0.0;
  } else {
    return false;
  }
}

function hex_byte(number) {
  let _block;
  let _pipe = $int.to_base16(number);
  _block = $string.lowercase(_pipe);
  let digits = _block;
  let $ = $string.length(digits);
  if ($ === 1) {
    return "0" + digits;
  } else {
    return digits;
  }
}

function channel(raw) {
  let $ = $int.parse(raw);
  if ($ instanceof Ok) {
    let number = $[0];
    if ((number >= 0) && (number <= 255)) {
      return new Some(hex_byte(number));
    } else {
      return Option$None$const;
    }
  } else {
    return Option$None$const;
  }
}

function from_rgb(rest) {
  let _block;
  let _pipe = rest;
  let _pipe$1 = $string.replace(_pipe, ")", "");
  let _pipe$2 = $string.replace(_pipe$1, "/", ",");
  let _pipe$3 = $string.split(_pipe$2, ",");
  _block = $list.map(_pipe$3, $string.trim);
  let parts = _block;
  if (parts instanceof $Empty) {
    return Option$None$const;
  } else {
    let $ = parts.tail;
    if ($ instanceof $Empty) {
      return Option$None$const;
    } else {
      let $1 = $.tail;
      if ($1 instanceof $Empty) {
        return Option$None$const;
      } else {
        let $2 = $1.tail;
        if ($2 instanceof $Empty) {
          let red = parts.head;
          let green = $.head;
          let blue = $1.head;
          let $3 = channel(red);
          let $4 = channel(green);
          let $5 = channel(blue);
          if ($3 instanceof Some && $4 instanceof Some && $5 instanceof Some) {
            let r = $3[0];
            let g = $4[0];
            let b = $5[0];
            return new Some((("#" + r) + g) + b);
          } else {
            return Option$None$const;
          }
        } else {
          let $3 = $2.tail;
          if ($3 instanceof $Empty) {
            let alpha = $2.head;
            if ((alpha === "0") || (alpha === "0.0")) {
              return new Some("transparent");
            } else {
              let red = parts.head;
              let green = $.head;
              let blue = $1.head;
              let $4 = channel(red);
              let $5 = channel(green);
              let $6 = channel(blue);
              if ($4 instanceof Some && $5 instanceof Some && $6 instanceof Some) {
                let r = $4[0];
                let g = $5[0];
                let b = $6[0];
                return new Some((("#" + r) + g) + b);
              } else {
                return Option$None$const;
              }
            }
          } else {
            let red = parts.head;
            let green = $.head;
            let blue = $1.head;
            let $4 = channel(red);
            let $5 = channel(green);
            let $6 = channel(blue);
            if ($4 instanceof Some && $5 instanceof Some && $6 instanceof Some) {
              let r = $4[0];
              let g = $5[0];
              let b = $6[0];
              return new Some((("#" + r) + g) + b);
            } else {
              return Option$None$const;
            }
          }
        }
      }
    }
  }
}

function from_hex(digits) {
  let $ = $string.to_graphemes(digits);
  if ($ instanceof $Empty) {
    return Option$None$const;
  } else {
    let $1 = $.tail;
    if ($1 instanceof $Empty) {
      return Option$None$const;
    } else {
      let $2 = $1.tail;
      if ($2 instanceof $Empty) {
        return Option$None$const;
      } else {
        let $3 = $2.tail;
        if ($3 instanceof $Empty) {
          let r = $.head;
          let g = $1.head;
          let b = $2.head;
          return new Some(((((("#" + r) + r) + g) + g) + b) + b);
        } else {
          let $4 = $3.tail;
          if ($4 instanceof $Empty) {
            return Option$None$const;
          } else {
            let $5 = $4.tail;
            if ($5 instanceof $Empty) {
              return Option$None$const;
            } else {
              let $6 = $5.tail;
              if ($6 instanceof $Empty) {
                return new Some("#" + digits);
              } else {
                return Option$None$const;
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Normalize a colour so notations compare equal — `#fff`, `#ffffff`, `white`
 * and `rgb(255, 255, 255)` all become `#ffffff`.
 *
 * `None` when the value names no single colour: a keyword like `inherit`, or
 * a `background` shorthand carrying an image or gradient, where whatever is
 * underneath decides readability rather than the declared colour.
 */
export function colour(value) {
  let _block;
  let _pipe = value;
  let _pipe$1 = $string.trim(_pipe);
  _block = $string.lowercase(_pipe$1);
  let value$1 = _block;
  let $ = $list.contains(non_colours, value$1) || $string.contains(
    value$1,
    "url(",
  );
  if ($) {
    return Option$None$const;
  } else {
    if (value$1.charCodeAt(0) === 35) {
      let digits = value$1.slice(1);
      return from_hex(digits);
    } else if (value$1.startsWith("rgb(")) {
      let rest = value$1.slice(4);
      return from_rgb(rest);
    } else if (value$1.startsWith("rgba(")) {
      let rest = value$1.slice(5);
      return from_rgb(rest);
    } else {
      let $1 = $list.key_find(named_colours, value$1);
      if ($1 instanceof Ok) {
        let resolved = $1[0];
        return new Some(resolved);
      } else {
        return new Some(value$1);
      }
    }
  }
}

/**
 * `font-weight: bold`, `bolder`, or a numeric weight of 600+.
 */
export function is_bold(styles) {
  let $ = get(styles, "font-weight");
  if ($ instanceof Some) {
    let value = $[0];
    return ((value === "bold") || (value === "bolder")) || (() => {
      let $1 = length(value);
      if ($1 instanceof Some) {
        let weight = $1[0];
        return weight >= 600.0;
      } else {
        return false;
      }
    })();
  } else {
    return false;
  }
}

/**
 * `font-style: italic` or `oblique`.
 */
export function is_italic(styles) {
  return is_any(styles, "font-style", toList(["italic", "oblique"]));
}

/**
 * `text-decoration: underline` or `line-through`.
 */
export function is_decorated(styles) {
  return is_any(
    styles,
    "text-decoration",
    toList(["underline", "line-through"]),
  );
}

function positive(styles, property) {
  let $ = get(styles, property);
  if ($ instanceof Some) {
    let value = $[0];
    let $1 = length(value);
    if ($1 instanceof Some) {
      let number = $1[0];
      return number > 0.0;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

/**
 * Does this element push its neighbours apart horizontally?
 *
 * Emails routinely separate words with CSS alone —
 * `<span style="padding-right:5px">Hi</span><span>Nolan</span>` contains no
 * whitespace whatsoever, yet reads as two words. This is the same inference
 * pdf-inspector makes from geometric gaps, one layer up.
 */
export function has_horizontal_gap(styles) {
  return ((positive(styles, "padding-right") || positive(styles, "padding-left")) || positive(
    styles,
    "margin-right",
  )) || positive(styles, "margin-left");
}
