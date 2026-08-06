// A scripted, in-memory SyncEngine for end-to-end tests.
//
// The real SyncEngine (sync.ts) is a service whose deps reach into a
// SQLite worker (OPFS), the Gmail REST API, CompressionStream and the
// image proxy. None of those exist in a headless test. This fake provides
// the SAME SyncEngine service tag with scripted outcomes, so the machine's
// commands and the whole service graph can run end-to-end without any IO.
//
// The machine only cares about the sync pass results; the read-model
// methods (loadInbox etc.) are present to satisfy the full interface and
// return empty/zero in tests that don't exercise them.

import { Effect, Layer, Option } from "effect";
import { HistoryId, PageToken, ThreadId } from "../../Gmail";
import {
  SyncEngine,
  Applied,
  Expired,
  Overflowed,
  type BatchResult,
  type HistoryResult,
  type ImageBatchResult,
  type PrimeResult,
  type SyncCheckpoint,
  type ThreadDetail,
  type ThreadRow,
} from "../../sync";

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

export const defaultScript = (): SyncScript => ({
  checkpoint: Option.none(),
  prime: {
    historyId: HistoryId.make("h-prime"),
    syncedCount: 1,
    totalEstimate: 3,
  },
  // One page, exhausted: the walk ends immediately.
  batches: [{ syncedCount: 3, maybeNextPageToken: Option.none() }],
  history: Applied({
    historyId: HistoryId.make("h-100"),
    changedCount: 2,
    syncedAt: 1000,
  }),
});

/** Build a SyncEngine value from a script. Each syncBatch call walks the next
 *  scripted page, so a multi-page backfill is scriptable in order. */
export const makeFakeSyncEngine = (script: SyncScript = defaultScript()) => {
  let batchIndex = 0;

  const readCheckpoint = (
    _accountEmail: string,
  ): Effect.Effect<Option.Option<SyncCheckpoint>, never> =>
    Effect.succeed(script.checkpoint);

  const primeInbox: Effect.Effect<PrimeResult, never> = Effect.succeed(script.prime);

  const syncBatch = (
    _maybePageToken: Option.Option<PageToken>,
    _previousCount: number,
  ): Effect.Effect<BatchResult, never> =>
    Effect.sync(() => {
      const last = script.batches[script.batches.length - 1] ?? {
        syncedCount: 0,
        maybeNextPageToken: Option.none(),
      };
      const page = script.batches[Math.min(batchIndex, script.batches.length - 1)] ?? last;
      batchIndex += 1;
      return page;
    });

  const applyHistory = (
    _startHistoryId: HistoryId,
  ): Effect.Effect<HistoryResult, never> => Effect.succeed(script.history);

  const loadInbox: Effect.Effect<ReadonlyArray<ThreadRow>, never> =
    Effect.succeed([]);
  const loadInboxTop = (
    _limit: number,
  ): Effect.Effect<ReadonlyArray<ThreadRow>, never> => Effect.succeed([]);
  const loadThread = (_id: ThreadId): Effect.Effect<ThreadDetail, never> =>
    Effect.die("FakeSyncEngine.loadThread not exercised");
  const localSizeBytes: Effect.Effect<number, never> = Effect.succeed(0);
  const cacheImageBatch: Effect.Effect<ImageBatchResult, never> =
    Effect.succeed({ isIdle: true, isRecentReady: false });

  return {
    readCheckpoint,
    primeInbox,
    syncBatch,
    applyHistory,
    loadInbox,
    loadInboxTop,
    loadThread,
    localSizeBytes,
    cacheImageBatch,
  } as const;
};

/** A Layer providing the fake SyncEngine — the IO-replacement insertion point
 *  for the end-to-end test graph. */
export const FakeSyncEngineLayer = (
  script?: SyncScript,
): Layer.Layer<SyncEngine> =>
  // The fake intentionally returns `never`-error Effects and readonly schema
  // types where the real engine allows a wider error channel or mutable
  // shape; the cast is the documented seam of a test double.
  Layer.succeed(
    SyncEngine,
    makeFakeSyncEngine(script) as unknown as never,
  );
