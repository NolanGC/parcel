//// Layout-row flattening, heading inference, and image placement.
////
//// Every case here comes from a real email that got it wrong first.

import email_to_markdown
import gleam/string

fn convert(html: String) -> String {
  email_to_markdown.convert_string(html)
}

/// The HTML image shape the emitter produces. Markdown has no syntax for
/// dimensions, so images carry their true display width as HTML.
fn img(src: String, alt: String, width: String) -> String {
  "<img src=\""
  <> src
  <> "\" alt=\""
  <> alt
  <> "\" width=\""
  <> width
  <> "\" style=\"max-width:100%;vertical-align:middle\">"
}

// ── Marker rows ──────────────────────────────────────────────────────

/// `<td>•</td><td>text</td>` is how email writes a bullet list. Emitting a
/// block per cell stranded the bullet on its own line.
pub fn bullet_cell_joins_its_content_test() {
  let html =
    "<table><tr><td width=\"18\">&bull;</td>"
    <> "<td><p><strong>Recap</strong>: markets fell.</p></td></tr></table>"

  assert convert(html) == "- **Recap**: markets fell.\n"
}

/// The cells are separated by source whitespace in real markup, so a row's
/// children are not its cells. This is the form that actually shipped broken.
pub fn marker_row_with_whitespace_between_cells_test() {
  let html =
    "<table>\n  <tr>\n    <td>&bull;</td>\n"
    <> "    <td><p>Some content here.</p></td>\n  </tr>\n</table>"

  assert convert(html) == "- Some content here.\n"
}

/// Lettered options are unambiguous when the marker owns its own cell, even
/// though `classify` refuses them in prose to avoid firing on "e.g.".
pub fn lettered_marker_cell_joins_test() {
  let html =
    "<table><tr><td>A.</td><td><p>The first option.</p></td></tr></table>"

  assert convert(html) == "A. The first option.\n"
}

pub fn empty_leading_paragraph_is_skipped_when_injecting_test() {
  let html =
    "<table><tr><td>&bull;</td>"
    <> "<td><p></p><p>Real content.</p></td></tr></table>"

  assert convert(html) == "- Real content.\n"
}

// ── Icon rows ────────────────────────────────────────────────────────

pub fn icon_row_stays_on_one_line_test() {
  let html =
    "<table><tr>"
    <> "<td><img src=\"https://x.test/a.png\" alt=\"A\" width=\"24\"></td>"
    <> "<td><img src=\"https://x.test/b.png\" alt=\"B\" width=\"24\"></td>"
    <> "</tr></table>"

  assert convert(html)
    == img("https://x.test/a.png", "A", "24")
    <> " "
    <> img("https://x.test/b.png", "B", "24")
    <> "\n"
}

pub fn icons_in_separate_blocks_still_merge_test() {
  let html =
    "<div><img src=\"https://x.test/a.png\" alt=\"A\" width=\"20\"></div>"
    <> "<div><img src=\"https://x.test/b.png\" alt=\"B\" width=\"20\"></div>"

  assert convert(html)
    == img("https://x.test/a.png", "A", "20")
    <> " "
    <> img("https://x.test/b.png", "B", "20")
    <> "\n"
}

/// A content-sized image is not an icon and keeps its own block.
pub fn large_images_stay_block_level_test() {
  let html =
    "<div><img src=\"https://x.test/hero.png\" alt=\"Hero\" width=\"600\"></div>"
    <> "<div><img src=\"https://x.test/other.png\" alt=\"Other\" width=\"600\"></div>"

  assert convert(html)
    == img("https://x.test/hero.png", "Hero", "600")
    <> "\n\n"
    <> img("https://x.test/other.png", "Other", "600")
    <> "\n"
}

pub fn decorative_image_without_alt_is_dropped_test() {
  let html = "<p>Body</p><img src=\"https://x.test/divider.png\" alt=\"\">"

  assert convert(html) == "Body\n"
}

// ── Heading inference ────────────────────────────────────────────────

/// Real emails contain zero <h1>-<h6>; hierarchy is font size alone.
pub fn font_size_becomes_a_heading_test() {
  let html =
    "<div style=\"font-size:16px\">"
    <> "<div style=\"font-size:28px\">Big Title</div>"
    <> "<p>Body copy that establishes the baseline size for this document.</p>"
    <> "</div>"

  assert string.contains(convert(html), "# Big Title")
}

