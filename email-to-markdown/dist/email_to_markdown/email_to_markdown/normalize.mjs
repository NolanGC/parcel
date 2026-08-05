import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import * as $chars from "../email_to_markdown/chars.mjs";
import * as $classify from "../email_to_markdown/classify.mjs";
import * as $dom from "../email_to_markdown/dom.mjs";
import { Element, Text } from "../email_to_markdown/dom.mjs";
import * as $heading from "../email_to_markdown/heading.mjs";
import * as $style from "../email_to_markdown/style.mjs";
import * as $table from "../email_to_markdown/table.mjs";
import { Ok, Error, toList, Empty as $Empty, prepend as listPrepend } from "../gleam.mjs";

/**
 * Container classes mail clients use to mark a quoted reply chain.
 * 
 * @ignore
 */
const quote_classes = /* @__PURE__ */ toList([
  "gmail_quote",
  "yahoo_quoted",
  "moz-cite-prefix",
  "outlookmessageheader",
  "gmail_extra",
  "protonmail_quote",
]);

/**
 * Longest a flattened row can be and still read as a single line.
 * 
 * @ignore
 */
const max_inline_row_length = 120;

/**
 * Tags whose only purpose is presentational grouping.
 * 
 * @ignore
 */
const unwrap_tags = /* @__PURE__ */ toList([
  "font",
  "center",
  "tbody",
  "thead",
  "tfoot",
  "colgroup",
  "col",
  "figure",
]);

/**
 * Zero-width characters used purely as preheader padding.
 * 
 * @ignore
 */
const zero_width = /* @__PURE__ */ toList([
  "\u{200b}",
  "\u{200c}",
  "\u{200d}",
  "\u{feff}",
]);

/**
 * Characters Gleam's `string.trim` does not treat as whitespace, but which
 * behave like it. Left in place they defeat every trim in the pipeline —
 * `<strong>…9:00PM.&nbsp;</strong>` emitted `**…9:00PM. **`, which Markdown
 * will not close because the marker no longer touches the text.
 * 
 * @ignore
 */
const space_like = /* @__PURE__ */ toList(["\u{00a0}", "\u{2007}", "\u{202f}"]);

function as_blockquote(node) {
  if (node instanceof Element) {
    let children = node.children;
    return new Element("blockquote", $dict.new$(), children);
  } else {
    return node;
  }
}

function is_quote_container(node) {
  let _block;
  let _pipe = node;
  let _pipe$1 = $dom.attr_or_empty(_pipe, "class");
  let _pipe$2 = $string.lowercase(_pipe$1);
  _block = $string.split(_pipe$2, " ");
  let classes = _block;
  return $list.any(
    classes,
    (class$) => { return $list.contains(quote_classes, class$); },
  );
}

/**
 * Rebuild a cell as a block, carrying its resolved typography across so the
 * heading analysis can still see the font size it was set in.
 * 
 * @ignore
 */
function as_block(source, children) {
  return new Element("div", $heading.carried_attrs(source), children);
}

/**
 * Separate cells with a space so their text does not fuse when joined.
 * 
 * @ignore
 */
function join_inline(contents) {
  let _pipe = contents;
  let _pipe$1 = $list.filter(
    _pipe,
    (cell) => { return !(cell instanceof $Empty); },
  );
  let _pipe$2 = $list.intersperse(_pipe$1, toList([new Text(" ")]));
  return $list.flatten(_pipe$2);
}

/**
 * A row short enough to read as one line.
 *
 * Measured across the whole row rather than per cell. A preheader bar of
 * "Plus, June market recap…" (54 chars) beside "View in Browser" (15) reads
 * exactly like a 35/34 split does, but a per-cell limit rejects the first
 * and accepts the second purely because of where the boundary falls.
 * 
 * @ignore
 */
function is_short_row(contents) {
  let _block;
  let _pipe = contents;
  let _pipe$1 = $list.map(
    _pipe,
    (cell) => {
      let _pipe$1 = cell;
      let _pipe$2 = $list.map(_pipe$1, $dom.text_content);
      let _pipe$3 = $string.concat(_pipe$2);
      return $string.trim(_pipe$3);
    },
  );
  let _pipe$2 = $string.join(_pipe$1, " ");
  _block = $string.length(_pipe$2);
  let total = _block;
  return ($list.length(contents) > 1) && (total <= max_inline_row_length);
}

