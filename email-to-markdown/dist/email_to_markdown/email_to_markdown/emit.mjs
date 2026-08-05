import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $float from "../../gleam_stdlib/gleam/float.mjs";
import * as $int from "../../gleam_stdlib/gleam/int.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../../gleam_stdlib/gleam/option.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import * as $chars from "../email_to_markdown/chars.mjs";
import * as $classify from "../email_to_markdown/classify.mjs";
import * as $dom from "../email_to_markdown/dom.mjs";
import { Element, Text } from "../email_to_markdown/dom.mjs";
import * as $heading from "../email_to_markdown/heading.mjs";
import * as $normalize from "../email_to_markdown/normalize.mjs";
import * as $style from "../email_to_markdown/style.mjs";
import * as $table from "../email_to_markdown/table.mjs";
import {
  Ok,
  toList,
  Empty as $Empty,
  List$Empty$const as $List$Empty$const,
  prepend as listPrepend,
} from "../gleam.mjs";

/**
 * Characters that occupy space without carrying content. Emails use these
 * as spacers — `&nbsp;` filler cells, `&zwnj;` preheader padding — and
 * `string.trim` does not treat them as whitespace, so a spacer block would
 * otherwise survive as a line containing one invisible character.
 * 
 * @ignore
 */
const blank_chars = /* @__PURE__ */ toList([
  "\u{00a0}",
  "\u{200b}",
  "\u{200c}",
  "\u{200d}",
  "\u{feff}",
]);

/**
 * Longest an inline run can be and still plausibly be a heading. Beyond
 * this it is body copy that merely happens to be set large.
 * 
 * @ignore
 */
const max_heading_length = 120;

