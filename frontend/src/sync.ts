// The SyncEngine: Gmail → local SQLite, serving all reads (inbox list, open
// thread) from the store. The sync machine (syncMachine.ts) drives the
// network passes: primeInbox fills the first screen, syncBatch walks the
// whole mailbox page by page, applyHistory replays Gmail's change feed.
// Provided to the Foldkit runtime via `resources` in entry.ts.

import { Clock, Context, Effect, Layer, Option, Schema as S } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  Gmail,
  HistoryId,
  LabelId,
  MessageId,
  ThreadId,
  type GmailError,
  type ListHistoryResponse,
  type Message as GmailMessage,
  type MessagePart,
  type PageToken,
  type Thread as GmailThread,
} from "./Gmail";
import { SqlLive } from "./sql";

// Gmail's inbox tab categories, as they appear in system label ids
// (CATEGORY_PERSONAL etc.). "none" = no category label on the thread.
export const ThreadCategory = S.Literals([
  "personal",
  "promotions",
  "social",
  "updates",
  "forums",
  "none",
]);
export type ThreadCategory = typeof ThreadCategory.Type;

// One inbox list row. `date` is epoch milliseconds.
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

// What the SELECTs below return. A mismatch is a bug in our own
// schema/DDL pair, hence orDie at the call sites.
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
  body: S.String,
});
const decodeDbBodies = S.decodeUnknownEffect(S.Array(DbBodyRow));

const DbImageRow = S.Struct({
  message_id: MessageId,
  content_id: S.String,
  mime_type: S.String,
  bytes: S.instanceOf(Uint8Array),
});
const decodeDbImages = S.decodeUnknownEffect(S.Array(DbImageRow));

const DbSubjectRow = S.Struct({ subject: S.String });
const decodeDbSubjects = S.decodeUnknownEffect(S.Array(DbSubjectRow));

const DbSyncStateRow = S.Struct({
  history_id: S.NullOr(HistoryId),
  synced_count: S.Number,
  total_estimate: S.Number,
  backfill_done: S.Number,
});
const decodeDbSyncState = S.decodeUnknownEffect(S.Array(DbSyncStateRow));

const DbCountRow = S.Struct({ n: S.Number });
const decodeDbCounts = S.decodeUnknownEffect(S.Array(DbCountRow));

const DbThreadHistoryRow = S.Struct({
  id: ThreadId,
  history_id: S.NullOr(HistoryId),
});
const decodeDbThreadHistories = S.decodeUnknownEffect(
  S.Array(DbThreadHistoryRow),
);

const DbMessageIdRow = S.Struct({ id: MessageId });
const decodeDbMessageIds = S.decodeUnknownEffect(S.Array(DbMessageIdRow));

// The sync machine's persisted knowledge: everything the machine needs to
// re-derive its state after a refresh. No runtime state (page tokens, retry
// attempts) is ever persisted — those die with the tab by design.
export const SyncCheckpoint = S.Struct({
  maybeHistoryId: S.Option(HistoryId),
  isBackfillDone: S.Boolean,
  syncedCount: S.Number,
  totalEstimate: S.Number,
});
export type SyncCheckpoint = typeof SyncCheckpoint.Type;

/** What primeInbox reports back to the machine. */
export type PrimeResult = Readonly<{
  historyId: HistoryId;
  syncedCount: number;
  totalEstimate: number;
}>;

/** What one backfill page reports back to the machine. */
export type BatchResult = Readonly<{
  syncedCount: number;
  maybeNextPageToken: Option.Option<PageToken>;
}>;

/** What a history pass reports back to the machine. Expired = Gmail forgot
 *  the cursor (~a week); Overflowed = more changes than per-thread re-syncs
 *  are worth (the machine full-resyncs instead — see HISTORY_RESYNC_CAP). */
export type HistoryResult =
  | Readonly<{
      _tag: "Applied";
      historyId: HistoryId;
      changedCount: number;
      syncedAt: number;
    }>
  | Readonly<{ _tag: "Expired" }>
  | Readonly<{ _tag: "Overflowed" }>;

