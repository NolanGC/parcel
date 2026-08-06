// The sync machine: the state machine that fills and freshens the local
// store, on foldkit's experimental Machine.
//
//   Cold ──SucceededReadSyncCheckpoint──► Priming | Backfilling | CatchingUp
//   Priming ──CompletedPrimeInbox──► Backfilling
//   Backfilling ──CompletedSyncBatch──► Backfilling (next page) | CatchingUp
//   CatchingUp ──AppliedHistory──► Settled ──TickedPoll──► CatchingUp
//   CatchingUp ──Expired/Overflowed──► Priming (bounded full resync)
//   any network pass ──FailedSync──► Backoff (resume-aware) | NeedsAuth
//   Cold ──FailedReadSyncCheckpoint──► Backoff ──CompletedWaitRetry──► Cold (re-read)
//   NeedsAuth ──ClickedReconnect──► Priming
//
// The store answers every read throughout; the machine only makes it more
// complete. Its state is derived from the SQLite checkpoint at boot — never
// persisted itself — so a refresh mid-backfill resumes with honest progress.
//
// DESIGN: Machine edge callbacks (to/when/otherwise build + commands) are
// PURE — they run synchronously inside Machine.step(). The backoff delay
// math is a pure function on the BackoffPolicy schema. The Policy Effect
// service (./services/policy) wraps the same values so Effectful commands
// like WaitRetry and WaitPoll agree with the pure edge callbacks.

import { Effect, Match as M, Option, Schema as S } from "effect";
import { Command } from "foldkit";
import { Machine } from "foldkit/experimental";
import { otherwise, to, when } from "foldkit/experimental/machine";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

import { HistoryId, PageToken, type GmailError } from "./Gmail";
import { computeDelay, defaultBackoffPolicy, LivePolicy, Policy } from "./services/policy";
import { SyncEngine } from "./sync";

import type { SqlError } from "effect/unstable/sql/SqlError";

// THE DEFAULT BACKOFF POLICY
//
// The pure edge callbacks (to/when/otherwise build + commands) run
// synchronously during Machine.step() and cannot access Effect services.
// The BackoffPolicy schema and default values live in services/policy.ts.
// This module imports defaultBackoffPolicy from there. The Policy Effect
// service (Layer) provides the same defaults to Effectful commands
// (WaitRetry, WaitPoll). A test Layer can override both simultaneously.

// REQUIREMENTS: services the machine's Commands need.
export type SyncResources = SyncEngine;

// STATE SCHEMAS

/** Active states carry `attempt`: consecutive failures of this pass (0 =
 *  fresh). A failure lands in Backoff with attempt + 1, and the retry
 *  re-enters the pass carrying the count, so repeated failures escalate
 *  the delay instead of resetting it. */
