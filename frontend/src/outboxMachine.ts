// The outbox machine: when the queue drains, on foldkit's experimental
// Machine — the sibling of syncMachine.ts, pointed the other way.
//
//   Idle ──QueuedOp──► Draining
//   Draining ──Applied/Rejected──► Draining (the next op)
//   Draining ──Drained──► Idle
//   Draining ──Deferred(auth)──► NeedsAuth ──ClickedReconnect──► Draining
//   Draining ──Deferred──► Backoff ──CompletedWaitRetry──► Draining
//
// A separate machine rather than another branch of the sync's: the two share
// a service and a backoff curve and nothing else. The sync's states carry
// backfill cursors that mean nothing to a drain, and pulling a mailbox down
// and pushing three label edits up are independent enough that one stalling
// must not stall the other.
//
// The whole machine is pure: `drainStep` reports every outcome including its
// failures as a DrainResult value, so there is no error channel to handle
// here and no state that is only reachable via one.

import { Effect, Match as M, Option, Schema as S } from "effect";
import { Command } from "foldkit";
import { Machine } from "foldkit/experimental";
import { otherwise, to, when } from "foldkit/experimental/machine";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";

import { backoffDelayMs } from "./backoff";
import {
  Deferred,
  DrainResult,
  OutboxEngine,
  OutboxSummary,
  emptySummary,
} from "./outboxEngine";

// STATE
//
// Every state carries the summary, so the toolbar's queue badge reads the
// machine directly rather than tracking a parallel count that could disagree
// with it.

export const Idle = ts("Idle", { summary: OutboxSummary });
/** A drain is in flight. `attempt` is the consecutive-failure count carried
 *  through the retry, so repeated failures escalate the delay. */
export const Draining = ts("Draining", {
  attempt: S.Number,
  summary: OutboxSummary,
});
export const Backoff = ts("Backoff", {
  attempt: S.Number,
  delayMs: S.Number,
  summary: OutboxSummary,
});
/** The grant is gone or predates the write scopes. Everything queued stays
 *  queued — nothing is lost, it just cannot leave yet. */
export const NeedsAuth = ts("NeedsAuth", { summary: OutboxSummary });

export const State = S.Union([Idle, Draining, Backoff, NeedsAuth]);
export type State = typeof State.Type;

export const init = (): State => Idle({ summary: emptySummary });

/** Whether anything is waiting to go out or has given up trying — what the
 *  toolbar shows a badge for. */
export const hasQueue = (state: State): boolean =>
  state.summary.pendingCount > 0 || state.summary.failedCount > 0;

// MESSAGE

/** Something became pending: a fresh action, or a failed send re-queued. */
export const QueuedOp = m("QueuedOp");
export const SteppedDrain = m("SteppedDrain", { result: DrainResult });
export const CompletedWaitRetry = m("CompletedWaitRetry");
/** The reconnect pill, which the sync machine also listens for. */
export const ClickedReconnect = m("ClickedReconnect");
/** The queue badge's "retry" action, for sends that gave up. */
export const ClickedRetryFailed = m("ClickedRetryFailed");

export const Message = S.Union([
  QueuedOp,
  SteppedDrain,
  CompletedWaitRetry,
  ClickedReconnect,
  ClickedRetryFailed,
]);
export type Message = typeof Message.Type;

// COMMAND

/**
 * One op, attempted once.
 *
 * NOTE: Infallible by construction — the engine folds every failure into a
 * DrainResult, because a drain that could fail its own Command would need a
 * second failure path here that says exactly what Deferred already says.
 */
export const DrainOutbox = Command.define(
  "DrainOutbox",
  SteppedDrain,
)(
  Effect.gen(function* () {
    const engine = yield* OutboxEngine;
    return yield* engine.drainStep.pipe(
      Effect.map((result) => SteppedDrain({ result })),
      // A SqlError here means the local store is unreachable, which the next
      // attempt may well find recovered; it is reported as the transient
      // deferral it is rather than losing the queue.
      Effect.catch(() =>
        Effect.succeed(
          SteppedDrain({
            result: Deferred({
              isAuthError: false,
              maybeRetryAfterMs: Option.none(),
            }),
          }),
        ),
      ),
    );
  }),
);

