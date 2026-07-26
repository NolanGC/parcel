// Message bodies are ~91% of the local store and compress ~6.5x (they're
// mostly HTML), so message_bodies holds gzip bytes and decompresses on the
// way out — a millisecond or two per body, once per thread open. That ratio
// is what makes keeping every body affordable, which is what makes the whole
// mailbox readable offline. See docs/caching.md.
//
// Built on the browser-native CompressionStream: no library, and the work
// streams inside the platform rather than blocking on a JS implementation.

import { Context, Effect, Layer, Schema as S } from "effect";

/** Compression or decompression failed. For decompression this means the
 *  stored bytes don't match their codec — corruption, or a bug in whatever
 *  wrote the row — so the recovery is refetching the body, never retrying
 *  the decode. */
export class CompressionError extends S.TaggedErrorClass<CompressionError>()(
  "CompressionError",
  { message: S.String },
) {}

/** How a stored body is encoded. Persisted per row so every read is
 *  self-describing: plaintext written before compression existed, bodies too
 *  short to be worth compressing, and gzip all come back through one path. */
export const BodyCodec = S.Literals(["gzip", "none"]);
export type BodyCodec = typeof BodyCodec.Type;

export const CompressedBody = S.Struct({
  codec: BodyCodec,
  data: S.instanceOf(Uint8Array),
});
export type CompressedBody = typeof CompressedBody.Type;

// Below this, gzip's header and dictionary cost more than they save. Rare in
// practice — 92 of 22,057 bodies in the mailbox we measured — but it keeps
// short plain-text replies from growing.
const MIN_COMPRESS_BYTES = 512;

const through = (
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream,
): Promise<ArrayBuffer> =>
  new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer();

export class Compression extends Context.Service<Compression>()(
  "parcel/Compression",
  {
    make: Effect.sync(() => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, CompressionError> =>
        Effect.tryPromise(run).pipe(
          Effect.mapError(
            (cause) => new CompressionError({ message: String(cause) }),
          ),
        );

      const compress = (
        text: string,
      ): Effect.Effect<CompressedBody, CompressionError> => {
        const bytes = encoder.encode(text);
        return bytes.byteLength < MIN_COMPRESS_BYTES
          ? Effect.succeed({ codec: "none", data: bytes } satisfies CompressedBody)
          : attempt(() => through(bytes, new CompressionStream("gzip"))).pipe(
              Effect.map(
                (buffer): CompressedBody => ({
                  codec: "gzip",
                  data: new Uint8Array(buffer),
                }),
              ),
            );
      };

      const decompress = (
        body: CompressedBody,
      ): Effect.Effect<string, CompressionError> =>
        body.codec === "none"
          ? Effect.succeed(decoder.decode(body.data))
          : attempt(() =>
              through(body.data, new DecompressionStream("gzip")),
            ).pipe(Effect.map((buffer) => decoder.decode(buffer)));

      return { compress, decompress } as const;
    }),
  },
) {
  static readonly layer: Layer.Layer<Compression> = Layer.effect(
    this,
    this.make,
  );
}
