import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $int from "../../gleam_stdlib/gleam/int.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import * as $dom from "../email_to_markdown/dom.mjs";
import { Element, Text } from "../email_to_markdown/dom.mjs";
import {
  Ok,
  Error,
  toList,
  Empty as $Empty,
  List$Empty$const as $List$Empty$const,
  prepend as listPrepend,
  CustomType as $CustomType,
} from "../gleam.mjs";

export class Class extends $CustomType {
  constructor(name) {
    super();
    this.name = name;
  }
}
export const Selector$Class = (name) => new Class(name);
export const Selector$isClass = (value) => value instanceof Class;
export const Selector$Class$name = (value) => value.name;
export const Selector$Class$0 = (value) => value.name;

export class Id extends $CustomType {
  constructor(name) {
    super();
    this.name = name;
  }
}
export const Selector$Id = (name) => new Id(name);
export const Selector$isId = (value) => value instanceof Id;
export const Selector$Id$name = (value) => value.name;
export const Selector$Id$0 = (value) => value.name;

export class Tag extends $CustomType {
  constructor(name) {
    super();
    this.name = name;
  }
}
export const Selector$Tag = (name) => new Tag(name);
export const Selector$isTag = (value) => value instanceof Tag;
export const Selector$Tag$name = (value) => value.name;
export const Selector$Tag$0 = (value) => value.name;

export const Selector$name = (value) => value.name;

export class Rule extends $CustomType {
  constructor(selector, declarations, specificity) {
    super();
    this.selector = selector;
    this.declarations = declarations;
    this.specificity = specificity;
  }
}
export const Rule$Rule = (selector, declarations, specificity) =>
  new Rule(selector, declarations, specificity);
export const Rule$isRule = (value) => value instanceof Rule;
export const Rule$Rule$selector = (value) => value.selector;
export const Rule$Rule$0 = (value) => value.selector;
export const Rule$Rule$declarations = (value) => value.declarations;
export const Rule$Rule$1 = (value) => value.declarations;
export const Rule$Rule$specificity = (value) => value.specificity;
export const Rule$Rule$2 = (value) => value.specificity;

const max_rule_body = 2048;

/**
 * Rules are only useful if they carry something a later stage reads.
 *
 * This list has to stay in step with what `visibility`, `style`, `table` and
 * `emit` actually look up. A property missing here is invisible to them, so
 * the declaration works inline and silently does nothing from a `<style>`
 * block — an asymmetry that has produced three separate bugs.
 *
 * `convert_test` pins it: every property below is asserted to mean the same
 * thing declared either way, so dropping one fails the suite. Adding a read
 * of a new property means adding it here and there.
 *
 * Filtering by name is not only about size. The size caps below bound the
 * worst case either way, but dropping this list makes a crafted stylesheet
 * roughly 3.5x more expensive to merge, and adversarial input is the case
 * that matters.
 * 
 * @ignore
 */
const interesting = /* @__PURE__ */ toList([
  "display",
  "visibility",
  "opacity",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "max-height",
  "width",
  "height",
  "position",
  "left",
  "top",
  "text-decoration",
  "color",
  "background",
  "background-color",
  "clip",
  "clip-path",
  "transform",
  "text-indent",
  "text-align",
  "padding-left",
  "padding-right",
  "margin-left",
  "margin-right",
]);

/**
 * Size bounds on what a single rule may carry.
 *
 * These are amplification limits, not tidiness. Matched declarations are
 * copied onto *every* element the selector hits, so one oversized rule is
 * multiplied by the match count: a single 150KB value across 5,000 `<div>`s
 * cost 24 seconds and 1.9GB before these caps, from 210KB of input. The
 * largest declaration anywhere in the sample corpus is 313 bytes and the
 * largest rule body 832, so real mail has room to spare.
 * 
 * @ignore
 */
const max_declaration = 512;

/**
 * CSS specificity, coarsely: id beats class beats tag.
 * 
 * @ignore
 */
function specificity(selector) {
  if (selector instanceof Class) {
    return 10;
  } else if (selector instanceof Id) {
    return 100;
  } else {
    return 1;
  }
}

function take_before(text, marker) {
  let $ = $string.split_once(text, marker);
  if ($ instanceof Ok) {
    let before = $[0][0];
    return before;
  } else {
    return text;
  }
}

/**
 * Reduce a selector to its rightmost compound, then to one simple part.
 * 
 * @ignore
 */
