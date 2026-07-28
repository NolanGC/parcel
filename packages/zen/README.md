# Zen

Email html, read as markdown.

Rendering a message today means handing an untrusted document to the browser
and then defending against it: a sandboxed iframe, a content policy, a fixed
height guessed in advance because the frame can't tell you its own. It works,
and it costs a document load and a layout per message opened. Markdown costs a
string.

The bet is that almost nothing a reader needs survives only in the html. A
newsletter's eight-deep nesting of layout tables is scaffolding for clients
that never got flexbox; the content is a heading, some paragraphs, a picture
and a button. Where the bet is wrong — a receipt whose columns carry the
meaning — the conversion keeps the table.

Measured over 1,500 random real messages from the local store: **no failures,
5.1× smaller, ~5ms each**, and the only empty results are messages whose source
is also blank.

## Chrome is not content

The judgment that matters most is the one markdown can't express. On screen a
16px reaction icon occupies 16px; converted naively it becomes a
paragraph-level image, and a LinkedIn digest turns into a column of enormous
disembodied thumbs-up icons with the writing scattered between them. The
information that made it bearable — how big it was — is exactly what markdown
throws away, so the decision has to be made during conversion or not at all.

Senders declare it, because email clients don't reliably support css sizing:
images carry `width`/`height` attributes and inline `style` dimensions. Reading
those, **9,025 of 17,418 images in a 1,500-message sample — 52% — turn out to
be furniture**: notification badges, reaction glyphs, avatars beside names
already written out, spacer strips. See `chrome.ts`; turn it off with
`dropChrome: false`.

The same file solves the opposite problem. Email uses
`background-image` + `background-size: cover` for anything that has to be
cropped, because it's the only cropping tool that works across clients — 24% of
messages do it. A converter that reads only `<img>` loses those pictures
silently.

## Using it

```ts
import { Dom, Zen } from "@foldkit/zen";

const program = Effect.gen(function* () {
  const zen = yield* Zen;
  return yield* zen.convert(html);
});

Effect.runPromise(program.pipe(Effect.provide(Zen.layer), Effect.provide(Dom.layer)));
```

`Dom.layer` uses the ambient `DOMParser`. Outside a browser, build one with
`Dom.from(parse)` — that indirection is why this package's only runtime
dependency is `effect`.

The result is not a bare string:

```ts
{ markdown, quotes, boilerplate, images, links }
```

`quotes` are line ranges into `markdown.split("\n")`, tagged with why they were
judged quoted (`gmail`, `cite`, `outlook`, `attribution`, `forward`,
`signature`). Nothing is removed — a consumer that ignores `quotes` still shows
the whole message; one that reads them can collapse a reply chain the way every
mail client does.

`renderMarkdown(markdown)` turns the output back into html. It accepts exactly
the dialect the serializer emits, so the two are inverses and a mistake in
either shows up as visibly wrong output rather than being quietly absorbed.

## Boilerplate is not the message

Even converted perfectly, a marketing mail is mostly not a message. Under the
offer sits the card issuer's disclosure, the state money-transmitter licences,
the MCC codes excluded from the promotion, the physical address, the
unsubscribe link — and sometimes a block of template text the sender forgot to
fill in. One real Venmo mail here runs forty-six lines and says what it came to
say in three of them.

`boilerplate` reports those as line ranges, on the same contract as `quotes`:
**nothing is deleted.** The terms are genuinely there, some of them are legally
required to be, and a reader who wants them is entitled to find them — so the
renderer folds, it doesn't discard. Across 1,500 real messages, 82% have an
administrative tail and 13.5% of all converted text sits inside a fold.

The bar is deliberately high, because the cost is asymmetric: folding a
paragraph of real content is a bug the reader sees instantly, while leaving a
paragraph of legalese unfolded is a bad afternoon for nobody. A footer only
counts as a footer if a message came before it — three lines of actual prose —
which is what stops a mail *about* your subscription from folding away its own
subject.

## Shape

| file | job |
| --- | --- |
| `preclean.ts` | what to throw away: trackers, hidden preheaders, style/script |
| `boilerplate.ts` | the legal tail and unfilled templates, as foldable ranges |
| `chrome.ts` | furniture vs content: icon sizing, and css background pictures |
| `tables.ts` | telling a real table apart from a page built out of tables |
| `convert.ts` | the walk: html into a tree of blocks and inlines |
| `serialize.ts` | the tree, written out as markdown — all syntax lives here |
| `quotes.ts` | finding the part of the message that isn't the message |
| `postprocess.ts` | tidying lines without moving anyone's line numbers |
| `render.ts` | the markdown, back to html |

## A known divergence

happy-dom throws on a handful of pathological documents that real browsers
accept — one message in ~4,000 hits
`insertBefore: The new node is a parent of the node to insert to`. Zen turns
that into a typed `ZenParseError` rather than a crash, and Chrome's own
`DOMParser` handles the same document without complaint, so it affects the
tests and the hillclimb dashboard, never the app.

## Improving it

See `packages/zen-hillclimb` — the dashboard that puts Zen's output next to the
real thing and records what it lost.
