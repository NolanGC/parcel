import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../../gleam_stdlib/gleam/option.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import { Ok, Error, toList, Empty as $Empty } from "../gleam.mjs";

const a_attrs = /* @__PURE__ */ toList(["href"]);

/**
 * Schemes a `src` or `href` may carry.
 *
 * Deliberately duplicated from `emit.safe_url` rather than shared. This
 * module's whole purpose is to hold independently of what the emitter did,
 * and here that is load-bearing: the tag reaching this function was not
 * necessarily written by the emitter. Body text that merely *looks* like a
 * valid tag — `<p>&lt;a href="javascript:alert(1)"&gt;click&lt;/a&gt;</p>`,
 * which is inert HTML that DOMPurify has no reason to touch — arrives here
 * as a syntactically perfect `<a>`, and checking only attribute *names*
 * promoted it to a live link that never passed the emitter's allowlist.
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
 * The only `style` value the emitter ever writes. Pinning it exactly closes
 * CSS injection as a category: no `url(...)` beacons, no `position:fixed`
 * overlays, no matter what upstream does.
 * 
 * @ignore
 */
const allowed_style = "max-width:100%;vertical-align:middle";

/**
 * Attributes each tag may carry. Anything else — notably every `on*` event
 * handler — disqualifies the tag.
 * 
 * @ignore
 */
const img_attrs = /* @__PURE__ */ toList([
  "src",
  "alt",
  "width",
  "height",
  "style",
]);

/**
 * An explicit allowed scheme is required, so relative and protocol-relative
 * URLs are rejected along with `javascript:` and `data:`. A `/`, `?` or `#`
 * ahead of the colon means there was no scheme at all.
 * 
 * @ignore
 */
function has_safe_scheme(url) {
  let $ = $string.split_once(url, ":");
  if ($ instanceof Ok) {
    let scheme = $[0][0];
    return ((!$string.contains(scheme, "/") && !$string.contains(scheme, "?")) && !$string.contains(
      scheme,
      "#",
    )) && $list.contains(safe_schemes, $string.lowercase(scheme));
  } else {
    return false;
  }
}

function value_allowed(name, value) {
  if (name === "style") {
    return value === allowed_style;
  } else if (name === "src") {
    return has_safe_scheme(value);
  } else if (name === "href") {
    return has_safe_scheme(value);
  } else {
    return !$string.contains(value, "<") && !$string.contains(value, ">");
  }
}

function attr_name(part) {
  let $ = $string.split_once($string.trim(part), "=");
  if ($ instanceof Ok) {
    let $1 = $[0][1];
    if ($1 === "") {
      let name = $[0][0];
      return new Ok($string.trim(name));
    } else {
      return new Error(undefined);
    }
  } else {
    return new Error(undefined);
  }
}

function check_pairs(parts, allowed) {
  if (parts instanceof $Empty) {
    return true;
  } else {
    let $ = parts.tail;
    if ($ instanceof $Empty) {
      let last = parts.head;
      return $list.contains(toList(["", "/"]), $string.trim(last));
    } else {
      let name = parts.head;
      let value = $.head;
      let rest = $.tail;
      let $1 = attr_name(name);
      if ($1 instanceof Ok) {
        let name$1 = $1[0];
        return ($list.contains(allowed, name$1) && value_allowed(name$1, value)) && check_pairs(
          rest,
          allowed,
        );
      } else {
        return false;
      }
    }
  }
}

/**
 * Every attribute must be named in the allowlist and double-quoted, and
 * its value must pass the check for that name.
 *
 * Splitting on `"` yields name/value alternately, so the parts are walked
 * pairwise. An even number of parts means an unbalanced quote.
 * 
 * @ignore
 */
function attrs_allowed(attrs, allowed) {
  let parts = $string.split(attrs, "\"");
  let $ = ($list.length(parts) % 2) === 1;
  if ($) {
    return check_pairs(parts, allowed);
  } else {
    return $;
  }
}

function is_allowed(body) {
  let $ = $string.contains(body, "<");
  if ($) {
    return false;
  } else {
    let $1 = $string.trim(body);
    if ($1 === "/a") {
      return true;
    } else {
      let trimmed = $1;
      let $2 = $string.split_once(trimmed, " ");
      if ($2 instanceof Ok) {
        let $3 = $2[0][0];
        if ($3 === "img") {
          let attrs = $2[0][1];
          return attrs_allowed(attrs, img_attrs);
        } else if ($3 === "a") {
          let attrs = $2[0][1];
          return attrs_allowed(attrs, a_attrs);
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
  }
}

/**
 * If `rest` opens with an allowed tag, return its body and what follows.
 * 
 * @ignore
 */
function allowed_tag(rest) {
  let $ = $string.split_once(rest, ">");
  if ($ instanceof Ok) {
    let body = $[0][0];
    let after = $[0][1];
    let $1 = is_allowed(body);
    if ($1) {
      return new Some([body, after]);
    } else {
      return Option$None$const;
    }
  } else {
    return Option$None$const;
  }
}

/**
 * Tail-recursive on purpose: the recursion depth is the number of `<` in the
 * output, and an email whose body text is tens of thousands of escaped angle
 * brackets would otherwise overflow the stack — turning a total function into
 * a crash.
 * 
 * @ignore
 */
function scan(loop$remaining, loop$acc) {
  while (true) {
    let remaining = loop$remaining;
    let acc = loop$acc;
    let $ = $string.split_once(remaining, "<");
    if ($ instanceof Ok) {
      let before = $[0][0];
      let rest = $[0][1];
      let $1 = allowed_tag(rest);
      if ($1 instanceof Some) {
        let tag = $1[0][0];
        let after = $1[0][1];
        loop$remaining = after;
        loop$acc = (((acc + before) + "<") + tag) + ">";
      } else {
        loop$remaining = rest;
        loop$acc = (acc + before) + "&lt;";
      }
    } else {
      return acc + remaining;
    }
  }
}

/**
 * Escape every `<` that does not begin an allowed tag.
 */
export function enforce(markdown) {
  return scan(markdown, "");
}