function to_selector(raw) {
  let _block;
  let _pipe = raw;
  let _pipe$1 = $string.trim(_pipe);
  let _pipe$2 = $string.replace(_pipe$1, ">", " ");
  let _pipe$3 = $string.replace(_pipe$2, "+", " ");
  let _pipe$4 = $string.replace(_pipe$3, "~", " ");
  let _pipe$5 = $string.split(_pipe$4, " ");
  let _pipe$6 = $list.filter(_pipe$5, (part) => { return part !== ""; });
  _block = $list.last(_pipe$6);
  let last = _block;
  if (last instanceof Ok) {
    let compound = last[0];
    let _block$1;
    let _pipe$7 = compound;
    let _pipe$8 = take_before(_pipe$7, ":");
    _block$1 = take_before(_pipe$8, "[");
    let compound$1 = _block$1;
    if (compound$1 === "") {
      return new Error(undefined);
    } else if (compound$1 === "*") {
      return new Error(undefined);
    } else {
      let $ = $string.split_once(compound$1, ".");
      if ($ instanceof Ok) {
        let class$ = $[0][1];
        if (class$ !== "") {
          return new Ok(new Class($string.lowercase(class$)));
        } else {
          let $1 = $string.split_once(compound$1, "#");
          if ($1 instanceof Ok) {
            let id = $1[0][1];
            if (id !== "") {
              return new Ok(new Id($string.lowercase(id)));
            } else {
              return new Ok(new Tag($string.lowercase(compound$1)));
            }
          } else {
            return new Ok(new Tag($string.lowercase(compound$1)));
          }
        }
      } else {
        let $1 = $string.split_once(compound$1, "#");
        if ($1 instanceof Ok) {
          let id = $1[0][1];
          if (id !== "") {
            return new Ok(new Id($string.lowercase(id)));
          } else {
            return new Ok(new Tag($string.lowercase(compound$1)));
          }
        } else {
          return new Ok(new Tag($string.lowercase(compound$1)));
        }
      }
    }
  } else {
    return new Error(undefined);
  }
}

/**
 * Take declarations while they fit, dropping whole ones rather than
 * truncating — a half-written declaration is nobody's intent.
 * 
 * @ignore
 */
function take_within(loop$declarations, loop$remaining, loop$acc) {
  while (true) {
    let declarations = loop$declarations;
    let remaining = loop$remaining;
    let acc = loop$acc;
    if (declarations instanceof $Empty) {
      return $list.reverse(acc);
    } else {
      let declaration = declarations.head;
      let rest = declarations.tail;
      let size = $string.length(declaration);
      let $ = size > remaining;
      if ($) {
        return $list.reverse(acc);
      } else {
        loop$declarations = rest;
        loop$remaining = remaining - size;
        loop$acc = listPrepend(declaration, acc);
      }
    }
  }
}

function is_interesting(declaration) {
  let $ = $string.split_once(declaration, ":");
  if ($ instanceof Ok) {
    let property = $[0][0];
    return ($string.length(declaration) <= max_declaration) && $list.contains(
      interesting,
      (() => {
        let _pipe = property;
        let _pipe$1 = $string.trim(_pipe);
        return $string.lowercase(_pipe$1);
      })(),
    );
  } else {
    return false;
  }
}

/**
 * Keep only declarations some later stage actually reads, up to the size
 * budget above.
 * 
 * @ignore
 */
function keep_interesting(body) {
  let _pipe = body;
  let _pipe$1 = $string.split(_pipe, ";");
  let _pipe$2 = $list.map(_pipe$1, $string.trim);
  let _pipe$3 = $list.filter(_pipe$2, is_interesting);
  let _pipe$4 = take_within(_pipe$3, max_rule_body, $List$Empty$const);
  return $string.join(_pipe$4, ";");
}

function to_rules(chunk) {
  let $ = $string.split_once(chunk, "{");
  if ($ instanceof Ok) {
    let selectors = $[0][0];
    let body = $[0][1];
    let declarations = keep_interesting(body);
    if (declarations === "") {
      return $List$Empty$const;
    } else {
      let _pipe = selectors;
      let _pipe$1 = $string.split(_pipe, ",");
      let _pipe$2 = $list.filter_map(_pipe$1, to_selector);
      return $list.map(
        _pipe$2,
        (selector) => {
          return new Rule(selector, declarations, specificity(selector));
        },
      );
    }
  } else {
    return $List$Empty$const;
  }
}

/**
 * A media query with no feature test and no medium we are not — `screen`,
 * `all`, or a comma-separated list of those.
 * 
 * @ignore
 */
function unconditional_media(query) {
  let $ = $string.contains(query, "(");
  if ($) {
    return false;
  } else {
    let _pipe = query;
    let _pipe$1 = $string.split(_pipe, ",");
    return $list.all(
      _pipe$1,
      (part) => {
        return $list.contains(
          toList(["all", "screen", "only screen"]),
          $string.trim(part),
        );
      },
    );
  }
}

/**
 * Does this at-rule's condition hold for the reader we assume — someone on
 * a desktop screen?
 * 
 * @ignore
 */
