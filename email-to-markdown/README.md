# email_to_markdown

Convert raw email HTML into clean, LLM-ready Markdown.

## Vendored into parcel

This is a standalone Gleam package kept here as source. The frontend imports
the compiled browser build through one module,
`frontend/src/emailMarkdown.ts`, and uses it at sync time to store a markdown
rendition of every html body — see `docs/caching.md`.

`dist/` is generated but **committed**, so building the app needs no Gleam
toolchain. After changing anything under `src/`, run `./build.sh` and commit
what it writes. It compiles to JavaScript, swaps the Node FFI (jsdom) for the
browser one (the host's own `DOMParser`), and copies the modules actually
reachable from the public entry into `dist/`.

Two things the app depends on, so keep them true:

- **The output is Markdown and is rendered as Markdown.** Never insert it as
  HTML. `renderEmailMarkdownToHtml` (frontend/src/markdown.ts) is the
  renderer, and `prepareBody` sanitizes what that produces.
- **`cid:` is on the scheme allowlist** (`emit.gleam`, `guard.gleam`) for
  inline attachments, which the client substitutes with local bytes on open.
  The rest of the allowlist — http, https, mailto, tel — must not grow.

```gleam
import email_to_markdown

let markdown = email_to_markdown.convert_string(raw_html)
```

Or through the branded types:

```gleam
raw_html
|> email_to_markdown.html
|> email_to_markdown.convert
|> email_to_markdown.to_string
```

`convert` is **total**. Malformed, hostile, or empty input yields empty
Markdown rather than an error.

## Setup

Node.js only. The one FFI call needs jsdom and DOMPurify:

```sh
npm install
gleam test
```

## Why this exists

Email HTML is the worst HTML in existence — nested layout tables 6–10 deep,
inline CSS everywhere, hidden preheader text, `<font>` tags. A naive
`turndown` pass produces garbage on it. This pipeline is built to destroy
layout and keep meaning.

```
Html
  │
  ├─[FFI, the only JavaScript]─► jsdom parse → DOMPurify → compact JSON tree
  ▼
  dom          decode the wire format
  visibility   drop invisible subtrees        ← prompt-injection defense
  normalize    unwrap layout, fold quotes
  emit         tree → Markdown
  postprocess  string cleanup
  ▼
Markdown
```

Everything after the JSON boundary is pure Gleam, so the whole pipeline is
testable from hand-written fixture data with no Node involved.

### The hidden-text defense

`visibility` is not cosmetic. DOMPurify passes `display:none` straight
through — invisible text is not malicious markup, it's just invisible — so
without this stage, hidden instructions land in the Markdown and from there
into whatever model consumes it. `test/fixtures/hidden_injection.html` pins
the behaviour.

### The one judgement call

Email uses `<table>` for layout far more often than for data, so something
has to decide. It's a single pure predicate, `table.is_data_table`, not a
classifier and not a routing layer. A table is data when it has a semantic
`role`, at least 2×2 cells, and either a `<th>` or a grid that looks tabular
(no nesting, no block-level cell content, no cell over 200 characters).
Everything else is unwrapped into ordinary blocks.

## Lineage

The structure is modelled on [pdf-inspector](https://github.com/firecrawl/pdf-inspector)
(vendored under `pdf-inspector/` for reference), which solves the same
last-mile problem for PDFs. Directly ported: the string cleanups in
`postprocess`, the compact table emission shape in `table`, and literal
list-marker recognition in `classify`.

Its PDF-only passes are deliberately absent — `fix_hyphenation` repairs
line-break artifacts, `remove_page_numbers` and `collapse_dot_leaders` strip
page furniture. None of that exists in email.

## Known limitations

- `<style>` blocks are not resolved; only inline `style` attributes are read.
  This matches how email is actually authored, since clients strip `<style>`.
- Body text is not escaped. Over-escaping ordinary prose costs more in
  readability than a stray emphasis marker costs in fidelity.
- MIME, quoted-printable, and charset decoding are the caller's job. The
  input is an HTML string, not a message.

## Development

```sh
gleam test                                    # unit + snapshot suite
gleam run -m birdie                           # review snapshot changes
gleam format --check src test
gleam run -m email_to_markdown/dev_cli -- test/fixtures/marketing_blast.html
```

The snapshot suite is the durable asset here. Conversion is heuristic, it
regresses silently, and you cannot eyeball a diff across a hundred emails.
Add real emails to `test/fixtures/` as you meet them.
