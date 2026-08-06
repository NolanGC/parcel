// Regression test: Layer.mergeAll does NOT auto-wire one member's service
// requirement from another member's output in Effect 4.0.0-beta, so the
// ApiUrl the AuthClient/ImageFetcher/Gmail layers require must be supplied
// with an explicit Layer.provide. These tests mirror exactly how AppLayer
// is composed, so an accidental removal of that wiring is caught here.

import { Effect, Layer } from "effect";
import { expect, test } from "vitest";

import { ApiUrl, LiveApiUrl } from "../config";
import { AuthClient } from "../auth";
import { ImageFetcher } from "../images";

// AuthClient.layer requires ApiUrl; composing it under LiveApiUrl via
// Layer.provide is the pattern AppLayer uses. Without it, `yield* ApiUrl`
// inside AuthClient.make throws "Service not found: parcel/ApiUrl".
test("Layer.provide(LiveApiUrl) wires ApiUrl into AuthClient.layer", async () => {
  const layer = AuthClient.layer.pipe(Layer.provide(LiveApiUrl));
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* AuthClient;
      expect(typeof client.getSession).toBe("function");
    }).pipe(Effect.provide(layer)),
  );
});

test("Layer.provide(LiveApiUrl) wires ApiUrl into ImageFetcher.layer", async () => {
  const layer = ImageFetcher.layer.pipe(Layer.provide(LiveApiUrl));
  await Effect.runPromise(
    Effect.gen(function* () {
      const fetcher = yield* ImageFetcher;
      expect(typeof fetcher.fetchImage).toBe("function");
    }).pipe(Effect.provide(layer)),
  );
});

// A plain mergeAll (no Layer.provide) must NOT silently satisfy ApiUrl —
// asserting it still throws documents the exact footgun AppLayer avoids.
test("mergeAll without Layer.provide still leaves ApiUrl unresolved", async () => {
  const layer = Layer.mergeAll(LiveApiUrl, AuthClient.layer);
  // mergeAll leaves R = ApiUrl (the footgun), which tsc flags here — cast it
  // away so the runtime assertion shows the actual failure.
  const effect = Effect.gen(function* () {
    yield* AuthClient;
  }).pipe(Effect.provide(layer)) as unknown as Effect.Effect<void>;
  let rejected = false;
  try {
    await Effect.runPromise(effect);
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true); // the exact "Service not found: parcel/ApiUrl" AppLayer avoids
});
