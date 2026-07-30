// The outbox machine, exercised as the pure function it is: a state and a
// message in, the next state and the commands it issues out. No engine, no
// database, no Gmail — every outcome the drain can have is a DrainResult
// value, so all of them can simply be handed to `step`.

import { Option } from "effect";
import { describe, expect, test } from "vitest";

import { ThreadId } from "./Gmail";
import {
  Applied,
  Deferred,
  Drained,
  Rejected,
  emptySummary,
  type DrainResult,
  type OutboxSummary,
} from "./outboxEngine";
import * as OutboxMachine from "./outboxMachine";

const summaryOf = (pendingCount: number, failedCount = 0): OutboxSummary => ({
  pendingCount,
  failedCount,
});

const names = (
  commands: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<string> => commands.map((command) => command.name);

const stepped = (result: DrainResult) => OutboxMachine.SteppedDrain({ result });

const transient = (maybeRetryAfterMs = Option.none<number>()) =>
  stepped(Deferred({ isAuthError: false, maybeRetryAfterMs }));

const authFailure = stepped(
  Deferred({ isAuthError: true, maybeRetryAfterMs: Option.none() }),
);

const draining = (attempt = 0, summary = emptySummary) =>
  OutboxMachine.Draining({ attempt, summary });

describe("queueing", () => {
  test("an op queued while idle starts a drain", () => {
    const [state, commands] = OutboxMachine.step(
      OutboxMachine.init(),
      OutboxMachine.QueuedOp(),
    );

    expect(state._tag).toBe("Draining");
    expect(names(commands)).toEqual(["DrainOutbox"]);
  });

  // Two drains on one queue is the one way a message could be sent twice.
  test("an op queued mid-drain issues nothing: a drain is already in flight", () => {
    const [state, commands] = OutboxMachine.step(
      draining(),
      OutboxMachine.QueuedOp(),
    );

    expect(state._tag).toBe("Draining");
    expect(commands).toEqual([]);
  });

  test("the boot command drains whatever the last session left behind", () => {
    expect(names(OutboxMachine.bootCommands())).toEqual(["DrainOutbox"]);
  });
});

describe("draining", () => {
  test("a sent op is followed straight by the next one", () => {
    const [state, commands] = OutboxMachine.step(
      draining(),
      stepped(
        Applied({
          maybeSentThreadId: Option.none(),
          summary: summaryOf(2),
        }),
      ),
    );

    expect(state._tag).toBe("Draining");
    expect(state.summary.pendingCount).toBe(2);
    expect(names(commands)).toEqual(["DrainOutbox"]);
  });

  test("an empty queue settles, and stops asking", () => {
    const [state, commands] = OutboxMachine.step(
      draining(),
      stepped(Drained({ summary: emptySummary })),
    );

    expect(state._tag).toBe("Idle");
    expect(commands).toEqual([]);
  });

  // The engine has already rolled the op back or filed it as failed, so
  // there is nothing left to decide and no reason to stop.
  test("a rejected op does not stall the queue behind it", () => {
    const [state, commands] = OutboxMachine.step(
      draining(),
      stepped(
        Rejected({
          maybeRollback: Option.none(),
          maybeSentThreadId: Option.none(),
          message: "nope",
          summary: summaryOf(1, 1),
        }),
      ),
    );

    expect(state._tag).toBe("Draining");
    expect(names(commands)).toEqual(["DrainOutbox"]);
  });

  test("a success clears the failure count so the next op starts fresh", () => {
    const [state] = OutboxMachine.step(
      draining(4),
      stepped(
        Applied({ maybeSentThreadId: Option.none(), summary: summaryOf(1) }),
      ),
    );

    expect(state).toMatchObject({ _tag: "Draining", attempt: 0 });
  });
});

describe("failure", () => {
  test("a transient failure waits, and the wait is the state's own delay", () => {
    const [state, commands] = OutboxMachine.step(draining(), transient());

    expect(state._tag).toBe("Backoff");
    expect(names(commands)).toEqual(["WaitRetry"]);
    expect(state._tag === "Backoff" && state.delayMs).toBeGreaterThan(0);
    // The state and the command it issued must agree on how long the wait is.
    expect(commands[0]?.args).toEqual({
      delayMs: state._tag === "Backoff" ? state.delayMs : -1,
    });
  });

  // The attempt count rides through the retry, which is the whole reason
  // Draining carries one.
  test("consecutive failures escalate the delay instead of resetting it", () => {
    const [first] = OutboxMachine.step(draining(), transient());
    const [retrying] = OutboxMachine.step(
      first,
      OutboxMachine.CompletedWaitRetry(),
    );
    const [second] = OutboxMachine.step(retrying, transient());

    expect(first._tag === "Backoff" && second._tag === "Backoff").toBe(true);
    expect(
      second._tag === "Backoff" && first._tag === "Backoff"
        ? second.delayMs > first.delayMs
        : false,
    ).toBe(true);
  });

  test("Gmail's own Retry-After wins when it is longer than ours", () => {
    const [state] = OutboxMachine.step(
      draining(),
      transient(Option.some(90_000)),
    );

    expect(state).toMatchObject({ _tag: "Backoff", delayMs: 90_000 });
  });

  test("the wait ending resumes the drain", () => {
    const [waiting] = OutboxMachine.step(draining(), transient());
    const [state, commands] = OutboxMachine.step(
      waiting,
      OutboxMachine.CompletedWaitRetry(),
    );

    expect(state._tag).toBe("Draining");
    expect(names(commands)).toEqual(["DrainOutbox"]);
  });

  // A backoff is a scheduled retry of the op at the head of the queue.
  // Draining now would run that same op concurrently with the retry.
  test("a new op does not cut a backoff short", () => {
    const [waiting] = OutboxMachine.step(draining(), transient());
    const [state, commands] = OutboxMachine.step(
      waiting,
      OutboxMachine.QueuedOp(),
    );

    expect(state._tag).toBe("Backoff");
    expect(commands).toEqual([]);
  });
});

describe("authorization", () => {
  test("a lost grant parks the queue rather than retrying into it", () => {
    const [state, commands] = OutboxMachine.step(
      draining(0, summaryOf(3)),
      authFailure,
    );

    expect(state._tag).toBe("NeedsAuth");
    expect(commands).toEqual([]);
    // Nothing was lost — that is the point of parking rather than failing.
    expect(state.summary.pendingCount).toBe(3);
  });

  test("reconnecting drains from the top", () => {
    const [parked] = OutboxMachine.step(draining(), authFailure);
    const [state, commands] = OutboxMachine.step(
      parked,
      OutboxMachine.ClickedReconnect(),
    );

    expect(state._tag).toBe("Draining");
    expect(names(commands)).toEqual(["DrainOutbox"]);
  });
});

describe("failed sends", () => {
  test("retrying re-queues them and drains", () => {
    const [state, commands] = OutboxMachine.step(
      OutboxMachine.Idle({ summary: summaryOf(0, 2) }),
      OutboxMachine.ClickedRetryFailed(),
    );

    expect(state._tag).toBe("Idle");
    // The command re-queues and reports QueuedOp, which is what starts the
    // drain — this machine never drains without going through Draining.
    expect(names(commands)).toEqual(["RetryFailedSends"]);
  });

  // The badge renders wherever failedCount > 0, which includes the two states
  // a send is most likely to have failed from. Without an arm in each, the
  // button is a click that does nothing.
  test.each([
    [
      "Backoff",
      OutboxMachine.Backoff({
        attempt: 1,
        delayMs: 2_000,
        summary: summaryOf(1, 1),
      }),
    ],
    ["NeedsAuth", OutboxMachine.NeedsAuth({ summary: summaryOf(0, 1) })],
  ])("the retry is live in %s too", (_label, state) => {
    const [next, commands] = OutboxMachine.step(
      state,
      OutboxMachine.ClickedRetryFailed(),
    );

    expect(names(commands)).toEqual(["RetryFailedSends"]);
    // Re-queued, but not drained from here: Backoff already has a retry
    // scheduled, and NeedsAuth cannot send anything yet.
    expect(next._tag).toBe(state._tag);
  });
});

describe("the badge", () => {
  test("an empty queue has nothing to say", () => {
    expect(OutboxMachine.hasQueue(OutboxMachine.init())).toBe(false);
  });

  test("queued work and failed sends both count", () => {
    expect(
      OutboxMachine.hasQueue(OutboxMachine.Idle({ summary: summaryOf(1) })),
    ).toBe(true);
    expect(
      OutboxMachine.hasQueue(OutboxMachine.Idle({ summary: summaryOf(0, 1) })),
    ).toBe(true);
  });
});

// A resting state that cannot start a drain is a place queued mail goes to
// die. Each one is checked against the message that is supposed to wake it.
describe("every resting state can start a drain again", () => {
  const wakers: ReadonlyArray<
    readonly [string, OutboxMachine.State, OutboxMachine.Message]
  > = [
    ["Idle", OutboxMachine.init(), OutboxMachine.QueuedOp()],
    [
      "Backoff",
      OutboxMachine.Backoff({
        attempt: 1,
        delayMs: 2_000,
        summary: summaryOf(1),
      }),
      OutboxMachine.CompletedWaitRetry(),
    ],
    [
      "NeedsAuth",
      OutboxMachine.NeedsAuth({ summary: summaryOf(1) }),
      OutboxMachine.ClickedReconnect(),
    ],
  ];

  test.each(wakers)("%s wakes into a drain", (_label, state, message) => {
    const [next, commands] = OutboxMachine.step(state, message);

    expect(next._tag).toBe("Draining");
    expect(names(commands)).toEqual(["DrainOutbox"]);
  });

  // Parking preserves the queue rather than draining it away, so reconnecting
  // has something left to send.
  test("nothing is dropped on the way through a parked state", () => {
    const [parked] = OutboxMachine.step(draining(0, summaryOf(2)), authFailure);
    const [revived] = OutboxMachine.step(
      parked,
      OutboxMachine.ClickedReconnect(),
    );

    expect(revived.summary).toEqual(summaryOf(2));
  });
});

// The page needs to know which reply just settled so it can drop that
// thread's "sending" chip, whichever way it settled.
describe("a settled send names its thread", () => {
  const threadId = ThreadId.make("thread-1");

  test("when it lands", () => {
    const result = Applied({
      maybeSentThreadId: Option.some(threadId),
      summary: summaryOf(0),
    });
    const [, commands] = OutboxMachine.step(draining(), stepped(result));

    expect(result.maybeSentThreadId).toEqual(Option.some(threadId));
    expect(names(commands)).toEqual(["DrainOutbox"]);
  });

  test("and when it is given up on", () => {
    const result = Rejected({
      maybeRollback: Option.none(),
      maybeSentThreadId: Option.some(threadId),
      message: "Gave up after 8 attempts.",
      summary: summaryOf(0, 1),
    });
    const [state] = OutboxMachine.step(draining(), stepped(result));

    expect(result.maybeSentThreadId).toEqual(Option.some(threadId));
    expect(state.summary.failedCount).toBe(1);
  });
});
