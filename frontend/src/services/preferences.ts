// The Preferences service: every localStorage-backed preference, behind ONE
// Effect service with a single injected `KeyValueStore` dependency.
//
// Previously session (auth.ts), inbox snapshot (inboxSnapshot.ts) and
// appearance/reading-mode (settings.ts) each hand-rolled the same pattern —
// `Effect.map(KeyValueStore, toSchemaStore).pipe(Effect.provide(...))` — a
// total of 14 scattered self-provides. Here the store is a real dependency
// injected once at Layer build; the Commands just `yield* Preferences`.
//
// Reads run pre-boot (in `flags`) before the runtime's resources exist, so
// they self-provide `LivePreferences`; the Commands run inside the runtime
// and take Preferences from the graph (`AppResources`).

import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { Command } from "foldkit";

import {
  Session,
  CompletedSessionPersistence,
  SESSION_STORAGE_KEY,
  sessionStorageLayer,
} from "../auth";
import {
  InboxSnapshot,
  CompletedSnapshotPersistence,
  SNAPSHOT_STORAGE_KEY,
  SNAPSHOT_ROW_COUNT,
} from "../inboxSnapshot";
import {
  Appearance,
  DEFAULT_APPEARANCE,
  ReadingMode,
  DEFAULT_READING_MODE,
  CompletedSettingsPersistence,
  APPEARANCE_STORAGE_KEY,
  READING_MODE_STORAGE_KEY,
} from "../settings";

// SERVICE SHAPE

export type PreferencesShape = Readonly<{
  readSession: () => Effect.Effect<Option.Option<Session>>;
  saveSession: (session: Session) => Effect.Effect<void>;
  clearSession: () => Effect.Effect<void>;
  readSnapshot: () => Effect.Effect<Option.Option<InboxSnapshot>>;
  saveSnapshot: (snapshot: InboxSnapshot) => Effect.Effect<void>;
  clearSnapshot: () => Effect.Effect<void>;
  readAppearance: () => Effect.Effect<Appearance>;
  saveAppearance: (appearance: Appearance) => Effect.Effect<void>;
  readReadingMode: () => Effect.Effect<ReadingMode>;
  saveReadingMode: (mode: ReadingMode) => Effect.Effect<void>;
}>;

export class Preferences extends Context.Service<Preferences, PreferencesShape>()(
  "parcel/Preferences",
  {
    make: Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const session = KeyValueStore.toSchemaStore(kv, Session);
      const snapshot = KeyValueStore.toSchemaStore(kv, InboxSnapshot);
      const appearance = KeyValueStore.toSchemaStore(kv, Appearance);
      const readingMode = KeyValueStore.toSchemaStore(kv, ReadingMode);

      const getMaybe = <E, A>(get: Effect.Effect<Option.Option<A>, E>): Effect.Effect<Option.Option<A>> =>
        get.pipe(Effect.catch(() => Effect.succeedNone));

      return {
        readSession: () => getMaybe(session.get(SESSION_STORAGE_KEY)),
        saveSession: (v: Session) =>
          session.set(SESSION_STORAGE_KEY, v).pipe(Effect.ignore),
        clearSession: () => session.remove(SESSION_STORAGE_KEY).pipe(Effect.ignore),
        readSnapshot: () => getMaybe(snapshot.get(SNAPSHOT_STORAGE_KEY)),
        saveSnapshot: (v: InboxSnapshot) =>
          snapshot
            .set(SNAPSHOT_STORAGE_KEY, {
              email: v.email,
              rows: v.rows.slice(0, SNAPSHOT_ROW_COUNT),
            })
            .pipe(Effect.ignore),
        clearSnapshot: () => snapshot.remove(SNAPSHOT_STORAGE_KEY).pipe(Effect.ignore),
        readAppearance: () =>
          getMaybe(appearance.get(APPEARANCE_STORAGE_KEY)).pipe(
            Effect.map(Option.getOrElse(() => DEFAULT_APPEARANCE)),
          ),
        saveAppearance: (v: Appearance) =>
          appearance.set(APPEARANCE_STORAGE_KEY, v).pipe(Effect.ignore),
        readReadingMode: () =>
          getMaybe(readingMode.get(READING_MODE_STORAGE_KEY)).pipe(
            Effect.map(Option.getOrElse(() => DEFAULT_READING_MODE)),
          ),
        saveReadingMode: (v: ReadingMode) =>
          readingMode.set(READING_MODE_STORAGE_KEY, v).pipe(Effect.ignore),
      };   }),
  },
) {}

/** The production layer: Preferences over the browser's localStorage. */
export const LivePreferences: Layer.Layer<Preferences> = Layer.effect(
  Preferences,
  Preferences.make,
).pipe(Layer.provide(sessionStorageLayer));

// BOOT READS (self-provide; run before runtime resources exist)

export const readStoredSession: Effect.Effect<Option.Option<Session>> =
  Effect.gen(function* () {
    const p = yield* Preferences;
    return yield* p.readSession();
  }).pipe(Effect.provide(LivePreferences));

export const readStoredSnapshot: Effect.Effect<Option.Option<InboxSnapshot>> =
  Effect.gen(function* () {
    const p = yield* Preferences;
    return yield* p.readSnapshot();
  }).pipe(Effect.provide(LivePreferences));

export const readStoredAppearance: Effect.Effect<Appearance> =
  Effect.gen(function* () {
    const p = yield* Preferences;
    return yield* p.readAppearance();
  }).pipe(Effect.provide(LivePreferences));

export const readStoredReadingMode: Effect.Effect<ReadingMode> =
  Effect.gen(function* () {
    const p = yield* Preferences;
    return yield* p.readReadingMode();
  }).pipe(Effect.provide(LivePreferences));

// COMMANDS

export const SaveSession = Command.define(
  "SaveSession",
  { session: Session },
  CompletedSessionPersistence,
)(({ session }) =>
  Effect.gen(function* () {
    const p = yield* Preferences;
    yield* p.saveSession(session);
    return CompletedSessionPersistence();
  }),
);

export const ClearSession = Command.define(
  "ClearSession",
  CompletedSessionPersistence,
)(
  Effect.gen(function* () {
    const p = yield* Preferences;
    yield* p.clearSession();
    return CompletedSessionPersistence();
  }),
);

export const SaveSnapshot = Command.define(
  "SaveSnapshot",
  { snapshot: InboxSnapshot },
  CompletedSnapshotPersistence,
)(({ snapshot }) =>
  Effect.gen(function* () {
    const p = yield* Preferences;
    yield* p.saveSnapshot(snapshot);
    return CompletedSnapshotPersistence();
  }),
);

export const ClearSnapshot = Command.define(
  "ClearSnapshot",
  CompletedSnapshotPersistence,
)(
  Effect.gen(function* () {
    const p = yield* Preferences;
    yield* p.clearSnapshot();
    return CompletedSnapshotPersistence();
  }),
);

export const SaveAppearance = Command.define(
  "SaveAppearance",
  { appearance: Appearance },
  CompletedSettingsPersistence,
)(({ appearance }) =>
  Effect.gen(function* () {
    const p = yield* Preferences;
    yield* p.saveAppearance(appearance);
    return CompletedSettingsPersistence();
  }),
);

export const SaveReadingMode = Command.define(
  "SaveReadingMode",
  { mode: ReadingMode },
  CompletedSettingsPersistence,
)(({ mode }) =>
  Effect.gen(function* () {
    const p = yield* Preferences;
    yield* p.saveReadingMode(mode);
    return CompletedSettingsPersistence();
  }),
);