pub fn body_text_is_not_promoted_test() {
  let html =
    "<div style=\"font-size:16px\">"
    <> "<p>Ordinary body copy at the baseline size, nothing special here.</p>"
    <> "</div>"

  assert string.contains(convert(html), "#") == False
}

/// font-size is set on a wrapper and inherited by the text inside it.
pub fn inherited_font_size_is_resolved_test() {
  let html =
    "<table><tr><td style=\"font-size:24px\">Inherited Heading</td></tr></table>"
    <> "<p style=\"font-size:16px\">Body copy establishing the baseline size.</p>"

  assert string.contains(convert(html), "# Inherited Heading")
}

/// A masthead split by <br> is still one heading.
pub fn short_multiline_heading_is_folded_test() {
  let html =
    "<div style=\"font-size:40px\">Heard at<br>Goldman Sachs</div>"
    <> "<p style=\"font-size:16px\">Body copy establishing the baseline size.</p>"

  assert string.contains(convert(html), "# Heard at Goldman Sachs")
}

/// Long runs set large are body copy, not headings.
pub fn long_large_text_is_not_a_heading_test() {
  let long = string.repeat("word ", 40)
  let html =
    "<div style=\"font-size:24px\">"
    <> long
    <> "</div>"
    <> "<p style=\"font-size:16px\">Body copy establishing the baseline.</p>"

  assert string.contains(convert(html), "#") == False
}

/// Digit-only runs (prices, dates) must not define a tier.
pub fn digit_only_runs_do_not_define_tiers_test() {
  let html =
    "<div style=\"font-size:48px\">$5.00</div>"
    <> "<div style=\"font-size:16px\">Body copy establishing the baseline.</div>"

  assert string.contains(convert(html), "# $5.00") == False
}

pub fn list_items_are_never_promoted_to_headings_test() {
  let html =
    "<div style=\"font-size:16px\">"
    <> "<ul><li style=\"font-size:24px\">An item</li></ul>"
    <> "<p>Body copy establishing the baseline size for the document.</p>"
    <> "</div>"

  assert string.contains(convert(html), "- An item")
}

// ── Images that are really buttons or decoration ─────────────────────

/// A 51px graphic with alt="1" sitting beside a heading is a flourish.
pub fn small_image_with_meaningless_alt_is_dropped_test() {
  let html =
    "<p>Body</p><img src=\"https://x.test/bulb.png\" alt=\"1\" width=\"51\">"

  assert convert(html) == "Body\n"
}

/// A 520px photo with no alt is the article hero, not a spacer. Size, not
/// alt alone, decides.
pub fn large_image_without_alt_is_kept_test() {
  let html = "<img src=\"https://x.test/hero.jpg\" alt=\"\" width=\"520\">"

  assert convert(html) == img("https://x.test/hero.jpg", "", "520") <> "\n"
}

/// Unknown size plus empty alt falls on the decoration side, because real
/// content images in email essentially always declare dimensions.
pub fn undimensioned_image_without_alt_is_dropped_test() {
  let html = "<p>Body</p><img src=\"https://x.test/divider.png\" alt=\"\">"

  assert convert(html) == "Body\n"
}

/// Linked images keep their graphic. Substituting alt text used to be a
/// workaround for images rendering at the wrong size; now that each carries
/// its true display width, the substitution only destroyed avatars and logos.
pub fn linked_image_keeps_its_graphic_test() {
  let html =
    "<a href=\"https://x.test/yes\">"
    <> "<img src=\"https://x.test/thumbs-up.png\" alt=\"Yes\" width=\"200\"></a>"

  assert convert(html)
    == "<a href=\"https://x.test/yes\">"
    <> img("https://x.test/thumbs-up.png", "Yes", "200")
    <> "</a>\n"
}

/// The case that made the old rule untenable: a 64px avatar is real visual
/// content, not a label.
pub fn linked_avatar_survives_as_an_image_test() {
  let html =
    "<a href=\"https://x.test/p\">"
    <> "<img src=\"https://x.test/me.jpg\" alt=\"Kacy Hogarth profile picture\" width=\"64\"></a>"

  assert string.contains(convert(html), "<img src=\"https://x.test/me.jpg\"")
}

