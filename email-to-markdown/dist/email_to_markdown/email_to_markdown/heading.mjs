import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $float from "../../gleam_stdlib/gleam/float.mjs";
import * as $int from "../../gleam_stdlib/gleam/int.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../../gleam_stdlib/gleam/option.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import * as $chars from "../email_to_markdown/chars.mjs";
import * as $dom from "../email_to_markdown/dom.mjs";
import { Element, Text } from "../email_to_markdown/dom.mjs";
import * as $style from "../email_to_markdown/style.mjs";
import {
  Ok,
  Error,
  toList,
  Empty as $Empty,
  List$Empty$const as $List$Empty$const,
  prepend as listPrepend,
  CustomType as $CustomType,
  divideFloat,
} from "../gleam.mjs";

export class Tiers extends $CustomType {
  constructor(body_px, sizes) {
    super();
    this.body_px = body_px;
    this.sizes = sizes;
  }
}
export const Tiers$Tiers = (body_px, sizes) => new Tiers(body_px, sizes);
export const Tiers$isTiers = (value) => value instanceof Tiers;
export const Tiers$Tiers$body_px = (value) => value.body_px;
export const Tiers$Tiers$0 = (value) => value.body_px;
export const Tiers$Tiers$sizes = (value) => value.sizes;
export const Tiers$Tiers$1 = (value) => value.sizes;

class Sample extends $CustomType {
  constructor(size, bold, alphabetic) {
    super();
    this.size = size;
    this.bold = bold;
    this.alphabetic = alphabetic;
  }
}

/**
 * The size text resolves to when nothing declares one — every browser's
 * default, and the root of the inheritance chain.
 * 
 * @ignore
 */
const default_px = 16.0;

const bold_attr = "data-etm-bold";

/**
 * Synthetic attributes holding typography resolved through inheritance.
 * Prefixed so they cannot collide with a real attribute — the FFI's
 * allowlist would never emit these names.
 * 
 * @ignore
 */
const size_attr = "data-etm-size";

/**
 * Inference beyond H4 is noise; `analysis.rs` caps at 4 tiers too.
 * 
 * @ignore
 */
const max_tiers = 4;

/**
 * Sizes within this many px collapse into one tier.
 * 
 * @ignore
 */
const tier_tolerance = 1.0;

/**
 * Bold text only slightly larger than body, used when nothing clears the
 * main gate.
 * 
 * @ignore
 */
const bold_fallback_ratio = 1.05;

/**
 * A size must exceed the body baseline by this ratio to be a heading.
 * 
 * @ignore
 */
const heading_ratio = 1.2;

/**
 * Text below this size is chrome (legal fine print, footers) and must not
 * set the body baseline. `analysis.rs` uses 9.0pt; this is its px analogue.
 * 
 * @ignore
 */
const min_body_px = 11.0;

function is_bold_tag(tag) {
  return (tag === "b") || (tag === "strong");
}

function styles_of(attrs) {
  let $ = $dict.get(attrs, "style");
  if ($ instanceof Ok) {
    let value = $[0];
    return $style.parse(value);
  } else {
    return $dict.new$();
  }
}

function go(node, inherited, bold) {
  if (node instanceof Element) {
    let tag = node.tag;
    let attrs = node.attrs;
    let children = node.children;
    let styles = styles_of(attrs);
    let _block;
    let $ = $style.get(styles, "font-size");
    if ($ instanceof Some) {
      let value = $[0];
      let $1 = $style.length(value);
      if ($1 instanceof Some) {
        let px = $1[0];
        if (px > 0.0) {
          _block = px;
        } else {
          _block = inherited;
        }
      } else {
        _block = inherited;
      }
    } else {
      _block = inherited;
    }
    let size = _block;
    let bold$1 = (bold || $style.is_bold(styles)) || is_bold_tag(tag);
    let _block$1;
    let _pipe = attrs;
    let _pipe$1 = $dict.insert(_pipe, size_attr, $float.to_string(size));
    _block$1 = $dict.insert(
      _pipe$1,
      bold_attr,
      (() => {
        if (bold$1) {
          return "1";
        } else {
          return "0";
        }
      })(),
    );
    let attrs$1 = _block$1;
    return new Element(
      tag,
      attrs$1,
      $list.map(children, (_capture) => { return go(_capture, size, bold$1); }),
    );
  } else {
    return node;
  }
}

