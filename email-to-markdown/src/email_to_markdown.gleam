//// Raw email HTML in, Markdown out.
////
//// ```gleam
//// import email_to_markdown
////
//// let markdown =
////   raw_html
////   |> email_to_markdown.html
////   |> email_to_markdown.convert
////   |> email_to_markdown.to_string
//// ```
////
//// The pipeline is: sanitize (jsdom + DOMPurify, the only JavaScript) ->
//// drop invisible subtrees -> normalize away layout -> emit -> clean up.
////
//// MIME decoding is the caller's job. This takes an HTML string, not a
//// message.

import email_to_markdown/dom
import email_to_markdown/emit
import email_to_markdown/guard
import email_to_markdown/heading
import email_to_markdown/normalize
import email_to_markdown/postprocess
import email_to_markdown/stylesheet
import email_to_markdown/visibility
import gleam/option.{None, Some}

/// Raw email HTML, before conversion.
pub opaque type Html {
  Html(value: String)
}

/// Converted Markdown.
pub opaque type Markdown {
  Markdown(value: String)
}

/// Tag a raw string as email HTML.
pub fn html(value: String) -> Html {
  Html(value)
}

/// Unwrap converted Markdown.
pub fn to_string(markdown: Markdown) -> String {
  markdown.value
}

/// Convert email HTML to Markdown.
///
/// Total. Malformed, hostile, or empty input yields empty Markdown rather
/// than an error — there is no partial-failure mode worth surfacing to a
/// caller who just wants the text of an email.
pub fn convert(input: Html) -> Markdown {
  let document = dom.parse(input.value)

  // Stylesheet rules are merged in first: `visibility` is the hidden-text
  // defense and reads the element's own style, so a rule that hides content
  // has to reach the element before that check runs.
  let tree =
    document.stylesheet
    |> stylesheet.parse
    |> stylesheet.apply(document.root)

  case visibility.strip(tree) {
    None -> Markdown("")
    Some(visible) -> {
      // Typography must be resolved before `normalize` discards the wrapper
      // elements that carry it, and measured after, so the tiers reflect the
      // blocks that will actually be emitted.
      let tree = visible |> heading.resolve |> normalize.run
      let tiers = heading.analyze(tree)

      // `guard.enforce` is the last step deliberately: it makes "only <img>
      // and <a> reach the output" a property of the output itself rather
      // than of the emitter that happened to produce it.
      tree
      |> emit.run(tiers)
      |> postprocess.run
      |> guard.enforce
      |> Markdown
    }
  }
}

/// Convenience wrapper for callers holding a plain string.
pub fn convert_string(raw: String) -> String {
  raw |> html |> convert |> to_string
}
