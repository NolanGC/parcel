import { Context, Effect, Layer, Schema as S } from "effect";

// Message bodies compress 5-10x (they're mostly HTML), and OPFS quota is
// a real constraint for a whole mailbox — so message_bodies.body holds
// gzip bytes, decompressed on the fly when a thread opens (~ms per body).
// Built on the browser-native CompressionStream, so no library and no
// main-thread blocking: the work streams inside the platform.

/** Compression or decompression failed — for decompression this usually
 * means the stored bytes don't match their codec (corruption or a codec
 * column bug), so the sane recovery is refetching the body, not retrying. */
export class CompressionError extends S.TaggedErrorClass<CompressionError>()(
  "CompressionError",
  { message: S.String },
) {}

/** How a stored body is encoded; persisted per row in
 * message_bodies.codec so every read is self-describing. */
export type BodyCodec = "gzip" | "none";

export interface CompressedBody {
  readonly codec: BodyCodec;
  readonly data: Uint8Array<ArrayBuffer>;
}

// Below this size gzip's header/dictionary overhead beats the savings —
// short plain-text replies stay uncompressed.
const MIN_COMPRESS_BYTES = 512;

const through = (
  bytes: Uint8Array<ArrayBuffer>,
  transform: {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<BufferSource>;
  },
): Promise<ArrayBuffer> =>
  new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer();

export class Compression extends Context.Service<Compression>()(
  "parcel/Compression",
  {
    make: Effect.sync(() => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const compress = (
        text: string,
      ): Effect.Effect<CompressedBody, CompressionError> => {
        const bytes = encoder.encode(text);
        if (bytes.byteLength < MIN_COMPRESS_BYTES) {
          return Effect.succeed({ codec: "none", data: bytes });
        }
        return Effect.tryPromise(() =>
          through(bytes, new CompressionStream("gzip")),
        ).pipe(
          Effect.map(
            (buffer): CompressedBody => ({
              codec: "gzip",
              data: new Uint8Array(buffer),
            }),
          ),
          Effect.mapError(
            (cause) => new CompressionError({ message: String(cause) }),
          ),
        );
      };

      const decompress = (
        body: CompressedBody,
      ): Effect.Effect<string, CompressionError> =>
        body.codec === "none"
          ? Effect.sync(() => decoder.decode(body.data))
          : Effect.tryPromise(() =>
              through(body.data, new DecompressionStream("gzip")),
            ).pipe(
              Effect.map((buffer) => decoder.decode(buffer)),
              Effect.mapError(
                (cause) => new CompressionError({ message: String(cause) }),
              ),
            );

      return { compress, decompress } as const;
    }),
  },
) {
  static readonly layer: Layer.Layer<Compression> = Layer.effect(
    this,
    this.make,
  );
}
