// One Zen, wired to happy-dom, shared by the dashboard and the screenshot
// tool. Both have to convert with exactly the same rules or their verdicts
// aren't about the same converter.

import { Effect, Layer, ManagedRuntime } from "effect";
import { Window } from "happy-dom";

import { Dom, type DomDocument, type ZenResult, Zen } from "@foldkit/zen";

const window = new Window({ url: "https://localhost" });

const happyDom = Dom.from(
  (html) =>
    new window.DOMParser().parseFromString(
      html,
      "text/html",
    ) as unknown as DomDocument,
);

const runtime = ManagedRuntime.make(Zen.layer.pipe(Layer.provide(happyDom)));

/** A conversion that throws on a real message is the most valuable thing these
 *  tools can find, so failure comes back as a value to look at rather than an
 *  exception that only shows up in a terminal. */
export const convert = (
  html: string,
): Promise<ZenResult | { readonly error: string }> =>
  runtime
    .runPromise(
      Effect.gen(function* () {
        const zen = yield* Zen;
        return yield* zen.convert(html);
      }),
    )
    .catch((cause: unknown) => ({ error: String(cause) }) as const);