/** Puts every failed send back in the queue, then drains. */
export const RetryFailedSends = Command.define(
  "RetryFailedSends",
  QueuedOp,
)(
  Effect.gen(function* () {
    const engine = yield* OutboxEngine;
    // A retry that cannot even be recorded leaves the sends exactly where
    // they were: failed, visible, and still retryable.
    return yield* engine.retryFailedSends.pipe(
      Effect.catch(() => Effect.void),
      Effect.as(QueuedOp()),
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

/** Boot: drain whatever the last session left behind. An empty queue reports
 *  Drained and settles into Idle without a request. */
export const bootCommands = (): ReadonlyArray<
  Command.Command<Message, never, OutboxEngine>
> => [DrainOutbox()];

// MACHINE

// Narrows a drain result to one variant, the way syncMachine narrows a parked
// resume. The Draining exits are a chain of these.
const resultAs =
  <Tag extends DrainResult["_tag"]>(tag: Tag) =>
  (
    _state: State,
    message: typeof SteppedDrain.Type,
  ): Option.Option<Extract<DrainResult, { readonly _tag: Tag }>> =>
    Option.liftPredicate(
      message.result,
      (result): result is Extract<DrainResult, { readonly _tag: Tag }> =>
        result._tag === tag,
    );

// The one deferral a retry cannot fix, and so the only one that needs a guard
// of its own — everything else that reaches the end of the chain is a
// transient one, handled by `otherwise`.
const authDeferral = (
  state: State,
  message: typeof SteppedDrain.Type,
): Option.Option<typeof Deferred.Type> =>
  Option.filter(
    resultAs("Deferred")(state, message),
    (result) => result.isAuthError,
  );

// The delay the retry waits out. The Backoff state and its WaitRetry command
// both need it, and they must agree.
const retryDelay = (
  state: Readonly<{ attempt: number }>,
  message: typeof SteppedDrain.Type,
): number =>
  backoffDelayMs(
    state.attempt + 1,
    message.result._tag === "Deferred"
      ? message.result.maybeRetryAfterMs
      : Option.none(),
  );

export const outboxMachine = Machine.define({
  state: State,
  message: Message,
})({
  initial: Idle({ summary: emptySummary }),
  states: {
    Idle: {
      on: {
        QueuedOp: to(
          "Draining",
          ({ state }) => Draining({ attempt: 0, summary: state.summary }),
          () => [DrainOutbox()],
        ),
        ClickedRetryFailed: to(
          "Idle",
          ({ state }) => state,
          () => [RetryFailedSends()],
        ),
      },
    },

    Draining: {
      on: {
        SteppedDrain: [
          when(
            resultAs("Applied"),
            "Draining",
            ({ guardValue }) =>
              // A success clears the failure count: the next op starts fresh
              // rather than inheriting the previous one's suspicion.
              Draining({ attempt: 0, summary: guardValue.summary }),
            () => [DrainOutbox()],
          ),
          // A rejection is a settled answer, and the engine has already dealt
          // with the row, so the queue keeps moving.
          when(
            resultAs("Rejected"),
            "Draining",
            ({ guardValue }) =>
              Draining({ attempt: 0, summary: guardValue.summary }),
            () => [DrainOutbox()],
          ),
          when(
            resultAs("Drained"),
            "Idle",
            ({ guardValue }) => Idle({ summary: guardValue.summary }),
            () => [],
          ),
          when(authDeferral, "NeedsAuth", ({ state }) =>
            NeedsAuth({ summary: state.summary }),
          ),
          // Everything left is a transient deferral: the op is still at the
          // head of the queue, so the count is unchanged and only the delay
          // is new.
          otherwise(
            to(
              "Backoff",
              ({ state, message }) =>
                Backoff({
                  attempt: state.attempt + 1,
                  delayMs: retryDelay(state, message),
                  summary: state.summary,
                }),
              ({ state, message }) => [
                WaitRetry({ delayMs: retryDelay(state, message) }),
              ],
            ),
          ),
        ],
        // A drain is already in flight and takes the queue as it finds it, so
        // the new op needs no command of its own. Issuing one here would put
        // two drains on the same head-of-queue row.
        QueuedOp: to(
          "Draining",
          ({ state }) => state,
          () => [],
        ),
        ClickedRetryFailed: to(
          "Draining",
          ({ state }) => state,
          () => [RetryFailedSends()],
        ),
      },
    },

    // NOTE: A new action does not cut the wait short. The op at the head of
    // the queue is the one that failed, FIFO means it goes first regardless,
    // and draining now would run it concurrently with the retry already
    // scheduled — the one way a send could go out twice.
    Backoff: {
      on: {
        CompletedWaitRetry: to(
          "Draining",
          ({ state }) =>
            Draining({ attempt: state.attempt, summary: state.summary }),
          () => [DrainOutbox()],
        ),
        // Re-queues without draining: the scheduled WaitRetry is what picks
        // the queue back up, and a second drain now would double-send.
        ClickedRetryFailed: to(
          "Backoff",
          ({ state }) => state,
          () => [RetryFailedSends()],
        ),
      },
    },

    // Nothing is lost here: the queue is intact and drains from the top the
    // moment the grant comes back.
    NeedsAuth: {
      on: {
        ClickedReconnect: to(
          "Draining",
          ({ state }) => Draining({ attempt: 0, summary: state.summary }),
          () => [DrainOutbox()],
        ),
        // Re-queued but still parked: nothing leaves until the grant is back.
        // Without this arm the retry button, which renders in this state too,
        // would be a click that does nothing at all.
        ClickedRetryFailed: to(
          "NeedsAuth",
          ({ state }) => state,
          () => [RetryFailedSends()],
        ),
      },
    },
  },
});

/** Tuple-shaped step over the Machine — state + commands out, `Ignored`
 *  collapsing to a no-op. What the inbox update and the tests consume. */
export const step = (
  state: State,
  message: Message,
): readonly [
  State,
  ReadonlyArray<Command.Command<Message, never, OutboxEngine>>,
] => {
  const result = outboxMachine.step(state, message);
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