/**
 * Push `font-size` and boldness down to every element.
 *
 * Email sets `font-size` on a wrapper `<td>` and leaves the text inside
 * bare, so without resolving inheritance almost nothing declares a size.
 * Must run before `normalize`, which discards the wrappers.
 */
export function resolve(node) {
  return go(node, default_px, false);
}

/**
 * The resolved typography of a node, as attributes.
 *
 * `normalize` rebuilds flattened table cells as fresh `<div>`s; without
 * carrying these across, the font size that made an element a heading is
 * discarded before `analyze` ever sees it.
 */
export function carried_attrs(node) {
  if (node instanceof Element) {
    let attrs = node.attrs;
    let _pipe = toList([size_attr, bold_attr]);
    let _pipe$1 = $list.filter_map(
      _pipe,
      (key) => {
        let $ = $dict.get(attrs, key);
        if ($ instanceof Ok) {
          let value = $[0];
          return new Ok([key, value]);
        } else {
          return new Error(undefined);
        }
      },
    );
    return $dict.from_list(_pipe$1);
  } else {
    return $dict.new$();
  }
}

/**
 * The resolved font size on an element, once `resolve` has run.
 */
export function size_of(node) {
  if (node instanceof Element) {
    let attrs = node.attrs;
    let $ = $dict.get(attrs, size_attr);
    if ($ instanceof Ok) {
      let value = $[0];
      return $option.from_result($float.parse(value));
    } else {
      return Option$None$const;
    }
  } else {
    return Option$None$const;
  }
}

function bold_of(node) {
  return $dom.attr_or_empty(node, bold_attr) === "1";
}

function near(a, b) {
  return $float.absolute_value(a - b) < tier_tolerance;
}

function cluster(sizes) {
  let _pipe = sizes;
  let _pipe$1 = $list.fold(
    _pipe,
    $List$Empty$const,
    (acc, size) => {
      let $ = $list.any(acc, (tier) => { return near(tier, size); });
      if ($) {
        return acc;
      } else {
        return listPrepend(size, acc);
      }
    },
  );
  return $list.reverse(_pipe$1);
}

function sort_desc(sizes) {
  return $list.sort(sizes, (a, b) => { return $float.compare(b, a); });
}

function tiers(samples, body) {
  let _block;
  let _pipe = samples;
  let _pipe$1 = $list.filter(_pipe, (sample) => { return sample.alphabetic; });
  let _pipe$2 = $list.filter(
    _pipe$1,
    (sample) => { return (divideFloat(sample.size, body)) >= heading_ratio; },
  );
  let _pipe$3 = $list.map(_pipe$2, (sample) => { return sample.size; });
  let _pipe$4 = sort_desc(_pipe$3);
  _block = cluster(_pipe$4);
  let found = _block;
  if (found instanceof $Empty) {
    let _pipe$5 = samples;
    let _pipe$6 = $list.filter(
      _pipe$5,
      (sample) => { return sample.alphabetic && sample.bold; },
    );
    let _pipe$7 = $list.filter(
      _pipe$6,
      (sample) => {
        return (divideFloat(sample.size, body)) >= bold_fallback_ratio;
      },
    );
    let _pipe$8 = $list.map(_pipe$7, (sample) => { return sample.size; });
    let _pipe$9 = sort_desc(_pipe$8);
    let _pipe$10 = cluster(_pipe$9);
    return $list.take(_pipe$10, max_tiers);
  } else {
    return $list.take(found, max_tiers);
  }
}

function result_or(result, default$) {
  if (result instanceof Ok) {
    let value = result[0];
    return value;
  } else {
    return default$;
  }
}

