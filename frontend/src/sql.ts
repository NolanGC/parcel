import * as SqliteClient from "@effect/sql-sqlite-wasm/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-wasm/SqliteMigrator";
import { Effect, Layer } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";

// NOTE: The standards-based worker form, not a `?worker` import. Vite detects
// this exact `new Worker(new URL(...), import.meta.url)` pattern and bundles
// the worker, while bun (which imports this module tree for the landing-page
// prerender) parses it as plain code rather than choking on a `?worker`
// specifier. The worker is only constructed when the layer builds, which the
// prerender never does.
const ClientLive = SqliteClient.layer({
  worker: Effect.acquireRelease(
    Effect.sync(
      () =>
        new Worker(new URL("./worker.ts", import.meta.url), {
          type: "module",
        }),
    ),
    (worker) => Effect.sync(() => worker.terminate()),
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
    // `satisfies` only pins the key format; the migrator infers the values.
  } satisfies Record<`${number}_${string}`, unknown>),
}).pipe(Layer.provideMerge(ClientLive));