// Gmail body payloads are BASE64URL (-/_ alphabet), not btoa's +/.
const base64UrlToBytes = (data: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const utf8 = new TextDecoder();

// MIME TREE WALKING

const headerValue = (message: GmailMessage, name: string): string | undefined =>
  message.payload?.headers?.find((header) => header.name.toLowerCase() === name)
    ?.value;

const partHeader = (part: MessagePart, name: string): string | undefined =>
  part.headers?.find((header) => header.name.toLowerCase() === name)?.value;

const flattenParts = (part: MessagePart): ReadonlyArray<MessagePart> => [
  part,
  ...(part.parts ?? []).flatMap(flattenParts),
];

// The displayable body: prefer text/html, fall back to text/plain.
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

// `"Ada Lovelace" <ada@example.com>` → { name, email }; bare addresses
// use the address as both.
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
// The prime page: enough to fill the first screen.
const PULL_LIMIT = 15;
// One backfill page. Small enough that progress ticks visibly and a
// refresh loses at most one page of (idempotent) work.
const BATCH_SIZE = 25;
const SYNC_CONCURRENCY = 4;
const HISTORY_PAGE_SIZE = 500;
// Above this many changed threads, per-thread re-syncs are slower than a
// fresh skip-scan walk — the machine resets to Priming instead.
const HISTORY_RESYNC_CAP = 100;

export class SyncEngine extends Context.Service<SyncEngine>()(
  "parcel/SyncEngine",
  {
    make: Effect.gen(function* () {
      const gmail = yield* Gmail;
      const sql = yield* SqlClient.SqlClient;

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

      const upsertBody = (message: GmailMessage) =>
        Effect.gen(function* () {
          const part = displayPart(message);
          const data = part?.body?.data;
          if (part === undefined || data === undefined) return;
          yield* sql`INSERT OR REPLACE INTO message_bodies ${sql.insert([
            {
              message_id: message.id,
              mime_type: part.mimeType ?? "text/plain",
              body: utf8.decode(base64UrlToBytes(data)),
            },
          ])}`;
        });

      // Inline image bytes: small ones ride along in the payload, larger
      // ones need the attachments endpoint.
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

      const syncThread = (id: ThreadId) =>
        Effect.gen(function* () {
          const thread = yield* gmail.getThread(id, "full");
          yield* upsertThread(thread);
          yield* Effect.forEach(thread.messages ?? [], (message) =>
            Effect.all([
              upsertMessage(thread.id, message),
              upsertBody(message),
              upsertInlineImages(message),
            ]),
          );
        });

      const countLocalThreads = Effect.gen(function* () {
        const raw = yield* sql`SELECT COUNT(*) AS n FROM threads`;
        const rows = yield* decodeDbCounts(raw).pipe(Effect.orDie);
        return rows[0]?.n ?? 0;
      });

      // The stubs from a threads.list page that the local store can't
      // serve current yet. Stubs carry a per-thread historyId, so a page
      // of already-synced threads costs one local SELECT and no fetches —
      // this is what makes restarting the backfill walk from the top cheap
      // (the resume path after a refresh or an expired page token).
      const staleThreadIds = (stubs: ReadonlyArray<GmailThread>) =>
        Effect.gen(function* () {
          if (stubs.length === 0) return [];
          const raw = yield* sql`
            SELECT id, history_id FROM threads
            WHERE ${sql.in(
              "id",
              stubs.map((stub) => stub.id),
            )}
          `;
          const rows = yield* decodeDbThreadHistories(raw).pipe(Effect.orDie);
          const local = new Map(rows.map((row) => [row.id, row.history_id]));
          return stubs
            .filter(
              (stub) =>
                stub.historyId === undefined ||
                local.get(stub.id) !== stub.historyId,
            )
            .map((stub) => stub.id);
        });

      // MACHINE PASSES

      const readCheckpoint = Effect.gen(function* () {
        const raw = yield* sql`
          SELECT history_id, synced_count, total_estimate, backfill_done
          FROM sync_state WHERE id = 1
        `;
        const rows = yield* decodeDbSyncState(raw).pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined) return Option.none<SyncCheckpoint>();
        return Option.some<SyncCheckpoint>({
          maybeHistoryId: Option.fromNullishOr(row.history_id),
          isBackfillDone: row.backfill_done !== 0,
          syncedCount: row.synced_count,
          totalEstimate: row.total_estimate,
        });
      });

      // The first-screen pass: capture the history cursor BEFORE pulling
      // anything (changes during the long backfill are then replayed by the
      // first applyHistory), sync the newest page, stamp the checkpoint.
      const primeInbox: Effect.Effect<
        PrimeResult,
        GmailError | SqlError
      > = Effect.gen(function* () {
        const profile = yield* gmail.getProfile;
        const page = yield* gmail.listThreads({
          labelIds: [INBOX],
          maxResults: PULL_LIMIT,
        });
        const stale = yield* staleThreadIds(page.threads ?? []);
        yield* Effect.forEach(stale, (id) => syncThread(id), {
          concurrency: SYNC_CONCURRENCY,
        });
        const syncedCount = yield* countLocalThreads;
        const syncedAt = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO sync_state (id, history_id, email, last_synced_at, synced_count, total_estimate, backfill_done)
          VALUES (1, ${profile.historyId}, ${profile.emailAddress}, ${syncedAt}, ${syncedCount}, ${profile.threadsTotal}, 0)
          ON CONFLICT (id) DO UPDATE SET
            history_id = excluded.history_id,
            email = excluded.email,
            last_synced_at = excluded.last_synced_at,
            synced_count = excluded.synced_count,
            total_estimate = excluded.total_estimate,
            backfill_done = 0
        `;
        return {
          historyId: profile.historyId,
          syncedCount,
          totalEstimate: profile.threadsTotal,
        };
      });

      // One backfill page: list BATCH_SIZE stubs, fetch only the stale
      // ones, stamp progress. The checkpoint stores counts (knowledge),
      // never the page token (runtime state) — a resumed walk re-lists
      // from the top and skip-scans, see staleThreadIds.
      const syncBatch = (
        maybePageToken: Option.Option<PageToken>,
      ): Effect.Effect<BatchResult, GmailError | SqlError> =>
        Effect.gen(function* () {
          const page = yield* gmail.listThreads({
            labelIds: [INBOX],
            maxResults: BATCH_SIZE,
            ...Option.match(maybePageToken, {
              onNone: () => ({}),
              onSome: (pageToken) => ({ pageToken }),
            }),
          });
          const stale = yield* staleThreadIds(page.threads ?? []);
          yield* Effect.forEach(stale, (id) => syncThread(id), {
            concurrency: SYNC_CONCURRENCY,
          });
          const syncedCount = yield* countLocalThreads;
          const maybeNextPageToken = Option.fromNullishOr(page.nextPageToken);
          const syncedAt = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE sync_state SET
              synced_count = ${syncedCount},
              backfill_done = ${Option.isNone(maybeNextPageToken) ? 1 : 0},
              last_synced_at = ${syncedAt}
            WHERE id = 1
          `;
          return { syncedCount, maybeNextPageToken };
        });

      const deleteMessagesLocal = (ids: ReadonlyArray<MessageId>) =>
        Effect.forEach(ids, (id) =>
          Effect.all([
            sql`DELETE FROM message_attachments WHERE message_id = ${id}`,
            sql`DELETE FROM message_bodies WHERE message_id = ${id}`,
            sql`DELETE FROM message_labels WHERE message_id = ${id}`,
            sql`DELETE FROM messages WHERE id = ${id}`,
          ]),
        );

      const deleteThreadLocal = (id: ThreadId) =>
        Effect.gen(function* () {
          const raw = yield* sql`SELECT id FROM messages WHERE thread_id = ${id}`;
          const rows = yield* decodeDbMessageIds(raw).pipe(Effect.orDie);
          yield* deleteMessagesLocal(rows.map((row) => row.id));
          yield* sql`DELETE FROM threads WHERE id = ${id}`;
        });

      // The incremental pass: everything that changed since the cursor,
      // applied locally. Cheap when nothing changed (one request), targeted
      // when something did (full re-sync of just the touched threads).
      const applyHistory = (
        startHistoryId: HistoryId,
      ): Effect.Effect<HistoryResult, GmailError | SqlError> =>
        Effect.gen(function* () {
          const touched = new Set<ThreadId>();
          const deletedMessages: Array<MessageId> = [];
          let latest = startHistoryId;
          let pageToken: PageToken | undefined = undefined;

          do {
            const page: ListHistoryResponse = yield* gmail.listHistory({
              startHistoryId,
              maxResults: HISTORY_PAGE_SIZE,
              ...(pageToken === undefined ? {} : { pageToken }),
            });
            for (const record of page.history ?? []) {
              for (const added of record.messagesAdded ?? []) {
                touched.add(added.message.threadId);
              }
              for (const removed of record.messagesDeleted ?? []) {
                deletedMessages.push(removed.message.id);
                touched.add(removed.message.threadId);
              }
              for (const change of [
                ...(record.labelsAdded ?? []),
                ...(record.labelsRemoved ?? []),
              ]) {
                touched.add(change.message.threadId);
              }
            }
            if (page.historyId !== undefined) latest = page.historyId;
            pageToken = page.nextPageToken;
          } while (pageToken !== undefined);

          if (touched.size > HISTORY_RESYNC_CAP) {
            return { _tag: "Overflowed" } as const;
          }

          yield* deleteMessagesLocal(deletedMessages);
          yield* Effect.forEach(
            [...touched],
            (id) =>
              syncThread(id).pipe(
                // 404: the whole thread is gone (deleted forever, or the
                // last message aged out of Spam/Trash).
                Effect.catchTag("GmailNotFound", () => deleteThreadLocal(id)),
              ),
            { concurrency: SYNC_CONCURRENCY },
          );

          const syncedAt = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE sync_state SET history_id = ${latest}, last_synced_at = ${syncedAt}
            WHERE id = 1
          `;
          return {
            _tag: "Applied",
            historyId: latest,
            changedCount: touched.size,
            syncedAt,
          } as const;
        }).pipe(
          // On listHistory a 404 means the cursor expired, not a missing
          // resource — the machine full-resyncs from Priming.
          Effect.catchTag("GmailNotFound", () =>
            Effect.succeed({ _tag: "Expired" } as const),
          ),
        );

      // READS

      // The whole store, newest first. VirtualList renders a fixed window
      // regardless of length, so the full mailbox rides in the model.
      const selectInbox = Effect.gen(function* () {
        const raw = yield* sql`
          SELECT id, subject, snippet, participants, latest_date, is_unread, category
          FROM threads
          ORDER BY latest_date DESC
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

      // Local-first: reads never touch the network. Filling the store is
      // entirely the sync machine's job.
      const loadInbox = selectInbox;

      // Inline image bytes reach the html as blob: urls (not data: URIs —
      // inlining megabytes of base64 into the body string is slow and can
      // OOM the tab). Each thread's urls are revoked on its next load.
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

      // Opening a thread: SQLite only.
      const loadThread = (id: ThreadId) =>
        Effect.gen(function* () {
          const subjectRaw = yield* sql`
            SELECT subject FROM threads WHERE id = ${id}
          `;
          const subject =
            (yield* decodeDbSubjects(subjectRaw).pipe(Effect.orDie))[0]
              ?.subject ?? "";

          const rowsRaw = yield* sql`
            SELECT id, internal_date, from_name, from_email
            FROM messages
            WHERE thread_id = ${id}
            ORDER BY internal_date ASC
          `;
          const rows = yield* decodeDbMessages(rowsRaw).pipe(Effect.orDie);

          for (const url of threadObjectUrls.get(id) ?? []) {
            URL.revokeObjectURL(url);
          }
          const objectUrls: Array<string> = [];
          threadObjectUrls.set(id, objectUrls);

          const messages = yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const bodyRaw = yield* sql`
                SELECT message_id, mime_type, body
                FROM message_bodies
                WHERE message_id = ${row.id}
              `;
              const stored = (yield* decodeDbBodies(bodyRaw).pipe(
                Effect.orDie,
              ))[0];
              const imagesRaw = yield* sql`
                SELECT message_id, content_id, mime_type, bytes
                FROM message_attachments
                WHERE message_id = ${row.id}
              `;
              const images = yield* decodeDbImages(imagesRaw).pipe(
                Effect.orDie,
              );

              let body = stored?.body ?? "";
              for (const image of images) {
                body = body.replaceAll(
                  `cid:${image.content_id}`,
                  registerObjectUrl(objectUrls, image.mime_type, image.bytes),
                );
              }

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

      return {
        loadInbox,
        loadThread,
        readCheckpoint,
        primeInbox,
        syncBatch,
        applyHistory,
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(Gmail.layer, SqlLive)),
  );
}

export type LoadInboxError = SqlError;
export type LoadThreadError = SqlError;
