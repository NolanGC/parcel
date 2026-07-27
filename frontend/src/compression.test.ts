// Round-trip tests for the body codec. These run the real CompressionStream
// (Node provides it), so they exercise the same path the browser will.
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { Compression, CompressionError } from "./compression";

const withCompression = <A, E>(
  use: (service: Compression["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const compression = yield* Compression;
      return yield* use(compression);
    }).pipe(Effect.provide(Compression.layer)) as Effect.Effect<A, E>,
  );

// Representative of what actually gets stored: marketing HTML, which is what
// makes the ~6.5x ratio real. Repetitive by nature, hence the long run.
const htmlBody = `<!doctype html><html><body>${
  `<table role="presentation" style="width:100%;border-collapse:collapse">` +
  `<tr><td style="padding:12px;font-family:Helvetica,Arial,sans-serif">` +
  `Thanks for your order. Your package is on its way.</td></tr></table>`
    .repeat(40)
}</body></html>`;

describe("compression", () => {
  test("a compressed body round-trips to the original string", async () => {
    const result = await withCompression((compression) =>
      Effect.gen(function* () {
        const stored = yield* compression.compress(htmlBody);
        const restored = yield* compression.decompress(stored);
        return { stored, restored };
      }),
    );

    expect(result.restored).toBe(htmlBody);
    expect(result.stored.codec).toBe("gzip");
  });

  test("compressing actually shrinks a realistic html body", async () => {
    const stored = await withCompression((compression) =>
      compression.compress(htmlBody),
    );

    const raw = new TextEncoder().encode(htmlBody).byteLength;
    expect(stored.data.byteLength).toBeLessThan(raw / 2);
  });

  // Non-ASCII is the case a naive length-based codec gets wrong: the byte
  // count and the character count differ, so a round-trip that only looks
  // right for ASCII would pass without this.
  test("non-ascii survives the round trip intact", async () => {
    const body = "Grüße aus München — 日本語のテキスト — emoji 🎉🎉";

    const restored = await withCompression((compression) =>
      Effect.flatMap(compression.compress(body), compression.decompress),
    );

    expect(restored).toBe(body);
  });

  // Short bodies are stored as-is: gzip's header would make them bigger.
  test("a body under the floor is stored uncompressed but still reads back", async () => {
    const body = "thanks!";

    const result = await withCompression((compression) =>
      Effect.gen(function* () {
        const stored = yield* compression.compress(body);
        const restored = yield* compression.decompress(stored);
        return { stored, restored };
      }),
    );

    expect(result.stored.codec).toBe("none");
    expect(result.stored.data.byteLength).toBe(body.length);
    expect(result.restored).toBe(body);
  });

  // The migration carries pre-compression rows over as codec 'none' holding
  // the text's UTF-8 bytes. That path has to decode without a special case.
  test("legacy plaintext bytes decode through the same path", async () => {
    const body = "<p>written before compression existed</p>";

    const restored = await withCompression((compression) =>
      compression.decompress({
        codec: "none",
        data: new TextEncoder().encode(body),
      }),
    );

    expect(restored).toBe(body);
  });

  // Corruption has to surface as a failure rather than a crash or silent
  // garbage: the recovery is refetching the body, which needs an error to
  // react to. This is what makes FailedLoadThread reachable.
  test("bytes that don't match their codec fail rather than dying", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const compression = yield* Compression;
        return yield* compression.decompress({
          codec: "gzip",
          data: new Uint8Array([1, 2, 3, 4, 5]),
        });
      }).pipe(Effect.provide(Compression.layer), Effect.result),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.failure).toBeInstanceOf(CompressionError);
    }
  });
});