function always_applies(prelude) {
  let _block;
  let _pipe = prelude;
  let _pipe$1 = $string.lowercase(_pipe);
  let _pipe$2 = $string.replace(_pipe$1, "\n", " ");
  let _pipe$3 = $string.replace(_pipe$2, "\t", " ");
  _block = $string.trim(_pipe$3);
  let normalized = _block;
  let $ = $string.split_once(normalized, " ");
  if ($ instanceof Ok) {
    let $1 = $[0][0];
    if ($1 === "media") {
      let query = $[0][1];
      return unconditional_media(query);
    } else if ($1 === "supports") {
      let query = $[0][1];
      return !$string.starts_with($string.trim(query), "not");
    } else {
      return false;
    }
  } else {
    return false;
  }
}

/**
 * The next `{` or `}`: whether it opened a block, the text before it, and
 * the text after it.
 * 
 * @ignore
 */
function next_brace(css) {
  let $ = $string.split_once(css, "{");
  let $1 = $string.split_once(css, "}");
  if ($ instanceof Ok) {
    if ($1 instanceof Ok) {
      let before_open = $[0][0];
      let after_open = $[0][1];
      let before_close = $1[0][0];
      let after_close = $1[0][1];
      let $2 = $string.length(before_open) < $string.length(before_close);
      if ($2) {
        return new Ok([true, before_open, after_open]);
      } else {
        return new Ok([false, before_close, after_close]);
      }
    } else {
      let before_open = $[0][0];
      let after_open = $[0][1];
      return new Ok([true, before_open, after_open]);
    }
  } else if ($1 instanceof Ok) {
    let before_close = $1[0][0];
    let after_close = $1[0][1];
    return new Ok([false, before_close, after_close]);
  } else {
    return new Error(undefined);
  }
}

/**
 * The contents of a balanced block, and the text after its closing brace.
 *
 * Jumps brace to brace rather than grapheme to grapheme. Stepping one
 * character at a time allocates a fresh substring per character, which made
 * parsing a 25KB stylesheet take 400ms — more than the rest of the pipeline
 * put together.
 * 
 * @ignore
 */
function take_block(loop$css, loop$depth, loop$acc) {
  while (true) {
    let css = loop$css;
    let depth = loop$depth;
    let acc = loop$acc;
    let $ = next_brace(css);
    if ($ instanceof Ok) {
      let $1 = $[0][0];
      if ($1) {
        let before = $[0][1];
        let rest = $[0][2];
        loop$css = rest;
        loop$depth = depth + 1;
        loop$acc = (acc + before) + "{";
      } else {
        let before = $[0][1];
        let rest = $[0][2];
        if (depth === 1) {
          return [acc + before, rest];
        } else {
          loop$css = rest;
          loop$depth = depth - 1;
          loop$acc = (acc + before) + "}";
        }
      }
    } else {
      return [acc + css, ""];
    }
  }
}

/**
 * Split an at-rule into its prelude, its block body, and what follows.
 * 
 * @ignore
 */
function split_at_rule(rest) {
  let $ = $string.split_once(rest, "{");
  if ($ instanceof Ok) {
    let prelude = $[0][0];
    let body = $[0][1];
    let $1 = $string.split_once(prelude, ";");
    if ($1 instanceof Ok) {
      let statement = $1[0][0];
      let after = $1[0][1];
      return [statement, "", (after + "{") + body];
    } else {
      let $2 = take_block(body, 1, "");
      let inner = $2[0];
      let after = $2[1];
      return [prelude, inner, after];
    }
  } else {
    return [rest, "", ""];
  }
}

function starts_with_letter(css) {
  let $ = $string.first(css);
  if ($ instanceof Ok) {
    let character = $[0];
    return $string.lowercase(character) !== $string.uppercase(character);
  } else {
    return false;
  }
}

function count(text, needle) {
  let $ = $string.contains(text, needle);
  if ($) {
    return $list.length($string.split(text, needle)) - 1;
  } else {
    return 0;
  }
}

/**
 * Walk to each at-rule, tracking brace depth on the way.
 *
 * The depth is what stops `background:url(https://x.test/@2x.png)` from
 * being read as an at-rule and swallowing the rule after it — which happened,
 * and there is one such URL in the corpus. Requiring a letter after the `@`
 * covers the other spelling, a selector like `[href*="@"]`.
 *
 * Splitting on `@` and counting braces in each chunk, rather than walking
 * marker to marker, keeps a stylesheet with no at-rules at a single scan.
 * The marker-walking version compared positions with `string.length`, which
 * segments graphemes, and cost 45ms a corpus.
 * 
 * @ignore
 */
