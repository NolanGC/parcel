// The SyncEngine: orchestrates the Gmail transport and the local SQLite
// store. Provided to the Foldkit runtime via `resources` in entry.ts, so
// commands returned from init/update (and subscriptions) can yield it.
//
// The contract with the UI is local-first: reads (loadInbox, loadThread)
// only touch SQLite; the network runs once at sync time, which pulls
// everything a thread needs to *display* — headers, the best body part
// (compressed), and inline images — so opening mail after a sync is
// instant and offline-safe.

import { Context, Effect, Layer, Schema as S } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { Compression, type CompressionError } from "./compression";
import { API_URL } from "./config";
import {
  Gmail,
  LabelId,
  MessageId,
  ThreadId,
  type GmailError,
  type Message as GmailMessage,
  type MessagePart,
  type Thread as GmailThread,
} from "./Gmail";
import { SqlLive } from "./sql";

// How much of a thread the sync pass caches locally:
//   "text"        — headers + the displayable body only
//   "attachments" — + inline cid: images (Gmail attachment parts)
//   "full"        — + remote html assets (<img src="https://...">),
//                   fetched once through the API image proxy and stored
//                   like any other blob, so rendering a thread touches no
//                   third-party server (tracking pixels included).
export const CacheTier = S.Literals(["text", "attachments", "full"]);
export type CacheTier = typeof CacheTier.Type;

// Hardcoded to the deepest tier for now: we only pull PULL_LIMIT (15)
// threads, so caching everything locally is cheap. How tiers get assigned
// (per-category, per-sender, a setting) is a decision for later.
export const CACHE_TIER: CacheTier = "full";

// Gmail's inbox tab categories, as they appear in system label ids
// (CATEGORY_PERSONAL etc.). "none" = the message carries no category
// label (common for mail that skipped the inbox).
export const ThreadCategory = S.Literals([
  "personal",
  "promotions",
  "social",
  "updates",
  "forums",
  "none",
]);
export type ThreadCategory = typeof ThreadCategory.Type;

// One inbox list row — everything the list view paints, nothing more.
// `date` is epoch milliseconds; `unread` is real (derived from the UNREAD
// system label on the thread's messages).
export const ThreadRow = S.Struct({
  id: ThreadId,
  subject: S.String,
  sender: S.String,
  snippet: S.String,
  date: S.Number,
  unread: S.Boolean,
  category: ThreadCategory,
});
export type ThreadRow = typeof ThreadRow.Type;

// The open-thread payload: bodies arrive decompressed with inline images
// already rewritten to blob: urls over locally stored bytes, so the view
// renders them with zero further work (and zero network).
export const BodyKind = S.Literals(["html", "plain"]);
export type BodyKind = typeof BodyKind.Type;

export const MessageDetail = S.Struct({
  id: MessageId,
  fromName: S.String,
  fromEmail: S.String,
  date: S.Number,
  bodyKind: BodyKind,
  body: S.String,
});
export type MessageDetail = typeof MessageDetail.Type;

export const ThreadDetail = S.Struct({
  id: ThreadId,
  subject: S.String,
  messages: S.Array(MessageDetail),
});
export type ThreadDetail = typeof ThreadDetail.Type;

// What the SELECTs below return; decoded then mapped onto the exported
// shapes. A mismatch is a bug in our own schema/DDL pair, hence orDie at
// the call sites.
const DbThreadRow = S.Struct({
  id: ThreadId,
  subject: S.String,
  snippet: S.String,
  participants: S.String,
  latest_date: S.Number,
  is_unread: S.Number,
  category: ThreadCategory,
});
const decodeDbRows = S.decodeUnknownEffect(S.Array(DbThreadRow));

const DbMessageRow = S.Struct({
  id: MessageId,
  internal_date: S.Number,
  from_name: S.String,
  from_email: S.String,
});
const decodeDbMessages = S.decodeUnknownEffect(S.Array(DbMessageRow));

const DbBodyRow = S.Struct({
  message_id: MessageId,
  mime_type: S.String,
  codec: S.Literals(["gzip", "none"]),
  body: S.instanceOf(Uint8Array),
});
const decodeDbBodies = S.decodeUnknownEffect(S.Array(DbBodyRow));