/**
 * A short leading marker cell followed by its content — the two-column
 * bullet and lettered-option layouts email uses constantly.
 * 
 * @ignore
 */
function is_marker_row(contents) {
  if (contents instanceof $Empty) {
    return false;
  } else {
    let $ = contents.tail;
    if ($ instanceof $Empty) {
      return false;
    } else {
      let $1 = $.tail;
      if ($1 instanceof $Empty) {
        let first = contents.head;
        let _block;
        let _pipe = first;
        let _pipe$1 = $list.map(_pipe, $dom.text_content);
        _block = $string.concat(_pipe$1);
        let text = _block;
        let trimmed = $string.trim(text);
        return (($string.length(trimmed) <= 4) && (trimmed !== "")) && $classify.is_list_item(
          trimmed + " x",
        );
      } else {
        return false;
      }
    }
  }
}

function has_image(node) {
  if (node instanceof Element) {
    let $ = node.tag;
    if ($ === "img") {
      return true;
    } else {
      let children = node.children;
      return $list.any(children, has_image);
    }
  } else {
    return false;
  }
}

/**
 * Every cell holds an image and nothing else — a social/app-badge strip.
 * 
 * @ignore
 */
function is_icon_row(contents) {
  return ($list.length(contents) > 1) && $list.all(
    contents,
    (cell) => {
      let _block;
      let _pipe = cell;
      let _pipe$1 = $list.map(_pipe, $dom.text_content);
      _block = $string.concat(_pipe$1);
      let text = _block;
      return ($string.trim(text) === "") && $list.any(cell, has_image);
    },
  );
}

function is_structural(tag) {
  return $list.contains(
    toList([
      "table",
      "ul",
      "ol",
      "blockquote",
      "pre",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
    ]),
    tag,
  );
}

function is_block_tag(tag) {
  return $list.contains(
    toList([
      "div",
      "p",
      "table",
      "ul",
      "ol",
      "blockquote",
      "pre",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "section",
      "article",
    ]),
    tag,
  );
}

function count_blocks(nodes) {
  return $list.fold(
    nodes,
    0,
    (total, node) => {
      if (node instanceof Element) {
        let tag = node.tag;
        let $ = is_block_tag(tag);
        if ($) {
          return total + 1;
        } else {
          return total;
        }
      } else {
        return total;
      }
    },
  );
}

/**
 * Does this content carry real block *structure*, as opposed to a wrapper?
 *
 * A lone `<div>` around inline content is not structure — email wraps
 * everything, and Fidelity's header is two cells each holding one such div.
 * What genuinely forces a vertical stack is a structural element, or two
 * block-level siblings in the same container.
 * 
 * @ignore
 */
function has_block_structure(nodes) {
  return (count_blocks(nodes) > 1) || $list.any(
    nodes,
    (node) => {
      if (node instanceof Element) {
        let tag = node.tag;
        let children = node.children;
        return is_structural(tag) || has_block_structure(children);
      } else {
        return false;
      }
    },
  );
}

function row_is_inline(cells, contents) {
  let has_block = $list.any(contents, has_block_structure);
  let $ = has_block || (cells instanceof $Empty);
  if ($) {
    return false;
  } else {
    return (is_icon_row(contents) || is_marker_row(contents)) || is_short_row(
      contents,
    );
  }
}

function inject(node, marker) {
  if (node instanceof Element) {
    let tag = node.tag;
    let attrs = node.attrs;
    let children = node.children;
    return new Element(
      tag,
      attrs,
      listPrepend(new Text(marker + " "), children),
    );
  } else {
    let content = node.content;
    return new Text((marker + " ") + $string.trim_start(content));
  }
}

/**
 * Insert the marker at the front of the first content-bearing node, so it
 * ends up on the same line as the text it labels.
 * 
 * @ignore
 */
function prepend_marker(marker, content) {
  if (content instanceof $Empty) {
    return toList([new Text(marker)]);
  } else {
    let first = content.head;
    let rest = content.tail;
    let $ = $string.trim($dom.text_content(first)) === "";
    if ($) {
      return listPrepend(first, prepend_marker(marker, rest));
    } else {
      return listPrepend(inject(first, marker), rest);
    }
  }
}

/**
 * A two-cell row whose first cell is nothing but a list marker.
 * 
 * @ignore
 */
