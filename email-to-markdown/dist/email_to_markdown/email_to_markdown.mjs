import * as $option from "../gleam_stdlib/gleam/option.mjs";
import { None, Some } from "../gleam_stdlib/gleam/option.mjs";
import * as $dom from "./email_to_markdown/dom.mjs";
import * as $emit from "./email_to_markdown/emit.mjs";
import * as $guard from "./email_to_markdown/guard.mjs";
import * as $heading from "./email_to_markdown/heading.mjs";
import * as $normalize from "./email_to_markdown/normalize.mjs";
import * as $postprocess from "./email_to_markdown/postprocess.mjs";
import * as $stylesheet from "./email_to_markdown/stylesheet.mjs";
import * as $visibility from "./email_to_markdown/visibility.mjs";
import { CustomType as $CustomType } from "./gleam.mjs";

class Html extends $CustomType {
  constructor(value) {
    super();
    this.value = value;
  }
}

class Markdown extends $CustomType {
  constructor(value) {
    super();
    this.value = value;
  }
}

/**
 * Tag a raw string as email HTML.
 */
export function html(value) {
  return new Html(value);
}

/**
 * Unwrap converted Markdown.
 */
export function to_string(markdown) {
  return markdown.value;
}

/**
 * Convert email HTML to Markdown.
 *
 * Total. Malformed, hostile, or empty input yields empty Markdown rather
 * than an error — there is no partial-failure mode worth surfacing to a
 * caller who just wants the text of an email.
 */
export function convert(input) {
  let document = $dom.parse(input.value);
  let _block;
  let _pipe = document.stylesheet;
  let _pipe$1 = $stylesheet.parse(_pipe);
  _block = $stylesheet.apply(_pipe$1, document.root);
  let tree = _block;
  let $ = $visibility.strip(tree);
  if ($ instanceof Some) {
    let visible = $[0];
    let _block$1;
    let _pipe$2 = visible;
    let _pipe$3 = $heading.resolve(_pipe$2);
    _block$1 = $normalize.run(_pipe$3);
    let tree$1 = _block$1;
    let tiers = $heading.analyze(tree$1);
    let _pipe$4 = tree$1;
    let _pipe$5 = $emit.run(_pipe$4, tiers);
    let _pipe$6 = $postprocess.run(_pipe$5);
    let _pipe$7 = $guard.enforce(_pipe$6);
    return new Markdown(_pipe$7);
  } else {
    return new Markdown("");
  }
}

/**
 * Convenience wrapper for callers holding a plain string.
 */
export function convert_string(raw) {
  let _pipe = raw;
  let _pipe$1 = html(_pipe);
  let _pipe$2 = convert(_pipe$1);
  return to_string(_pipe$2);
}
