//// The output invariant: only `<img>` and `<a>` survive as markup.

import email_to_markdown
import email_to_markdown/guard
import gleam/string

fn convert(html: String) -> String {
  email_to_markdown.convert_string(html)
}

// ── HTML arriving as text, not markup ────────────────────────────────

/// The hole this module closes. `&lt;script&gt;` in an email's *text*
/// decodes to `<script>` during extraction; emitted raw it would execute in
/// any renderer with inline HTML enabled. DOMPurify never sees it, because
/// at sanitize time it is text.
pub fn script_written_as_text_is_inert_test() {
  let output = convert("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")

  assert string.contains(output, "<script") == False
  assert string.contains(output, "&lt;script")
}

pub fn event_handler_written_as_text_is_inert_test() {
  let output = convert("<p>&lt;img src=x onerror=alert(1)&gt;</p>")

  assert string.starts_with(output, "&lt;img")
}

pub fn angle_brackets_in_prose_are_escaped_test() {
  assert convert("<p>if a &lt; b</p>") == "if a &lt; b\n"
}

// ── The two permitted tags ───────────────────────────────────────────

pub fn images_survive_the_guard_test() {
  let output =
    convert("<img src=\"https://x.test/a.png\" alt=\"L\" width=\"20\">")

  assert string.starts_with(output, "<img src=")
}

pub fn linked_images_survive_the_guard_test() {
  let html =
    "<a href=\"https://x.test\">"
    <> "<img src=\"https://x.test/a.png\" alt=\"L\" width=\"20\"></a>"

  assert string.starts_with(convert(html), "<a href=\"https://x.test\"><img ")
}

// ── URL scheme allowlist ─────────────────────────────────────────────

/// DOMPurify permits `data:image/svg+xml` — an attacker-controlled document
/// embedded in the page. Browsers do not script SVG inside `<img>`, but
/// nothing downstream is obliged to keep treating it as one.
pub fn data_uri_images_are_dropped_test() {
  let html =
    "<img src=\"data:image/svg+xml;base64,PHN2Zy8+\" alt=\"a\" width=\"20\">"

  assert convert(html) == ""
}

/// `cid:` names a part of the message the reader already holds, so it fetches
/// nothing on its own — a client either substitutes the local attachment or
/// leaves the image broken. Dropping it would silently lose every inline
/// image in mail sent with attachments.
pub fn cid_references_survive_test() {
  let output =
    convert("<img src=\"cid:part1@mail\" alt=\"signature photo\" width=\"400\">")

  assert string.contains(output, "src=\"cid:part1@mail\"")
}

pub fn http_and_https_survive_test() {
  assert string.contains(
    convert("<a href=\"http://x.test\">t</a>"),
    "http://x.test",
  )
  assert string.contains(
    convert("<a href=\"mailto:a@b.test\">t</a>"),
    "mailto:",
  )
}

// ── Control characters ───────────────────────────────────────────────

/// A raw newline inside `src` splits the tag across lines and breaks the
/// Markdown block it sits in.
pub fn newlines_in_urls_are_stripped_test() {
  let output = convert("<img src=\"https://x.test/a\nb.png\" alt=\"a\">")

  assert string.contains(output, "\n<") == False
  assert string.contains(output, "https://x.test/ab.png")
}

/// Trojan Source: a right-to-left override makes `safe<RLO>gnp.exe` render
/// as `safeexe.png`.
pub fn bidi_overrides_are_stripped_from_alt_test() {
  let output =
    convert(
      "<img src=\"https://x.test/a.png\" alt=\"safe\u{202e}gnp.exe\" width=\"20\">",
    )

  assert string.contains(output, "\u{202e}") == False
}

// ── Relative URLs ────────────────────────────────────────────────────

/// An email has no base document, so a relative URL there is meaningless.
/// Rendered inside a webmail client it resolves against *that client's*
/// origin, and the browser fetches it with the user's cookies.
pub fn relative_urls_are_dropped_test() {
  assert convert("<img src=\"/api/account/delete\" alt=\"a\" width=\"20\">")
    == ""
  assert convert("<a href=\"/settings/disable-2fa\">click</a>") == "click\n"
}

pub fn protocol_relative_urls_are_dropped_test() {
  assert convert("<img src=\"//evil.test/track.png\" alt=\"a\" width=\"20\">")
    == ""
}

/// The emitter writes exactly one style value; the guard pins it, so no
/// `url(...)` beacon or `position:fixed` overlay can ride in on that
/// attribute even if an upstream stage regresses.
pub fn foreign_style_values_are_rejected_test() {
  let injected =
    "<img src=\"https://x.test/a.png\" style=\"background:url(https://evil.test)\">"

  assert string.starts_with(guard.enforce(injected), "&lt;img")
}

pub fn event_handlers_are_rejected_by_the_guard_test() {
  let injected = "<img src=\"https://x.test/a.png\" onerror=\"alert(1)\">"

  assert string.starts_with(guard.enforce(injected), "&lt;img")
}

pub fn other_tags_are_rejected_by_the_guard_test() {
  assert guard.enforce("<div>x</div>") == "&lt;div>x&lt;/div>"
  assert guard.enforce("<script>x</script>") == "&lt;script>x&lt;/script>"
}
