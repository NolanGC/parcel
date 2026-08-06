// The SyncEngine: Gmail → local SQLite, serving every read from the store.
// syncMachine.ts drives the network passes.

import {
  Array as Arr,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schema as S,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ts } from "foldkit/schema";

import {
  Gmail,
  HistoryId,
  LabelId,
  MessageId,
  ThreadId,
  type GmailError,
  type History as GmailHistory,
  type ListHistoryResponse,
  type Message as GmailMessage,
  type MessagePart,
  type PageToken,
  type Thread as GmailThread,
} from "./Gmail";
import { BodyCodec, Compression, CompressionError } from "./compression";
import {
  IMAGE_CONCURRENCY,
  ImageFetcher,
  remoteImageUrls,
  rewriteImageUrls,
} from "./images";
import {
  base64UrlToBytes,
  displayPart,
  flattenParts,
  headerValue,
  inlineImages,
  latestDate,
  parseFrom,
  partHeader,
  toInlineImage,
  type InlineImage,
  utf8,
} from "./mailDecode";

import {
  BOOT_ENGINE_READY,
  BOOT_ENGINE_START,
  BOOT_QUERY_END,
  BOOT_QUERY_START,
  logBootReport,
  mark,
} from "./bootMarks";
import { cleanSnippet } from "./snippet";
import { SqlLive } from "./sql";
import { HOT_THREAD_COUNT, OPENED_LRU_COUNT } from "./tiers";

// As they appear in system label ids (CATEGORY_PERSONAL etc.).
export const ThreadCategory = S.Literals([
  "personal",
  "promotions",
  "social",
  "updates",
  "forums",
  "none",
]);
export type ThreadCategory = typeof ThreadCategory.Type;

/** One inbox list row. `date` is epoch milliseconds. */
export const ThreadRow = S.Struct({
  id: ThreadId,
  subject: S.String,
  sender: S.String,
  snippet: S.String,
  date: S.Number,
  isUnread: S.Boolean,
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

// NOTE: A mismatch between these and the DDL is a bug in our own schema pair,
// hence orDie at the call sites. Exported because search.ts selects the same
// shape and must not drift from it.
export const THREAD_ROW_COLUMNS =
  "id, subject, snippet, participants, latest_date, is_unread, category";

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

const decodeParticipants = S.decodeUnknownOption(S.Array(S.String));

const senderOf = (participants: string): string =>
  Option.getOrElse(
    Option.flatMap(decodeParticipants(JSON.parse(participants)), Arr.head),
    () => "",
  );

export const decodeThreadRows = (
  raw: unknown,
): Effect.Effect<ReadonlyArray<ThreadRow>> =>
  decodeDbRows(raw).pipe(
    Effect.orDie,
    Effect.map((rows) =>
      rows.map(
        (row): ThreadRow => ({
          id: row.id,
          subject: row.subject,
          sender: senderOf(row.participants),
          snippet: cleanSnippet(row.snippet),
          date: row.latest_date,
          isUnread: row.is_unread !== 0,
          category: row.category,
        }),
      ),
    ),
  );

// A missing row means an empty store, not a failure, so callers name a zero.
const firstRowOr = <Row, Value>(
  rows: ReadonlyArray<Row>,
  select: (row: Row) => Value,
  fallback: Value,
): Value =>
  Option.getOrElse(Option.map(Arr.head(rows), select), () => fallback);

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
  data: S.instanceOf(Uint8Array),
  codec: BodyCodec,
});
const decodeDbBodies = S.decodeUnknownEffect(S.Array(DbBodyRow));

const DbImageRow = S.Struct({
  message_id: MessageId,
  content_id: S.String,
  mime_type: S.String,
  bytes: S.instanceOf(Uint8Array),
});
const decodeDbImages = S.decodeUnknownEffect(S.Array(DbImageRow));

const DbRemoteImageRow = S.Struct({
  url: S.String,
  mime_type: S.String,
  bytes: S.instanceOf(Uint8Array),
});
const decodeDbRemoteImages = S.decodeUnknownEffect(S.Array(DbRemoteImageRow));

const DbUrlRow = S.Struct({ url: S.String });
const decodeDbUrls = S.decodeUnknownEffect(S.Array(DbUrlRow));

const DbThreadIdRow = S.Struct({ id: ThreadId });
const decodeDbThreadIds = S.decodeUnknownEffect(S.Array(DbThreadIdRow));

const DbCutoffRow = S.Struct({ latest_date: S.Number });
const decodeDbCutoffs = S.decodeUnknownEffect(S.Array(DbCutoffRow));

const DbSubjectRow = S.Struct({ subject: S.String });
const decodeDbSubjects = S.decodeUnknownEffect(S.Array(DbSubjectRow));

const DbSyncStateRow = S.Struct({
  history_id: S.NullOr(HistoryId),
  email: S.NullOr(S.String),
  synced_count: S.Number,
  total_estimate: S.Number,
  backfill_done: S.Number,
});
const decodeDbSyncState = S.decodeUnknownEffect(S.Array(DbSyncStateRow));

const DbCountRow = S.Struct({ n: S.Number });
const decodeDbCounts = S.decodeUnknownEffect(S.Array(DbCountRow));