function marker_row(cells, contents) {
  if (cells instanceof $Empty) {
    return new Error(undefined);
  } else if (contents instanceof $Empty) {
    return new Error(undefined);
  } else {
    let $ = cells.tail;
    if ($ instanceof $Empty) {
      return new Error(undefined);
    } else {
      let $1 = contents.tail;
      if ($1 instanceof $Empty) {
        return new Error(undefined);
      } else {
        let $2 = $.tail;
        if ($2 instanceof $Empty) {
          let $3 = $1.tail;
          if ($3 instanceof $Empty) {
            let first = contents.head;
            let second = $1.head;
            let _block;
            let _pipe = first;
            let _pipe$1 = $list.map(_pipe, $dom.text_content);
            let _pipe$2 = $string.concat(_pipe$1);
            _block = $string.trim(_pipe$2);
            let marker = _block;
            let $4 = $classify.is_standalone_marker(marker) && (!(second instanceof $Empty));
            if ($4) {
              return new Ok([marker, second]);
            } else {
              return new Error(undefined);
            }
          } else {
            return new Error(undefined);
          }
        } else {
          return new Error(undefined);
        }
      }
    }
  }
}

function cell_children(cell) {
  if (cell instanceof Element) {
    let $ = cell.tag;
    if ($ === "td") {
      let children = cell.children;
      return children;
    } else if ($ === "th") {
      let children = cell.children;
      return children;
    } else {
      return toList([cell]);
    }
  } else {
    return toList([cell]);
  }
}

