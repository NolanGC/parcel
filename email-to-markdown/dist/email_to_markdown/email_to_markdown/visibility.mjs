import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../../gleam_stdlib/gleam/option.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import * as $dom from "../email_to_markdown/dom.mjs";
import { Element, Text } from "../email_to_markdown/dom.mjs";
import * as $style from "../email_to_markdown/style.mjs";
import { Ok, Error, toList, isEqual } from "../gleam.mjs";

/**
 * Smallest font size that renders as readable text.
 * 
 * @ignore
 */
const min_readable_px = 4.0;

/**
 * Off-canvas positioning threshold, in CSS pixels.
 * 
 * @ignore
 */
const off_canvas_px = -1000.0;

function declared(styles, property) {
  let $ = $style.get(styles, property);
  if ($ instanceof Some) {
    let value = $[0];
    return value;
  } else {
    return "";
  }
}

function foreground_of(node, styles) {
  let _pipe = $style.colour(declared(styles, "color"));
  return $option.lazy_or(
    _pipe,
    () => { return $style.colour($dom.attr_or_empty(node, "color")); },
  );
}

function declares_other_colour(node, hidden) {
  let styles = $style.parse($dom.attr_or_empty(node, "style"));
  let $ = foreground_of(node, styles);
  if ($ instanceof Some) {
    let colour = $[0];
    return colour !== hidden;
  } else {
    return false;
  }
}

/**
 * Does any descendant paint itself a different colour, overriding the
 * unreadable one it would otherwise inherit?
 * 
 * @ignore
 */
function restores_colour(node, hidden) {
  if (node instanceof Element) {
    let children = node.children;
    return $list.any(
      children,
      (child) => {
        return declares_other_colour(child, hidden) || restores_colour(
          child,
          hidden,
        );
      },
    );
  } else {
    return false;
  }
}

function background_matches(node, styles, foreground) {
  let declared_background = $list.any(
    toList(["background-color", "background"]),
    (property) => {
      return isEqual(
        $style.colour(declared(styles, property)),
        new Some(foreground)
      );
    },
  );
  return declared_background || (isEqual(
    $style.colour($dom.attr_or_empty(node, "bgcolor")),
    new Some(foreground)
  ));
}

/**
 * Text painted in a colour that cannot be read against its own background.
 *
 * White-on-white is the oldest hidden-text trick there is. Comparing the two
 * declarations on the *same* element keeps this tight: an element that sets
 * only `color` is inheriting its background from an ancestor, and guessing
 * what that resolved to is how false positives get made.
 *
 * The descendant check is not optional, and is here for the same reason the
 * one in `is_zeroed_text` is. AvalonBay's footer `<td>` really does declare
 * `background-color:#ffffff;color:#ffffff`, and really is readable, because
 * a `<font color="#444444">` inside repaints it.
 * 
 * @ignore
 */
function is_unreadable_colour(node, styles) {
  let $ = foreground_of(node, styles);
  if ($ instanceof Some) {
    let foreground = $[0];
    return ((foreground === "transparent") || background_matches(
      node,
      styles,
      foreground,
    )) && !restores_colour(node, foreground);
  } else {
    return false;
  }
}

