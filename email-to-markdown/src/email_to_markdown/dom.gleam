//// The one boundary between JavaScript and Gleam.
////
//// `parse` runs jsdom + DOMPurify in FFI and receives a compact JSON tree
//// back. Everything downstream of `decode` is pure Gleam, which is what makes
//// the rest of the pipeline testable from hand-written fixture JSON with no
//// Node involvement at all.

import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

/// A minimal HTML node. Comments, CDATA, script and style content never make
/// it this far — the serializer drops them.
pub type Node {
  Element(tag: String, attrs: Dict(String, String), children: List(Node))
  Text(content: String)
}

/// A parsed document: the sanitized tree plus the raw `<style>` text, which
/// is resolved separately because email hides real content behind it.
pub type Document {
  Document(root: Node, stylesheet: String)
}

/// Parse and sanitize raw email HTML.
///
/// Total: malformed input or an unexpected wire payload degrades to an empty
/// document rather than failing.
pub fn parse(html: String) -> Document {
  html
  |> do_parse_sanitize
  |> decode_document
}

/// Decode the FFI wire payload: `{"css": "...", "tree": {...}}`.
pub fn decode_document(payload: String) -> Document {
  let decoder = {
    use css <- decode.field("css", decode.string)
    use tree <- decode.field("tree", node_decoder())
    decode.success(Document(root: tree, stylesheet: css))
  }

  case json.parse(from: payload, using: decoder) {
    Ok(document) -> document
    Error(_) -> Document(root: empty_body(), stylesheet: "")
  }
}

/// Decode the FFI wire format. Pure — this is the seam the tests drive.
///
/// Elements are `{"t": tag, "a": {attr: value}, "c": [child, ...]}`; text
/// nodes are bare JSON strings.
pub fn decode(payload: String) -> Node {
  case json.parse(from: payload, using: node_decoder()) {
    Ok(node) -> node
    Error(_) -> empty_body()
  }
}

/// An empty document body — the degraded result for unparseable input.
pub fn empty_body() -> Node {
  Element("body", dict.new(), [])
}

fn node_decoder() -> decode.Decoder(Node) {
  decode.recursive(fn() {
    decode.one_of(decode.string |> decode.map(Text), or: [element_decoder()])
  })
}

fn element_decoder() -> decode.Decoder(Node) {
  use tag <- decode.field("t", decode.string)
  use attrs <- decode.field("a", decode.dict(decode.string, decode.string))
  use children <- decode.field("c", decode.list(node_decoder()))
  decode.success(Element(tag, attrs, children))
}

// The house FFI pattern: private, `do_` prefixed, underscore params, and a
// Gleam fallback body so the module still compiles on non-JavaScript targets.
@external(javascript, "./dom_ffi.mjs", "parseSanitize")
fn do_parse_sanitize(_html: String) -> String {
  "{\"css\":\"\",\"tree\":{\"t\":\"body\",\"a\":{},\"c\":[]}}"
}

// ── Node helpers ─────────────────────────────────────────────────────

/// Look up an attribute, lowercased and trimmed. `None` when absent.
fn attr(node: Node, name: String) -> Option(String) {
  case node {
    Text(_) -> None
    Element(attrs:, ..) ->
      case dict.get(attrs, name) {
        Ok(value) -> Some(string.trim(value))
        Error(_) -> None
      }
  }
}

/// An attribute's value, or `""` when absent.
pub fn attr_or_empty(node: Node, name: String) -> String {
  case attr(node, name) {
    Some(value) -> value
    None -> ""
  }
}

/// All text beneath a node, concatenated with no separator.
pub fn text_content(node: Node) -> String {
  case node {
    Text(content:) -> content
    Element(children:, ..) ->
      children
      |> list.map(text_content)
      |> string.concat
  }
}

/// Does this element (or any descendant) use the given tag?
pub fn has_descendant(node: Node, tag: String) -> Bool {
  case node {
    Text(_) -> False
    Element(tag: node_tag, children:, ..) ->
      node_tag == tag || list.any(children, has_descendant(_, tag))
  }
}