const block_tags = /* @__PURE__ */ toList([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "dd",
  "dt",
  "fieldset",
  "figcaption",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/**
 * Characters that must never appear inside an emitted attribute or URL.
 *
 * A raw newline inside `src` splits the tag across lines and breaks the
 * Markdown block; the bidi overrides let `safe\u{202e}gnp.exe` render as
 * `safeexe.png`, which is display spoofing rather than a parser bug.
 * 
 * @ignore
 */
const control_chars = /* @__PURE__ */ toList([
  "\n",
  "\r",
  "\t",
  "\u{0000}",
  "\u{000b}",
  "\u{000c}",
  "\u{007f}",
  "\u{202a}",
  "\u{202b}",
  "\u{202c}",
  "\u{202d}",
  "\u{202e}",
  "\u{2066}",
  "\u{2067}",
  "\u{2068}",
  "\u{2069}",
]);

/**
 * URL schemes allowed to reach the output.
 *
 * An allowlist, not a blocklist. DOMPurify already removes `javascript:`
 * and friends, but it permits `data:image/svg+xml`, which is an attacker
 * controlled document embedded in the page — browsers do not script SVG in
 * an `<img>`, but nothing downstream is obliged to keep treating it as one.
 *
 * `cid:` names a part of the message the reader already has. It fetches
 * nothing on its own: a client either substitutes the local attachment or
 * the image stays broken.
 * 
 * @ignore
 */
const safe_schemes = /* @__PURE__ */ toList([
  "http",
  "https",
  "mailto",
  "tel",
  "cid",
]);

/**
 * Widest an image can declare and still be an icon rather than content.
 * 
 * @ignore
 */
const icon_max_px = 64.0;

/**
 * Longest fence worth building. Content with a longer backtick run than this
 * is not code anyone typed, so it degrades to escaped prose.
 * 
 * @ignore
 */
const max_fence_length = 16;

function leading_hashes(loop$rest, loop$count) {
  while (true) {
    let rest = loop$rest;
    let count = loop$count;
    let $ = $string.starts_with(rest, "#");
    if ($) {
      loop$rest = $string.drop_start(rest, 1);
      loop$count = count + 1;
    } else {
      return count;
    }
  }
}

/**
 * An ATX heading is one to six `#` followed by a space or the line's end.
 * 
 * @ignore
 */
function opens_heading(rest) {
  let $ = $string.starts_with(rest, "#");
  if ($) {
    let hashes = leading_hashes(rest, 0);
    let after = $string.drop_start(rest, hashes);
    return (hashes <= 6) && ((after === "") || $string.starts_with(after, " "));
  } else {
    return $;
  }
}

function opens_block(rest) {
  return ($string.starts_with(rest, ">") || $string.starts_with(rest, "+ ")) || opens_heading(
    rest,
  );
}

function leading_spaces(loop$line, loop$count) {
  while (true) {
    let line = loop$line;
    let count = loop$count;
    let $ = $string.starts_with(line, " ");
    if ($) {
      loop$line = $string.drop_start(line, 1);
      loop$count = count + 1;
    } else {
      return count;
    }
  }
}

/**
 * Up to three leading spaces still open a block in CommonMark; beyond that the
 * line is indented code and the marker is inert.
 * 
 * @ignore
 */
function guard_line_start(line) {
  let indent = leading_spaces(line, 0);
  let rest = $string.drop_start(line, indent);
  let $ = (indent <= 3) && opens_block(rest);
  if ($) {
    return ($string.repeat(" ", indent) + "\\") + rest;
  } else {
    return line;
  }
}

function has_line_marker(text) {
  return ($string.contains(text, "#") || $string.contains(text, ">")) || $string.contains(
    text,
    "+",
  );
}

/**
 * Neutralize block syntax that only fires at the start of a line: an ATX
 * heading (`#`), a blockquote (`>`), or a `+` bullet.
 *
 * A paragraph reading `# Sale ends today` or a support reply quoting
 * `> your earlier message` is plain prose in the source, but rendered — or fed
 * to a model — the leading marker turns it into a heading or a quote and the
 * meaning shifts. Escaping the marker keeps it literal.
 *
 * `-`, `*`, and the numbered forms (`1.`, `1)`, `(1)`) are intentionally left
 * alone: `classify` promotes those to real list items, since email routinely
 * builds lists as bullet-prefixed prose with no `<ul>`. `+` is not among them,
 * so it stays a hazard rather than a feature. Escaping mid-line is harmless —
 * `\#`, `\>`, and `\+` all render as the bare character — so the occasional
 * false positive on a non-leading run costs a backslash and nothing else.
 * 
 * @ignore
 */
function escape_line_starts(text) {
  let $ = has_line_marker(text);
  if ($) {
    let _pipe = text;
    let _pipe$1 = $string.split(_pipe, "\n");
    let _pipe$2 = $list.map(_pipe$1, guard_line_start);
    return $string.join(_pipe$2, "\n");
  } else {
    return text;
  }
}

function needs_escaping(text) {
  return ($string.contains(text, "\\") || $string.contains(text, "]")) || $string.contains(
    text,
    "`",
  );
}

/**
 * Inline Markdown syntax — the part that can name a destination.
 *
 * Body text is not built by us, and that left a hole: `<p>Click
 * [here](javascript:alert(1))</p>` is perfectly ordinary HTML that DOMPurify
 * has no reason to touch, yet the text is already valid Markdown. Rendered, it
 * becomes a working link — one that never passed `safe_url`, defeating the
 * scheme allowlist along with the relative-URL and `data:` rules in a single
 * step.
 *
 * Every link form — inline, reference, collapsed, shortcut, and image — needs
 * an active `]`, so escaping that one character closes all of them. `\` has to
 * go first: otherwise `[x\](javascript:alert(1))` becomes `[x\\](...)`, where
 * the doubled backslash is itself escaped and the `]` goes right back to being
 * live.
 *
 * Backticks go too, for a subtler reason. Text carrying its own ``` opens a
 * fence, and the next code block's opening fence closes it — which drops that
 * block's contents into prose position, live link syntax and all. With
 * backticks escaped the only fences in the output are the ones we wrote.
 *
 * Emphasis markers are deliberately left alone. `*` and `_` are noisy in
 * ordinary prose and cannot name a destination or open a block.
 * 
 * @ignore
 */
function escape_inline(text) {
  let $ = needs_escaping(text);
  if ($) {
    let _pipe = text;
    let _pipe$1 = $string.replace(_pipe, "\\", "\\\\");
    let _pipe$2 = $string.replace(_pipe$1, "]", "\\]");
    return $string.replace(_pipe$2, "`", "\\`");
  } else {
    return text;
  }
}

/**
 * Neutralize Markdown syntax in text taken verbatim from the email.
 *
 * Two jobs, in order: inline syntax that could point somewhere (`escape_inline`),
 * then block syntax that could restructure a line (`escape_line_starts`).
 * 
 * @ignore
 */
function escape_text(text) {
  let _pipe = text;
  let _pipe$1 = escape_inline(_pipe);
  return escape_line_starts(_pipe$1);
}

/**
 * Is this text visually empty?
 * 
 * @ignore
 */
function is_blank(text) {
  return (() => {
    let _pipe = blank_chars;
    let _pipe$1 = $list.fold(
      _pipe,
      text,
      (acc, char) => { return $string.replace(acc, char, " "); },
    );
    return $string.trim(_pipe$1);
  })() === "";
}

function level_of(node, tiers) {
  let $ = $heading.size_of(node);
  if ($ instanceof Some) {
    let size = $[0];
    let $1 = $heading.level_for(tiers, size);
    if ($1 instanceof Some) {
      let level = $1[0];
      return level;
    } else {
      return 0;
    }
  } else {
    return 0;
  }
}

/**
 * A paragraph that opens with a literal bullet is a list item the author
 * built without `<ul>`. Common in `<td>`-based email layouts.
 * 
 * @ignore
 */
function maybe_list_item(text) {
  let $ = $classify.is_list_item(text);
  if ($) {
    return $classify.format_list_item(text);
  } else {
    return text;
  }
}

function is_list_line(text) {
  return $classify.is_list_item(text) || $string.starts_with(text, "- ");
}

/**
 * Promote an inline run to a heading when its font size named a tier.
 *
 * A `<br>`-split masthead ("Heard at<br>Goldman Sachs") is still one
 * heading, so short multi-line runs are folded onto a single line rather
 * than rejected. List items are never promoted.
 * 
 * @ignore
 */
function as_heading(text, level) {
  let _block;
  let _pipe = text;
  let _pipe$1 = $string.replace(_pipe, "\n", " ");
  _block = $chars.squeeze_spaces(_pipe$1);
  let folded = _block;
  let $ = (((level > 0) && !is_list_line(text)) && ($string.length(folded) <= max_heading_length)) && $chars.has_letter(
    folded,
  );
  if ($) {
    return ($string.repeat("#", level) + " ") + folded;
  } else {
    return text;
  }
}

/**
 * Trim each line of an inline run. A `<br>` is followed by the source's own
 * indentation, which would otherwise survive as a stray leading space.
 * 
 * @ignore
 */
function tidy_lines(text) {
  let _pipe = text;
  let _pipe$1 = $string.split(_pipe, "\n");
  let _pipe$2 = $list.map(_pipe$1, $string.trim);
  let _pipe$3 = $string.join(_pipe$2, "\n");
  return $string.trim(_pipe$3);
}

function trailing_space(text) {
  let $ = $string.ends_with(text, " ");
  if ($) {
    return " ";
  } else {
    return "";
  }
}

function leading_space(text) {
  let $ = $string.starts_with(text, " ");
  if ($) {
    return " ";
  } else {
    return "";
  }
}

/**
 * Apply an emphasis marker so it touches the text.
 *
 * `** bold **` is not bold — Markdown requires the marker to be adjacent to
 * the content, so any surrounding whitespace has to move outside it.
 * 
 * @ignore
 */
function hug(inner, marker) {
  let $ = $string.trim(inner);
  if ($ === "") {
    return inner;
  } else {
    let trimmed = $;
    return (((leading_space(inner) + marker) + trimmed) + marker) + trailing_space(
      inner,
    );
  }
}

/**
 * Percent-encode the characters that would otherwise end a Markdown link
 * destination early.
 *
 * The usual remedy — wrapping the destination in `<...>` — cannot be used
 * here, because `guard` escapes every `<` that does not open an `<img>` or
 * `<a>`. That turned `[t](<https://ok.test/a)[e](https://evil.test>)` into
 * `[t](&lt;https://ok.test/a)[e](https://evil.test>)`, where the trailing
 * `[e](...)` is a second, working link to the attacker's host.
 *
 * `%` is deliberately left alone: email URLs are full of existing escapes,
 * and encoding it would turn every `%20` into `%2520`.
 * 
 * @ignore
 */
function encode_url(url) {
  let _pipe = url;
  let _pipe$1 = $string.replace(_pipe, " ", "%20");
  let _pipe$2 = $string.replace(_pipe$1, "(", "%28");
  let _pipe$3 = $string.replace(_pipe$2, ")", "%29");
  let _pipe$4 = $string.replace(_pipe$3, "<", "%3C");
  return $string.replace(_pipe$4, ">", "%3E");
}

function strip_controls(value) {
  return $list.fold(
    control_chars,
    value,
    (acc, character) => { return $string.replace(acc, character, ""); },
  );
}

/**
 * Escape a value for use inside a double-quoted HTML attribute. `&` first,
 * or it would double-escape the entities introduced after it.
 * 
 * @ignore
 */
function escape_attr(value) {
  let _pipe = value;
  let _pipe$1 = strip_controls(_pipe);
  let _pipe$2 = $string.replace(_pipe$1, "&", "&amp;");
  let _pipe$3 = $string.replace(_pipe$2, "\"", "&quot;");
  let _pipe$4 = $string.replace(_pipe$3, "<", "&lt;");
  return $string.replace(_pipe$4, ">", "&gt;");
}

/**
 * Does this already contain a Markdown *link*?
 *
 * Image syntax has to be discounted first: `![alt](src)` also contains `](`,
 * and a linked image is perfectly valid — it is only link-inside-link that
 * cannot nest.
 * 
 * @ignore
 */
function contains_link(text) {
  let $ = $string.split(text, "![");
  if ($ instanceof $Empty) {
    return false;
  } else {
    let first = $.head;
    let images = $.tail;
    return $string.contains(first, "](") || $list.any(
      images,
      (segment) => {
        let $1 = $string.split_once(segment, ")");
        if ($1 instanceof Ok) {
          let after = $1[0][1];
          return $string.contains(after, "](");
        } else {
          return false;
        }
      },
    );
  }
}

/**
 * Reduce a URL to one that is safe to emit, or drop it.
 *
 * An explicit allowed scheme is REQUIRED. Relative (`/api/logout`) and
 * protocol-relative (`//evil.test`) URLs are dropped: an email has no base
 * document, so a relative URL there is meaningless — but rendered inside a
 * webmail client it resolves against *that client's* origin, and the
 * browser fetches it with the user's cookies. Across the sample corpus all
 * 189 URLs carry an explicit scheme, so requiring one costs nothing.
 * 
 * @ignore
 */
function safe_url(url) {
  let url$1 = strip_controls(url);
  let $ = $string.split_once(url$1, ":");
  if ($ instanceof Ok) {
    let scheme = $[0][0];
    let $1 = (($string.contains(scheme, "/") || $string.contains(scheme, "?")) || $string.contains(
      scheme,
      "#",
    )) || !$list.contains(safe_schemes, $string.lowercase(scheme));
    if ($1) {
      return "";
    } else {
      return url$1;
    }
  } else {
    return "";
  }
}

function styled_dimension(node, name) {
  let $ = $style.get($style.parse($dom.attr_or_empty(node, "style")), name);
  if ($ instanceof Some) {
    let value = $[0];
    return value;
  } else {
    return "";
  }
}

/**
 * The size the image actually renders at, in CSS pixels.
 *
 * CSS wins over the `width` attribute. On retina assets the attribute is the
 * *file's* natural width while the CSS carries the display size — Venmo
 * ships a 106px logo shown at 53px — so reading the attribute first doubles
 * every such image.
 * 
 * @ignore
 */
function declared_px(node, name) {
  let _pipe = styled_dimension(node, name);
  let _pipe$1 = $style.px(_pipe);
  return $option.lazy_or(
    _pipe$1,
    () => { return $style.px($dom.attr_or_empty(node, name)); },
  );
}

/**
 * Markdown has no syntax for image dimensions, so images are emitted as
 * HTML.
 *
 * `max-width:100%` keeps a 630px full-bleed image from overflowing a
 * narrower container. `vertical-align:middle` overrides the browser default
 * of `baseline`, which sits an inline icon's bottom edge on the text
 * baseline and leaves it visibly riding high next to the words beside it.
 * 
 * @ignore
 */
function img_tag(src, alt, width) {
  let _block;
  if (width instanceof Some) {
    let px = width[0];
    _block = (" width=\"" + $int.to_string($float.round(px))) + "\"";
  } else {
    _block = "";
  }
  let width_attr = _block;
  return ((((("<img src=\"" + escape_attr(src)) + "\" alt=\"") + escape_attr(
    alt,
  )) + "\"") + width_attr) + " style=\"max-width:100%;vertical-align:middle\">";
}

/**
 * Width if it is declared, else height. Either one is enough to tell an icon
 * from a photograph; neither means the image said nothing about its size.
 * 
 * @ignore
 */
function declared_size(node) {
  let _pipe = declared_px(node, "width");
  return $option.lazy_or(_pipe, () => { return declared_px(node, "height"); });
}

function is_large(node) {
  let $ = declared_size(node);
  if ($ instanceof Some) {
    let size = $[0];
    return size > icon_max_px;
  } else {
    return false;
  }
}

/**
 * Alt text that says something. `""` and `"1"` do not; `"Yes"` does.
 * 
 * @ignore
 */
function is_informative(alt) {
  return (alt !== "") && $chars.has_letter(alt);
}

/**
 * Uninformative alt, and no positive evidence the image is large.
 *
 * Keyed on largeness rather than smallness because dividers and spacers
 * usually declare no dimensions at all, while real content images almost
 * always do. So "unknown size" falls on the decoration side.
 * 
 * @ignore
 */
function is_decorative(node, alt) {
  return !is_informative(alt) && !is_large(node);
}

/**
 * Render an image, or drop it.
 *
 * Size alone is the wrong signal for what to discard. A 520px photo with no
 * alt is the article hero; a 51px graphic with `alt="1"` is a flourish next
 * to a heading. So the drop rule is *small AND uninformative*, which keeps
 * content photos and removes decoration.
 * 
 * @ignore
 */
function image(node) {
  let src = $dom.attr_or_empty(node, "src");
  let _block;
  let _pipe = node;
  let _pipe$1 = $dom.attr_or_empty(_pipe, "alt");
  let _pipe$2 = strip_controls(_pipe$1);
  _block = $string.trim(_pipe$2);
  let alt = _block;
  let $ = safe_url(src);
  if ($ === "") {
    return $;
  } else {
    let src$1 = $;
    let $1 = is_decorative(node, alt);
    if ($1) {
      return "";
    } else {
      return img_tag(src$1, alt, declared_px(node, "width"));
    }
  }
}

/**
 * Emails express emphasis through inline CSS far more often than through
 * `<strong>` / `<em>`, so styled spans are honoured here.
 * 
 * @ignore
 */
function styled_span(node, children) {
  let inner = inline_all(children);
  let styles = $style.parse($dom.attr_or_empty(node, "style"));
  let $ = $normalize.carries_inline_style(node);
  if ($) {
    let $1 = $string.trim(inner);
    if ($1 === "") {
      return inner;
    } else {
      let _block;
      let $2 = $style.is_italic(styles);
      if ($2) {
        _block = hug(inner, "*");
      } else {
        _block = inner;
      }
      let inner$1 = _block;
      let $3 = $style.is_bold(styles);
      if ($3) {
        return hug(inner$1, "**");
      } else {
        return inner$1;
      }
    }
  } else {
    return inner;
  }
}

function wrap(children, marker) {
  return hug(inline_all(children), marker);
}

function link(node, children) {
  let href = safe_url($dom.attr_or_empty(node, "href"));
  let _block;
  let _pipe = children;
  let _pipe$1 = inline_all(_pipe);
  _block = $string.trim(_pipe$1);
  let text = _block;
  if (href === "") {
    return text;
  } else if (text === "") {
    return text;
  } else {
    let $ = contains_link(text);
    if ($) {
      return text;
    } else {
      let $1 = $string.starts_with(text, "<img ");
      if ($1) {
        return ((("<a href=\"" + escape_attr(href)) + "\">") + text) + "</a>";
      } else {
        return ((("[" + text) + "](") + encode_url(href)) + ")";
      }
    }
  }
}

function inline(node) {
  if (node instanceof Element) {
    let tag = node.tag;
    let children = node.children;
    if (tag === "br") {
      return "\n";
    } else if (tag === "img") {
      return image(node);
    } else if (tag === "a") {
      return link(node, children);
    } else if (tag === "strong") {
      return wrap(children, "**");
    } else if (tag === "b") {
      return wrap(children, "**");
    } else if (tag === "em") {
      return wrap(children, "*");
    } else if (tag === "i") {
      return wrap(children, "*");
    } else if (tag === "code") {
      return wrap(children, "`");
    } else if (tag === "s") {
      return wrap(children, "~~");
    } else if (tag === "strike") {
      return wrap(children, "~~");
    } else if (tag === "del") {
      return wrap(children, "~~");
    } else if (tag === "u") {
      return inline_all(children);
    } else if (tag === "ins") {
      return inline_all(children);
    } else if (tag === "span") {
      return styled_span(node, children);
    } else {
      let $ = $list.contains(block_tags, tag);
      if ($) {
        return (" " + inline_all(children)) + " ";
      } else {
        return inline_all(children);
      }
    }
  } else {
    let content = node.content;
    return escape_text(content);
  }
}

function inline_all(nodes) {
  let _pipe = nodes;
  let _pipe$1 = $list.map(_pipe, inline);
  return $string.concat(_pipe$1);
}

function flush(pending, acc, level) {
  if (pending instanceof $Empty) {
    return acc;
  } else {
    let _block;
    let _pipe = pending;
    let _pipe$1 = $list.reverse(_pipe);
    let _pipe$2 = inline_all(_pipe$1);
    _block = tidy_lines(_pipe$2);
    let text = _block;
    let $ = is_blank(text);
    if ($) {
      return acc;
    } else {
      return listPrepend(as_heading(maybe_list_item(text), level), acc);
    }
  }
}

function is_partial_width(styles) {
  let $ = $style.get(styles, "width");
  if ($ instanceof Some) {
    let value = $[0];
    let $1 = $style.px(value);
    if ($1 instanceof Some) {
      let px = $1[0];
      return (px > 0.0) && (px < 400.0);
    } else {
      return (value !== "100%") && $string.contains(value, "%");
    }
  } else {
    return false;
  }
}

/**
 * Is this element laid out beside its siblings by CSS?
 *
 * `table-cell` always means side-by-side. `inline-block` does NOT: MJML
 * sets it on full-width column wrappers, and a 100%-wide inline-block still
 * occupies its own line. Treating those as inline collapsed an entire
 * newsletter into one paragraph, so a partial width is required as evidence
 * that the box actually shares a line.
 * 
 * @ignore
 */
function is_laid_inline(node) {
  let styles = $style.parse($dom.attr_or_empty(node, "style"));
  let $ = $style.is_any(styles, "display", toList(["table-cell"]));
  if ($) {
    return $;
  } else {
    return $style.is_any(styles, "display", toList(["inline", "inline-block"])) && is_partial_width(
      styles,
    );
  }
}

/**
 * Is this a small inline icon (social badge, app-store button, glyph)?
 *
 * Markdown cannot express dimensions, so the only size signal that survives
 * is *placement*: icons stay inline on one line, content images get their
 * own block. Callers cap actual display size with CSS.
 * 
 * @ignore
 */
function is_icon(node) {
  let $ = declared_size(node);
  if ($ instanceof Some) {
    let size = $[0];
    return size <= icon_max_px;
  } else {
    return false;
  }
}

function collect_images(node, acc) {
  if (node instanceof Element) {
    let $ = node.tag;
    if ($ === "img") {
      return listPrepend(node, acc);
    } else {
      let children = node.children;
      return $list.fold(
        children,
        acc,
        (acc, child) => { return collect_images(child, acc); },
      );
    }
  } else {
    return acc;
  }
}

/**
 * A container holding nothing but small icons is treated as inline, so a
 * run of them collapses onto one line instead of stacking vertically. This
 * is the only lever Markdown gives us over image layout.
 * 
 * @ignore
 */
function is_icon_only(node) {
  let images = collect_images(node, $List$Empty$const);
  return ((!(images instanceof $Empty)) && $list.all(images, is_icon)) && ($string.trim(
    $dom.text_content(node),
  ) === "");
}

function is_block(node) {
  if (node instanceof Element) {
    let tag = node.tag;
    return ($list.contains(block_tags, tag) && !is_icon_only(node)) && !is_laid_inline(
      node,
    );
  } else {
    return false;
  }
}

function image_block(node) {
  let $ = image(node);
  if ($ === "") {
    return $List$Empty$const;
  } else {
    let markdown = $;
    return toList([markdown]);
  }
}

function table_block(node) {
  let _pipe = node;
  let _pipe$1 = $table.rows_of(_pipe);
  let _pipe$2 = $table.to_markdown(
    _pipe$1,
    (content) => { return inline_all(content); },
  );
  return $string.trim(_pipe$2);
}

/**
 * The shortest fence the content cannot close.
 *
 * A fenced block ends at the first fence of equal or greater length, so a
 * `<pre>` whose own text contains ``` used to break straight out of it —
 * and everything after landed in prose position, where Markdown link syntax
 * is live and the URL allowlist no longer applies. Growing the fence past
 * the longest run in the content makes it unclosable.
 * 
 * @ignore
 */
function fence_for(loop$content, loop$fence) {
  while (true) {
    let content = loop$content;
    let fence = loop$fence;
    let $ = $string.length(fence) > max_fence_length;
    if ($) {
      return Option$None$const;
    } else {
      let $1 = $string.contains(content, fence);
      if ($1) {
        loop$content = content;
        loop$fence = fence + "`";
      } else {
        return new Some(fence);
      }
    }
  }
}

function code_block(node) {
  let $ = (() => {
    let _pipe = node;
    let _pipe$1 = $dom.text_content(_pipe);
    return $string.trim(_pipe$1);
  })();
  if ($ === "") {
    return $;
  } else {
    let content = $;
    let $1 = fence_for(content, "```");
    if ($1 instanceof Some) {
      let fence = $1[0];
      return (((fence + "\n") + content) + "\n") + fence;
    } else {
      return escape_text(content);
    }
  }
}

function indent_block(block, prefix) {
  let _pipe = block;
  let _pipe$1 = $string.split(_pipe, "\n");
  let _pipe$2 = $list.map(_pipe$1, (line) => { return prefix + line; });
  return $string.join(_pipe$2, "\n");
}

function paragraph(node, children, tiers) {
  let _block;
  let _pipe = children;
  let _pipe$1 = inline_all(_pipe);
  _block = tidy_lines(_pipe$1);
  let text = _block;
  let $ = is_blank(text);
  if ($) {
    return $List$Empty$const;
  } else {
    return toList([as_heading(maybe_list_item(text), level_of(node, tiers))]);
  }
}

function tagged_heading(tag, children) {
  let _block;
  let $ = $int.parse($string.drop_start(tag, 1));
  if ($ instanceof Ok) {
    let value = $[0];
    _block = value;
  } else {
    _block = 1;
  }
  let level = _block;
  let _block$1;
  let _pipe = children;
  let _pipe$1 = inline_all(_pipe);
  _block$1 = $string.trim(_pipe$1);
  let text = _block$1;
  if (text === "") {
    return text;
  } else {
    return ($string.repeat("#", level) + " ") + text;
  }
}

function do_group(loop$children, loop$pending, loop$acc, loop$tiers, loop$level) {
  while (true) {
    let children = loop$children;
    let pending = loop$pending;
    let acc = loop$acc;
    let tiers = loop$tiers;
    let level = loop$level;
    if (children instanceof $Empty) {
      return $list.reverse(flush(pending, acc, level));
    } else {
      let child = children.head;
      let rest = children.tail;
      let $ = is_block(child);
      if ($) {
        let acc$1 = flush(pending, acc, level);
        let acc$2 = $list.fold(
          blocks(child, tiers),
          acc$1,
          (a, b) => { return listPrepend(b, a); },
        );
        loop$children = rest;
        loop$pending = $List$Empty$const;
        loop$acc = acc$2;
        loop$tiers = tiers;
        loop$level = level;
      } else {
        loop$children = rest;
        loop$pending = listPrepend(child, pending);
        loop$acc = acc;
        loop$tiers = tiers;
        loop$level = level;
      }
    }
  }
}

/**
 * Same, but an inline run directly inside `node` inherits that element's
 * font size — which is how a styled `<div>` becomes a heading.
 * 
 * @ignore
 */
function group_children_of(node, children, tiers) {
  return do_group(
    children,
    $List$Empty$const,
    $List$Empty$const,
    tiers,
    level_of(node, tiers),
  );
}

/**
 * Split a child list into runs: consecutive inline nodes become one
 * paragraph, block nodes are emitted in place.
 * 
 * @ignore
 */
function group_children(children, tiers) {
  return do_group(children, $List$Empty$const, $List$Empty$const, tiers, 0);
}

function quote_block(node, tiers) {
  let _block;
  if (node instanceof Element) {
    let children = node.children;
    let _pipe = children;
    let _pipe$1 = group_children(_pipe, tiers);
    let _pipe$2 = $list.filter(_pipe$1, (block) => { return !is_blank(block); });
    _block = $string.join(_pipe$2, "\n\n");
  } else {
    let content = node.content;
    _block = escape_text(content);
  }
  let inner = _block;
  let $ = $string.trim(inner);
  if ($ === "") {
    return $;
  } else {
    let text = $;
    let _pipe = text;
    let _pipe$1 = $string.split(_pipe, "\n");
    let _pipe$2 = $list.map(
      _pipe$1,
      (line) => {
        if (line === "") {
          return ">";
        } else {
          return "> " + line;
        }
      },
    );
    return $string.join(_pipe$2, "\n");
  }
}

function render_item(item, marker, tiers) {
  let _block;
  if (item instanceof Element) {
    let children = item.children;
    _block = group_children(children, tiers);
  } else {
    let content = item.content;
    _block = toList([escape_text(content)]);
  }
  let parts = _block;
  let continuation = $string.repeat(" ", $string.length(marker));
  if (parts instanceof $Empty) {
    return "";
  } else {
    let first = parts.head;
    let rest = parts.tail;
    let head = marker + first;
    let tail = $list.map(
      rest,
      (part) => { return indent_block(part, continuation); },
    );
    return $string.join(listPrepend(head, tail), "\n");
  }
}

function list_block(node, tag, tiers) {
  let _block;
  if (node instanceof Element) {
    let children = node.children;
    _block = $list.filter(
      children,
      (child) => {
        if (child instanceof Element) {
          let $ = child.tag;
          if ($ === "li") {
            return true;
          } else {
            return false;
          }
        } else {
          return false;
        }
      },
    );
  } else {
    _block = $List$Empty$const;
  }
  let items = _block;
  let _block$1;
  let $ = $int.parse($dom.attr_or_empty(node, "start"));
  if ($ instanceof Ok) {
    let value = $[0];
    _block$1 = value;
  } else {
    _block$1 = 1;
  }
  let start = _block$1;
  let _pipe = items;
  let _pipe$1 = $list.index_map(
    _pipe,
    (item, index) => {
      let _block$2;
      if (tag === "ol") {
        _block$2 = $int.to_string(start + index) + ". ";
      } else {
        _block$2 = "- ";
      }
      let marker = _block$2;
      return render_item(item, marker, tiers);
    },
  );
  return $string.join(_pipe$1, "\n");
}

function blocks(node, tiers) {
  if (node instanceof Element) {
    let tag = node.tag;
    let children = node.children;
    if (tag === "h1") {
      return toList([tagged_heading(tag, children)]);
    } else if (tag === "h2") {
      return toList([tagged_heading(tag, children)]);
    } else if (tag === "h3") {
      return toList([tagged_heading(tag, children)]);
    } else if (tag === "h4") {
      return toList([tagged_heading(tag, children)]);
    } else if (tag === "h5") {
      return toList([tagged_heading(tag, children)]);
    } else if (tag === "h6") {
      return toList([tagged_heading(tag, children)]);
    } else if (tag === "p") {
      return paragraph(node, children, tiers);
    } else if (tag === "br") {
      return $List$Empty$const;
    } else if (tag === "hr") {
      return toList(["---"]);
    } else if (tag === "ul") {
      return toList([list_block(node, tag, tiers)]);
    } else if (tag === "ol") {
      return toList([list_block(node, tag, tiers)]);
    } else if (tag === "li") {
      return group_children(children, tiers);
    } else if (tag === "pre") {
      return toList([code_block(node)]);
    } else if (tag === "blockquote") {
      return toList([quote_block(node, tiers)]);
    } else if (tag === "table") {
      return toList([table_block(node)]);
    } else if (tag === "img") {
      return image_block(node);
    } else {
      return group_children_of(node, children, tiers);
    }
  } else {
    let content = node.content;
    let $ = $string.trim(content);
    if ($ === "") {
      return $List$Empty$const;
    } else {
      let text = $;
      return toList([escape_text(text)]);
    }
  }
}

/**
 * Render a normalized tree as Markdown, using `tiers` to recognize headings
 * that the source expressed only as font size.
 */
export function run(node, tiers) {
  let _pipe = node;
  let _pipe$1 = blocks(_pipe, tiers);
  let _pipe$2 = $list.filter(_pipe$1, (block) => { return !is_blank(block); });
  return $string.join(_pipe$2, "\n\n");
}