const DbImageRow = S.Struct({
  message_id: MessageId,
  content_id: S.String,
  mime_type: S.String,
  bytes: S.instanceOf(Uint8Array),
});
const decodeDbImages = S.decodeUnknownEffect(S.Array(DbImageRow));

const DbRemoteAssetRow = S.Struct({
  message_id: MessageId,
  url: S.String,
  mime_type: S.String,
  bytes: S.instanceOf(Uint8Array),
});
const decodeDbRemoteAssets = S.decodeUnknownEffect(S.Array(DbRemoteAssetRow));

const DbRemoteAssetKey = S.Struct({ message_id: MessageId, url: S.String });
const decodeDbRemoteAssetKeys = S.decodeUnknownEffect(
  S.Array(DbRemoteAssetKey),
);

const DbFailedUrlRow = S.Struct({ url: S.String });
const decodeDbFailedUrls = S.decodeUnknownEffect(S.Array(DbFailedUrlRow));

const DbSubjectRow = S.Struct({ subject: S.String });
const decodeDbSubjects = S.decodeUnknownEffect(S.Array(DbSubjectRow));

const DbThreadIdRow = S.Struct({ id: ThreadId });
const decodeDbThreadIds = S.decodeUnknownEffect(S.Array(DbThreadIdRow));

// BASE64URL (Gmail body payloads use the -/_ alphabet, not btoa's +//)

const base64UrlToBytes = (data: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const utf8 = new TextDecoder();

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// All needle→replacement swaps in ONE pass over the html. The naive
// per-asset replaceAll reduce copies the entire body string once per
// asset — on a multi-MB marketing email that's the difference between one
// allocation and dozens.
const rewriteAll = (
  text: string,
  replacements: ReadonlyMap<string, string>,
): string => {
  if (replacements.size === 0) return text;
  const pattern = new RegExp(
    [...replacements.keys()].map(escapeRegExp).join("|"),
    "g",
  );
  return text.replace(pattern, (match) => replacements.get(match) ?? match);
};

// Obvious impression beacons are skipped before any fetch: impression
// endpoints and explicit NxN pixel-size params. Deliberately conservative
// — a real photo url wrongly skipped just renders broken, but the common
// patterns are unmistakable.
const looksLikeTrackerPixel = (url: string): boolean =>
  /\/imp\?|[?&]sz=\d+x\d+/.test(url);

// MIME TREE WALKING (runs once at sync time; the database stores results)

const headerValue = (message: GmailMessage, name: string): string | undefined =>
  message.payload?.headers?.find((header) => header.name.toLowerCase() === name)
    ?.value;

const partHeader = (part: MessagePart, name: string): string | undefined =>
  part.headers?.find((header) => header.name.toLowerCase() === name)?.value;

const flattenParts = (part: MessagePart): ReadonlyArray<MessagePart> => [
  part,
  ...(part.parts ?? []).flatMap(flattenParts),
];

// The displayable body: prefer text/html (multipart/alternative always
// pairs it with a plain twin), fall back to text/plain.
const displayPart = (message: GmailMessage): MessagePart | undefined => {
  if (message.payload === undefined) return undefined;
  const parts = flattenParts(message.payload);
  return (
    parts.find((p) => p.mimeType === "text/html" && p.body?.data) ??
    parts.find((p) => p.mimeType === "text/plain" && p.body?.data)
  );
};

// Inline images: image parts carrying a Content-ID, referenced from the
// html as `cid:<id>`. The stored content_id drops the RFC angle brackets.
type InlineImage = {
  readonly contentId: string;
  readonly mimeType: string;
  readonly part: MessagePart;
};

const inlineImages = (message: GmailMessage): ReadonlyArray<InlineImage> => {
  if (message.payload === undefined) return [];
  return flattenParts(message.payload).flatMap((part) => {
    const contentId = partHeader(part, "content-id");
    if (
      contentId === undefined ||
      part.mimeType === undefined ||
      !part.mimeType.startsWith("image/")
    ) {
      return [];
    }
    return [
      {
        contentId: contentId.replace(/^</, "").replace(/>$/, ""),
        mimeType: part.mimeType,
        part,
      },
    ];
  });
};

// Remote images referenced by the html body (plain src="https://..."
// attributes). Matched raw, exactly as written in the html — the raw
// string is both the storage key and the replaceAll needle at read time;
// only the wire fetch entity-decodes it (&amp; → &).
const REMOTE_IMG_SRC =
  /<img\b[^>]*?\bsrc\s*=\s*(?:"(https?:\/\/[^"]+)"|'(https?:\/\/[^']+)'|(https?:\/\/[^\s>"']+))/gi;

