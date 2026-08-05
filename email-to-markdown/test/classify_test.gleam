import email_to_markdown/classify
import gleam/option.{None, Some}

pub fn bullet_marker_test() {
  assert classify.list_marker("• Item one")
    == Some(#(classify.Bullet, "Item one"))
}

pub fn unicode_bullet_variants_test() {
  assert classify.is_list_item("● a")
  assert classify.is_list_item("◦ a")
  assert classify.is_list_item("▪ a")
  assert classify.is_list_item("- a")
}

pub fn numbered_marker_test() {
  assert classify.list_marker("1. First")
    == Some(#(classify.Ordered(1), "First"))
}

pub fn paren_numbered_marker_test() {
  assert classify.list_marker("(2) Second")
    == Some(#(classify.Ordered(2), "Second"))
}

pub fn trailing_paren_numbered_marker_test() {
  assert classify.list_marker("10) Tenth")
    == Some(#(classify.Ordered(10), "Tenth"))
}

pub fn decimal_is_not_a_list_item_test() {
  assert classify.list_marker("1.5 million in revenue") == None
}

/// Deliberate deviation from the Rust original, which treats any
/// letter-then-period as a marker and so fires on ordinary prose.
pub fn abbreviation_is_not_a_list_item_test() {
  assert classify.is_list_item("e.g. this is prose") == False
  assert classify.is_list_item("i.e. also prose") == False
}

pub fn marker_without_following_space_is_not_a_list_test() {
  assert classify.is_list_item("•NoSpace") == False
}

pub fn plain_text_is_not_a_list_item_test() {
  assert classify.is_list_item("Just a sentence.") == False
}

pub fn format_list_item_normalizes_bullets_test() {
  assert classify.format_list_item("●  Buy milk") == "- Buy milk"
}

pub fn format_list_item_normalizes_numbers_test() {
  assert classify.format_list_item("(3)  Third") == "3. Third"
}

pub fn format_list_item_leaves_prose_alone_test() {
  assert classify.format_list_item("Not a list") == "Not a list"
}
