// A localStorage copy of the top of the inbox list, the list-shaped sibling
// of auth.ts's session cache: it only buys the returning visit a first paint
// with real rows. SQLite remains the authority — the boot LoadInbox reconciles
// over the seed the moment it lands.

import { Effect, Option, Schema as S } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { Command } from "foldkit";
import { m } from "foldkit/message";

import { sessionStorageLayer } from "./auth";
import { ThreadRow } from "./sync";

// VirtualList paints ~30 rows; 50 covers the viewport with margin while
// keeping the synchronous localStorage read a few KB.
export const SNAPSHOT_ROW_COUNT = 50;

const SNAPSHOT_STORAGE_KEY = "parcel-inbox-snapshot";

/** `email` scopes the seed: a snapshot from another account is no seed. */
export const InboxSnapshot = S.Struct({
  email: S.String,
  rows: S.Array(ThreadRow),
});
export type InboxSnapshot = typeof InboxSnapshot.Type;

export const CompletedSnapshotPersistence = m("CompletedSnapshotPersistence");

const snapshotStore = Effect.map(KeyValueStore.KeyValueStore, (store) =>
  KeyValueStore.toSchemaStore(store, InboxSnapshot),
);

// NOTE: Runs pre-boot as part of `flags`, before the runtime's `resources`
// exist, so it provides its own layer instead of using the R channel. A
// corrupt or unreadable cache is the same as no cache. The Commands below
// self-provide too, keeping all three off the resources requirement.
export const readStoredSnapshot: Effect.Effect<Option.Option<InboxSnapshot>> =
  snapshotStore.pipe(
    Effect.flatMap((store) => store.get(SNAPSHOT_STORAGE_KEY)),
    Effect.catch(() => Effect.succeedNone),
    Effect.provide(sessionStorageLayer),
  );

/** Best-effort, like SaveSession: a failed write only costs the next visit
 *  its instant list paint. Only the top slice is stored. */
export const SaveSnapshot = Command.define(
  "SaveSnapshot",
  { snapshot: InboxSnapshot },
  CompletedSnapshotPersistence,
)(({ snapshot }) =>
  snapshotStore.pipe(
    Effect.flatMap((store) =>
      store.set(SNAPSHOT_STORAGE_KEY, {
        email: snapshot.email,
        rows: snapshot.rows.slice(0, SNAPSHOT_ROW_COUNT),
      }),
    ),
    Effect.tapError((error) =>
      Effect.logWarning("inbox snapshot write failed", error),
    ),
    Effect.ignore,
    Effect.provide(sessionStorageLayer),
    Effect.as(CompletedSnapshotPersistence()),
  ),
);

/** Issued alongside ClearSession on sign-out, so the next visitor's first
 *  paint can't show the previous account's mail. */
export const ClearSnapshot = Command.define(
  "ClearSnapshot",
  CompletedSnapshotPersistence,
)(
  snapshotStore.pipe(
    Effect.flatMap((store) => store.remove(SNAPSHOT_STORAGE_KEY)),
    Effect.tapError((error) =>
      Effect.logWarning("inbox snapshot eviction failed", error),
    ),
    Effect.ignore,
    Effect.provide(sessionStorageLayer),
    Effect.as(CompletedSnapshotPersistence()),
  ),
);
