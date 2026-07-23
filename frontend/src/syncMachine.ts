// The sync machine: the state machine that fills and freshens the local
// store, on foldkit's experimental Machine (the checkout-machine shape).
//
//   Cold ──GotSyncCheckpoint──► Priming | Backfilling | CatchingUp
//   Priming ──CompletedPrime──► Backfilling
//   Backfilling ──CompletedBatch──► Backfilling (next page) | CatchingUp
//   CatchingUp ──AppliedHistory──► Settled ──TickedPoll──► CatchingUp
//   CatchingUp ──Expired/Overflowed──► Priming (bounded full resync)
//   any network pass ──FailedSync──► Backoff (resume-aware) | NeedsAuth
//
// The store answers every read throughout; the machine only makes it more
// complete. Its state is derived from the SQLite checkpoint at boot — never
// persisted itself — so a refresh mid-backfill resumes with honest progress.

import { Effect, Match as M, Option, Schema as S } from "effect";
import { Command } from "foldkit";
import { Machine } from "foldkit/experimental";
import { otherwise, to, when } from "foldkit/experimental/machine";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

import { HistoryId, PageToken, type GmailError } from "./Gmail";
import { SyncEngine } from "./sync";

import type { SqlError } from "effect/unstable/sql/SqlError";

// STATE

// Active states carry `attempt`: consecutive failures of this pass (0 =
// fresh). A failure lands in Backoff with attempt + 1, and the retry
// re-enters the pass carrying the count, so repeated failures escalate
// the delay instead of resetting it.
export const Cold = ts("Cold");
export const Priming = ts("Priming", { attempt: S.Number });
export const Backfilling = ts("Backfilling", {
  historyId: HistoryId,
  // Live within a session only; a resumed walk re-lists from the top and
  // skip-scans already-current threads (see SyncEngine.syncBatch).
  maybePageToken: S.Option(PageToken),
  syncedCount: S.Number,
  totalEstimate: S.Number,
  attempt: S.Number,
});
export const CatchingUp = ts("CatchingUp", {
  historyId: HistoryId,
  attempt: S.Number,
});
export const Settled = ts("Settled", {
  historyId: HistoryId,
  lastSyncedAt: S.Number,
});

export const ResumePrime = ts("ResumePrime");
export const ResumeBackfill = ts("ResumeBackfill", {
  historyId: HistoryId,
  maybePageToken: S.Option(PageToken),
  syncedCount: S.Number,
  totalEstimate: S.Number,
});
export const ResumeHistory = ts("ResumeHistory", { historyId: HistoryId });
export const Resume = S.Union([ResumePrime, ResumeBackfill, ResumeHistory]);
export type Resume = typeof Resume.Type;

export const Backoff = ts("Backoff", {
  attempt: S.Number,
  delayMs: S.Number,
  resume: Resume,
});
export const NeedsAuth = ts("NeedsAuth");

export const State = S.Union([
  Cold,
  Priming,
  Backfilling,
  CatchingUp,
  Settled,
  Backoff,
  NeedsAuth,
]);
export type State = typeof State.Type;

export const init = (): State => Cold();

// MESSAGE

export const GotSyncCheckpoint = m("GotSyncCheckpoint", {
  maybeCheckpoint: S.Option(
    S.Struct({
      maybeHistoryId: S.Option(HistoryId),
      isBackfillDone: S.Boolean,
      syncedCount: S.Number,
      totalEstimate: S.Number,
    }),
  ),
});
export const CompletedPrime = m("CompletedPrime", {
  historyId: HistoryId,
  syncedCount: S.Number,
  totalEstimate: S.Number,
});
export const CompletedBatch = m("CompletedBatch", {
  syncedCount: S.Number,
  maybeNextPageToken: S.Option(PageToken),
});
export const AppliedHistory = m("AppliedHistory", {
  historyId: HistoryId,
  changedCount: S.Number,
  syncedAt: S.Number,
});
/** Gmail expired the cursor (~a week of history): full resync. */
export const ExpiredHistory = m("ExpiredHistory");
/** More changes than per-thread re-syncs are worth: full resync. */
export const OverflowedHistory = m("OverflowedHistory");
export const FailedSync = m("FailedSync", {
  isAuthError: S.Boolean,
  maybeRetryAfterMs: S.Option(S.Number),
});
export const FiredRetry = m("FiredRetry");
export const TickedPoll = m("TickedPoll");

