// The inbox snapshot: a localStorage copy of the top of the inbox list, the
// list-shaped sibling of auth.ts's session cache. It only buys the returning
// visit a first paint with real rows; SQLite remains the authority — the boot
// LoadInbox reconciles over the seed the moment it lands.
//
// The read/write Commands (readStoredSnapshot / SaveSnapshot / ClearSnapshot)
// live in services/preferences.ts; this file keeps the schema and the message.

import { Schema as S } from "effect";
import { m } from "foldkit/message";

import { ThreadRow } from "./sync";

// VirtualList paints ~30 rows; 50 covers the viewport with margin while
// keeping the synchronous localStorage read a few KB.
export const SNAPSHOT_ROW_COUNT = 50;

export const SNAPSHOT_STORAGE_KEY = "parcel-inbox-snapshot";

/** `email` scopes the seed: a snapshot from another account is no seed. */
export const InboxSnapshot = S.Struct({
  email: S.String,
  rows: S.Array(ThreadRow),
});
export type InboxSnapshot = typeof InboxSnapshot.Type;

export const CompletedSnapshotPersistence = m("CompletedSnapshotPersistence");