function is_cell(node) {
  if (node instanceof Element) {
    let $ = node.tag;
    if ($ === "td") {
      return true;
    } else if ($ === "th") {
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

/**
 * Flatten one layout row.
 *
 * Emitting a block per cell severs pairs that only read correctly side by
 * side: `<td>•</td><td>text…</td>` orphans the bullet on its own line, and a
 * row of social icons becomes a vertical stack. When the row is inline-ish,
 * its cells are joined into a single block instead.
 * 
 * @ignore
 */
function flatten_row(children) {
  let cells = $list.filter(children, is_cell);
  let contents = $list.map(cells, cell_children);
  let $ = marker_row(cells, contents);
  if ($ instanceof Ok) {
    let marker = $[0][0];
    let content = $[0][1];
    return toList([
      new Element("div", $dict.new$(), prepend_marker(marker, content)),
    ]);
  } else {
    let $1 = row_is_inline(cells, contents);
    if ($1) {
      return toList([new Element("div", $dict.new$(), join_inline(contents))]);
    } else {
      return $list.map2(
        cells,
        contents,
        (cell, content) => { return as_block(cell, content); },
      );
    }
  }
}

function flatten_grid(node) {
  if (node instanceof Element) {
    let tag = node.tag;
    let children = node.children;
    if (tag === "table") {
      return $list.flat_map(children, flatten_grid);
    } else if (tag === "tbody") {
      return $list.flat_map(children, flatten_grid);
    } else if (tag === "thead") {
      return $list.flat_map(children, flatten_grid);
    } else if (tag === "tfoot") {
      return $list.flat_map(children, flatten_grid);
    } else if (tag === "tr") {
      return flatten_row(children);
    } else if (tag === "td") {
      return toList([as_block(node, children)]);
    } else if (tag === "th") {
      return toList([as_block(node, children)]);
    } else {
      return toList([node]);
    }
  } else {
    return toList([node]);
  }
}

/**
 * A data table stays a table, structure intact. A layout table collapses
 * into a plain block container whose rows and cells become blocks in
 * document order.
 *
 * The table's own `tr` / `td` are only flattened here, never in the generic
 * bottom-up pass — rewriting them earlier would dismantle a data table
 * before `is_data_table` could recognize it.
 * 
 * @ignore
 */
function rewrite_table(node) {
  let $ = $table.is_data_table(node);
  if ($) {
    return node;
  } else {
    return new Element("div", $dict.new$(), flatten_grid(node));
  }
}

function rewrite(node) {
  if (node instanceof Element) {
    let $ = node.tag;
    if ($ === "table") {
      return rewrite_table(node);
    } else {
      let $1 = is_quote_container(node);
      if ($1) {
        return as_blockquote(node);
      } else {
        return node;
      }
    }
  } else {
    return node;
  }
}

function is_at_most_one(value) {
  let $ = $style.length(value);
  if ($ instanceof $option.Some) {
    let number = $[0];
    return number <= 1.0;
  } else {
    return false;
  }
}

/**
 * 1×1 beacons, and images with no alt text and no usable source.
 * 
 * @ignore
 */
function is_tracking_pixel(node) {
  let tiny = is_at_most_one($dom.attr_or_empty(node, "width")) && is_at_most_one(
    $dom.attr_or_empty(node, "height"),
  );
  let useless = ($dom.attr_or_empty(node, "alt") === "") && ($dom.attr_or_empty(
    node,
    "src",
  ) === "");
  return tiny || useless;
}

function is_noise(node) {
  if (node instanceof Element) {
    let $ = node.tag;
    if ($ === "img") {
      return is_tracking_pixel(node);
    } else {
      let tag = $;
      let children = node.children;
      return (children instanceof $Empty) && $list.contains(
        toList(["div", "p", "span"]),
        tag,
      );
    }
  } else {
    return false;
  }
}

function drop_noise(children) {
  return $list.filter(children, (child) => { return !is_noise(child); });
}

function separates_neighbours(node) {
  let _pipe = node;
  let _pipe$1 = $dom.attr_or_empty(_pipe, "style");
  let _pipe$2 = $style.parse(_pipe$1);
  return $style.has_horizontal_gap(_pipe$2);
}

function is_redundant_wrapper(node) {
  if (node instanceof Element) {
    let $ = node.children;
    if ($ instanceof $Empty) {
      return false;
    } else {
      let $1 = $.head;
      if ($1 instanceof Element) {
        let $2 = $.tail;
        if ($2 instanceof $Empty) {
          let attrs = node.attrs;
          let child_tag = $1.tag;
          return ($dict.size(attrs) === 0) && is_block_tag(child_tag);
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
  } else {
    return false;
  }
}

/**
 * A `<span>` earns its existence only when it encodes formatting. Emails
 * express bold and italic through inline CSS far more often than through
 * `<strong>` / `<em>`, so those spans must survive to the emitter.
 */
export function carries_inline_style(node) {
  let styles = $style.parse($dom.attr_or_empty(node, "style"));
  return ($style.is_bold(styles) || $style.is_italic(styles)) || $style.is_decorated(
    styles,
  );
}

function should_unwrap(tag, node) {
  return ($list.contains(unwrap_tags, tag) || ((tag === "span") && !carries_inline_style(
    node,
  ))) || ((tag === "div") && is_redundant_wrapper(node));
}

function normalize_spaces(text) {
  let text$1 = $list.fold(
    space_like,
    text,
    (acc, c) => { return $string.replace(acc, c, " "); },
  );
  return $list.fold(
    zero_width,
    text$1,
    (acc, c) => { return $string.replace(acc, c, ""); },
  );
}

/**
 * Collapse runs of whitespace to a single space, per the HTML inline
 * whitespace rules. `<pre>` subtrees bypass this.
 * 
 * @ignore
 */
function collapse_whitespace(content) {
  let _pipe = content;
  let _pipe$1 = normalize_spaces(_pipe);
  return $chars.collapse_whitespace(_pipe$1);
}

/**
 * Normalize a child, then decide whether it survives as its own node or is
 * spliced into its parent's child list.
 * 
 * @ignore
 */
function expand(child, in_pre) {
  let normalized = go(child, in_pre);
  if (normalized instanceof Element) {
    let tag = normalized.tag;
    let children = normalized.children;
    let $ = should_unwrap(tag, normalized);
    if ($) {
      let $1 = separates_neighbours(normalized);
      if ($1) {
        return $list.append(children, toList([new Text(" ")]));
      } else {
        return children;
      }
    } else {
      return toList([normalized]);
    }
  } else {
    return toList([normalized]);
  }
}

function go(node, in_pre) {
  if (node instanceof Element) {
    let tag = node.tag;
    let attrs = node.attrs;
    let children = node.children;
    let nested_pre = in_pre || (tag === "pre");
    let _block;
    let _pipe = children;
    let _pipe$1 = $list.flat_map(
      _pipe,
      (child) => { return expand(child, nested_pre); },
    );
    _block = drop_noise(_pipe$1);
    let children$1 = _block;
    return rewrite(new Element(tag, attrs, children$1));
  } else {
    let content = node.content;
    if (in_pre) {
      return node;
    } else {
      return new Text(collapse_whitespace(content));
    }
  }
}

/**
 * Normalize a parsed, visibility-filtered tree.
 */
export function run(node) {
  return go(node, false);
}
