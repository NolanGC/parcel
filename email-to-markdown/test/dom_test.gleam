import email_to_markdown/dom
import gleam/dict
import gleam/string

pub fn decode_text_node_test() {
  assert dom.decode("\"hello\"") == dom.Text("hello")
}

pub fn decode_element_test() {
  let json = "{\"t\":\"p\",\"a\":{\"class\":\"x\"},\"c\":[\"hi\"]}"

  assert dom.decode(json)
    == dom.Element("p", dict.from_list([#("class", "x")]), [dom.Text("hi")])
}

pub fn decode_nested_element_test() {
  let json =
    "{\"t\":\"div\",\"a\":{},\"c\":[{\"t\":\"b\",\"a\":{},\"c\":[\"deep\"]}]}"

  assert dom.decode(json)
    == dom.Element("div", dict.new(), [
      dom.Element("b", dict.new(), [dom.Text("deep")]),
    ])
}

pub fn decode_garbage_degrades_to_empty_body_test() {
  assert dom.decode("not json at all") == dom.empty_body()
}

pub fn text_content_concatenates_test() {
  let node =
    dom.Element("p", dict.new(), [
      dom.Text("a "),
      dom.Element("b", dict.new(), [dom.Text("b")]),
      dom.Text(" c"),
    ])

  assert dom.text_content(node) == "a b c"
}

// ── FFI round trip (requires node + jsdom) ───────────────────────────

/// `parse` now returns a Document (tree + stylesheet); tests want the tree.
fn parse_root(html: String) -> dom.Node {
  dom.parse(html).root
}

pub fn parse_strips_scripts_and_handlers_test() {
  let node = parse_root("<p onclick=\"evil()\">hi<script>bad()</script></p>")

  assert dom.text_content(node) == "hi"
}

pub fn parse_preserves_style_attribute_test() {
  let node = parse_root("<div style=\"display:none\">x</div>")

  // body > div
  let assert dom.Element(children: [child], ..) = node
  assert dom.attr_or_empty(child, "style") == "display:none"
}

pub fn parse_drops_javascript_urls_test() {
  let node = parse_root("<a href=\"javascript:alert(1)\">click</a>")

  let assert dom.Element(children: [child], ..) = node
  assert dom.attr_or_empty(child, "href") == ""
}

pub fn parse_garbage_html_is_total_test() {
  let node = parse_root("<<<>>> not really html &&& <p unclosed")

  // Must not crash, and must still surface the readable text it found.
  assert dom.text_content(node) != ""
}

// ── Stylesheet extraction ────────────────────────────────────────────

pub fn parse_returns_stylesheet_text_test() {
  let document =
    dom.parse("<style>.x{display:none}</style><div class=\"x\">hi</div>")

  assert string.contains(document.stylesheet, "display:none")
}

pub fn decode_document_degrades_on_garbage_test() {
  let document = dom.decode_document("not json")

  assert document.root == dom.empty_body()
  assert document.stylesheet == ""
}