/**
 * The most common size, counted by how many text runs use it.
 *
 * Counts runs, not characters, matching `analysis.rs`. Weighting by
 * character count looks reasonable and is wrong: Fidelity's legal footer is
 * 617 characters at 12px against 413 characters of 16px body copy, so the
 * baseline came out as 12px and every ordinary paragraph then cleared the
 * 1.2x gate and became a heading. A long disclaimer is one stylistic
 * region, not the document's body.
 * 
 * @ignore
 */
function body_size(samples) {
  let _block;
  let _pipe = samples;
  let _pipe$1 = $list.filter(
    _pipe,
    (sample) => { return sample.size >= min_body_px; },
  );
  _block = $list.fold(
    _pipe$1,
    $dict.new$(),
    (acc, sample) => {
      let _block$1;
      let _pipe$2 = sample.size;
      let _pipe$3 = $float.round(_pipe$2);
      _block$1 = $int.to_float(_pipe$3);
      let key = _block$1;
      let _block$2;
      let _pipe$4 = $dict.get(acc, key);
      _block$2 = result_or(_pipe$4, 0);
      let running = _block$2;
      return $dict.insert(acc, key, running + 1);
    },
  );
  let counts = _block;
  let _pipe$2 = counts;
  let _pipe$3 = $dict.to_list(_pipe$2);
  let _pipe$4 = $list.fold(
    _pipe$3,
    [default_px, 0],
    (best, entry) => {
      let best_weight = best[1];
      let size = entry[0];
      let weight = entry[1];
      let $ = (weight > best_weight) || ((weight === best_weight) && (size < best[0]));
      if ($) {
        return [size, weight];
      } else {
        return best;
      }
    },
  );
  return ((best) => { return best[0]; })(_pipe$4);
}

function collect(node, acc) {
  if (node instanceof Element) {
    let children = node.children;
    let _block;
    let _pipe = size_of(node);
    _block = $option.unwrap(_pipe, default_px);
    let size = _block;
    let bold = bold_of(node);
    let _block$1;
    let _pipe$1 = children;
    let _pipe$2 = $list.filter_map(
      _pipe$1,
      (child) => {
        if (child instanceof Element) {
          return new Error(undefined);
        } else {
          let content = child.content;
          let $ = $string.trim(content);
          if ($ === "") {
            return new Error(undefined);
          } else {
            let text = $;
            return new Ok(text);
          }
        }
      },
    );
    _block$1 = $string.join(_pipe$2, " ");
    let direct = _block$1;
    let _block$2;
    if (direct === "") {
      _block$2 = acc;
    } else {
      _block$2 = listPrepend(
        new Sample(size, bold, $chars.has_letter(direct)),
        acc,
      );
    }
    let acc$1 = _block$2;
    return $list.fold(
      children,
      acc$1,
      (acc, child) => { return collect(child, acc); },
    );
  } else {
    return acc;
  }
}

/**
 * Measure a resolved document: find the body size, then the tiers above it.
 */
export function analyze(root) {
  let samples = collect(root, $List$Empty$const);
  let body = body_size(samples);
  return new Tiers(body, tiers(samples, body));
}

function matching_tier(loop$sizes, loop$size, loop$level) {
  while (true) {
    let sizes = loop$sizes;
    let size = loop$size;
    let level = loop$level;
    if (sizes instanceof $Empty) {
      return Option$None$const;
    } else {
      let tier = sizes.head;
      let rest = sizes.tail;
      let $ = near(tier, size);
      if ($) {
        return new Some(level);
      } else {
        loop$sizes = rest;
        loop$size = size;
        loop$level = level + 1;
      }
    }
  }
}

/**
 * Which heading level, if any, does this size correspond to?
 */
export function level_for(tiers, size) {
  let $ = matching_tier(tiers.sizes, size, 1);
  if ($ instanceof Some) {
    return $;
  } else {
    let $1 = (divideFloat(size, tiers.body_px)) >= heading_ratio;
    if ($1) {
      return new Some($int.min($list.length(tiers.sizes) + 1, max_tiers));
    } else {
      return Option$None$const;
    }
  }
}
