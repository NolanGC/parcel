// happy-dom stays on this side of the wall: Zen itself never imports a DOM
// implementation, so tests (and the hillclimb server) hand it one.

import { Effect, Layer } from "effect";
import { Window } from "happy-dom";

import { Dom, type DomDocument, Zen, type ZenOptions } from "../src/index.ts";

const window = new Window({ url: "https://localhost" });

export const happyDom: Layer.Layer<Dom> = Dom.from(
  (html) =>
    new window.DOMParser().parseFromString(
      html,
      "text/html",
    ) as unknown as DomDocument,
);

const layer = Zen.layer.pipe(Layer.provide(happyDom));

export const convert = (
  html: string,
  options?: Partial<ZenOptions>,
): Promise<import("../src/index.ts").ZenResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const zen = yield* Zen;
      return yield* zen.convert(html, options);
    }).pipe(Effect.provide(layer)),
  );

/** The markdown alone, which is what most assertions are about. */
export const markdown = async (
  html: string,
  options?: Partial<ZenOptions>,
): Promise<string> => (await convert(html, options)).markdown;