function scan(loop$css, loop$depth, loop$acc) {
  while (true) {
    let css = loop$css;
    let depth = loop$depth;
    let acc = loop$acc;
    let $ = $string.split_once(css, "@");
    if ($ instanceof Ok) {
      let before = $[0][0];
      let rest = $[0][1];
      let depth$1 = (depth + count(before, "{")) - count(before, "}");
      let $1 = (depth$1 === 0) && starts_with_letter(rest);
      if ($1) {
        let $2 = split_at_rule(rest);
        let prelude = $2[0];
        let body = $2[1];
        let after = $2[2];
        let _block;
        let $3 = always_applies(prelude);
        if ($3) {
          _block = scan(body, 0, "");
        } else {
          _block = "";
        }
        let kept = _block;
        loop$css = after;
        loop$depth = depth$1;
        loop$acc = (acc + before) + kept;
      } else {
        loop$css = rest;
        loop$depth = depth$1;
        loop$acc = (acc + before) + "@";
      }
    } else {
      return acc + css;
    }
  }
}

/**
 * Resolve at-rules: inline the blocks whose condition always holds, drop
 * the rest.
 *
 * Dropping every at-rule was the simpler rule and left a hole. `@media
 * (max-width: 480px)` really must go — honouring it would hide content that
 * is plainly visible, and LinkedIn's mobile rules would blank most of the
 * message. But `@media screen` and `@media all` carry no condition at all,
 * so they always apply, which makes them a tidy place to hide injected text
 * from a defense that throws them away unread.
 *
 * Every `@media` in the sample corpus carries a feature query, so honouring
 * the unconditional ones costs real mail nothing.
 * 
 * @ignore
 */
function resolve_at_rules(css) {
  return scan(css, 0, "");
}

function strip_comments(css) {
  let $ = $string.split_once(css, "/*");
  if ($ instanceof Ok) {
    let before = $[0][0];
    let rest = $[0][1];
    let $1 = $string.split_once(rest, "*/");
    if ($1 instanceof Ok) {
      let after = $1[0][1];
      return before + strip_comments(after);
    } else {
      return before;
    }
  } else {
    return css;
  }
}

/**
 * Parse a stylesheet into flat rules.
 */
export function parse(css) {
  let _pipe = css;
  let _pipe$1 = strip_comments(_pipe);
  let _pipe$2 = resolve_at_rules(_pipe$1);
  let _pipe$3 = $string.split(_pipe$2, "}");
  return $list.flat_map(_pipe$3, to_rules);
}

function matches(selector, tag, id, classes) {
  if (selector instanceof Class) {
    let name = selector.name;
    return $list.contains(classes, name);
  } else if (selector instanceof Id) {
    let name = selector.name;
    return id === name;
  } else {
    let name = selector.name;
    return name === tag;
  }
}

function attr_value(attrs, key) {
  let $ = $dict.get(attrs, key);
  if ($ instanceof Ok) {
    let value = $[0];
    let _pipe = value;
    let _pipe$1 = $string.trim(_pipe);
    return $string.lowercase(_pipe$1);
  } else {
    return "";
  }
}

function resolve(node, rules) {
  if (node instanceof Element) {
    let tag = node.tag;
    let attrs = node.attrs;
    let children = node.children;
    let _block;
    let _pipe = attrs;
    let _pipe$1 = attr_value(_pipe, "class");
    _block = $string.split(_pipe$1, " ");
    let classes = _block;
    let id = attr_value(attrs, "id");
    let _block$1;
    let _pipe$2 = rules;
    let _pipe$3 = $list.filter(
      _pipe$2,
      (rule) => { return matches(rule.selector, tag, id, classes); },
    );
    let _pipe$4 = $list.sort(
      _pipe$3,
      (a, b) => { return $int.compare(a.specificity, b.specificity); },
    );
    let _pipe$5 = $list.map(_pipe$4, (rule) => { return rule.declarations; });
    _block$1 = $string.join(_pipe$5, ";");
    let matched = _block$1;
    let _block$2;
    let $ = $dict.get(attrs, "style");
    if ($ instanceof Ok) {
      let value = $[0];
      _block$2 = value;
    } else {
      _block$2 = "";
    }
    let inline = _block$2;
    let _block$3;
    if (matched === "") {
      _block$3 = attrs;
    } else {
      _block$3 = $dict.insert(attrs, "style", (matched + ";") + inline);
    }
    let attrs$1 = _block$3;
    return new Element(
      tag,
      attrs$1,
      $list.map(children, (_capture) => { return resolve(_capture, rules); }),
    );
  } else {
    return node;
  }
}

/**
 * Merge matching declarations into every element's `style` attribute.
 *
 * Rules are applied lowest specificity first and the element's own inline
 * style goes last, so `dict.from_list` in `style.parse` — where later keys
 * win — reproduces CSS precedence closely enough.
 */
export function apply(rules, node) {
  if (rules instanceof $Empty) {
    return node;
  } else {
    return resolve(node, rules);
  }
}