export const Message = S.Union([
  GotSyncCheckpoint,
  CompletedPrime,
  CompletedBatch,
  AppliedHistory,
  ExpiredHistory,
  OverflowedHistory,
  FailedSync,
  FiredRetry,
  TickedPoll,
]);
export type Message = typeof Message.Type;

// COMMAND

const POLL_INTERVAL_MS = 60_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
// After this many consecutive failures a stored page token is presumed
// stale and dropped — the resumed walk skip-scans from the top instead of
// retrying a token Gmail may no longer honor.
const TOKEN_RESET_ATTEMPTS = 3;

// Every Gmail/SQL failure funnels into one FailedSync fact; the machine
// decides what it means from where it currently is. Auth-shaped errors
// (revoked token, lost scope) park the machine; everything else backs off.
const toFailedSync = (error: GmailError | SqlError): typeof FailedSync.Type =>
  M.value(error).pipe(
    M.tags({
      GmailAuthError: () =>
        FailedSync({ isAuthError: true, maybeRetryAfterMs: Option.none() }),
      GmailTokenError: () =>
        FailedSync({ isAuthError: true, maybeRetryAfterMs: Option.none() }),
      GmailScopeError: () =>
        FailedSync({ isAuthError: true, maybeRetryAfterMs: Option.none() }),
      GmailRateLimited: ({ retryAfterMs }) =>
        FailedSync({
          isAuthError: false,
          maybeRetryAfterMs: Option.fromNullishOr(retryAfterMs),
        }),
    }),
    M.orElse(() =>
      FailedSync({ isAuthError: false, maybeRetryAfterMs: Option.none() }),
    ),
  );

export const ReadSyncCheckpoint = Command.define(
  "ReadSyncCheckpoint",
  GotSyncCheckpoint,
  FailedSync,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.readCheckpoint.pipe(
      Effect.map((maybeCheckpoint) => GotSyncCheckpoint({ maybeCheckpoint })),
      Effect.catch((error) => Effect.succeed(toFailedSync(error))),
    );
  }),
);

export const PrimeInbox = Command.define(
  "PrimeInbox",
  CompletedPrime,
  FailedSync,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.primeInbox.pipe(
      Effect.map((result) => CompletedPrime(result)),
      Effect.catch((error) => Effect.succeed(toFailedSync(error))),
    );
  }),
);

export const SyncBatch = Command.define(
  "SyncBatch",
  { maybePageToken: S.Option(PageToken) },
  CompletedBatch,
  FailedSync,
)(({ maybePageToken }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.syncBatch(maybePageToken).pipe(
      Effect.map((result) => CompletedBatch(result)),
      Effect.catch((error) => Effect.succeed(toFailedSync(error))),
    );
  }),
);

export const ApplyHistory = Command.define(
  "ApplyHistory",
  { historyId: HistoryId },
  AppliedHistory,
  ExpiredHistory,
  OverflowedHistory,
  FailedSync,
)(({ historyId }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.applyHistory(historyId).pipe(
      Effect.map((result) =>
        M.value(result).pipe(
          M.tagsExhaustive({
            Applied: ({ historyId, changedCount, syncedAt }) =>
              AppliedHistory({ historyId, changedCount, syncedAt }),
            Expired: () => ExpiredHistory(),
            Overflowed: () => OverflowedHistory(),
          }),
        ),
      ),
      Effect.catch((error) => Effect.succeed(toFailedSync(error))),
    );
  }),
);

const WaitRetry = Command.define(
  "WaitRetry",
  { delayMs: S.Number },
  FiredRetry,
)(({ delayMs }) =>
  Effect.gen(function* () {
    yield* Effect.sleep(delayMs);
    return FiredRetry();
  }),
);

const WaitPoll = Command.define(
  "WaitPoll",
  TickedPoll,
)(
  Effect.gen(function* () {
    yield* Effect.sleep(POLL_INTERVAL_MS);
    return TickedPoll();
  }),
);

/** Boot: derive the entry state from the persisted checkpoint. */
export const bootCommands = (): ReadonlyArray<
  Command.Command<Message, never, SyncEngine>
> => [ReadSyncCheckpoint()];

// MACHINE

const backoffDelayMs = (
  attempt: number,
  maybeRetryAfterMs: Option.Option<number>,
): number => {
  const exponential = Math.min(
    BACKOFF_BASE_MS * 2 ** (attempt - 1),
    BACKOFF_MAX_MS,
  );
  return Math.max(exponential, Option.getOrElse(maybeRetryAfterMs, () => 0));
};

