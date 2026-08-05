//// Development helper: convert an HTML file and print the Markdown.
////
//// ```sh
//// gleam run -m email_to_markdown/dev_cli -- test/fixtures/newsletter.html
//// ```
////
//// Eyeballing real emails is how the heuristics get tuned, so this exists to
//// make that loop cheap.

import argv
import email_to_markdown
import gleam/io
import simplifile

pub fn main() -> Nil {
  case argv.load().arguments {
    [path] -> convert_file(path)
    _ -> io.println("usage: dev_cli <path-to-html-file>")
  }
}

fn convert_file(path: String) -> Nil {
  case simplifile.read(path) {
    Ok(source) -> io.println(email_to_markdown.convert_string(source))
    Error(_) -> io.println("could not read " <> path)
  }
}