export const Cold = ts("Cold", { attempt: S.Number });
export const Priming = ts("Priming", { attempt: S.Number });
export const Backfilling = ts("Backfilling", {
  historyId: HistoryId,
  /** Live within a session only; a resumed walk re-lists from the top and
   *  skip-scans already-current threads (see SyncEngine.syncBatch). */
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

// RESUME SCHEMAS
//
// Parked in Backoff so the retry can re-enter whichever pass failed.

export const ResumeCheckpoint = ts("ResumeCheckpoint", {
  accountEmail: S.String,
});
export const ResumePrime = ts("ResumePrime");
export const ResumeBackfill = ts("ResumeBackfill", {
  historyId: HistoryId,
  maybePageToken: S.Option(PageToken),
  syncedCount: S.Number,
  totalEstimate: S.Number,
});
export const ResumeHistory = ts("ResumeHistory", { historyId: HistoryId });
export const Resume = S.Union([
  ResumeCheckpoint,
  ResumePrime,
  ResumeBackfill,
  ResumeHistory,
]);
export type Resume = typeof Resume.Type;

// BACKOFF STATE

export const Backoff = ts("Backoff", {
  attempt: S.Number,
  delayMs: S.Number,
  resume: Resume,
});
export const NeedsAuth = ts("NeedsAuth");

// STATE UNION

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

export const init = (): State => Cold({ attempt: 0 });

// MESSAGE SCHEMAS

export const SucceededReadSyncCheckpoint = m("SucceededReadSyncCheckpoint", {
  maybeCheckpoint: S.Option(
    S.Struct({
      maybeHistoryId: S.Option(HistoryId),
      isBackfillDone: S.Boolean,
      syncedCount: S.Number,
      totalEstimate: S.Number,
    }),
  ),
});
export const CompletedPrimeInbox = m("CompletedPrimeInbox", {
  historyId: HistoryId,
  syncedCount: S.Number,
  totalEstimate: S.Number,
});
export const CompletedSyncBatch = m("CompletedSyncBatch", {
  syncedCount: S.Number,
  maybeNextPageToken: S.Option(PageToken),
});
export const AppliedHistory = m("AppliedHistory", {
  historyId: HistoryId,
  changedCount: S.Number,
  syncedAt: S.Number,
});
/** A history pass that ran *during* the backfill. A separate fact from
 *  AppliedHistory with no failure variant: every way it can go wrong
 *  collapses to `maybeHistoryId: None` and the backfill carries on. */
// NOTE: Routing this through FailedSync instead would let a transient network
// blip knock a 25-minute backfill into Backoff.
export const RefreshedDuringBackfill = m("RefreshedDuringBackfill", {
  maybeHistoryId: S.Option(HistoryId),
  changedCount: S.Number,
});
/** Gmail expired the cursor (~a week of history): full resync. */
export const ExpiredHistory = m("ExpiredHistory");
/** More changes than per-thread re-syncs are worth: full resync. */
export const OverflowedHistory = m("OverflowedHistory");
export const FailedSync = m("FailedSync", {
  isAuthError: S.Boolean,
  maybeRetryAfterMs: S.Option(S.Number),
});
/** The checkpoint read's own failure. Distinct from FailedSync because it
 *  is the one pass whose retry needs an argument, and Cold cannot hold the
 *  account itself — the page is constructed before sign-in is resolved. */
export const FailedReadSyncCheckpoint = m("FailedReadSyncCheckpoint", {
  accountEmail: S.String,
  isAuthError: S.Boolean,
  maybeRetryAfterMs: S.Option(S.Number),
});
export const CompletedWaitRetry = m("CompletedWaitRetry");
export const TickedPoll = m("TickedPoll");
/** The "Reconnect Gmail" pill was clicked: try the whole thing again. */
export const ClickedReconnect = m("ClickedReconnect");

export const Message = S.Union([
  SucceededReadSyncCheckpoint,
  CompletedPrimeInbox,
  CompletedSyncBatch,
  AppliedHistory,
  RefreshedDuringBackfill,
  ExpiredHistory,
  OverflowedHistory,
  FailedSync,
  FailedReadSyncCheckpoint,
  CompletedWaitRetry,
  TickedPoll,
  ClickedReconnect,
]);
export type Message = typeof Message.Type;

// COMMAND DEFINITIONS

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
  { accountEmail: S.String },
  SucceededReadSyncCheckpoint,
  FailedReadSyncCheckpoint,
)(({ accountEmail }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.readCheckpoint(accountEmail).pipe(
      Effect.map((maybeCheckpoint) =>
        SucceededReadSyncCheckpoint({ maybeCheckpoint }),
      ),
      Effect.catch((error) => {
        const failure = toFailedSync(error);
        return Effect.succeed(
          FailedReadSyncCheckpoint({
            accountEmail,
            isAuthError: failure.isAuthError,
            maybeRetryAfterMs: failure.maybeRetryAfterMs,
          }),
        );
      }),
    );
  }),
);

export const PrimeInbox = Command.define(
  "PrimeInbox",
  CompletedPrimeInbox,
  FailedSync,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.primeInbox.pipe(
      Effect.map((result) => CompletedPrimeInbox(result)),
      Effect.catch((error) => Effect.succeed(toFailedSync(error))),
    );
  }),
);