const isAuthFailure = (
  _state: State,
  message: typeof FailedSync.Type,
): boolean => message.isAuthError;

// The boot fork, off the persisted checkpoint: a finished backfill goes
// straight to the history diff; an unfinished one resumes with honest
// counts (and no page token — the walk skip-scans from the top); anything
// else primes from scratch.
const doneCheckpointCursor = (
  _cold: typeof Cold.Type,
  message: typeof GotSyncCheckpoint.Type,
): Option.Option<HistoryId> =>
  Option.flatMap(message.maybeCheckpoint, (checkpoint) =>
    checkpoint.isBackfillDone ? checkpoint.maybeHistoryId : Option.none(),
  );

const partialCheckpoint = (
  _cold: typeof Cold.Type,
  message: typeof GotSyncCheckpoint.Type,
): Option.Option<{
  historyId: HistoryId;
  syncedCount: number;
  totalEstimate: number;
}> =>
  Option.flatMap(message.maybeCheckpoint, (checkpoint) =>
    checkpoint.isBackfillDone
      ? Option.none()
      : Option.map(checkpoint.maybeHistoryId, (historyId) => ({
          historyId,
          syncedCount: checkpoint.syncedCount,
          totalEstimate: checkpoint.totalEstimate,
        })),
  );

// Past the threshold, stop trusting the stored page token — Gmail may no
// longer honor it, and the skip-scan walk from the top costs only cheap
// list pages.
const resumePageToken = (
  backfilling: typeof Backfilling.Type,
): Option.Option<PageToken> =>
  backfilling.attempt + 1 >= TOKEN_RESET_ATTEMPTS
    ? Option.none()
    : backfilling.maybePageToken;

const backfillResume = (
  _backoff: typeof Backoff.Type,
  resume: Resume,
): Option.Option<typeof ResumeBackfill.Type> =>
  resume._tag === "ResumeBackfill" ? Option.some(resume) : Option.none();

