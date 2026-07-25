// Pure step tests for the sync machine: states in, states + issued command
// descriptions out. No DOM, no network, no SQLite — the SyncEngine passes
// these commands describe are exercised elsewhere.
//
// Covers: the checkpoint-derived entry states (the refresh/resume story),
// the prime → backfill → catch-up → settle spine, the poll loop, bounded
// full resyncs (expired cursor, overflowed history), and the failure edges
// (escalating backoff, resume targets, the stored-page-token trust limit,
// auth parking).
import { Option } from "effect";
import { describe, expect, test } from "vitest";

import { HistoryId, PageToken } from "./Gmail";
import * as SyncMachine from "./syncMachine";

const cursor = HistoryId.make("h-100");
const token = PageToken.make("page-2");

const commandNames = (
  commands: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<string> => commands.map((command) => command.name);

// The count a SyncBatch carries into the engine. Progress advances by
// addition now (no COUNT(*) per page), so this number arriving wrong is a
// progress bar that silently resets rather than an error anyone would see.
const syncBatchCount = (
  commands: ReadonlyArray<{ readonly name: string }>,
): number => {
  const command = commands.find((c) => c.name === "SyncBatch");
  return (command as unknown as { args: { syncedCount: number } }).args
    .syncedCount;
};

const checkpoint = (
  overrides: Partial<{
    maybeHistoryId: Option.Option<HistoryId>;
    isBackfillDone: boolean;
    syncedCount: number;
    totalEstimate: number;
  }> = {},
) => ({
  maybeHistoryId: Option.some(cursor),
  isBackfillDone: false,
  syncedCount: 4000,
  totalEstimate: 10000,
  ...overrides,
});

const backfilling = SyncMachine.Backfilling({
  historyId: cursor,
  maybePageToken: Option.some(token),
  syncedCount: 4000,
  totalEstimate: 10000,
  attempt: 0,
});

const failed = (retryAfterMs?: number) =>
  SyncMachine.FailedSync({
    isAuthError: false,
    maybeRetryAfterMs: Option.fromNullishOr(retryAfterMs),
  });

describe("entry from the checkpoint", () => {
  test("no checkpoint primes from scratch", () => {
    const [state, commands] = SyncMachine.step(
      SyncMachine.init(),
      SyncMachine.GotSyncCheckpoint({ maybeCheckpoint: Option.none() }),
    );
    expect(state._tag).toBe("Priming");
    expect(commandNames(commands)).toEqual(["PrimeInbox"]);
  });

  test("a mid-backfill checkpoint resumes with honest counts", () => {
    const [state, commands] = SyncMachine.step(
      SyncMachine.init(),
      SyncMachine.GotSyncCheckpoint({
        maybeCheckpoint: Option.some(checkpoint()),
      }),
    );
    expect(state).toEqual(
      SyncMachine.Backfilling({
        historyId: cursor,
        // Never persisted: the resumed walk re-lists and skip-scans.
        maybePageToken: Option.none(),
        syncedCount: 4000,
        totalEstimate: 10000,
        attempt: 0,
      }),
    );
    expect(commandNames(commands)).toEqual(["SyncBatch"]);
  });

  test("a completed checkpoint goes straight to the history diff", () => {
    const [state, commands] = SyncMachine.step(
      SyncMachine.init(),
      SyncMachine.GotSyncCheckpoint({
        maybeCheckpoint: Option.some(checkpoint({ isBackfillDone: true })),
      }),
    );
    expect(state).toEqual(SyncMachine.CatchingUp({ historyId: cursor, attempt: 0 }));
    expect(commandNames(commands)).toEqual(["ApplyHistory"]);
  });

  test("a checkpoint without a cursor is a dead prime — start over", () => {
    const [state] = SyncMachine.step(
      SyncMachine.init(),
      SyncMachine.GotSyncCheckpoint({
        maybeCheckpoint: Option.some(
          checkpoint({ maybeHistoryId: Option.none() }),
        ),
      }),
    );
    expect(state._tag).toBe("Priming");
  });
});

// Every path that issues a SyncBatch has to hand the engine the count the
// walk is actually at. There are four, and they read it from four different
// places (checkpoint, prime result, batch result, backoff resume), so each
// one is its own chance to pass a zero and rewind the bar.
describe("progress carried into each backfill page", () => {
  test("resuming from a checkpoint carries the checkpoint's count", () => {
    const [, commands] = SyncMachine.step(
      SyncMachine.init(),
      SyncMachine.GotSyncCheckpoint({
        maybeCheckpoint: Option.some(checkpoint({ syncedCount: 4000 })),
      }),
    );
    expect(syncBatchCount(commands)).toBe(4000);
  });

  test("the first page after priming carries the prime's count", () => {
    const [, commands] = SyncMachine.step(
      SyncMachine.Priming({ attempt: 0 }),
      SyncMachine.CompletedPrime({
        historyId: cursor,
        syncedCount: 15,
        totalEstimate: 900,
      }),
    );
    expect(syncBatchCount(commands)).toBe(15);
  });

  test("each further page carries the running count, not the state's", () => {
    const [, commands] = SyncMachine.step(
      backfilling,
      SyncMachine.CompletedBatch({
        syncedCount: 4100,
        maybeNextPageToken: Option.some(token),
      }),
    );
    expect(syncBatchCount(commands)).toBe(4100);
  });

  test("a retry after failure resumes the count, it doesn't restart it", () => {
    const [failedState] = SyncMachine.step(backfilling, failed());
    const [, commands] = SyncMachine.step(
      failedState,
      SyncMachine.FiredRetry(),
    );
    expect(syncBatchCount(commands)).toBe(4000);
  });
});

describe("the sync spine", () => {
  test("prime → backfill", () => {
    const [state, commands] = SyncMachine.step(
      SyncMachine.Priming({ attempt: 0 }),
      SyncMachine.CompletedPrime({
        historyId: cursor,
        syncedCount: 15,
        totalEstimate: 10000,
      }),
    );
    expect(state._tag).toBe("Backfilling");
    expect(commandNames(commands)).toEqual(["SyncBatch"]);
  });

  test("a batch with a next page keeps walking", () => {
    const [state, commands] = SyncMachine.step(
      backfilling,
      SyncMachine.CompletedBatch({
        syncedCount: 4025,
        maybeNextPageToken: Option.some(PageToken.make("page-3")),
      }),
    );
    expect(state).toEqual(
      SyncMachine.Backfilling({
        historyId: cursor,
        maybePageToken: Option.some(PageToken.make("page-3")),
        syncedCount: 4025,
        totalEstimate: 10000,
        attempt: 0,
      }),
    );
    expect(commandNames(commands)).toEqual(["SyncBatch"]);
  });

  test("the last batch hands off to the history diff", () => {
    const [state, commands] = SyncMachine.step(
      backfilling,
      SyncMachine.CompletedBatch({
        syncedCount: 10000,
        maybeNextPageToken: Option.none(),
      }),
    );
    expect(state).toEqual(SyncMachine.CatchingUp({ historyId: cursor, attempt: 0 }));
    expect(commandNames(commands)).toEqual(["ApplyHistory"]);
  });

  test("an applied diff settles and schedules the next poll", () => {
    const [state, commands] = SyncMachine.step(
      SyncMachine.CatchingUp({ historyId: cursor, attempt: 0 }),
      SyncMachine.AppliedHistory({
        historyId: HistoryId.make("h-200"),
        changedCount: 3,
        syncedAt: 1234,
      }),
    );
    expect(state).toEqual(
      SyncMachine.Settled({
        historyId: HistoryId.make("h-200"),
        lastSyncedAt: 1234,
      }),
    );
    expect(commandNames(commands)).toEqual(["WaitPoll"]);
  });

  test("the poll tick re-enters the diff", () => {
    const [state, commands] = SyncMachine.step(
      SyncMachine.Settled({ historyId: cursor, lastSyncedAt: 0 }),
      SyncMachine.TickedPoll(),
    );
    expect(state._tag).toBe("CatchingUp");
    expect(commandNames(commands)).toEqual(["ApplyHistory"]);
  });

  test("an expired or overflowed cursor full-resyncs from Priming", () => {
    for (const message of [
      SyncMachine.ExpiredHistory(),
      SyncMachine.OverflowedHistory(),
    ]) {
      const [state, commands] = SyncMachine.step(
        SyncMachine.CatchingUp({ historyId: cursor, attempt: 0 }),
        message,
      );
      expect(state._tag).toBe("Priming");
      expect(commandNames(commands)).toEqual(["PrimeInbox"]);
    }
  });

  test("a stale poll tick mid-backfill is ignored", () => {
    const [state, commands] = SyncMachine.step(
      backfilling,
      SyncMachine.TickedPoll(),
    );
    expect(state).toEqual(backfilling);
    expect(commands).toEqual([]);
  });
});

// Three edges that each used to be a dead end: a failed checkpoint read was
// ignored (the machine sat in Cold forever, rendering nothing), and NeedsAuth
// had no transitions at all, so one bad token parked sync until a reload.
describe("no state is a dead end", () => {
  const failedCheckpoint = (isAuthError = false) =>
    SyncMachine.FailedCheckpoint({
      accountEmail: "ada@example.com",
      isAuthError,
      maybeRetryAfterMs: Option.none(),
    });

  test("a failed checkpoint read backs off instead of stalling in Cold", () => {
    const [state, commands] = SyncMachine.step(
      SyncMachine.init(),
      failedCheckpoint(),
    );
    expect(state._tag).toBe("Backoff");
    expect(state._tag === "Backoff" && state.resume._tag).toBe(
      "ResumeCheckpoint",
    );
    expect(commandNames(commands)).toEqual(["WaitRetry"]);
  });

  test("its retry re-reads the checkpoint for the same account", () => {
    const [backoff] = SyncMachine.step(SyncMachine.init(), failedCheckpoint());
    const [state, commands] = SyncMachine.step(
      backoff,
      SyncMachine.FiredRetry(),
    );
    // Back to Cold, not Priming: priming would re-stamp the checkpoint and
    // skip the account-ownership check the read performs.
    expect(state._tag).toBe("Cold");
    expect(commandNames(commands)).toEqual(["ReadSyncCheckpoint"]);
    expect(
      (commands[0] as unknown as { args: { accountEmail: string } }).args
        .accountEmail,
    ).toBe("ada@example.com");
  });

  test("repeated checkpoint failures still escalate the delay", () => {
    let state = SyncMachine.init();
    [state] = SyncMachine.step(state, failedCheckpoint());
    expect(state._tag === "Backoff" && state.delayMs).toBe(2_000);
    [state] = SyncMachine.step(state, SyncMachine.FiredRetry());
    [state] = SyncMachine.step(state, failedCheckpoint());
    expect(state._tag === "Backoff" && state.delayMs).toBe(4_000);
  });

  test("an auth-shaped checkpoint failure parks rather than retrying", () => {
    const [state] = SyncMachine.step(SyncMachine.init(), failedCheckpoint(true));
    expect(state._tag).toBe("NeedsAuth");
  });

  test("the reconnect click gets the machine out of NeedsAuth", () => {
    const [state, commands] = SyncMachine.step(
      SyncMachine.NeedsAuth(),
      SyncMachine.RetriedAuth(),
    );
    expect(state).toEqual(SyncMachine.Priming({ attempt: 0 }));
    expect(commandNames(commands)).toEqual(["PrimeInbox"]);
  });
});

describe("failure edges", () => {
  test("a rate-limited batch backs off at least as long as Gmail asks", () => {
    const [state, commands] = SyncMachine.step(backfilling, failed(30_000));
    expect(state._tag).toBe("Backoff");
    if (state._tag !== "Backoff") return;
    expect(state.delayMs).toBe(30_000);
    expect(state.resume._tag).toBe("ResumeBackfill");
    expect(commandNames(commands)).toEqual(["WaitRetry"]);
  });

  test("the retry resumes the backfill where it left off", () => {
    const [failedState] = SyncMachine.step(backfilling, failed());
    const [state, commands] = SyncMachine.step(
      failedState,
      SyncMachine.FiredRetry(),
    );
    expect(state).toEqual(
      SyncMachine.Backfilling({
        historyId: cursor,
        maybePageToken: Option.some(token),
        syncedCount: 4000,
        totalEstimate: 10000,
        attempt: 1,
      }),
    );
    expect(commandNames(commands)).toEqual(["SyncBatch"]);
  });

  test("repeated failures escalate the delay and eventually drop the page token", () => {
    let state = SyncMachine.init() as SyncMachine.State;
    [state] = SyncMachine.step(backfilling, failed());
    expect(state._tag === "Backoff" && state.delayMs).toBe(2_000);

    [state] = SyncMachine.step(state, SyncMachine.FiredRetry());
    [state] = SyncMachine.step(state, failed());
    expect(state._tag === "Backoff" && state.delayMs).toBe(4_000);

    [state] = SyncMachine.step(state, SyncMachine.FiredRetry());
    [state] = SyncMachine.step(state, failed());
    // Third consecutive failure: the stored page token is no longer
    // trusted; the resumed walk will skip-scan from the top instead.
    expect(
      state._tag === "Backoff" &&
        state.resume._tag === "ResumeBackfill" &&
        state.resume.maybePageToken,
    ).toEqual(Option.none());
  });

  test("a failed diff resumes the diff, not the backfill", () => {
    const [state] = SyncMachine.step(
      SyncMachine.CatchingUp({ historyId: cursor, attempt: 0 }),
      failed(),
    );
    expect(state._tag === "Backoff" && state.resume._tag).toBe(
      "ResumeHistory",
    );
  });

  test("an auth failure parks the machine", () => {
    const [state, commands] = SyncMachine.step(
      backfilling,
      SyncMachine.FailedSync({
        isAuthError: true,
        maybeRetryAfterMs: Option.none(),
      }),
    );
    expect(state._tag).toBe("NeedsAuth");
    expect(commands).toEqual([]);

    const [still] = SyncMachine.step(state, SyncMachine.FiredRetry());
    expect(still._tag).toBe("NeedsAuth");
  });
});