export const SyncBatch = Command.define(
  "SyncBatch",
  { maybePageToken: S.Option(PageToken), syncedCount: S.Number },
  CompletedSyncBatch,
  FailedSync,
)(({ maybePageToken, syncedCount }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.syncBatch(maybePageToken, syncedCount).pipe(
      Effect.map((result) => CompletedSyncBatch(result)),
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

/** The interleaved refresh: the same engine pass as ApplyHistory, but every
 *  outcome including failure becomes one infallible fact, because the backfill
 *  must not be interrupted by it. */
export const RefreshDuringBackfill = Command.define(
  "RefreshDuringBackfill",
  { historyId: HistoryId },
  RefreshedDuringBackfill,
)(({ historyId }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    const stale = RefreshedDuringBackfill({
      maybeHistoryId: Option.none(),
      changedCount: 0,
    });
    return yield* engine.applyHistory(historyId).pipe(
      Effect.map((result) =>
        M.value(result).pipe(
          M.tagsExhaustive({
            Applied: ({ historyId, changedCount }) =>
              RefreshedDuringBackfill({
                maybeHistoryId: Option.some(historyId),
                changedCount,
              }),
            Expired: () => stale,
            Overflowed: () => stale,
          }),
        ),
      ),
      Effect.catch(() => Effect.succeed(stale)),
    );
  }),
);

const WaitRetry = Command.define(
  "WaitRetry",
  { delayMs: S.Number },
  CompletedWaitRetry,
)(({ delayMs }) =>
  Effect.gen(function* () {
    yield* Effect.sleep(delayMs);
    return CompletedWaitRetry();
  }),
);

const WaitPoll = Command.define(
  "WaitPoll",
  TickedPoll,
)(
  Effect.gen(function* () {
    const policy = yield* Policy;
    yield* Effect.sleep(policy.pollIntervalMs);
    return TickedPoll();
  }).pipe(Effect.provide(LivePolicy)),
);

/** Boot: derive the entry state from the persisted checkpoint. */
export const bootCommands = (
  accountEmail: string,
): ReadonlyArray<Command.Command<Message, never, SyncEngine>> => [
  ReadSyncCheckpoint({ accountEmail }),
];

// MACHINE HELPER TYPES

type FailureMessage = Readonly<{
  isAuthError: boolean;
  maybeRetryAfterMs: Option.Option<number>;
}>;

// The delay the next attempt waits out. Both the Backoff state and its
// WaitRetry command need it, and they must agree.
const retryDelay = (
  state: Readonly<{ attempt: number }>,
  message: FailureMessage,
): number =>
  computeDelay(defaultBackoffPolicy, state.attempt + 1, message.maybeRetryAfterMs);

// Past the threshold, stop trusting the stored page token — Gmail may no
// longer honor it, and the skip-scan walk from the top costs only cheap
// list pages.
// NOTE: Uses the same TOKEN_RESET_ATTEMPTS as the Policy service. This is the
// pure sync counterpart (Machine edge callbacks cannot access services).
// The policy.ts default MUST match this constant.
const TOKEN_RESET_ATTEMPTS = 3;

const resumePageToken = (
  backfilling: typeof Backfilling.Type,
): Option.Option<PageToken> =>
  backfilling.attempt + 1 >= TOKEN_RESET_ATTEMPTS
    ? Option.none()
    : backfilling.maybePageToken;

// Schema-driven resume narrowing. Uses Schema.is instead of hand-written
// tag matching, so adding a Resume variant is caught at compile time if
// the exhaustiveness check on Resume's union membership is updated.
const resumeIs = <Tag extends Resume["_tag"]>(tag: Tag) =>
  (backoff: typeof Backoff.Type): Option.Option<Extract<Resume, { readonly _tag: Tag }>> =>
    Option.liftPredicate(
      backoff.resume,
      (resume): resume is Extract<Resume, { readonly _tag: Tag }> =>
        resume._tag === tag,
    );

// Every network pass fails the same way: auth-shaped errors park the machine
// in NeedsAuth, anything else escalates the delay and re-enters the pass it
// came from. Only the resume payload differs, so only that is a parameter.
const failsIntoBackoff = <
  SourceState extends State & Readonly<{ attempt: number }>,
  TriggerMessage extends Message & FailureMessage,
>(
  toResume: (state: SourceState, message: TriggerMessage) => Resume,
) =>
  [
    when<State, Message, SourceState, TriggerMessage, boolean, "NeedsAuth">(
      (_state, message): boolean => message.isAuthError,
      "NeedsAuth",
      () => NeedsAuth(),
    ),
    otherwise(
      to<State, Message, SourceState, TriggerMessage, "Backoff", SyncResources>(
        "Backoff",
        ({ state, message }) =>
          Backoff({
            attempt: state.attempt + 1,
            delayMs: retryDelay(state, message),
            resume: toResume(state, message),
          }),
        ({ state, message }) => [
          WaitRetry({ delayMs: retryDelay(state, message) }),
        ],
      ),
    ),
  ] as const;

export const syncMachine = Machine.define({
  state: State,
  message: Message,
})({
  initial: Cold({ attempt: 0 }),
  states: {
    Cold: {
      on: {
        SucceededReadSyncCheckpoint: [
          when(
            (_cold, message) =>
              Option.flatMap(message.maybeCheckpoint, (checkpoint) =>
                checkpoint.isBackfillDone ? checkpoint.maybeHistoryId : Option.none(),
              ),
            "CatchingUp",
            ({ guardValue }) =>
              CatchingUp({ historyId: guardValue, attempt: 0 }),
            ({ guardValue }) => [ApplyHistory({ historyId: guardValue })],
          ),
          when(
            (_cold, message) =>
              Option.flatMap(message.maybeCheckpoint, (checkpoint) =>
                checkpoint.isBackfillDone
                  ? Option.none()
                  : Option.map(checkpoint.maybeHistoryId, (historyId) => ({
                      historyId,
                      syncedCount: checkpoint.syncedCount,
                      totalEstimate: checkpoint.totalEstimate,
                    })),
              ),
            "Backfilling",
            ({ guardValue }) =>
              Backfilling({
                ...guardValue,
                maybePageToken: Option.none(),
                attempt: 0,
              }),
            ({ guardValue }) => [
              SyncBatch({
                maybePageToken: Option.none(),
                syncedCount: guardValue.syncedCount,
              }),
            ],
          ),
          otherwise(
            to(
              "Priming",
              () => Priming({ attempt: 0 }),
              () => [PrimeInbox()],
            ),
          ),
        ],
        FailedReadSyncCheckpoint: failsIntoBackoff((_state, message) =>
          ResumeCheckpoint({ accountEmail: message.accountEmail }),
        ),
      },
    },

    Priming: {
      on: {
        CompletedPrimeInbox: to(
          "Backfilling",
          ({ message }) =>
            Backfilling({
              historyId: message.historyId,
              maybePageToken: Option.none(),
              syncedCount: message.syncedCount,
              totalEstimate: message.totalEstimate,
              attempt: 0,
            }),
          ({ message }) => [
            SyncBatch({
              maybePageToken: Option.none(),
              syncedCount: message.syncedCount,
            }),
          ],
        ),
        FailedSync: failsIntoBackoff(() => ResumePrime()),
      },
    },

    Backfilling: {
      on: {
        CompletedSyncBatch: [
          when(
            (_state, message) => message.maybeNextPageToken,
            "Backfilling",
            ({ state, message, guardValue }) =>
              evo(state, {
                maybePageToken: () => Option.some(guardValue),
                syncedCount: () => message.syncedCount,
                attempt: () => 0,
              }),
            ({ state, message, guardValue }) => [
              SyncBatch({
                maybePageToken: Option.some(guardValue),
                syncedCount: message.syncedCount,
              }),
              RefreshDuringBackfill({ historyId: state.historyId }),
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
        RefreshedDuringBackfill: to(
          "Backfilling",
          ({ state, message }) =>
            evo(state, {
              historyId: () =>
                Option.getOrElse(message.maybeHistoryId, () => state.historyId),
            }),
          () => [],
        ),
        FailedSync: failsIntoBackoff((state) =>
          ResumeBackfill({
            historyId: state.historyId,
            maybePageToken: resumePageToken(state),
            syncedCount: state.syncedCount,
            totalEstimate: state.totalEstimate,
          }),
        ),
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
        FailedSync: failsIntoBackoff((state) =>
          ResumeHistory({ historyId: state.historyId }),
        ),
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

    Backoff: {
      on: {
        CompletedWaitRetry: [
          when(
            resumeIs("ResumeCheckpoint"),
            "Cold",
            ({ state }) => Cold({ attempt: state.attempt }),
            ({ guardValue }) => [
              ReadSyncCheckpoint({ accountEmail: guardValue.accountEmail }),
            ],
          ),
          when(
            resumeIs("ResumeBackfill"),
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
              SyncBatch({
                maybePageToken: guardValue.maybePageToken,
                syncedCount: guardValue.syncedCount,
              }),
            ],
          ),
          when(
            resumeIs("ResumeHistory"),
            "CatchingUp",
            ({ state, guardValue }) =>
              CatchingUp({
                historyId: guardValue.historyId,
                attempt: state.attempt,
              }),
            ({ guardValue }) => [
              ApplyHistory({ historyId: guardValue.historyId }),
            ],
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

    NeedsAuth: {
      on: {
        ClickedReconnect: to(
          "Priming",
          () => Priming({ attempt: 0 }),
          () => [PrimeInbox()],
        ),
      },
    },
  },
});

/**
 * Collapsed step: state + commands out, `Ignored` collapsing to a no-op.
 *
 * This is the primary interface consumers (inbox update, tests) use. The
 * Machine's raw `step` is available for observability when needed.
 */
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
