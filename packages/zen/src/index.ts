// Zen: email html, read as markdown.
//
// The problem this exists for is that rendering a message means handing an
// untrusted document to the browser and then defending against it — a
// sandboxed iframe, a content policy, a fixed height guessed in advance
// because the frame can't tell you its own. It works, and it costs a document
// load and a layout per message you open. Markdown costs a string.
//
// The bet is that almost nothing a reader needs survives only in the html. A
// newsletter's eight-deep nesting of layout tables is scaffolding for clients
// that never got flexbox; the content is a heading, some paragraphs, a picture
// and a button. Where that bet is wrong — a receipt whose columns carry the
// meaning — the conversion keeps the table. Where it's right, which is most of
// the mail most people get, what's left is the message.
//
// Pipeline: parse, then walk (convert.ts) into a tree of blocks, then write
// that tree out (serialize.ts), then tidy the lines without losing anyone's
// place (postprocess.ts). Quote chains are found in two passes because the
// evidence arrives in two forms (quotes.ts).

import { Context, Effect, Layer } from "effect";

import { detectBoilerplate } from "./boilerplate.ts";
import { convert } from "./convert.ts";
import { Dom } from "./dom.ts";
import { postprocess } from "./postprocess.ts";
import { revealDownlevelComments } from "./preclean.ts";
import { detectQuoteRegions } from "./quotes.ts";
import { serialize } from "./serialize.ts";
import {
  defaultOptions,
  type ZenOptions,
  type ZenParseError,
  type ZenResult,
} from "./types.ts";

export { type BoilerplateKind, BoilerplateRegion } from "./boilerplate.ts";
export { Dom, type DomDocument, type ParseHtml } from "./dom.ts";
export { renderMarkdown } from "./render.ts";
export {
  defaultOptions,
  type QuoteKind,
  QuoteRegion,
  type ZenImage,
  type ZenLink,
  type ZenOptions,
  ZenParseError,
  ZenResult,
} from "./types.ts";
export { ZEN_VERSION } from "./version.ts";

/** Adjacent blocks under the same quote signal are one region: the walker
 *  hands every block inside a `div.gmail_quote` the same mark object, so
 *  identity is exactly the grouping we want. */
const regionsFromSpans = (
  spans: ReturnType<typeof postprocess>["spans"],
): Array<{
  kind: (typeof spans)[number]["mark"]["kind"];
  startLine: number;
  endLine: number;
  attribution?: string;
}> =>
  spans
    .reduce<
      Array<{
        mark: (typeof spans)[number]["mark"];
        startLine: number;
        endLine: number;
      }>
    >((grouped, span) => {
      const last = grouped[grouped.length - 1];
      if (last !== undefined && last.mark === span.mark) {
        last.endLine = Math.max(last.endLine, span.endLine);
        return grouped;
      }
      grouped.push({
        mark: span.mark,
        startLine: span.startLine,
        endLine: span.endLine,
      });
      return grouped;
    }, [])
    .map((group) => ({
      kind: group.mark.kind,
      startLine: group.startLine,
      endLine: group.endLine,
      ...(group.mark.attribution === undefined
        ? {}
        : { attribution: group.mark.attribution }),
    }));

export class Zen extends Context.Service<Zen>()("parcel/Zen", {
  make: Effect.gen(function* () {
    const dom = yield* Dom;

    const convertHtml = (
      html: string,
      overrides?: Partial<ZenOptions>,
    ): Effect.Effect<ZenResult, ZenParseError> =>
      Effect.gen(function* () {
        const options: ZenOptions = { ...defaultOptions, ...overrides };
        const document = yield* dom.parse(revealDownlevelComments(html));
        const body = document.body;
        if (body === null) {
          return {
            markdown: "",
            quotes: [],
            boilerplate: [],
            images: [],
            links: [],
          };
        }

        const blocks = convert(body, options);
        const written = serialize(blocks, options);
        const tidied = postprocess(
          written.lines,
          written.spans,
          written.images,
          written.links,
        );

        const structural = regionsFromSpans(tidied.spans);
        const quotes = options.detectQuotes
          ? detectQuoteRegions(tidied.lines, structural)
          : structural;

        return {
          markdown: tidied.markdown,
          quotes,
          boilerplate: options.detectBoilerplate
            ? detectBoilerplate(tidied.lines)
            : [],
          images: tidied.images,
          links: tidied.links,
        };
      });

    return { convert: convertHtml } as const;
  }),
}) {
  static readonly layer: Layer.Layer<Zen, never, Dom> = Layer.effect(
    this,
    this.make,
  );
}
