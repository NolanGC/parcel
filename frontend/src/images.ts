// Remote images in mail bodies: finding them, fetching them through the
// proxy, and putting them back into the html as local blobs.
//
// Why a proxy at all: mail CDNs send no CORS headers, so the client can't
// read the bytes itself — it can only hand a url to an `<img>` and let the
// browser paint something it can never store. The API worker fetches on our
// behalf and returns the bytes same-origin, which is what makes caching
// possible in the first place.
//
// The privacy shape is mixed, and worth stating precisely. A remote image
// loaded live from an open mail is a tracking pixel firing at the moment you
// read: it tells the sender your IP, your user agent, and exactly when you
// looked. Fetched through the proxy instead, the sender sees a Cloudflare IP
// and learns nothing about when the mail was opened.
//
// But the images are prefetched in the background, across the whole hot
// window, for mail that has never been opened at all. That turns "no signal"
// into "delivered and opened" for every recent message — read receipts the
// sender would not otherwise have had. So open trackers are filtered out
// before anything is fetched: see isTrackerUrl and the tiny-image scan.

import { Array as Arr, Context, Effect, Layer, Option } from "effect";

import { ApiUrl } from "./config";

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

// Open-tracker endpoints, which are not images in any useful sense: they
// record a read and hand back a redirect, a transparent 1x1, or nothing at
// all. Requesting one during the background prefetch reports the message as
// opened, which is the thing we are trying not to do.
//
// Matched narrowly on the endpoint shapes the big senders use rather than on
// anything resembling a heuristic. A false positive here is cheap and a false
// negative is not: an image wrongly skipped simply loads from its origin when
// the mail is opened (see rewriteImageUrls), while a tracker wrongly fetched
// is a read receipt that cannot be taken back.
const TRACKER_PATTERNS: ReadonlyArray<RegExp> = [
  /\/wf\/open\b/i, // SendGrid, Sailthru
  /\/track(?:ing)?\/open/i, // Mailchimp and friends
  /\bopen\?upn=/i,
  /\/e\/o\//i, // Marketo
  /\/brand-views\b/i, // Glassdoor impression beacon
  /\/imp\?/i, // generic impression beacon
  /\bbeacon\b/i,
  // "pixel" only where a tracker puts it: its own path segment, a query key,
  // or the whole filename. A bare word match also caught real artwork named
  // pixel-grid-clip-path-shape.png, which is the kind of image the mail is
  // actually about.
  /\/pixel[/?.]/i,
  /[?&]pixel=/i,
  /\bpixel\.(?:gif|png|jpe?g)\b/i,
];

const isTrackerUrl = (url: string): boolean =>
  TRACKER_PATTERNS.some((pattern) => pattern.test(url));

// An image declared 1x1 (or near it) is a spacer or a beacon either way, and
// neither is worth a request. Read off the tag's own attributes because the
// bytes are exactly what we are trying to avoid fetching.
const IMG_TAG_PATTERN = /<img\b[^>]*>/gi;
const TAG_SRC_PATTERN = /\bsrc\s*=\s*["']([^"']+)["']/i;
const TRACKING_DIMENSION_PX = 2;

const declaredDimension = (tag: string, name: string): number | undefined => {
  const match = new RegExp(`\\b${name}\\s*[=:]\\s*["']?\\s*(\\d+)`, "i").exec(
    tag,
  );
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const isTrackingSized = (tag: string): boolean => {
  // Without the src stripped out first, a CDN url like
  // `/cdn-cgi/image/width=600,quality=90/photo.png` reads as the tag's own
  // declared width, and one spelling `width=1` would suppress a real image.
  const attributes = tag.replace(TAG_SRC_PATTERN, "");
  const width = declaredDimension(attributes, "width");
  const height = declaredDimension(attributes, "height");
  return (
    (width !== undefined && width <= TRACKING_DIMENSION_PX) ||
    (height !== undefined && height <= TRACKING_DIMENSION_PX)
  );
};

const decodeEntities = (url: string): string =>
  url.replaceAll("&amp;", "&").replaceAll("&#38;", "&");

// NOTE: Collected in its own pass because SRC_PATTERN matches bare attributes
// and so cannot see the width and height sitting next to them.
const trackingSizedUrls = (body: string): ReadonlySet<string> =>
  new Set(
    Arr.getSomes(
      Arr.map([...body.matchAll(IMG_TAG_PATTERN)], ([tag]) =>
        isTrackingSized(tag)
          ? Option.map(
              Option.flatMap(
                Option.fromNullishOr(TAG_SRC_PATTERN.exec(tag)),
                (match) => Arr.get(match, 1),
              ),
              (source) => decodeEntities(source.trim()),
            )
          : Option.none(),
      ),
    ),
  );

// NOTE: cid: is the inline-attachment path (message_attachments), data: is
// already local, and anything else non-http we have no way to fetch.
const isFetchableUrl = (url: string): boolean =>
  url.startsWith("http://") || url.startsWith("https://");

export const remoteImageUrls = (body: string): ReadonlyArray<string> => {
  const tiny = trackingSizedUrls(body);
  const candidates = Arr.getSomes(
    Arr.map([...body.matchAll(SRC_PATTERN)], (match) =>
      Option.map(Arr.get(match, 1), (raw) => decodeEntities(raw.trim())),
    ),
  );
  return Arr.take(
    Arr.dedupe(
      Arr.filter(
        candidates,
        (url) => isFetchableUrl(url) && !tiny.has(url) && !isTrackerUrl(url),
      ),
    ),
    MAX_IMAGES_PER_MESSAGE,
  );
};

/** Swap cached urls for local blob urls. Anything absent from `local` is left
 *  exactly as it was, so an uncached image still loads from its origin rather
 *  than turning into a broken image. */
export const rewriteImageUrls = (
  body: string,
  local: ReadonlyMap<string, string>,
): string =>
  Arr.reduce([...local], body, (rewritten, [url, blobUrl]) =>
    rewritten.replaceAll(url, blobUrl),
  );

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
    make: Effect.gen(function* () {
      const apiUrl = yield* ApiUrl;
      const fetchImage = (
        url: string,
      ): Effect.Effect<Option.Option<FetchedImage>> =>
        Effect.tryPromise(async () => {
          const response = await fetch(
            `${apiUrl}/api/proxy/image?url=${encodeURIComponent(url)}`,
            { credentials: "include" },
          );
          if (!response.ok) {
            return Option.none<FetchedImage>();
          }
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
  static readonly layer = Layer.effect(this, this.make);
}
