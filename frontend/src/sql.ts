import * as SqliteClient from "@effect/sql-sqlite-wasm/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-wasm/SqliteMigrator";
import { Effect, Layer } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";

// `?worker` to import as a module (`vite`)
import SqlWorker from "./worker?worker";

const ClientLive = SqliteClient.layer({
  worker: Effect.acquireRelease(
    Effect.sync(() => new SqlWorker()),
    (worker) => Effect.sync(() => worker.terminate()),
  ),
});

// Local mailbox store. Normalized around the two access patterns that
// matter: the inbox list (one indexed query over `threads`, no bodies
// touched) and opening a thread (its `messages` rows + `message_bodies`
// decompressed on demand). Everything the UI sorts or filters on is a
// real column extracted once at sync time — raw API JSON is never stored.
export const SqlLive = SqliteMigrator.layer({
  loader: Migrator.fromRecord({
    "0001_create_tables": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // The sync engine's persistent state. Single-row with typed columns
      // (CHECK makes "exactly one sync state" a database invariant); NULLs
      // mean "not yet synced", and the row maps 1:1 onto a schema struct
      // at the read boundary.
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
      // paint lives here. latest_date is epoch milliseconds (Gmail's
      // internalDate string converted at write time — string ordering
      // misorders across digit counts). participants is a JSON array of
      // { name, email } for the "From" column.
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

      // Junction table (not a JSON column) because label membership is
      // the core list query — "INBOX ∩ UNREAD" needs an index.
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
      // in. body holds the displayable content (decoded from base64url
      // MIME at sync time), compressed per the Compression service;
      // codec ('gzip' | 'none') makes each row self-describing, so the
      // small-body threshold can change without a migration.
      yield* sql`
        CREATE TABLE message_bodies (
          message_id TEXT PRIMARY KEY REFERENCES messages (id),
          mime_type TEXT NOT NULL,
          codec TEXT NOT NULL,
          body BLOB NOT NULL
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
    }),
  } satisfies Record<`${number}_${string}`, any>),
}).pipe(Layer.provideMerge(ClientLive));
