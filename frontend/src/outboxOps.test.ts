// The ops the outbox stores: what each one does locally, what undoes it, and
// which failures are worth retrying.

import { Effect, Option } from "effect";
import { describe, expect, test } from "vitest";

import {
  GmailAuthError,
  GmailInvalidRequest,
  GmailNetworkError,
  GmailNotFound,
  GmailRateLimited,
  GmailScopeError,
  GmailServerError,
  ThreadId,
  type GmailError,
} from "./Gmail";
import {
  ModifyThreadLabels,
  SendMessage,
  archiveOp,
  classifyFailure,
  decodeOutboxPayload,
  encodeOutboxOp,
  inverseOf,
  patchOf,
  readOp,
  starOp,
  type OutboxOp,
} from "./outboxOps";

const threadId = ThreadId.make("thread-1");

const roundTrip = (op: OutboxOp): Option.Option<OutboxOp> =>
  Effect.runSync(decodeOutboxPayload(JSON.stringify(encodeOutboxOp(op))));

describe("the flag actions are label edits", () => {
  test("starring adds the label, unstarring removes it", () => {
    expect(starOp(threadId, false).addLabelIds).toEqual(["STARRED"]);
    expect(starOp(threadId, true).removeLabelIds).toEqual(["STARRED"]);
  });

  // Marking read is the removal of UNREAD, which is the direction that trips
  // people up: the op is named for the label, not for the intent.
  test("marking read removes UNREAD, marking unread adds it", () => {
    expect(readOp(threadId, true).removeLabelIds).toEqual(["UNREAD"]);
    expect(readOp(threadId, false).addLabelIds).toEqual(["UNREAD"]);
  });

  test("archiving removes INBOX", () => {
    expect(archiveOp(threadId).removeLabelIds).toEqual(["INBOX"]);
  });
});

describe("the local effect", () => {
  test("starring says something about the star and nothing else", () => {
    const patch = patchOf(starOp(threadId, false));

    expect(patch.maybeIsStarred).toEqual(Option.some(true));
    expect(patch.maybeIsUnread).toEqual(Option.none());
    expect(patch.isRemoved).toBe(false);
  });

  test("marking read says the thread is no longer unread", () => {
    expect(patchOf(readOp(threadId, true)).maybeIsUnread).toEqual(
      Option.some(false),
    );
  });

  test("archiving takes the row out of the list", () => {
    expect(patchOf(archiveOp(threadId)).isRemoved).toBe(true);
  });

  // A thread gaining INBOX has arrived rather than been un-archived, and
  // that reaches the list through the sync, not through a patch.
  test("gaining INBOX does not put a row back", () => {
    const unarchive = ModifyThreadLabels({
      threadId,
      addLabelIds: [],
      removeLabelIds: [],
    });

    expect(patchOf(unarchive).isRemoved).toBe(false);
  });
});

describe("rollback", () => {
  test("the inverse swaps the two sets", () => {
    const inverse = inverseOf(starOp(threadId, false));

    expect(inverse.addLabelIds).toEqual([]);
    expect(inverse.removeLabelIds).toEqual(["STARRED"]);
  });

  test("undoing an archive puts the row back", () => {
    expect(patchOf(inverseOf(archiveOp(threadId))).isRemoved).toBe(false);
  });

  test("the inverse of the inverse is the original", () => {
    const op = readOp(threadId, true);

    expect(inverseOf(inverseOf(op))).toEqual(op);
  });

  test("a rolled-back star lands back where it started", () => {
    const wasStarred = true;
    const op = starOp(threadId, wasStarred);

    expect(patchOf(op).maybeIsStarred).toEqual(Option.some(!wasStarred));
    expect(patchOf(inverseOf(op)).maybeIsStarred).toEqual(
      Option.some(wasStarred),
    );
  });
});

describe("payloads", () => {
  test("a label edit survives the round trip through the queue", () => {
    const op = starOp(threadId, false);

    expect(roundTrip(op)).toEqual(Option.some(op));
  });

  test("a reply keeps its threading headers", () => {
    const op = SendMessage({
      to: ["grace@example.com"],
      subject: "Re: Lunch",
      bodyMarkdown: "**yes**",
      bodyHtml: "<p><strong>yes</strong></p>",
      maybeThreadId: Option.some(threadId),
      maybeInReplyTo: Option.some("<parent@mail.example.com>"),
      references: "<root@mail.example.com> <parent@mail.example.com>",
    });

    expect(roundTrip(op)).toEqual(Option.some(op));
  });

  // Total by design: a payload this app wrote and can no longer read is a bug
  // in the schema pair, and dropping that one row beats taking the mailbox
  // down over it.
  test("an unreadable payload reports None rather than failing", () => {
    expect(Effect.runSync(decodeOutboxPayload("not json"))).toEqual(
      Option.none(),
    );
    expect(Effect.runSync(decodeOutboxPayload('{"_tag":"Nonsense"}'))).toEqual(
      Option.none(),
    );
  });
});

describe("failure classification", () => {
  const transient: ReadonlyArray<readonly [string, GmailError]> = [
    ["offline", new GmailNetworkError({ message: "offline" })],
    ["Google's fault", new GmailServerError({ message: "boom", code: 503 })],
    ["a rate limit", new GmailRateLimited({ message: "slow down" })],
  ];

  test.each(transient)("%s is worth retrying", (_label, error) => {
    expect(classifyFailure(error)._tag).toBe("Transient");
  });

  test("a rate limit carries Google's own retry hint through", () => {
    const failure = classifyFailure(
      new GmailRateLimited({ message: "slow down", retryAfterMs: 30_000 }),
    );

    expect(failure).toMatchObject({
      _tag: "Transient",
      maybeRetryAfterMs: Option.some(30_000),
    });
  });

  const unauthorized: ReadonlyArray<readonly [string, GmailError]> = [
    ["a rejected token", new GmailAuthError({ message: "401" })],
    ["a missing scope", new GmailScopeError({ message: "403" })],
  ];

  // These park the queue rather than consuming attempts: the grant coming
  // back is not a retry of a request that was refused on its merits.
  test.each(unauthorized)("%s parks the queue", (_label, error) => {
    expect(classifyFailure(error)._tag).toBe("Unauthorized");
  });

  const permanent: ReadonlyArray<readonly [string, GmailError]> = [
    ["a thread that is gone", new GmailNotFound({ message: "404" })],
    [
      "a malformed request",
      new GmailInvalidRequest({ message: "", code: 400 }),
    ],
  ];

  test.each(permanent)("%s is a settled answer", (_label, error) => {
    expect(classifyFailure(error)._tag).toBe("Permanent");
  });

  // Guessing Permanent on an error we failed to anticipate would throw away a
  // send; guessing Transient costs at worst the attempt cap.
  test("an unrecognized failure is assumed to be transient", () => {
    expect(classifyFailure({ _tag: "SqlError" } as never)._tag).toBe(
      "Transient",
    );
  });
});