const remoteImageUrls = (html: string): ReadonlyArray<string> => {
  const urls = new Set<string>();
  for (const match of html.matchAll(REMOTE_IMG_SRC)) {
    const url = match[1] ?? match[2] ?? match[3];
    if (url !== undefined) urls.add(url);
  }
  return [...urls];
};

// A transparent 1x1 GIF. Un-cached remote images rewrite to this at render
// time so the html handed to the frame carries no live network URL — the
// render reads only what SQLite holds; a missing image is an absence, never a
// fetch. (The frame CSP stays as defense-in-depth, not the guard.)
const PLACEHOLDER_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

// One remote asset through the API image proxy (mail CDNs don't serve
// CORS, so the client can't read their bytes directly). Failures yield
// undefined and the asset is simply skipped: at the full tier the frame
// CSP blocks its live load too, so a skipped asset renders as a broken
// image rather than a tracking beacon.
const fetchRemoteAsset = (url: string) =>
  Effect.tryPromise(async () => {
    const response = await fetch(
      `${API_URL}/api/proxy/image?url=${encodeURIComponent(url.replaceAll("&amp;", "&"))}`,
      { credentials: "include" },
    );
    if (!response.ok) return undefined;
    return {
      mimeType:
        response.headers.get("content-type") ?? "application/octet-stream",
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

// `"Ada Lovelace" <ada@example.com>` → { name: "Ada Lovelace",
// email: "ada@example.com" }; bare addresses use the address as both.
const parseFrom = (from: string): { name: string; email: string } => {
  const email = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const beforeAngle = from.split("<")[0]?.trim() ?? "";
  const unquoted = beforeAngle.replace(/^"(.*)"$/, "$1").trim();
  return { name: unquoted === "" ? email : unquoted, email };
};

const UNREAD_LABEL = "UNREAD";
const CATEGORY_PREFIX = "CATEGORY_";

const threadCategory = (
  messages: ReadonlyArray<GmailMessage>,
): ThreadCategory => {
  for (const message of messages) {
    const label = message.labelIds?.find((id) =>
      id.startsWith(CATEGORY_PREFIX),
    );
    if (label !== undefined) {
      const category = label.slice(CATEGORY_PREFIX.length).toLowerCase();
      const decoded = S.decodeUnknownOption(ThreadCategory)(category);
      if (decoded._tag === "Some") return decoded.value;
    }
  }
  return "none";
};

const latestDate = (messages: ReadonlyArray<GmailMessage>): number =>
  messages.reduce((max, message) => {
    const date = Number(message.internalDate ?? "0");
    return Number.isFinite(date) && date > max ? date : max;
  }, 0);

// SERVICE

const INBOX = LabelId.make("INBOX");
const PULL_LIMIT = 15;

export class SyncEngine extends Context.Service<SyncEngine>()(
  "parcel/SyncEngine",
  {
    make: Effect.gen(function* () {
      const gmail = yield* Gmail;
      const sql = yield* SqlClient.SqlClient;
      const compression = yield* Compression;

      const upsertThread = (thread: GmailThread) => {
        const messages = thread.messages ?? [];
        const latest = messages[messages.length - 1];
        return sql`INSERT OR REPLACE INTO threads ${sql.insert([
          {
            id: thread.id,
            history_id: thread.historyId ?? null,
            subject:
              latest === undefined
                ? ""
                : (headerValue(latest, "subject") ?? ""),
            snippet: thread.snippet ?? latest?.snippet ?? "",
            participants: JSON.stringify(
              latest === undefined
                ? []
                : [parseFrom(headerValue(latest, "from") ?? "").name],
            ),
            latest_date: latestDate(messages),
            message_count: messages.length,
            is_unread: messages.some((message) =>
              message.labelIds?.some((id) => id === UNREAD_LABEL),
            )
              ? 1
              : 0,
            category: threadCategory(messages),
          },
        ])}`;
      };

      const upsertMessage = (threadId: ThreadId, message: GmailMessage) => {
        const from = parseFrom(headerValue(message, "from") ?? "");
        return sql`INSERT OR REPLACE INTO messages ${sql.insert([
          {
            id: message.id,
            thread_id: threadId,
            internal_date: Number(message.internalDate ?? "0"),
            from_name: from.name,
            from_email: from.email,
            to_json: JSON.stringify(headerValue(message, "to") ?? ""),
            subject: headerValue(message, "subject") ?? "",
            snippet: message.snippet ?? "",
            has_attachments: (message.payload?.parts ?? []).some(
              (part) => (part.filename ?? "") !== "",
            )
              ? 1
              : 0,
          },
        ])}`;
      };

      // The message's displayable part, base64url-decoded then compressed
      // per the Compression service (codec column keeps each row
      // self-describing).
      const upsertBody = (message: GmailMessage) =>
        Effect.gen(function* () {
          const part = displayPart(message);
          const data = part?.body?.data;
          if (part === undefined || data === undefined) return;
          const text = utf8.decode(base64UrlToBytes(data));
          const compressed = yield* compression.compress(text);
          yield* sql`INSERT OR REPLACE INTO message_bodies ${sql.insert([
            {
              message_id: message.id,
              mime_type: part.mimeType ?? "text/plain",
              codec: compressed.codec,
              body: compressed.data,
            },
          ])}`;
        });

      // Inline image bytes: small ones ride along in the payload, larger
      // ones need the attachments endpoint. Either way they land locally
      // at sync time so the open path never fetches. Stored raw — image
      // formats are already compressed.
      const upsertInlineImages = (message: GmailMessage) =>
        Effect.forEach(
          inlineImages(message),
          (image) =>
            Effect.gen(function* () {
              const inline = image.part.body?.data;
              const attachmentId = image.part.body?.attachmentId;
              const data =
                inline ??
                (attachmentId === undefined
                  ? undefined
                  : (yield* gmail.getAttachment(message.id, attachmentId))
                      .data);
              if (data === undefined) return;
              yield* sql`INSERT OR REPLACE INTO message_attachments ${sql.insert(
                [
                  {
                    message_id: message.id,
                    content_id: image.contentId,
                    mime_type: image.mimeType,
                    bytes: base64UrlToBytes(data),
                  },
                ],
              )}`;
            }),
          { concurrency: 2 },
        );

      // Every url in remote_asset_failures — the "don't retry" set shared
      // by the sync-time upsert and the backfill.
      const failedUrls = Effect.gen(function* () {
        const raw = yield* sql`SELECT url FROM remote_asset_failures`;
        return new Set(
          (yield* decodeDbFailedUrls(raw).pipe(Effect.orDie)).map(
            (row) => row.url,
          ),
        );
      });

      // One remote asset: fetch through the proxy, store on success,
      // negative-cache on failure so the url is never attempted again.
      const fetchAndStoreAsset = (messageId: MessageId, url: string) =>
        Effect.gen(function* () {
          const fetched = yield* fetchRemoteAsset(url);
          if (fetched === undefined) {
            yield* sql`INSERT OR REPLACE INTO remote_asset_failures ${sql.insert(
              [{ url, failed_at: Date.now() }],
            )}`;
            return;
          }
          yield* sql`INSERT OR REPLACE INTO remote_assets ${sql.insert([
            {
              message_id: messageId,
              url,
              mime_type: fetched.mimeType,
              bytes: fetched.bytes,
            },
          ])}`;
        });

      // Remote html assets, fetched through the API proxy and stored like
      // inline images. Idempotent per (message, url); already-stored,
      // already-failed, and obvious-tracker urls are all skipped.
      const upsertRemoteAssets = (message: GmailMessage) =>
        Effect.gen(function* () {
          const part = displayPart(message);
          const data = part?.body?.data;
          if (part?.mimeType !== "text/html" || data === undefined) return;
          const urls = remoteImageUrls(
            utf8.decode(base64UrlToBytes(data)),
          ).filter((url) => !looksLikeTrackerPixel(url));
          if (urls.length === 0) return;

          const storedRaw = yield* sql`
            SELECT message_id, url FROM remote_assets
            WHERE message_id = ${message.id}
          `;
          const stored = new Set(
            (yield* decodeDbRemoteAssetKeys(storedRaw).pipe(Effect.orDie)).map(
              (row) => row.url,
            ),
          );
          const failed = yield* failedUrls;

          yield* Effect.forEach(
            urls.filter((url) => !stored.has(url) && !failed.has(url)),
            (url) => fetchAndStoreAsset(message.id, url),
            { concurrency: 4 },
          );
        });

      const syncThread = (id: ThreadId) =>
        Effect.gen(function* () {
          const thread = yield* gmail.getThread(id, "full");
          yield* upsertThread(thread);
          yield* Effect.forEach(thread.messages ?? [], (message) =>
            Effect.all([
              upsertMessage(thread.id, message),
              upsertBody(message),
              ...((CACHE_TIER as CacheTier) === "text"
                ? []
                : [upsertInlineImages(message)]),
              ...((CACHE_TIER as CacheTier) === "full"
                ? [upsertRemoteAssets(message)]
                : []),
            ]),
          );
        });

      // The network pass: one page of inbox threads, fetched in full
      // format and persisted with everything the UI needs to display them.
      const syncInbox = Effect.gen(function* () {
        const page = yield* gmail.listThreads({
          labelIds: [INBOX],
          maxResults: PULL_LIMIT,
        });
        yield* Effect.forEach(
          page.threads ?? [],
          (stub) => syncThread(stub.id),
          { concurrency: 4 },
        );
      });

      const selectInbox = Effect.gen(function* () {
        const raw = yield* sql`
          SELECT id, subject, snippet, participants, latest_date, is_unread, category
          FROM threads
          ORDER BY latest_date DESC
          LIMIT ${PULL_LIMIT}
        `;
        const rows = yield* decodeDbRows(raw).pipe(Effect.orDie);
        return rows.map(
          (row): ThreadRow => ({
            id: row.id,
            subject: row.subject,
            sender: (JSON.parse(row.participants) as string[])[0] ?? "",
            snippet: row.snippet,
            date: row.latest_date,
            unread: row.is_unread !== 0,
            category: row.category,
          }),
        );
      });

      // Local-first read: a synced store answers straight from SQLite (a
      // page refresh renders with zero network); only an empty store
      // triggers the sync pass first.
      const loadInbox = Effect.gen(function* () {
        const local = yield* selectInbox;
        if (local.length > 0) return local;
        yield* syncInbox;
        return yield* selectInbox;
      });

      // Background hydration: threads whose messages were never pulled
      // (rows from a metadata-only sync, or stubs) get their full content
      // now, so first opens hit SQLite instead of the network. Runs after
      // the list has painted — it must never delay the initial render.
      // Stores synced before the full tier existed have html bodies but no
      // remote_assets rows — syncThread never re-runs for them (local-first
      // reads skip the network once rows exist), so the backfill walks the
      // stored bodies directly. Idempotent: already-fetched urls are
      // skipped, so steady-state runs do no network at all.
      const backfillRemoteAssets = Effect.gen(function* () {
        if ((CACHE_TIER as CacheTier) !== "full") return;
        const bodiesRaw = yield* sql`
          SELECT message_id, mime_type, codec, body
          FROM message_bodies
          WHERE mime_type = 'text/html'
        `;
        const bodies = yield* decodeDbBodies(bodiesRaw).pipe(Effect.orDie);
        const storedRaw = yield* sql`SELECT message_id, url FROM remote_assets`;
        const stored = new Set(
          (yield* decodeDbRemoteAssetKeys(storedRaw).pipe(Effect.orDie)).map(
            (row) => `${row.message_id}\n${row.url}`,
          ),
        );
        const failed = yield* failedUrls;

        yield* Effect.forEach(
          bodies,
          (row) =>
            Effect.gen(function* () {
              const html = yield* compression.decompress({
                codec: row.codec,
                data: new Uint8Array(row.body),
              });
              yield* Effect.forEach(
                remoteImageUrls(html).filter(
                  (url) =>
                    !looksLikeTrackerPixel(url) &&
                    !failed.has(url) &&
                    !stored.has(`${row.message_id}\n${url}`),
                ),
                (url) => fetchAndStoreAsset(row.message_id, url),
                { concurrency: 4 },
              );
            }),
          { concurrency: 2 },
        );
      });

      const hydrateMissing = Effect.gen(function* () {
        const raw = yield* sql`
          SELECT t.id AS id
          FROM threads t
          LEFT JOIN messages m ON m.thread_id = t.id
          WHERE m.id IS NULL
          ORDER BY t.latest_date DESC
          LIMIT ${PULL_LIMIT}
        `;
        const rows = yield* decodeDbThreadIds(raw).pipe(Effect.orDie);
        yield* Effect.forEach(rows, (row) => syncThread(row.id), {
          concurrency: 3,
        });
        yield* backfillRemoteAssets;
        return yield* selectInbox;
      });

      const selectThreadMessages = (id: ThreadId) =>
        Effect.gen(function* () {
          const messagesRaw = yield* sql`
            SELECT id, internal_date, from_name, from_email
            FROM messages
            WHERE thread_id = ${id}
            ORDER BY internal_date ASC
          `;
          return yield* decodeDbMessages(messagesRaw).pipe(Effect.orDie);
        });

      // Local image bytes reach the html as short-lived blob: urls, not
      // base64 data: URIs — inlining megabytes of base64 into the body
      // string was measurably janky (main-thread encode + a giant srcdoc
      // for the vdom) and could OOM the tab. Each thread's urls are
      // revoked on its next load; at most PULL_LIMIT threads' worth stays
      // registered, and the bytes live in SQLite either way.
      const threadObjectUrls = new Map<ThreadId, Array<string>>();
      const registerObjectUrl = (
        registry: Array<string>,
        mimeType: string,
        bytes: Uint8Array,
      ): string => {
        const url = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
        );
        registry.push(url);
        return url;
      };

      // Opening a thread: normally SQLite only. A thread with no local
      // messages (a store synced before bodies were pulled, or a row that
      // arrived without its content) self-heals with one network fetch,
      // then reads back from the database like every other open.
      const loadThread = (id: ThreadId) =>
        Effect.gen(function* () {
          const subjectRaw = yield* sql`
            SELECT subject FROM threads WHERE id = ${id}
          `;
          const subject =
            (yield* decodeDbSubjects(subjectRaw).pipe(Effect.orDie))[0]
              ?.subject ?? "";

          const local = yield* selectThreadMessages(id);
          const rows =
            local.length > 0
              ? local
              : yield* syncThread(id).pipe(
                  Effect.andThen(selectThreadMessages(id)),
                );

          // One query per table for the whole thread (not two per
          // message): every worker round trip is a postMessage hop, so a
          // six-message thread is 2 statements instead of 12.
          const ids = rows.map((row) => row.id);
          const bodiesRaw =
            ids.length === 0
              ? []
              : yield* sql`
                  SELECT message_id, mime_type, codec, body
                  FROM message_bodies
                  WHERE ${sql.in("message_id", ids)}
                `;
          const bodyByMessage = new Map(
            (yield* decodeDbBodies(bodiesRaw).pipe(Effect.orDie)).map(
              (body) => [body.message_id, body] as const,
            ),
          );
          const imagesRaw =
            ids.length === 0
              ? []
              : yield* sql`
                  SELECT message_id, content_id, mime_type, bytes
                  FROM message_attachments
                  WHERE ${sql.in("message_id", ids)}
                `;
          const allImages = yield* decodeDbImages(imagesRaw).pipe(Effect.orDie);
          const remoteRaw =
            ids.length === 0
              ? []
              : yield* sql`
                  SELECT message_id, url, mime_type, bytes
                  FROM remote_assets
                  WHERE ${sql.in("message_id", ids)}
                `;
          const allRemote = yield* decodeDbRemoteAssets(remoteRaw).pipe(
            Effect.orDie,
          );

          // This load owns the thread's object urls from here on: the
          // previous load's urls (if any) are stale — nothing displayed
          // still references them, since a thread re-load only happens
          // after its old detail left the model.
          for (const url of threadObjectUrls.get(id) ?? []) {
            URL.revokeObjectURL(url);
          }
          const objectUrls: Array<string> = [];
          threadObjectUrls.set(id, objectUrls);

          // Full tier caches everything and the frame blocks the network, so
          // the render is hermetic (cached → blob:, un-cached → placeholder).
          // Lower tiers cache nothing and deliberately let remote images load
          // live, so there un-cached urls stay as written.
          const isFullTier = (CACHE_TIER as CacheTier) === "full";

          const messages = yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const stored = bodyByMessage.get(row.id);
              const text =
                stored === undefined
                  ? ""
                  : yield* compression.decompress({
                      codec: stored.codec,
                      data: new Uint8Array(stored.body),
                    });

              // Local-first render: the html must carry no live network URL,
              // so every reference resolves against what SQLite has. cid:
              // inline images and cached remote assets swap to blob: urls; any
              // remote url we never cached swaps to an inert placeholder. So
              // opening a thread makes zero requests by construction — the
              // render never chases a missing image over the network.
              const replacements = new Map<string, string>();
              for (const image of allImages) {
                if (image.message_id !== row.id) continue;
                replacements.set(
                  `cid:${image.content_id}`,
                  registerObjectUrl(objectUrls, image.mime_type, image.bytes),
                );
              }
              const cachedRemote = new Map(
                allRemote
                  .filter((asset) => asset.message_id === row.id)
                  .map((asset) => [asset.url, asset] as const),
              );
              for (const url of remoteImageUrls(text)) {
                const cached = cachedRemote.get(url);
                if (cached !== undefined) {
                  replacements.set(
                    url,
                    registerObjectUrl(objectUrls, cached.mime_type, cached.bytes),
                  );
                } else if (isFullTier) {
                  replacements.set(url, PLACEHOLDER_IMAGE);
                }
              }
              const rewritten = rewriteAll(text, replacements);
              // Full tier: srcset comes off — its variants aren't cached, so
              // left in it would be the one live URL that survives the rewrite
              // (the src is already a blob: or the placeholder).
              const body =
                isFullTier && stored?.mime_type === "text/html"
                  ? rewritten.replace(/\s+srcset\s*=\s*("[^"]*"|'[^']*')/gi, "")
                  : rewritten;

              return {
                id: row.id,
                fromName: row.from_name,
                fromEmail: row.from_email,
                date: row.internal_date,
                bodyKind: (stored?.mime_type === "text/html"
                  ? "html"
                  : "plain") satisfies BodyKind,
                body,
              } satisfies MessageDetail;
            }),
          );

          return { id, subject, messages } satisfies ThreadDetail;
        });

      // Dev-only hook for the perf harness (perf/src/bench.ts): read the
      // listed thread ids in list order, and delete a thread's local
      // content so the next open takes loadThread's self-heal (cold)
      // path. Dead code in production builds — Vite replaces
      // `import.meta.env.DEV` with false and drops the block.
      if (import.meta.env.DEV) {
        const makeThreadCold = (id: string) =>
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM message_bodies
              WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ${id})
            `;
            yield* sql`
              DELETE FROM message_attachments
              WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ${id})
            `;
            yield* sql`
              DELETE FROM remote_assets
              WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ${id})
            `;
            yield* sql`
              DELETE FROM message_labels
              WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ${id})
            `;
            yield* sql`DELETE FROM messages WHERE thread_id = ${id}`;
          });
        const topThreads = Effect.gen(function* () {
          const rows = yield* sql`
            SELECT id FROM threads ORDER BY latest_date DESC LIMIT ${PULL_LIMIT}
          `;
          return rows.map((row) => String(row.id));
        });
        (globalThis as { __parcelPerf?: unknown }).__parcelPerf = {
          topThreads: () => Effect.runPromise(topThreads),
          makeThreadCold: (id: string) => Effect.runPromise(makeThreadCold(id)),
        };
      }

      return { loadInbox, loadThread, hydrateMissing, syncInbox } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(Gmail.layer, SqlLive, Compression.layer)),
  );
}

export type LoadInboxError = GmailError | SqlError | CompressionError;
export type LoadThreadError = GmailError | SqlError | CompressionError;
