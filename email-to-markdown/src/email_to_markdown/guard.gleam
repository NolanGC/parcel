//// Output invariant: the Markdown may contain `<img>` and `<a>` and nothing
//// else.
////
//// Everything upstream is *supposed* to produce only those two tags, but
//// that is an emergent property of the emitter — one new branch, one missed
//// escape, one future contributor, and it silently stops being true. This
//// module makes it an enforced property of the output instead, checked at
//// the boundary and independent of how the string was built.
////
//// Anything that is not an allowed tag has its `<` escaped, so it renders as
//// visible text rather than markup. The guard never deletes content.

import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

/// Attributes each tag may carry. Anything else — notably every `on*` event
/// handler — disqualifies the tag.
const img_attrs = ["src", "alt", "width", "height", "style"]

/// The only `style` value the emitter ever writes. Pinning it exactly closes
/// CSS injection as a category: no `url(...)` beacons, no `position:fixed`
/// overlays, no matter what upstream does.
const allowed_style = "max-width:100%;vertical-align:middle"

const a_attrs = ["href"]

/// Schemes a `src` or `href` may carry.
///
/// Deliberately duplicated from `emit.safe_url` rather than shared. This
/// module's whole purpose is to hold independently of what the emitter did,
/// and here that is load-bearing: the tag reaching this function was not
/// necessarily written by the emitter. Body text that merely *looks* like a
/// valid tag — `<p>&lt;a href="javascript:alert(1)"&gt;click&lt;/a&gt;</p>`,
/// which is inert HTML that DOMPurify has no reason to touch — arrives here
/// as a syntactically perfect `<a>`, and checking only attribute *names*
/// promoted it to a live link that never passed the emitter's allowlist.
const safe_schemes = ["http", "https", "mailto", "tel", "cid"]

/// Escape every `<` that does not begin an allowed tag.
pub fn enforce(markdown: String) -> String {
  scan(markdown, "")
}

/// Tail-recursive on purpose: the recursion depth is the number of `<` in the
/// output, and an email whose body text is tens of thousands of escaped angle
/// brackets would otherwise overflow the stack — turning a total function into
/// a crash.
fn scan(remaining: String, acc: String) -> String {
  case string.split_once(remaining, "<") {
    Error(_) -> acc <> remaining
    Ok(#(before, rest)) ->
      case allowed_tag(rest) {
        Some(#(tag, after)) -> scan(after, acc <> before <> "<" <> tag <> ">")
        None -> scan(rest, acc <> before <> "&lt;")
      }
  }
}

/// If `rest` opens with an allowed tag, return its body and what follows.
fn allowed_tag(rest: String) -> Option(#(String, String)) {
  case string.split_once(rest, ">") {
    Error(_) -> None
    Ok(#(body, after)) ->
      case is_allowed(body) {
        True -> Some(#(body, after))
        False -> None
      }
  }
}

fn is_allowed(body: String) -> Bool {
  // A `<` inside the tag body means the `>` we split on was not this tag's.
  case string.contains(body, "<") {
    True -> False
    False ->
      case string.trim(body) {
        "/a" -> True
        trimmed ->
          case string.split_once(trimmed, " ") {
            Ok(#("img", attrs)) -> attrs_allowed(attrs, img_attrs)
            Ok(#("a", attrs)) -> attrs_allowed(attrs, a_attrs)
            _ -> False
          }
      }
  }
}

/// Every attribute must be named in the allowlist and double-quoted, and
/// its value must pass the check for that name.
///
/// Splitting on `"` yields name/value alternately, so the parts are walked
/// pairwise. An even number of parts means an unbalanced quote.
fn attrs_allowed(attrs: String, allowed: List(String)) -> Bool {
  let parts = string.split(attrs, "\"")

  case list.length(parts) % 2 == 1 {
    False -> False
    True -> check_pairs(parts, allowed)
  }
}

fn check_pairs(parts: List(String), allowed: List(String)) -> Bool {
  case parts {
    [] -> True
    // Trailing fragment after the final value, e.g. the ` /` of ` />`.
    [last] -> list.contains(["", "/"], string.trim(last))
    [name, value, ..rest] ->
      case attr_name(name) {
        Ok(name) ->
          list.contains(allowed, name)
          && value_allowed(name, value)
          && check_pairs(rest, allowed)
        Error(_) -> False
      }
  }
}

fn attr_name(part: String) -> Result(String, Nil) {
  case string.split_once(string.trim(part), "=") {
    Ok(#(name, "")) -> Ok(string.trim(name))
    _ -> Error(Nil)
  }
}

fn value_allowed(name: String, value: String) -> Bool {
  case name {
    // Pinned exactly, so no `url(...)` beacon or positioning can ride in.
    "style" -> value == allowed_style
    "src" | "href" -> has_safe_scheme(value)
    _ -> !string.contains(value, "<") && !string.contains(value, ">")
  }
}

/// An explicit allowed scheme is required, so relative and protocol-relative
/// URLs are rejected along with `javascript:` and `data:`. A `/`, `?` or `#`
/// ahead of the colon means there was no scheme at all.
fn has_safe_scheme(url: String) -> Bool {
  case string.split_once(url, ":") {
    Error(_) -> False
    Ok(#(scheme, _)) ->
      !string.contains(scheme, "/")
      && !string.contains(scheme, "?")
      && !string.contains(scheme, "#")
      && list.contains(safe_schemes, string.lowercase(scheme))
  }
}
