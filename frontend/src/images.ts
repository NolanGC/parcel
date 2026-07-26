// Remote images in mail bodies: finding them, fetching them through the
// proxy, and putting them back into the html as local blobs.
//
// Why a proxy at all: mail CDNs send no CORS headers, so the client can't
// read the bytes itself — it can only hand a url to an `<img>` and let the
// browser paint something it can never store. The API worker fetches on our
// behalf and returns the bytes same-origin, which is what makes caching
// possible in the first place.
//
// The privacy shape falls out of that for free. A remote image loaded live
// from an open mail is a tracking pixel firing at the moment you read: it
// tells the sender your IP, your user agent, and precisely when you looked.
// Fetched here instead, the sender sees a Cloudflare IP at sync time and
// learns nothing about when — or whether — the mail was ever opened.

import { Context, Effect, Layer, Option } from "effect";

import { API_URL } from "./config";

// Images referenced by a mail body, in document order, deduplicated.
//
// Deliberately a regex and not a DOM parse: this runs over every body in the
// mailbox, and `DOMParser` on 22,000 documents averaging 50 KB is seconds of
// main thread. The cost of the shortcut is bounded — a missed url means one
// image is fetched live on open instead of served locally, never a broken
// render, because the rewrite below only substitutes urls it actually has.
const SRC_PATTERN = /(?:src|background)\s*=\s*["']([^"']+)["']/gi;

/** How many remote images we're willing to store for one message. Real mail
 *  averages ~13; the tail is tracking-pixel farms and image-sliced newsletter
 *  layouts, where the hundredth image is not what makes the mail readable. */
const MAX_IMAGES_PER_MESSAGE = 60;

const decodeEntities = (url: string): string =>
  url.replaceAll("&amp;", "&").replaceAll("&#38;", "&");

export const remoteImageUrls = (body: string): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const match of body.matchAll(SRC_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const url = decodeEntities(raw.trim());
    // cid: is the inline-attachment path (message_attachments), data: is
    // already local, and anything else non-http we have no way to fetch.
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    found.add(url);
    if (found.size >= MAX_IMAGES_PER_MESSAGE) break;
  }
  return [...found];
};

/** Swap cached urls for local blob urls. Anything absent from `local` is
 *  left exactly as it was, so an uncached image still loads from its origin
 *  rather than turning into a broken image. */
export const rewriteImageUrls = (
  body: string,
  local: ReadonlyMap<string, string>,
): string => {
  let rewritten = body;
  for (const [url, blobUrl] of local) {
    rewritten = rewritten.replaceAll(url, blobUrl);
  }
  return rewritten;
};

export type FetchedImage = Readonly<{
  mimeType: string;
  bytes: Uint8Array;
}>;

/** Bytes we refuse to keep for one image. Past this it is a hero banner or a
 *  mis-served video, and the store is the thing we're protecting. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Concurrent proxy requests. The ceiling is the browser's own per-origin
 *  connection pool, not the worker — going above it just queues in the tab
 *  while starving every other request the app wants to make. */
export const IMAGE_CONCURRENCY = 6;

// Fetching one image cannot fail: a mail CDN that 404s, a tracking pixel
// whose campaign ended, a url that was never an image. All of it is normal
// and none of it should cost the thread — or the pass — anything. `None`
// means "no bytes worth storing", and the html keeps its original url.
export class ImageFetcher extends Context.Service<ImageFetcher>()(
  "parcel/ImageFetcher",
  {
    make: Effect.sync(() => {
      const fetchImage = (
        url: string,
      ): Effect.Effect<Option.Option<FetchedImage>> =>
        Effect.tryPromise(async () => {
          const response = await fetch(
            `${API_URL}/api/proxy/image?url=${encodeURIComponent(url)}`,
            { credentials: "include" },
          );
          if (!response.ok) return Option.none<FetchedImage>();
          const mimeType = response.headers.get("content-type") ?? "image/png";
          const buffer = await response.arrayBuffer();
          return buffer.byteLength > MAX_IMAGE_BYTES
            ? Option.none<FetchedImage>()
            : Option.some<FetchedImage>({
                mimeType,
                bytes: new Uint8Array(buffer),
              });
        }).pipe(Effect.catchCause(() => Effect.succeed(Option.none())));

      return { fetchImage } as const;
    }),
  },
) {
  static readonly layer: Layer.Layer<ImageFetcher> = Layer.effect(
    this,
    this.make,
  );
}
