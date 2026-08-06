// A scripted, in-memory SyncEngine for end-to-end tests.
//
// The machine depends on the SyncEngine *service tag* — an interface. In
// tests we provide a fake implementation behind that same tag, the way
// Effect layers are meant to be used: the consumer never knows it isn't
// the real engine, and the whole graph keeps running with real Layer
// composition.
//
// The value is built with `SyncEngine.of(...)`, which TYPE-CHECKS the fake
// against the service shape — no `as never` cast, so a drift between the
// fake and the real interface is a compile error, not a runtime surprise.

import { Effect, Layer, Option } from "effect";
import { HistoryId, PageToken, ThreadId } from "../../Gmail";
import { SyncEngine } from "../../sync";
import type { BatchResult, HistoryResult, PrimeResult, SyncCheckpoint } from "../../sync";

/** What the fake returns for each pass. Scripted by the test. */
export type SyncScript = Readonly<{
  /** The persisted checkpoint the boot read reports. */
  checkpoint: Option.Option<SyncCheckpoint>;
  /** primeInbox result. */
  prime: PrimeResult;
  /** The sequence of pages one backfill walk produces. */
  batches: ReadonlyArray<BatchResult>;
  /** What applyHistory resolves to. */
  history: HistoryResult;
}>;

const applied = (
  historyId = HistoryId.make("h-100"),
  changedCount = 0,
  syncedAt = 0,
): HistoryResult => ({
  _tag: "Applied",
  historyId,
  changedCount,
  syncedAt,
} as HistoryResult);

export const defaultScript = (): SyncScript => ({
  checkpoint: Option.none(),
  prime: {
    historyId: HistoryId.make("h-prime"),
    syncedCount: 1,
    totalEstimate: 3,
  },
  batches: [{ syncedCount: 3, maybeNextPageToken: Option.none() }],
  history: applied(),
});

/** Build a SyncEngine value from a script (type-checked via SyncEngine.of). */
export const makeFakeSyncEngine = (script: SyncScript = defaultScript()) => {
  let batchIndex = 0;
  return SyncEngine.of({
    readCheckpoint: (
      _accountEmail: string,
    ): Effect.Effect<Option.Option<SyncCheckpoint>, never> => Effect.succeed(script.checkpoint),
    primeInbox: Effect.succeed(script.prime),
    syncBatch: (
      _maybePageToken: Option.Option<PageToken>,
      _previousCount: number,
    ): Effect.Effect<BatchResult, never> =>
      Effect.sync(() => {
        const last = script.batches[script.batches.length - 1] ?? {
          syncedCount: 0,
          maybeNextPageToken: Option.none(),
        };
        return script.batches[Math.min(batchIndex, script.batches.length - 1)] ?? last;
      }),
    applyHistory: (
      _startHistoryId: HistoryId,
    ): Effect.Effect<HistoryResult, never> => Effect.succeed(script.history),
    loadInbox: Effect.succeed([]),
    loadInboxTop: (_limit: number) => Effect.succeed([]),
    loadThread: (_id: ThreadId) => Effect.die("FakeSyncEngine.loadThread not exercised"),
    localSizeBytes: Effect.succeed(0),
    cacheImageBatch: Effect.succeed({ isIdle: true, isRecentReady: false }),
  });
}

/** A Layer providing the fake SyncEngine — the IO-replacement insertion point
 *  for the end-to-end test graph. */
export const FakeSyncEngineLayer = (
  script?: SyncScript,
): Layer.Layer<SyncEngine> => Layer.succeed(SyncEngine, makeFakeSyncEngine(script));