const DbWindowCountRow = S.Struct({ total: S.Number, pending: S.Number });
const decodeDbWindowCounts = S.decodeUnknownEffect(S.Array(DbWindowCountRow));

// PRAGMA results come back named after the pragma itself.
const decodeDbPragmaCounts = S.decodeUnknownEffect(
  S.Array(S.Struct({ page_count: S.Number })),
);
const decodeDbPragmaSizes = S.decodeUnknownEffect(
  S.Array(S.Struct({ page_size: S.Number })),
);

const DbThreadHistoryRow = S.Struct({
  id: ThreadId,
  history_id: S.NullOr(HistoryId),
});
const decodeDbThreadHistories = S.decodeUnknownEffect(
  S.Array(DbThreadHistoryRow),
);

const DbMessageIdRow = S.Struct({ id: MessageId });
const decodeDbMessageIds = S.decodeUnknownEffect(S.Array(DbMessageIdRow));

// NOTE: Knowledge only. Runtime state (page tokens, retry attempts) is never
// persisted; it dies with the tab by design.
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

/** What one image batch reports back to the page's prefetch loop.
 *
 *  `isIdle` means the queue came up empty, which is the loop's cue to slow
 *  down rather than to stop: the backfill is usually still producing threads.
 *
 *  `isRecentReady` is the milestone: the hot window is full and every thread in
 *  it has its images stored. A real crossing point rather than a gauge, because
 *  the backfill walks newest-first and only ever adds older threads, so once
 *  the store passes HOT_THREAD_COUNT the window's membership stops changing. */
export type ImageBatchResult = Readonly<{
  isIdle: boolean;
  isRecentReady: boolean;
}>;

/** What a history pass reports back to the machine. Expired = Gmail forgot the
 *  cursor (~a week); Overflowed = more changes than per-thread re-syncs are
 *  worth, so the machine full-resyncs instead (see HISTORY_RESYNC_CAP). */
export const Applied = ts("Applied", {
  historyId: HistoryId,
  changedCount: S.Number,
  syncedAt: S.Number,
});
export const Expired = ts("Expired");
export const Overflowed = ts("Overflowed");

export const HistoryResult = S.Union([Applied, Expired, Overflowed]);
export type HistoryResult = typeof HistoryResult.Type;


const UNREAD_LABEL = "UNREAD";
const CATEGORY_PREFIX = "CATEGORY_";

const decodeThreadCategory = S.decodeUnknownOption(ThreadCategory);

const messageCategory = (
  message: GmailMessage,
): Option.Option<ThreadCategory> =>
  Option.flatMap(
    Arr.findFirst(message.labelIds ?? [], (id) =>
      id.startsWith(CATEGORY_PREFIX),
    ),
    (label) =>
      decodeThreadCategory(label.slice(CATEGORY_PREFIX.length).toLowerCase()),
  );

const threadCategory = (
  messages: ReadonlyArray<GmailMessage>,
): ThreadCategory =>
  Option.getOrElse(
    Arr.findFirst(messages, messageCategory),
    (): ThreadCategory => "none",
  );

// HISTORY SCAN

// NOTE: `touched` is a Set because the same thread routinely appears in
// several records of one page, and re-syncing it once is the point.
type HistoryScan = Readonly<{
  touched: ReadonlySet<ThreadId>;
  deletedMessages: ReadonlyArray<MessageId>;
  latest: HistoryId;
}>;

const emptyHistoryScan = (startHistoryId: HistoryId): HistoryScan => ({
  touched: new Set(),
  deletedMessages: [],
  latest: startHistoryId,
});

const recordThreadIds = (record: GmailHistory): ReadonlyArray<ThreadId> =>
  Arr.map(
    [
      ...(record.messagesAdded ?? []),
      ...(record.messagesDeleted ?? []),
      ...(record.labelsAdded ?? []),
      ...(record.labelsRemoved ?? []),
    ],
    ({ message }) => message.threadId,
  );

const recordDeletedMessageIds = (
  record: GmailHistory,
): ReadonlyArray<MessageId> =>
  Arr.map(record.messagesDeleted ?? [], ({ message }) => message.id);

const foldHistoryPage = (
  scan: HistoryScan,
  page: ListHistoryResponse,
): HistoryScan => {
  const records = page.history ?? [];
  return {
    touched: new Set([
      ...scan.touched,
      ...Arr.flatMap(records, recordThreadIds),
    ]),
    deletedMessages: [
      ...scan.deletedMessages,
      ...Arr.flatMap(records, recordDeletedMessageIds),
    ],
    latest: page.historyId ?? scan.latest,
  };
};

// SERVICE