/// Icons stay images, but the row must still collapse onto one line — that
/// is layout, handled independently of sizing.
pub fn linked_icon_row_stays_on_one_line_test() {
  let html =
    "<table><tr>"
    <> "<td><a href=\"https://x.test/ig\"><img src=\"https://x.test/ig.png\" alt=\"Instagram\" width=\"33\"></a></td>"
    <> "<td><a href=\"https://x.test/fb\"><img src=\"https://x.test/fb.png\" alt=\"Facebook\" width=\"33\"></a></td>"
    <> "</tr></table>"

  assert convert(html)
    == "<a href=\"https://x.test/ig\">"
    <> img("https://x.test/ig.png", "Instagram", "33")
    <> "</a> <a href=\"https://x.test/fb\">"
    <> img("https://x.test/fb.png", "Facebook", "33")
    <> "</a>\n"
}

/// A long alt is a caption, not a button label — keep the image.
pub fn linked_image_with_caption_alt_stays_an_image_test() {
  let alt = "A detailed photograph of the midyear financial review process"
  let html =
    "<a href=\"https://x.test/a\">"
    <> "<img src=\"https://x.test/p.jpg\" alt=\""
    <> alt
    <> "\" width=\"520\"></a>"

  assert convert(html)
    == "<a href=\"https://x.test/a\">"
    <> img("https://x.test/p.jpg", alt, "520")
    <> "</a>\n"
}

/// Artwork keeps its graphic inside a link.
pub fn large_linked_artwork_stays_an_image_test() {
  let html =
    "<a href=\"https://x.test\">"
    <> "<img src=\"https://x.test/logo.png\" alt=\"Marcus\" width=\"600\"></a>"

  assert convert(html)
    == "<a href=\"https://x.test\">"
    <> img("https://x.test/logo.png", "Marcus", "600")
    <> "</a>\n"
}

// ── True display size ────────────────────────────────────────────────

/// Retina assets set the `width` attribute to the FILE's natural width and
/// carry the display size in CSS. Venmo ships a 106px logo shown at 53px, so
/// reading the attribute first renders every such image at double size.
pub fn css_width_wins_over_the_attribute_test() {
  let html =
    "<img src=\"https://x.test/logo.png\" alt=\"Venmo logo\" width=\"106\" style=\"width:53px\">"

  assert convert(html)
    == img("https://x.test/logo.png", "Venmo logo", "53") <> "\n"
}

/// A percentage is not a pixel count; fall back to the attribute.
pub fn percentage_width_falls_back_to_the_attribute_test() {
  let html =
    "<img src=\"https://x.test/hero.png\" alt=\"Hero\" width=\"630\" style=\"width:100%\">"

  assert convert(html) == img("https://x.test/hero.png", "Hero", "630") <> "\n"
}

/// Images are emitted as HTML, so a bare URL now appears inside `src="..."`.
/// The URL linkifier must not rewrite it into Markdown link syntax.
pub fn urls_inside_html_attributes_are_not_linkified_test() {
  let output = convert("<img src=\"https://x.test/a.png\" alt=\"Logo\">")

  assert string.contains(output, "](") == False
  assert string.contains(output, "src=\"https://x.test/a.png\"")
}

pub fn attribute_values_are_html_escaped_test() {
  let html = "<img src=\"https://x.test/a?u=1&v=2\" alt=\"Q &amp; A\">"
  let output = convert(html)

  assert string.contains(output, "u=1&amp;v=2")
  assert string.contains(output, "alt=\"Q &amp; A\"")
}

/// Row length is a property of the whole row, not each cell. A preheader bar
/// pairs a 54-char blurb with a 15-char "View in Browser" link; a per-cell
/// limit rejected it purely because of where the cell boundary fell.
pub fn uneven_two_cell_row_still_joins_test() {
  let html =
    "<table><tr>"
    <> "<td>Plus, June market recap, lifestyle inflation, and more</td>"
    <> "<td><a href=\"https://x.test\">View in Browser</a></td>"
    <> "</tr></table>"

  assert convert(html)
    == "Plus, June market recap, lifestyle inflation, and more"
    <> " [View in Browser](https://x.test)\n"
}

/// A row of genuine prose columns is too long to be one line and stays split.
pub fn long_prose_row_stays_split_test() {
  let left = string.repeat("left ", 20)
  let right = string.repeat("right ", 20)
  let html =
    "<table><tr><td>" <> left <> "</td><td>" <> right <> "</td></tr></table>"

  assert string.contains(convert(html), "\n\n")
}