export const syncMachine = Machine.define({
  state: State,
  message: Message,
})({
  initial: Cold(),
  states: {
    Cold: {
      on: {
        GotSyncCheckpoint: [
          when(
            doneCheckpointCursor,
            "CatchingUp",
            ({ guardValue }) =>
              CatchingUp({ historyId: guardValue, attempt: 0 }),
            ({ guardValue }) => [ApplyHistory({ historyId: guardValue })],
          ),
          when(
            partialCheckpoint,
            "Backfilling",
            ({ guardValue }) =>
              Backfilling({
                ...guardValue,
                maybePageToken: Option.none(),
                attempt: 0,
              }),
            () => [SyncBatch({ maybePageToken: Option.none() })],
          ),
          otherwise(
            to(
              "Priming",
              () => Priming({ attempt: 0 }),
              () => [PrimeInbox()],
            ),
          ),
        ],
      },
    },

    Priming: {
      on: {
        CompletedPrime: to(
          "Backfilling",
          ({ message }) =>
            Backfilling({
              historyId: message.historyId,
              maybePageToken: Option.none(),
              syncedCount: message.syncedCount,
              totalEstimate: message.totalEstimate,
              attempt: 0,
            }),
          () => [SyncBatch({ maybePageToken: Option.none() })],
        ),
        FailedSync: [
          when(isAuthFailure, "NeedsAuth", () => NeedsAuth()),
          otherwise(
            to(
              "Backoff",
              ({ state, message }) =>
                Backoff({
                  attempt: state.attempt + 1,
                  delayMs: backoffDelayMs(
                    state.attempt + 1,
                    message.maybeRetryAfterMs,
                  ),
                  resume: ResumePrime(),
                }),
              ({ state, message }) => [
                WaitRetry({
                  delayMs: backoffDelayMs(
                    state.attempt + 1,
                    message.maybeRetryAfterMs,
                  ),
                }),
              ],
            ),
          ),
        ],
      },
    },

    Backfilling: {
      on: {
        CompletedBatch: [
          when(
            (_state, message) => message.maybeNextPageToken,
            "Backfilling",
            ({ state, message, guardValue }) =>
              evo(state, {
                maybePageToken: () => Option.some(guardValue),
                syncedCount: () => message.syncedCount,
                attempt: () => 0,
              }),
            ({ guardValue }) => [
              SyncBatch({ maybePageToken: Option.some(guardValue) }),
            ],
          ),
          otherwise(
            to(
              "CatchingUp",
              ({ state }) =>
                CatchingUp({ historyId: state.historyId, attempt: 0 }),
              ({ state }) => [ApplyHistory({ historyId: state.historyId })],
            ),
          ),
        ],
        FailedSync: [
          when(isAuthFailure, "NeedsAuth", () => NeedsAuth()),
          otherwise(
            to(
              "Backoff",
              ({ state, message }) =>
                Backoff({
                  attempt: state.attempt + 1,
                  delayMs: backoffDelayMs(
                    state.attempt + 1,
                    message.maybeRetryAfterMs,
                  ),
                  resume: ResumeBackfill({
                    historyId: state.historyId,
                    maybePageToken: resumePageToken(state),
                    syncedCount: state.syncedCount,
                    totalEstimate: state.totalEstimate,
                  }),
                }),
              ({ state, message }) => [
                WaitRetry({
                  delayMs: backoffDelayMs(
                    state.attempt + 1,
                    message.maybeRetryAfterMs,
                  ),
                }),
              ],
            ),
          ),
        ],
      },
    },

    CatchingUp: {
      on: {
        AppliedHistory: to(
          "Settled",
          ({ message }) =>
            Settled({
              historyId: message.historyId,
              lastSyncedAt: message.syncedAt,
            }),
          () => [WaitPoll()],
        ),
        ExpiredHistory: to(
          "Priming",
          () => Priming({ attempt: 0 }),
          () => [PrimeInbox()],
        ),
        OverflowedHistory: to(
          "Priming",
          () => Priming({ attempt: 0 }),
          () => [PrimeInbox()],
        ),
        FailedSync: [
          when(isAuthFailure, "NeedsAuth", () => NeedsAuth()),
          otherwise(
            to(
              "Backoff",
              ({ state, message }) =>
                Backoff({
                  attempt: state.attempt + 1,
                  delayMs: backoffDelayMs(
                    state.attempt + 1,
                    message.maybeRetryAfterMs,
                  ),
                  resume: ResumeHistory({ historyId: state.historyId }),
                }),
              ({ state, message }) => [
                WaitRetry({
                  delayMs: backoffDelayMs(
                    state.attempt + 1,
                    message.maybeRetryAfterMs,
                  ),
                }),
              ],
            ),
          ),
        ],
      },
    },

    Settled: {
      on: {
        TickedPoll: to(
          "CatchingUp",
          ({ state }) => CatchingUp({ historyId: state.historyId, attempt: 0 }),
          ({ state }) => [ApplyHistory({ historyId: state.historyId })],
        ),
      },
    },

    // The retry re-enters the pass carrying the attempt count, so the
    // next failure escalates instead of resetting the delay.
    Backoff: {
      on: {
        FiredRetry: [
          when(
            (state) => backfillResume(state, state.resume),
            "Backfilling",
            ({ state, guardValue }) =>
              Backfilling({
                historyId: guardValue.historyId,
                maybePageToken: guardValue.maybePageToken,
                syncedCount: guardValue.syncedCount,
                totalEstimate: guardValue.totalEstimate,
                attempt: state.attempt,
              }),
            ({ guardValue }) => [
              SyncBatch({ maybePageToken: guardValue.maybePageToken }),
            ],
          ),
          when(
            (state) =>
              state.resume._tag === "ResumeHistory"
                ? Option.some(state.resume.historyId)
                : Option.none<HistoryId>(),
            "CatchingUp",
            ({ state, guardValue }) =>
              CatchingUp({ historyId: guardValue, attempt: state.attempt }),
            ({ guardValue }) => [ApplyHistory({ historyId: guardValue })],
          ),
          otherwise(
            to(
              "Priming",
              ({ state }) => Priming({ attempt: state.attempt }),
              () => [PrimeInbox()],
            ),
          ),
        ],
      },
    },

    NeedsAuth: { on: {} },
  },
});

/** Tuple-shaped step over the Machine — state + commands out, `Ignored`
 *  collapsing to a no-op. What the inbox update and the tests consume. */
export const step = (
  state: State,
  message: Message,
): readonly [
  State,
  ReadonlyArray<Command.Command<Message, never, SyncEngine>>,
] => {
  const result = syncMachine.step(state, message);
  return [
    result.state,
    M.value(result).pipe(
      M.tagsExhaustive({
        Transitioned: ({ commands }) => commands,
        Ignored: () => [],
      }),
    ),
  ];
};