const INBOX = LabelId.make("INBOX");
// The prime page: enough to fill the first screen.
const PULL_LIMIT = 15;
// NOTE: threads.list costs 10 quota units whatever the page size, so small
// pages are pure overhead. Held at 100 rather than the 500 maximum only
// because one CompletedSyncBatch per page is also the progress tick, which at
// the ~19 threads/sec ceiling reports in every ~5s. Going higher wants
// progress decoupled from paging first.
const LIST_PAGE_SIZE = 100;
// Threads fetched and committed together. Bounds how many payloads sit in
// memory at once, and is the transaction size that stops every INSERT paying
// its own OPFS fsync.
const SYNC_CHUNK_SIZE = 25;
// NOTE: Gmail allows 250 quota units/user/sec and the token bucket in Gmail.ts
// paces to 200, so the ceiling is ~19 threads/sec (threads.get = 10 units). 20
// in flight is what it takes to reach it; the bucket, not this number, is what
// keeps us under the quota.
const SYNC_CONCURRENCY = 20;
const HISTORY_PAGE_SIZE = 500;
// Above this many changed threads, per-thread re-syncs are slower than a fresh
// skip-scan walk, so the machine resets to Priming instead.
const HISTORY_RESYNC_CAP = 100;
// Threads per image batch. Real mail carries ~13 remote images per message, so
// this is ~100 proxy fetches per pass: small enough that the pill's counter
// moves visibly, large enough that per-batch SQL overhead disappears.
const IMAGE_BATCH_THREADS = 8;
// NOTE: The eviction query is unbounded by nature, so without a cap one turn
// of a four-second loop walks the entire cold tail. Draining a slice per cycle
// keeps each turn's cost flat no matter how large the store grows.
const IMAGE_EVICT_BATCH = 64;

