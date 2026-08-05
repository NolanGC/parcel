import * as SqliteClient from "@effect/sql-sqlite-wasm/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-wasm/SqliteMigrator";
import { Effect, Layer } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";

import { BOOT_WORKER_SPAWN, markNow } from "./bootMarks";

// NOTE: The standards-based worker form, not a `?worker` import. Vite detects
// this exact `new Worker(new URL(...), import.meta.url)` pattern and bundles
// the worker, while bun (which imports this module tree for the landing-page
// prerender) parses it as plain code rather than choking on a `?worker`
// specifier.
//
// The worker runs its whole boot (wasm fetch + compile, OPFS handle pool,
// open) the moment it starts, so it is spawned at module eval rather than at
// layer build: that work overlaps bundle eval and the first paint instead of
// following them.
//
// The globalThis slot (rather than module state) is what survives HMR, and
// what makes "at most one database worker per tab" enforceable. That bound is
// not a tidiness preference: the OPFS access handles a worker opens are
// EXCLUSIVE, so a second live worker cannot open the database at all, and each
// leaked one holds a wa-sqlite instance until the tab runs out of memory.
//
// NOTE: Hence `replaceWorker` rather than a bare spawn. A runtime rebuild that
// never released its worker (every HMR cycle in dev) would otherwise leave the
// old one running while the new one fails to acquire the pool.
const workerGlobal = globalThis as { __parcelDbWorker?: Worker };

const replaceWorker = (): Worker => {
  workerGlobal.__parcelDbWorker?.terminate();
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  workerGlobal.__parcelDbWorker = worker;
  markNow(BOOT_WORKER_SPAWN);
  return worker;
};

// NOTE: OPFS, not `typeof Worker`, is the guard. bun defines a Worker global
// (with or without happy-dom registered), so a Worker check does not keep the
// landing-page prerender from eagerly spawning a database worker that has no
// OPFS to open — it would fail asynchronously inside the worker and survive
// only because prerender's process.exit wins the race. `getDirectory` is the
// exact capability AccessHandlePoolVFS needs, so testing for it is the honest
// question: can a database worker actually boot here?
const canOpenOpfs =
  typeof navigator !== "undefined" &&
  typeof navigator.storage?.getDirectory === "function";

// The eager spawn: the head start that lets the worker's wasm compile and OPFS
// open overlap bundle eval and the first paint. The first layer build claims
// it; any later build replaces it rather than racing it for the handles.
const maybeEagerWorker =
  canOpenOpfs && workerGlobal.__parcelDbWorker === undefined
    ? replaceWorker()
    : undefined;

const ClientLive = SqliteClient.layer({
  worker: Effect.acquireRelease(
    Effect.sync(() =>
      maybeEagerWorker !== undefined &&
      workerGlobal.__parcelDbWorker === maybeEagerWorker
        ? maybeEagerWorker
        : replaceWorker(),
    ),
    (worker) =>
      Effect.sync(() => {
        worker.terminate();
        if (workerGlobal.__parcelDbWorker === worker) {
          delete workerGlobal.__parcelDbWorker;
        }
      }),
  ),
});

