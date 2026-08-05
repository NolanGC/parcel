import * as $json from "../../gleam_json/gleam/json.mjs";
import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $decode from "../../gleam_stdlib/gleam/dynamic/decode.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../../gleam_stdlib/gleam/option.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import {
  Ok,
  toList,
  List$Empty$const as $List$Empty$const,
  CustomType as $CustomType,
} from "../gleam.mjs";
import { parseSanitize as do_parse_sanitize } from "./dom_ffi.mjs";

export class Element extends $CustomType {
  constructor(tag, attrs, children) {
    super();
    this.tag = tag;
    this.attrs = attrs;
    this.children = children;
  }
}
export const Node$Element = (tag, attrs, children) =>
  new Element(tag, attrs, children);
export const Node$isElement = (value) => value instanceof Element;
export const Node$Element$tag = (value) => value.tag;
export const Node$Element$0 = (value) => value.tag;
export const Node$Element$attrs = (value) => value.attrs;
export const Node$Element$1 = (value) => value.attrs;
export const Node$Element$children = (value) => value.children;
export const Node$Element$2 = (value) => value.children;

export class Text extends $CustomType {
  constructor(content) {
    super();
    this.content = content;
  }
}
export const Node$Text = (content) => new Text(content);
export const Node$isText = (value) => value instanceof Text;
export const Node$Text$content = (value) => value.content;
export const Node$Text$0 = (value) => value.content;

export class Document extends $CustomType {
  constructor(root, stylesheet) {
    super();
    this.root = root;
    this.stylesheet = stylesheet;
  }
}
export const Document$Document = (root, stylesheet) =>
  new Document(root, stylesheet);
export const Document$isDocument = (value) => value instanceof Document;
export const Document$Document$root = (value) => value.root;
export const Document$Document$0 = (value) => value.root;
export const Document$Document$stylesheet = (value) => value.stylesheet;
export const Document$Document$1 = (value) => value.stylesheet;

/**
 * An empty document body — the degraded result for unparseable input.
 */
export function empty_body() {
  return new Element("body", $dict.new$(), $List$Empty$const);
}

function element_decoder() {
  return $decode.field(
    "t",
    $decode.string,
    (tag) => {
      return $decode.field(
        "a",
        $decode.dict($decode.string, $decode.string),
        (attrs) => {
          return $decode.field(
            "c",
            $decode.list(node_decoder()),
            (children) => {
              return $decode.success(new Element(tag, attrs, children));
            },
          );
        },
      );
    },
  );
}

function node_decoder() {
  return $decode.recursive(
    () => {
      return $decode.one_of(
        (() => {
          let _pipe = $decode.string;
          return $decode.map(_pipe, (var0) => { return new Text(var0); });
        })(),
        toList([element_decoder()]),
      );
    },
  );
}

/**
 * Decode the FFI wire format. Pure — this is the seam the tests drive.
 *
 * Elements are `{"t": tag, "a": {attr: value}, "c": [child, ...]}`; text
 * nodes are bare JSON strings.
 */
export function decode(payload) {
  let $ = $json.parse(payload, node_decoder());
  if ($ instanceof Ok) {
    let node = $[0];
    return node;
  } else {
    return empty_body();
  }
}

/**
 * Decode the FFI wire payload: `{"css": "...", "tree": {...}}`.
 */
export function decode_document(payload) {
  let decoder = $decode.field(
    "css",
    $decode.string,
    (css) => {
      return $decode.field(
        "tree",
        node_decoder(),
        (tree) => { return $decode.success(new Document(tree, css)); },
      );
    },
  );
  let $ = $json.parse(payload, decoder);
  if ($ instanceof Ok) {
    let document = $[0];
    return document;
  } else {
    return new Document(empty_body(), "");
  }
}

/**
 * Parse and sanitize raw email HTML.
 *
 * Total: malformed input or an unexpected wire payload degrades to an empty
 * document rather than failing.
 */
export function parse(html) {
  let _pipe = html;
  let _pipe$1 = do_parse_sanitize(_pipe);
  return decode_document(_pipe$1);
}

/**
 * Look up an attribute, lowercased and trimmed. `None` when absent.
 * 
 * @ignore
 */
function attr(node, name) {
  if (node instanceof Element) {
    let attrs = node.attrs;
    let $ = $dict.get(attrs, name);
    if ($ instanceof Ok) {
      let value = $[0];
      return new Some($string.trim(value));
    } else {
      return Option$None$const;
    }
  } else {
    return Option$None$const;
  }
}

/**
 * An attribute's value, or `""` when absent.
 */
export function attr_or_empty(node, name) {
  let $ = attr(node, name);
  if ($ instanceof Some) {
    let value = $[0];
    return value;
  } else {
    return "";
  }
}

/**
 * All text beneath a node, concatenated with no separator.
 */
export function text_content(node) {
  if (node instanceof Element) {
    let children = node.children;
    let _pipe = children;
    let _pipe$1 = $list.map(_pipe, text_content);
    return $string.concat(_pipe$1);
  } else {
    let content = node.content;
    return content;
  }
}

/**
 * Does this element (or any descendant) use the given tag?
 */
export function has_descendant(node, tag) {
  if (node instanceof Element) {
    let node_tag = node.tag;
    let children = node.children;
    return (node_tag === tag) || $list.any(
      children,
      (_capture) => { return has_descendant(_capture, tag); },
    );
  } else {
    return false;
  }
}