function declares_visible_size(node) {
  let styles = $style.parse($dom.attr_or_empty(node, "style"));
  let $ = $style.get(styles, "font-size");
  if ($ instanceof Some) {
    let value = $[0];
    let $1 = $style.length(value);
    if ($1 instanceof Some) {
      let size = $1[0];
      return size >= min_readable_px;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

/**
 * Does any descendant declare a visible font size, overriding the zero?
 * 
 * @ignore
 */
function restores_font_size(node) {
  if (node instanceof Element) {
    let children = node.children;
    return $list.any(
      children,
      (child) => {
        return declares_visible_size(child) || restores_font_size(child);
      },
    );
  } else {
    return false;
  }
}

function in_pixels(value) {
  let _pipe = value;
  let _pipe$1 = $string.trim(_pipe);
  let _pipe$2 = $string.lowercase(_pipe$1);
  return $string.ends_with(_pipe$2, "px");
}

/**
 * Is the declared size too small to read?
 *
 * Zero is the MJML / Outlook case the guards above exist for. Anything else
 * under a few pixels is nobody's typography — `font-size:1px` carries a
 * paragraph that only a parser will ever see.
 *
 * The threshold applies to pixel values only. `style.px` hands back the bare
 * number, and `0.5em` is eight perfectly readable pixels at a default base.
 * 
 * @ignore
 */
function is_sub_visible_size(styles) {
  let $ = $style.get(styles, "font-size");
  if ($ instanceof Some) {
    let value = $[0];
    let $1 = $style.px(value);
    if ($1 instanceof Some) {
      let size = $1[0];
      return (size <= 0.0) || (in_pixels(value) && (size < min_readable_px));
    } else {
      return false;
    }
  } else {
    return false;
  }
}

/**
 * `font-size:0` is only *sometimes* a hiding technique.
 *
 * It is also the standard Outlook image-gap fix, and MJML — one of the most
 * widely used email frameworks — emits `font-size:0px` on every text cell,
 * resetting the real size on an inner `<div>`. Treating that as hidden
 * silently eats the body of any MJML-built email.
 *
 * So it only counts as hiding when nothing underneath restores it: no image
 * or link to lose, and no descendant declaring its own visible size.
 *
 * `line-height:0` is deliberately NOT a signal here. It collapses the line
 * box but the glyphs still render, and it is the standard way to stop a
 * `<sup>` from stretching line spacing — honouring it ate the ® from
 * "Fidelity Mobile®".
 * 
 * @ignore
 */
function is_zeroed_text(node, styles) {
  let $ = is_sub_visible_size(styles);
  if ($) {
    return (!$dom.has_descendant(node, "img") && !$dom.has_descendant(node, "a")) && !restores_font_size(
      node,
    );
  } else {
    return $;
  }
}

function zero_style(styles, property) {
  let $ = $style.get(styles, property);
  if ($ instanceof Some) {
    let value = $[0];
    return $style.is_zero_length(value);
  } else {
    return false;
  }
}

function zero_attr(attrs, name) {
  let $ = $dict.get(attrs, name);
  if ($ instanceof Ok) {
    let value = $[0];
    return $style.is_zero_length($string.trim(value));
  } else {
    return false;
  }
}

/**
 * A box collapsed to nothing via presentational attributes or CSS.
 *
 * Restricted to tags actually used as spacers, so a zero dimension on a
 * text-bearing block is not over-eagerly dropped.
 * 
 * @ignore
 */
function is_collapsed_box(tag, attrs, styles) {
  let $ = $list.contains(
    toList(["img", "td", "th", "table", "tr", "div", "span"]),
    tag,
  );
  if ($) {
    return ((zero_attr(attrs, "width") || zero_attr(attrs, "height")) || zero_style(
      styles,
      "width",
    )) || zero_style(styles, "height");
  } else {
    return $;
  }
}

/**
 * `transform: scale(0)` renders the box at no size at all.
 * 
 * @ignore
 */
function is_scaled_to_nothing(styles) {
  let transform = $string.replace(declared(styles, "transform"), " ", "");
  return $list.any(
    toList(["scale(0)", "scale(0,0)", "scale3d(0,0,0)", "scale(0%)"]),
    (zero) => { return $string.contains(transform, zero); },
  );
}

/**
 * Clipped to a zero-area rectangle: the `.sr-only` / visually-hidden recipe,
 * in both its old (`clip`) and current (`clip-path`) spellings.
 *
 * Legitimate uses exist, but they exist precisely because the content is
 * invisible — which is the question this module is asking.
 * 
 * @ignore
 */
function is_clipped(styles) {
  let clip = declared(styles, "clip");
  let path = declared(styles, "clip-path");
  return (($string.replace(clip, " ", "") === "rect(0,0,0,0)") || ($string.replace(
    path,
    " ",
    "",
  ) === "inset(50%)")) || ($string.replace(path, " ", "") === "inset(100%)");
}

function is_far_negative(styles, property) {
  let $ = $style.get(styles, property);
  if ($ instanceof Some) {
    let value = $[0];
    let $1 = $style.length(value);
    if ($1 instanceof Some) {
      let number = $1[0];
      return number <= off_canvas_px;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

/**
 * Text pushed off-screen by a large negative indent — the old
 * image-replacement trick, and a tidy way to smuggle a paragraph.
 * 
 * @ignore
 */
function is_indented_away(styles) {
  return is_far_negative(styles, "text-indent");
}

/**
 * Absolutely positioned far outside the viewport — the classic
 * screen-reader-text / hidden-preheader trick.
 * 
 * @ignore
 */
function is_off_canvas(styles) {
  let $ = $style.is_any(styles, "position", toList(["absolute", "fixed"]));
  if ($) {
    return is_far_negative(styles, "left") || is_far_negative(styles, "top");
  } else {
    return $;
  }
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

/**
 * Would this element render as invisible to the recipient?
 * 
 * @ignore
 */
function is_hidden(node) {
  if (node instanceof Element) {
    let tag = node.tag;
    let attrs = node.attrs;
    let styles = styles_of(attrs);
    return (((((((((($dict.has_key(attrs, "hidden") || $style.is_any(
      styles,
      "display",
      toList(["none"]),
    )) || $style.is_any(styles, "visibility", toList(["hidden", "collapse"]))) || zero_style(
      styles,
      "opacity",
    )) || zero_style(styles, "max-height")) || is_off_canvas(styles)) || is_indented_away(
      styles,
    )) || is_clipped(styles)) || is_scaled_to_nothing(styles)) || is_collapsed_box(
      tag,
      attrs,
      styles,
    )) || is_zeroed_text(node, styles)) || is_unreadable_colour(node, styles);
  } else {
    return false;
  }
}

function keep(node) {
  let $ = strip(node);
  if ($ instanceof Some) {
    let kept = $[0];
    return new Ok(kept);
  } else {
    return new Error(undefined);
  }
}

/**
 * Remove every invisible subtree. `None` when the node itself is hidden.
 */
export function strip(node) {
  if (node instanceof Element) {
    let tag = node.tag;
    let attrs = node.attrs;
    let children = node.children;
    let $ = is_hidden(node);
    if ($) {
      return Option$None$const;
    } else {
      return new Some(new Element(tag, attrs, $list.filter_map(children, keep)));
    }
  } else {
    return new Some(node);
  }
}