// Local mailbox store. Everything the UI sorts or filters on is a real
// column extracted once at sync time — raw API JSON is never stored.
export const SqlLive = SqliteMigrator.layer({
  loader: Migrator.fromRecord({
    "0001_create_tables": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // The sync engine's persistent state, a single row by CHECK.
      // NULLs mean "not yet synced".
      yield* sql`
        CREATE TABLE sync_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          history_id TEXT,
          email TEXT,
          last_synced_at INTEGER
        )
      `;

      yield* sql`
        CREATE TABLE labels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'user',
          messages_total INTEGER,
          messages_unread INTEGER,
          threads_total INTEGER,
          threads_unread INTEGER
        )
      `;

      // Denormalized for the list view: everything the inbox needs to
      // paint lives here. latest_date is epoch milliseconds; participants
      // is a JSON array of sender names.
      yield* sql`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          history_id TEXT,
          subject TEXT NOT NULL DEFAULT '',
          snippet TEXT NOT NULL DEFAULT '',
          participants TEXT NOT NULL DEFAULT '[]',
          latest_date INTEGER NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0,
          is_unread INTEGER NOT NULL DEFAULT 0,
          category TEXT NOT NULL DEFAULT 'none'
        )
      `;
      yield* sql`
        CREATE INDEX threads_latest_date ON threads (latest_date DESC)
      `;

      // Headers are extracted once at sync time, not parsed per render.
      yield* sql`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads (id),
          internal_date INTEGER NOT NULL DEFAULT 0,
          from_name TEXT NOT NULL DEFAULT '',
          from_email TEXT NOT NULL DEFAULT '',
          to_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          snippet TEXT NOT NULL DEFAULT '',
          has_attachments INTEGER NOT NULL DEFAULT 0
        )
      `;
      yield* sql`
        CREATE INDEX messages_thread ON messages (thread_id, internal_date)
      `;

      yield* sql`
        CREATE TABLE message_labels (
          message_id TEXT NOT NULL REFERENCES messages (id),
          label_id TEXT NOT NULL,
          PRIMARY KEY (message_id, label_id)
        )
      `;
      yield* sql`
        CREATE INDEX message_labels_label ON message_labels (label_id, message_id)
      `;

      // Bodies live apart from messages so list queries never page them
      // in. body holds the displayable content, decoded from base64url
      // MIME at sync time.
      yield* sql`
        CREATE TABLE message_bodies (
          message_id TEXT PRIMARY KEY REFERENCES messages (id),
          mime_type TEXT NOT NULL,
          body TEXT NOT NULL
        )
      `;

      // Outbound mutation queue: local writes (archive, read, send) land
      // here first, apply optimistically to the tables above, and drain
      // to Gmail when connectivity and scopes allow.
      yield* sql`
        CREATE TABLE outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0
        )
      `;

      // Inline images (MIME parts with a Content-ID) fetched at sync time.
      // content_id is stored without its RFC angle brackets — exactly what
      // the html references as cid:<content_id>.
      yield* sql`
        CREATE TABLE message_attachments (
          message_id TEXT NOT NULL REFERENCES messages (id),
          content_id TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          bytes BLOB NOT NULL,
          PRIMARY KEY (message_id, content_id)
        )
      `;
    }),

    // Backfill progress for the sync machine's checkpoint: counts drive the
    // toolbar pill across refreshes, backfill_done gates the boot-time entry
    // state (Backfilling vs CatchingUp).
    "0002_sync_checkpoint": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE sync_state ADD COLUMN synced_count INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE sync_state ADD COLUMN total_estimate INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE sync_state ADD COLUMN backfill_done INTEGER NOT NULL DEFAULT 0`;
    }),

    // Whether a thread is still in the INBOX. Without this the list showed
    // every thread ever synced: archiving removes the INBOX label, which
    // reaches us as a change on the thread, so the row was updated and kept.
    // Defaults to 1 so nothing disappears on upgrade; existing rows are
    // corrected as applyHistory touches them.
    // NOTE: Numbered 0004, skipping 0003. The vector-search branch owns
    // 0003_thread_vectors, and the migrator skips any id <= the highest
    // already applied, so reusing 0003 would silently no-op on a database that
    // had run that branch.
    "0004_thread_inbox_membership": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE threads ADD COLUMN in_inbox INTEGER NOT NULL DEFAULT 1`;
      yield* sql`CREATE INDEX threads_inbox ON threads (in_inbox, latest_date DESC)`;
    }),

    // Bodies become gzip bytes: they are ~91% of the store and compress ~6.5x,
    // which is what makes keeping every body affordable. See docs/caching.md.
    // NOTE: SQLite can't retype a column, hence the rebuild. Existing rows
    // carry over as codec 'none' because CAST(body AS BLOB) yields the text's
    // UTF-8 bytes, so they decode through the same path as new rows and no
    // legacy branch is needed. They turn into gzip as threads re-sync.
    "0005_compress_message_bodies": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE message_bodies_v2 (
          message_id TEXT PRIMARY KEY REFERENCES messages (id),
          mime_type TEXT NOT NULL,
          data BLOB NOT NULL,
          codec TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO message_bodies_v2 (message_id, mime_type, data, codec)
        SELECT message_id, mime_type, CAST(body AS BLOB), 'none'
        FROM message_bodies
      `;
      yield* sql`DROP TABLE message_bodies`;
      yield* sql`ALTER TABLE message_bodies_v2 RENAME TO message_bodies`;
    }),

    // Remote images, cached so mail renders instantly and offline, and so
    // opening a mail stops firing its tracking pixels. Distinct from
    // message_attachments: those are inline MIME parts arriving with the
    // message, these are urls fetched from the sender's CDN through the API
    // worker's proxy. See images.ts and docs/caching.md.
    // NOTE: Unlike bodies these are tiered, because hydrating every image is
    // ~280,000 fetches and several gigabytes. The two thread columns are what
    // make the tier decidable without a second table: images_cached_at is the
    // work queue (0 = pending), images_used_at the LRU stamp (0 = never).
    "0006_remote_images": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE message_images (
          message_id TEXT NOT NULL REFERENCES messages (id),
          url TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          bytes BLOB NOT NULL,
          PRIMARY KEY (message_id, url)
        )
      `;
      yield* sql`ALTER TABLE threads ADD COLUMN images_cached_at INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE threads ADD COLUMN images_used_at INTEGER NOT NULL DEFAULT 0`;
      // The image pass's queue query, in one index: pending threads, newest
      // first. Without it every batch is a full scan of the threads table
      // against a column that is 0 for almost every row.
      yield* sql`
        CREATE INDEX threads_images_pending
        ON threads (images_cached_at, latest_date DESC)
      `;
    }),

    // Outgoing actions. Three separate needs, one migration because they
    // arrive with the same feature (see outboxEngine.ts):
    //
    //  - is_starred: the one flag the list can show that wasn't extracted
    //    yet. Defaults to 0 and is recomputed from the STARRED label as
    //    threads re-sync, exactly like is_unread.
    //  - The reply headers: RFC 2822 threading is In-Reply-To/References,
    //    which have to come from the message being replied to. Rows written
    //    before this migration carry '', and a reply to one threads on
    //    Gmail's threadId alone until that thread next re-syncs.
    //  - outbox status/last_error: a permanently failed send is kept rather
    //    than dropped, so the composed body survives for a retry. Label ops
    //    never reach 'failed' — they roll back and delete themselves.
    "0007_outgoing_actions": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE threads ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE messages ADD COLUMN rfc822_message_id TEXT NOT NULL DEFAULT ''`;
      yield* sql`ALTER TABLE messages ADD COLUMN references_header TEXT NOT NULL DEFAULT ''`;
      yield* sql`ALTER TABLE outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`;
      yield* sql`ALTER TABLE outbox ADD COLUMN last_error TEXT NOT NULL DEFAULT ''`;
      // The drain's queue query — oldest pending op first — and the anti-clobber
      // read in syncThreads, which scans every pending op on each chunk commit.
      yield* sql`CREATE INDEX outbox_pending ON outbox (status, id)`;
    }),
    // Real mailboxes beyond the inbox. The four flags are the system labels
    // the folder dropdown serves — sent, drafts, spam, trash (inbox and
    // starred already have columns) — recomputed from the thread's labels on
    // every sync exactly like is_unread.
    //
    // NOTE: The data wipe is deliberate. Until now the backfill only ever
    // listed INBOX, so the store holds no sent/draft/spam/trash threads, and
    // the skip-scan resume treats "we have this id" as "complete" — existing
    // rows would keep these flags stuck at 0 forever. Emptying the mail
    // tables and the checkpoint makes the next boot re-prime and walk the
    // whole mailbox with the flags in place. The outbox survives: queued
    // user actions must not be lost to a schema upgrade.
    "0008_mailbox_folders": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE threads ADD COLUMN is_sent INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE threads ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE threads ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE threads ADD COLUMN is_trash INTEGER NOT NULL DEFAULT 0`;
      yield* Effect.forEach(
        [
          "message_attachments",
          "message_images",
          "message_bodies",
          "message_labels",
          "messages",
          "threads",
          "sync_state",
        ],
        (table) => sql`DELETE FROM ${sql.literal(table)}`,
        { discard: true },
      );
    }),
    // Sender avatars: a face for people, a logo for companies, the letter
    // tile for everyone else. See avatars.ts for how a sender resolves to a
    // key and sync.ts for the pass that fills this in.
    //
    // NOTE: One table for both sources rather than one per source, because
    // the read is always the same question — "is there an image for this
    // key?" — and `key` already says which kind it is. `is_missing` is the
    // negative cache and is not optional: most domains have no reachable
    // favicon, and without a row saying so every one of them is retried on
    // every pass, forever.
    //
    // NOTE: `sender_email` is a new column on threads, and the wipe is what
    // populates it. The backfill's skip-scan treats a stored id as complete
    // (see unseenThreadIds), so existing rows would keep an empty address and
    // never get an avatar. Same reasoning as 0008, and safe in either order:
    // if 0008 has already run, these tables are empty and this wipe is a
    // no-op. The outbox and the avatars survive — queued user actions must
    // not be lost to a schema upgrade, and avatar bytes are expensive to
    // refetch and outlive any single mailbox walk.
    "0009_sender_avatars": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE threads ADD COLUMN sender_email TEXT NOT NULL DEFAULT ''`;
      yield* sql`ALTER TABLE sync_state ADD COLUMN people_synced_at INTEGER NOT NULL DEFAULT 0`;
      yield* sql`
        CREATE TABLE avatars (
          key TEXT PRIMARY KEY,
          bytes BLOB,
          mime_type TEXT NOT NULL DEFAULT '',
          is_missing INTEGER NOT NULL DEFAULT 0,
          fetched_at INTEGER NOT NULL
        )
      `;
      yield* Effect.forEach(
        [
          "message_attachments",
          "message_images",
          "message_bodies",
          "message_labels",
          "messages",
          "threads",
          "sync_state",
        ],
        (table) => sql`DELETE FROM ${sql.literal(table)}`,
        { discard: true },
      );
    }),
    // A second rendition of every html body, converted to markdown once at
    // sync time so opening a message is a decompress and a markdown parse
    // rather than a DOMPurify pass over a hundred kilobytes of table layout.
    // The html stays: it is what the image pass reads urls out of, what a
    // future converter change would re-run against, and the fallback while
    // this column is still filling.
    //
    // NOTE: Nullable, and the null is the work queue — the same trick as
    // images_cached_at in 0006, without a column of its own. Rows written
    // before this migration have no markdown and are picked up by the
    // backfill loop (convertMarkdownBatch in sync.ts); until then they open
    // through the html path, which is exactly what they did yesterday. No
    // wipe: bodies are the expensive thing in the store and refetching 30k of
    // them to add a derived column would be absurd.
    "0010_markdown_bodies": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE message_bodies ADD COLUMN markdown BLOB`;
      yield* sql`ALTER TABLE message_bodies ADD COLUMN markdown_codec TEXT`;
      // Partial: the index holds only what is left to do, so it shrinks to
      // nothing as the backfill drains rather than carrying a row per body.
      yield* sql`
        CREATE INDEX message_bodies_markdown_pending
        ON message_bodies (message_id)
        WHERE markdown IS NULL AND mime_type = 'text/html'
      `;
    }),
    // `satisfies` only pins the key format; the migrator infers the values.
  } satisfies Record<`${number}_${string}`, unknown>),
}).pipe(Layer.provideMerge(ClientLive));
