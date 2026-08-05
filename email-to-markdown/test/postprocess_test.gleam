import email_to_markdown/postprocess

pub fn collapse_consecutive_spaces_test() {
  assert postprocess.collapse_consecutive_spaces("a  b   c") == "a b c"
}

pub fn collapse_consecutive_spaces_preserves_indent_test() {
  assert postprocess.collapse_consecutive_spaces("    a  b") == "    a b"
}

pub fn remove_spaces_before_closing_brackets_test() {
  assert postprocess.remove_spaces_before_closing_brackets("[kg/m3 ]")
    == "[kg/m3]"
}

pub fn remove_space_before_period_test() {
  assert postprocess.remove_spaces_before_sentence_punctuation("word . Next")
    == "word. Next"
}

pub fn remove_space_before_pipe_token_end_test() {
  assert postprocess.remove_spaces_before_sentence_punctuation("|cell .|next|")
    == "|cell.|next|"
}

pub fn ellipsis_survives_punctuation_pass_test() {
  assert postprocess.remove_spaces_before_sentence_punctuation("wait ... more")
    == "wait ... more"
}

pub fn decimal_survives_punctuation_pass_test() {
  assert postprocess.remove_spaces_before_sentence_punctuation("3 .14")
    == "3 .14"
}

pub fn collapse_blank_lines_test() {
  assert postprocess.collapse_blank_lines("a\n\n\n\n\nb") == "a\n\nb"
}

// ── URL linking ──────────────────────────────────────────────────────

pub fn format_bare_url_test() {
  assert postprocess.format_urls("see https://x.com/a now")
    == "see [https://x.com/a](https://x.com/a) now"
}

pub fn format_url_trailing_period_stays_outside_link_test() {
  assert postprocess.format_urls("go to https://x.com.")
    == "go to [https://x.com](https://x.com)."
}

pub fn existing_markdown_link_is_not_rewrapped_test() {
  let input = "[click](https://x.com/a)"

  assert postprocess.format_urls(input) == input
}

pub fn url_inside_link_text_is_not_wrapped_test() {
  let input = "[https://x.com](https://x.com)"

  assert postprocess.format_urls(input) == input
}

pub fn non_scheme_http_word_is_left_alone_test() {
  assert postprocess.format_urls("the http protocol") == "the http protocol"
}

pub fn multiple_urls_test() {
  assert postprocess.format_urls("a https://x.com b https://y.com c")
    == "a [https://x.com](https://x.com) b [https://y.com](https://y.com) c"
}

// ── Full chain ───────────────────────────────────────────────────────

pub fn run_trims_and_terminates_with_newline_test() {
  assert postprocess.run("\n\n  hello  world  \n\n\n\n") == "hello world\n"
}

pub fn run_on_empty_input_test() {
  assert postprocess.run("   \n\n  ") == ""
}