export class SyncEngine extends Context.Service<SyncEngine>()(
  "parcel/SyncEngine",
  {
    make: Effect.gen(function* () {
      yield* mark(BOOT_ENGINE_START);
      const gmail = yield* Gmail;
      const sql = yield* SqlClient.SqlClient;
      const compression = yield* Compression;
      const imageFetcher = yield* ImageFetcher;
      yield* mark(BOOT_ENGINE_READY);

      // The list columns all come off the newest message in the thread, so
      // they are resolved together rather than each re-deriving it.
      const upsertThread = (thread: GmailThread) => {
        const latest = Option.match(Arr.last(thread.messages ?? []), {
          onNone: () => ({
            subject: "",
            snippet: "",
            participants: [] as ReadonlyArray<string>,
          }),
          onSome: (message) => ({
            subject: headerValue(message, "subject") ?? "",
            snippet: message.snippet ?? "",
            participants: [parseFrom(headerValue(message, "from") ?? "").name],
          }),
        });
        const messages = thread.messages ?? [];
        return sql`INSERT OR REPLACE INTO threads ${sql.insert([
          {
            id: thread.id,
            history_id: thread.historyId ?? null,
            subject: latest.subject,
            snippet: thread.snippet ?? latest.snippet,
            participants: JSON.stringify(latest.participants),
            latest_date: latestDate(messages),
            message_count: messages.length,
            is_unread: messages.some((message) =>
              message.labelIds?.some((id) => id === UNREAD_LABEL),
            )
              ? 1
              : 0,
            // Archiving is just the removal of this label, so re-reading it
            // on every sync is what lets a thread leave the local inbox.
            in_inbox: messages.some((message) =>
              message.labelIds?.some((id) => id === INBOX),
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

      // NOTE: orDie on compress. This gzips a string we just decoded
      // ourselves, so a failure is the platform misbehaving rather than
      // anything a sync retry could fix, and keeping it out of the error
      // channel stops CompressionError leaking into every sync signature.
      const upsertBody = (message: GmailMessage) =>
        Option.match(displayPart(message), {
          onNone: () => Effect.void,
          onSome: (part) =>
            Effect.gen(function* () {
              const data = part.body?.data;
              if (data === undefined) {
                return;
              }
              const body = yield* compression
                .compress(utf8.decode(base64UrlToBytes(data)))
                .pipe(Effect.orDie);
              yield* sql`INSERT OR REPLACE INTO message_bodies ${sql.insert([
                {
                  message_id: message.id,
                  mime_type: part.mimeType ?? "text/plain",
                  data: body.data,
                  codec: body.codec,
                },
              ])}`;
            }),
        });

      // NOTE: Resolved during the fetch phase so the write phase is pure SQL.
      // A transaction must never be held open across a network round-trip.
      const resolveInlineImages = (message: GmailMessage) =>
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
              return data === undefined
                ? []
                : [
                    {
                      message_id: message.id,
                      content_id: image.contentId,
                      mime_type: image.mimeType,
                      bytes: base64UrlToBytes(data),
                    },
                  ];
            }),
          { concurrency: 2 },
        ).pipe(Effect.map((groups) => groups.flat()));

      type FetchedThread = Readonly<{
        thread: GmailThread;
        images: ReadonlyArray<{
          message_id: MessageId;
          content_id: string;
          mime_type: string;
          bytes: Uint8Array;
        }>;
      }>;

      // `None` means Gmail 404'd it: the thread is gone, so the caller drops
      // the local copy.
      const fetchThread = (
        id: ThreadId,
      ): Effect.Effect<Option.Option<FetchedThread>, GmailError> =>
        Effect.gen(function* () {
          const thread = yield* gmail.getThread(id, "full");
          const images = yield* Effect.forEach(
            thread.messages ?? [],
            resolveInlineImages,
          ).pipe(Effect.map((groups) => groups.flat()));
          return Option.some<FetchedThread>({ thread, images });
        }).pipe(
          Effect.catchTag("GmailNotFound", () =>
            Effect.succeed(Option.none<FetchedThread>()),
          ),
        );

      const persistThread = ({ thread, images }: FetchedThread) =>
        Effect.gen(function* () {
          yield* upsertThread(thread);
          yield* Effect.forEach(thread.messages ?? [], (message) =>
            Effect.gen(function* () {
              yield* upsertMessage(thread.id, message);
              yield* upsertBody(message);
            }),
          );
          yield* Effect.forEach(
            images,
            (image) =>
              sql`INSERT OR REPLACE INTO message_attachments ${sql.insert([image])}`,
          );
        });

      // NOTE: Fetch concurrently, then commit one transaction per chunk.
      // Splitting the phases is what keeps the network out of the transaction,
      // and what makes the transaction worth having: an fsync per chunk rather
      // than per INSERT.
      const syncThreads = (ids: ReadonlyArray<ThreadId>) =>
        Effect.forEach(
          Arr.chunksOf(ids, SYNC_CHUNK_SIZE),
          (group) =>
            Effect.forEach(
              group,
              (id) =>
                fetchThread(id).pipe(
                  Effect.map((maybeFetched) => ({ id, maybeFetched })),
                ),
              { concurrency: SYNC_CONCURRENCY },
            ).pipe(
              Effect.flatMap((fetched) =>
                sql.withTransaction(
                  Effect.forEach(
                    fetched,
                    ({ id, maybeFetched }) =>
                      Option.match(maybeFetched, {
                        onNone: () => deleteThreadLocal(id),
                        onSome: persistThread,
                      }),
                    { discard: true },
                  ),
                ),
              ),
            ),
          { discard: true },
        );

      const countLocalThreads = Effect.gen(function* () {
        const raw = yield* sql`SELECT COUNT(*) AS n FROM threads`;
        const rows = yield* decodeDbCounts(raw).pipe(Effect.orDie);
        return firstRowOr(rows, (row) => row.n, 0);
      });

      // On-disk size of the local store, from SQLite's own page accounting.
      // Surfaced in the sync pill's detail because a local-first client that
      // quietly grows to a gigabyte should say so where you can see it.
      const localSizeBytes = Effect.gen(function* () {
        const pageCount = yield* sql`PRAGMA page_count`;
        const pageSize = yield* sql`PRAGMA page_size`;
        const counts = yield* decodeDbPragmaCounts(pageCount).pipe(
          Effect.orDie,
        );
        const sizes = yield* decodeDbPragmaSizes(pageSize).pipe(Effect.orDie);
        return (
          firstRowOr(counts, (row) => row.page_count, 0) *
          firstRowOr(sizes, (row) => row.page_size, 0)
        );
      });

      // The stubs from a threads.list page the store has never seen. A page of
      // already-stored threads costs one local SELECT and no fetches, which is
      // what makes restarting the walk from the top cheap on resume.
      //
      // NOTE: Membership, deliberately, not a historyId comparison. Keeping
      // threads current is applyHistory's job and is correct by construction,
      // since primeInbox captures the cursor before the walk starts. Comparing
      // historyIds added no correctness and, whenever the two disagreed,
      // silently re-downloaded the whole mailbox on every resume. Safe because
      // persistThread writes a thread and its messages in one transaction, so
      // "we have this id" means the thread is complete.
      const unseenThreadIds = (stubs: ReadonlyArray<GmailThread>) =>
        Effect.gen(function* () {
          if (Arr.isReadonlyArrayEmpty(stubs)) {
            return [];
          }
          const raw = yield* sql`
            SELECT id, history_id FROM threads
            WHERE ${sql.in(
              "id",
              stubs.map((stub) => stub.id),
            )}
          `;
          const rows = yield* decodeDbThreadHistories(raw).pipe(Effect.orDie);
          const local = new Set(rows.map((row) => row.id));
          return stubs
            .filter((stub) => !local.has(stub.id))
            .map((stub) => stub.id);
        });

      // MACHINE PASSES

      // Every local table, in foreign-key order. Used when the signed-in
      // account changes: the store is one mailbox's worth of data keyed by
      // nothing, so the only safe response to a different owner is to drop
      // all of it.
      const deleteAllLocal = sql.withTransaction(
        Effect.forEach(
          [
            "message_attachments",
            "message_images",
            "message_bodies",
            "message_labels",
            "messages",
            "threads",
            "labels",
            "outbox",
            "sync_state",
          ],
          (table) => sql`DELETE FROM ${sql.literal(table)}`,
          { discard: true },
        ),
      );

      // NOTE: `accountEmail` is the signed-in address from the session, not
      // from Gmail. A network call here could fail, and failing open would
      // render the previous account's mail to whoever just signed in. The OPFS
      // database is per-origin and holds exactly one mailbox with no owner
      // column, so a mismatch is not a merge problem. Wipe and re-prime.
      const readCheckpoint = (accountEmail: string) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT history_id, email, synced_count, total_estimate, backfill_done
            FROM sync_state WHERE id = 1
          `;
          const rows = yield* decodeDbSyncState(raw).pipe(Effect.orDie);
          const maybeRow = Arr.head(rows);
          if (Option.isNone(maybeRow)) {
            return Option.none<SyncCheckpoint>();
          }
          const row = maybeRow.value;

          if (row.email !== null && row.email !== accountEmail) {
            yield* Effect.logInfo(
              "mailbox owner changed; clearing local store",
            );
            yield* deleteAllLocal;
            return Option.none<SyncCheckpoint>();
          }

          // NOTE: total_estimate is otherwise only ever written by primeInbox,
          // and a mailbox resuming mid-backfill never re-primes, so it would
          // keep whatever number the last prime wrote. Refreshed once per boot,
          // best-effort: a progress denominator is not worth failing a boot over.
          const totalEstimate = yield* gmail.getLabel(INBOX).pipe(
            Effect.map((label) => label.threadsTotal ?? row.total_estimate),
            Effect.catchCause(() => Effect.succeed(row.total_estimate)),
          );
          if (totalEstimate !== row.total_estimate) {
            yield* sql`
              UPDATE sync_state SET total_estimate = ${totalEstimate} WHERE id = 1
            `;
          }

          return Option.some<SyncCheckpoint>({
            maybeHistoryId: Option.fromNullishOr(row.history_id),
            isBackfillDone: row.backfill_done !== 0,
            syncedCount: row.synced_count,
            totalEstimate,
          });
        });

      // The first-screen pass: capture the history cursor before pulling
      // anything, sync the newest page, stamp the checkpoint.
      // NOTE: The cursor is captured first so the first applyHistory replays
      // every change that lands during the long backfill.
      const primeInbox: Effect.Effect<PrimeResult, GmailError | SqlError> =
        Effect.gen(function* () {
          const profile = yield* gmail.getProfile;
          // NOTE: The backfill only ever walks INBOX, so the denominator has
          // to be the INBOX label's own count. profile.threadsTotal counts the
          // entire mailbox, which reads as a bar that stalls at a few percent
          // and then declares itself done.
          const inboxLabel = yield* gmail.getLabel(INBOX);
          const totalEstimate = inboxLabel.threadsTotal ?? profile.threadsTotal;
          const page = yield* gmail.listThreads({
            labelIds: [INBOX],
            maxResults: PULL_LIMIT,
          });
          yield* syncThreads(yield* unseenThreadIds(page.threads ?? []));
          const syncedCount = yield* countLocalThreads;
          const syncedAt = yield* Clock.currentTimeMillis;
          yield* sql`
          INSERT INTO sync_state (id, history_id, email, last_synced_at, synced_count, total_estimate, backfill_done)
          VALUES (1, ${profile.historyId}, ${profile.emailAddress}, ${syncedAt}, ${syncedCount}, ${totalEstimate}, 0)
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
            totalEstimate,
          };
        });

      // One backfill page: list LIST_PAGE_SIZE stubs, fetch only the stale
      // ones, stamp progress. The checkpoint stores counts (knowledge),
      // never the page token (runtime state) — a resumed walk re-lists
      // from the top and skip-scans, see staleThreadIds.
      //
      // `previousCount` comes from the machine's own Backfilling state, so
      // progress advances by addition. The last page reconciles against a
      // real COUNT(*): additions can drift from the truth if applyHistory
      // deleted a thread mid-walk, and "done" is the one moment the number
      // is worth being exact about.
      const syncBatch = (
        maybePageToken: Option.Option<PageToken>,
        previousCount: number,
      ): Effect.Effect<BatchResult, GmailError | SqlError> =>
        Effect.gen(function* () {
          const page = yield* gmail.listThreads({
            labelIds: [INBOX],
            maxResults: LIST_PAGE_SIZE,
            ...Option.match(maybePageToken, {
              onNone: () => ({}),
              onSome: (pageToken) => ({ pageToken }),
            }),
          });
          const unseen = yield* unseenThreadIds(page.threads ?? []);
          yield* syncThreads(unseen);
          const maybeNextPageToken = Option.fromNullishOr(page.nextPageToken);
          const isDone = Option.isNone(maybeNextPageToken);
          const syncedCount = isDone
            ? yield* countLocalThreads
            : previousCount + unseen.length;
          const syncedAt = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE sync_state SET
              synced_count = ${syncedCount},
              backfill_done = ${isDone ? 1 : 0},
              last_synced_at = ${syncedAt}
            WHERE id = 1
          `;
          return { syncedCount, maybeNextPageToken };
        });

      const deleteMessagesLocal = (ids: ReadonlyArray<MessageId>) =>
        Effect.forEach(ids, (id) =>
          Effect.all([
            sql`DELETE FROM message_attachments WHERE message_id = ${id}`,
            sql`DELETE FROM message_images WHERE message_id = ${id}`,
            sql`DELETE FROM message_bodies WHERE message_id = ${id}`,
            sql`DELETE FROM message_labels WHERE message_id = ${id}`,
            sql`DELETE FROM messages WHERE id = ${id}`,
          ]),
        );

      const deleteThreadLocal = (id: ThreadId) =>
        Effect.gen(function* () {
          const raw =
            yield* sql`SELECT id FROM messages WHERE thread_id = ${id}`;
          const rows = yield* decodeDbMessageIds(raw).pipe(Effect.orDie);
          yield* deleteMessagesLocal(rows.map((row) => row.id));
          yield* sql`DELETE FROM threads WHERE id = ${id}`;
        });

      // The incremental pass: everything that changed since the cursor,
      // applied locally. Cheap when nothing changed (one request), targeted
      // when something did (full re-sync of just the touched threads).
      const scanPages = (
        startHistoryId: HistoryId,
        maybePageToken: Option.Option<PageToken>,
        scan: HistoryScan,
      ): Effect.Effect<HistoryScan, GmailError> =>
        Effect.gen(function* () {
          const page: ListHistoryResponse = yield* gmail.listHistory({
            startHistoryId,
            maxResults: HISTORY_PAGE_SIZE,
            ...Option.match(maybePageToken, {
              onNone: () => ({}),
              onSome: (pageToken) => ({ pageToken }),
            }),
          });
          const scanned = foldHistoryPage(scan, page);
          return yield* Option.match(Option.fromNullishOr(page.nextPageToken), {
            onNone: () => Effect.succeed(scanned),
            onSome: (pageToken) =>
              scanPages(startHistoryId, Option.some(pageToken), scanned),
          });
        });

      const applyHistory = (
        startHistoryId: HistoryId,
      ): Effect.Effect<HistoryResult, GmailError | SqlError> =>
        Effect.gen(function* () {
          const { touched, deletedMessages, latest } = yield* scanPages(
            startHistoryId,
            Option.none(),
            emptyHistoryScan(startHistoryId),
          );

          if (touched.size > HISTORY_RESYNC_CAP) {
            return Overflowed();
          }

          yield* deleteMessagesLocal(deletedMessages);
          // syncThreads already treats a 404 as "the thread is gone" and drops
          // the local copy, which is exactly the history case too.
          yield* syncThreads([...touched]);

          const syncedAt = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE sync_state SET history_id = ${latest}, last_synced_at = ${syncedAt}
            WHERE id = 1
          `;
          return Applied({
            historyId: latest,
            changedCount: touched.size,
            syncedAt,
          });
        }).pipe(
          // NOTE: On listHistory a 404 means the cursor expired, not a missing
          // resource. The machine full-resyncs from Priming.
          Effect.catchTag("GmailNotFound", () => Effect.succeed(Expired())),
        );

      // IMAGE PASS
      //
      // NOTE: Runs concurrently with the backfill because the two are bound by
      // different resources (quota bucket vs image proxy). Work is queued in
      // the threads table itself: images_cached_at = 0 means pending.

      // The latest_date of the HOT_THREAD_COUNT-th newest thread. Below that
      // count there is no row at the offset and everything is hot, which is
      // right for a mailbox mid-backfill.
      const hotCutoffDate = Effect.gen(function* () {
        const raw = yield* sql`
          SELECT latest_date FROM threads
          WHERE in_inbox = 1
          ORDER BY latest_date DESC
          LIMIT 1 OFFSET ${HOT_THREAD_COUNT - 1}
        `;
        const rows = yield* decodeDbCutoffs(raw).pipe(Effect.orDie);
        return firstRowOr(rows, (row) => row.latest_date, 0);
      });

      // Priority order: opened threads first, then the hot window newest-first.
      // Threads outside the window you never opened are never prefetched.
      const pendingImageThreadIds = (cutoffDate: number) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT id FROM threads
            WHERE images_cached_at = 0
              AND (images_used_at > 0 OR latest_date >= ${cutoffDate})
            ORDER BY images_used_at DESC, latest_date DESC
            LIMIT ${IMAGE_BATCH_THREADS}
          `;
          const rows = yield* decodeDbThreadIds(raw).pipe(Effect.orDie);
          return rows.map((row) => row.id);
        });

      // Bodies are the source and already local, so building the work list
      // costs no network.
      const uncachedImageUrls = (id: ThreadId) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT b.message_id, b.mime_type, b.data, b.codec
            FROM message_bodies b
            JOIN messages m ON m.id = b.message_id
            WHERE m.thread_id = ${id}
          `;
          const bodies = yield* decodeDbBodies(raw).pipe(Effect.orDie);

          // NOTE: A body that won't decompress costs its own images and
          // nothing more. This pass is an optimization and must never be the
          // thing that fails a sync.
          const referenced = yield* Effect.forEach(
            Arr.filter(bodies, (stored) => stored.mime_type === "text/html"),
            (stored) =>
              compression.decompress(stored).pipe(
                Effect.catchCause(() => Effect.succeed("")),
                Effect.map((body) =>
                  Arr.map(remoteImageUrls(body), (url): [string, MessageId] => [
                    url,
                    stored.message_id,
                  ]),
                ),
              ),
          ).pipe(Effect.map(Arr.flatten));

          // The first body to reference a url owns it, which is what `new Map`
          // would undo, so duplicates are dropped before it is built.
          const wanted = new Map(
            Arr.dedupeWith(referenced, ([left], [right]) => left === right),
          );

          // NOTE: `sql.in` with an empty list is a syntax error, and a thread
          // with no remote images at all is the common case.
          if (wanted.size === 0) {
            return [];
          }
          const knownRaw = yield* sql`
            SELECT url FROM message_images
            WHERE ${sql.in("message_id", [...new Set(wanted.values())])}
          `;
          const known = new Set(
            (yield* decodeDbUrls(knownRaw).pipe(Effect.orDie)).map(
              (row) => row.url,
            ),
          );

          return [...wanted]
            .filter(([url]) => !known.has(url))
            .map(([url, messageId]) => ({ url, messageId }));
        });

      const cacheThreadImages = (id: ThreadId) =>
        Effect.gen(function* () {
          const wanted = yield* uncachedImageUrls(id);
          const fetched = yield* Effect.forEach(
            wanted,
            ({ url, messageId }) =>
              imageFetcher.fetchImage(url).pipe(
                Effect.map(
                  Option.map((image) => ({
                    message_id: messageId,
                    url,
                    mime_type: image.mimeType,
                    bytes: image.bytes,
                  })),
                ),
              ),
            { concurrency: IMAGE_CONCURRENCY },
          ).pipe(Effect.map(Arr.getSomes));

          const cachedAt = yield* Clock.currentTimeMillis;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* Effect.forEach(
                fetched,
                (row) =>
                  sql`INSERT OR REPLACE INTO message_images ${sql.insert([row])}`,
                { discard: true },
              );
              // Stamped even when nothing was fetched: a thread whose images
              // are all dead links is *done*, and leaving it at 0 would put
              // it back at the head of the queue forever.
              yield* sql`
                UPDATE threads SET images_cached_at = ${cachedAt} WHERE id = ${id}
              `;
            }),
          );
        });

      // Outside the hot window only the OPENED_LRU_COUNT most recently opened
      // threads keep their images. Evicted threads reset to images_used_at = 0
      // so they leave the queue rather than churning back into it.
      // NOTE: Capped per cycle and one transaction. Selecting the whole cold
      // tail and opening a transaction per thread cost a worker round trip
      // each, which showed up as dropped frames every four seconds.
      const evictColdImages = (cutoffDate: number) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT id FROM threads
            WHERE images_cached_at > 0 AND latest_date < ${cutoffDate}
            ORDER BY images_used_at DESC, latest_date DESC
            LIMIT ${IMAGE_EVICT_BATCH} OFFSET ${OPENED_LRU_COUNT}
          `;
          const rows = yield* decodeDbThreadIds(raw).pipe(Effect.orDie);
          // NOTE: `sql.in` with an empty list is a syntax error.
          if (Arr.isReadonlyArrayEmpty(rows)) {
            return;
          }
          const ids = rows.map((row) => row.id);
          yield* sql.withTransaction(
            Effect.all([
              sql`
                DELETE FROM message_images WHERE message_id IN
                  (SELECT id FROM messages WHERE ${sql.in("thread_id", ids)})
              `,
              sql`
                UPDATE threads
                SET images_cached_at = 0, images_used_at = 0
                WHERE ${sql.in("id", ids)}
              `,
            ]),
          );
        });

      // NOTE: Requires a full window, not just an empty queue. Mid-backfill
      // the queue also runs dry, and claiming the recent window is ready there
      // would be a claim about threads not yet downloaded.
      const isHotWindowReady = (cutoffDate: number) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT
              (SELECT COUNT(*) FROM threads WHERE in_inbox = 1) AS total,
              (SELECT COUNT(*) FROM threads
                WHERE in_inbox = 1
                  AND latest_date >= ${cutoffDate}
                  AND images_cached_at = 0) AS pending
          `;
          const rows = yield* decodeDbWindowCounts(raw).pipe(Effect.orDie);
          return firstRowOr(
            rows,
            (row) => row.total >= HOT_THREAD_COUNT && row.pending === 0,
            false,
          );
        });

      const cacheImageBatch: Effect.Effect<ImageBatchResult, SqlError> =
        Effect.gen(function* () {
          const cutoffDate = yield* hotCutoffDate;
          const ids = yield* pendingImageThreadIds(cutoffDate);
          yield* Effect.forEach(ids, cacheThreadImages, { discard: true });
          yield* evictColdImages(cutoffDate);
          return {
            isIdle: Arr.isReadonlyArrayEmpty(ids),
            isRecentReady: yield* isHotWindowReady(cutoffDate),
          };
        });

      // READS

      // The whole store, newest first. VirtualList renders a fixed window
      // regardless of length, so the full mailbox rides in the model. Never
      // touches the network: filling the store is the sync machine's job.
      const loadInbox = Effect.gen(function* () {
        const raw = yield* sql`
          SELECT ${sql.literal(THREAD_ROW_COLUMNS)}
          FROM threads
          WHERE in_inbox = 1
          ORDER BY latest_date DESC
        `;
        return yield* decodeThreadRows(raw);
      });

      // The boot-only first read: the viewport's worth of rows in O(limit),
      // served by the (in_inbox, latest_date DESC) index. The full loadInbox
      // follows it and settles the list. Runs once per boot, which is what
      // makes it the right home for the boot-query bracket.
      const loadInboxTop = (limit: number) =>
        Effect.gen(function* () {
          yield* mark(BOOT_QUERY_START);
          const raw = yield* sql`
            SELECT ${sql.literal(THREAD_ROW_COLUMNS)}
            FROM threads
            WHERE in_inbox = 1
            ORDER BY latest_date DESC
            LIMIT ${limit}
          `;
          const rows = yield* decodeThreadRows(raw);
          yield* mark(BOOT_QUERY_END);
          yield* logBootReport(rows.length);
          return rows;
        });

      // Image bytes reach the html as blob: urls rather than data: URIs, since
      // inlining megabytes of base64 into the body string is slow and can OOM
      // the tab.
      //
      // NOTE: One registry for the whole engine, not one per thread. A blob:
      // url pins its bytes until revoked and only one thread is ever on
      // screen, so everything from the previous open is garbage the moment the
      // next one starts. Keying this by thread leaked every other thread's
      // images for the life of the tab, about a megabyte per thread opened.
      const liveObjectUrls = yield* Ref.make<ReadonlyArray<string>>([]);

      const revokeObjectUrls = Ref.getAndSet(liveObjectUrls, []).pipe(
        Effect.flatMap((urls) =>
          Effect.sync(() => {
            urls.forEach(URL.revokeObjectURL);
          }),
        ),
      );

      const registerObjectUrl = (
        mimeType: string,
        bytes: Uint8Array,
      ): Effect.Effect<string> =>
        Effect.gen(function* () {
          const url = URL.createObjectURL(
            new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
          );
          yield* Ref.update(liveObjectUrls, Arr.append(url));
          return url;
        });

      // Opening a thread: SQLite only.
      const loadThread = (id: ThreadId) =>
        Effect.gen(function* () {
          const subjectRaw = yield* sql`
            SELECT subject FROM threads WHERE id = ${id}
          `;
          const subjects = yield* decodeDbSubjects(subjectRaw).pipe(
            Effect.orDie,
          );
          const subject = firstRowOr(subjects, (row) => row.subject, "");

          const rowsRaw = yield* sql`
            SELECT id, internal_date, from_name, from_email
            FROM messages
            WHERE thread_id = ${id}
            ORDER BY internal_date ASC
          `;
          const rows = yield* decodeDbMessages(rowsRaw).pipe(Effect.orDie);

          yield* revokeObjectUrls;

          const messages = yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const bodyRaw = yield* sql`
                SELECT message_id, mime_type, data, codec
                FROM message_bodies
                WHERE message_id = ${row.id}
              `;
              const maybeStored = Arr.head(
                yield* decodeDbBodies(bodyRaw).pipe(Effect.orDie),
              );
              const imagesRaw = yield* sql`
                SELECT message_id, content_id, mime_type, bytes
                FROM message_attachments
                WHERE message_id = ${row.id}
              `;
              const images = yield* decodeDbImages(imagesRaw).pipe(
                Effect.orDie,
              );
              const remoteRaw = yield* sql`
                SELECT url, mime_type, bytes
                FROM message_images
                WHERE message_id = ${row.id}
              `;
              const remote = yield* decodeDbRemoteImages(remoteRaw).pipe(
                Effect.orDie,
              );

              // Decompressed first: the cid: rewrite below is a string
              // replacement and this is where the string comes from.
              const decompressed = yield* Option.match(maybeStored, {
                onNone: () => Effect.succeed(""),
                onSome: (stored) => compression.decompress(stored),
              });

              const inlineBlobs = yield* Effect.forEach(images, (image) =>
                registerObjectUrl(image.mime_type, image.bytes).pipe(
                  Effect.map((url): [string, string] => [
                    `cid:${image.content_id}`,
                    url,
                  ]),
                ),
              );
              const inlined = Arr.reduce(
                inlineBlobs,
                decompressed,
                (body, [token, url]) => body.replaceAll(token, url),
              );

              // Cached remote images become blobs too, so the render is local
              // and the sender's tracking pixels never fire on open. Uncached
              // urls are left alone and load live, which is what keeps a cold
              // thread readable rather than half-broken.
              const remoteBlobs = yield* Effect.forEach(remote, (image) =>
                registerObjectUrl(image.mime_type, image.bytes).pipe(
                  Effect.map((url): [string, string] => [image.url, url]),
                ),
              );

              return {
                id: row.id,
                fromName: row.from_name,
                fromEmail: row.from_email,
                date: row.internal_date,
                bodyKind: Option.match(maybeStored, {
                  onNone: (): BodyKind => "plain",
                  onSome: ({ mime_type }): BodyKind =>
                    mime_type === "text/html" ? "html" : "plain",
                }),
                body: rewriteImageUrls(inlined, new Map(remoteBlobs)),
              } satisfies MessageDetail;
            }),
          );

          // The LRU stamp, and the only way a thread outside the hot window
          // ever enters the image queue: opening it is the signal that its
          // images are worth keeping. The next batch picks it up, so this
          // open renders remote images live and every later one is local.
          const usedAt = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE threads SET images_used_at = ${usedAt} WHERE id = ${id}
          `;

          return { id, subject, messages } satisfies ThreadDetail;
        });

      return {
        cacheImageBatch,
        loadInbox,
        loadInboxTop,
        loadThread,
        localSizeBytes,
        readCheckpoint,
        primeInbox,
        syncBatch,
        applyHistory,
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Gmail.layer,
        SqlLive,
        Compression.layer,
        ImageFetcher.layer,
      ),
    ),
  );
}

export type LoadInboxError = SqlError;
// Decompression is in this path and can fail on bytes that don't match their
// stored codec. That surfaces as FailedLoadThread rather than dying: a single
// corrupt body should cost you that thread, not the app.
export type LoadThreadError = SqlError | CompressionError;
