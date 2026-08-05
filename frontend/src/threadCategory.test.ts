// Which tab a thread lands in — and, because the backfill walks Primary
// first, which slice of the mailbox it appears to have fetched.
//
// The bug these were written for: the category was read from the thread's
// *first* categorized message. Gmail hands `thread.messages` over oldest-first
// and places a conversation by its newest message, so a thread that began as a
// newsletter kept the newsletter's tab forever. Gmail would serve it in the
// Primary slice and the store would file it under Updates.

import { describe, expect, it } from "vitest";

import { MessageId, ThreadId, type Message } from "./Gmail";
import { threadCategory } from "./sync";

const message = (date: number, labelIds: ReadonlyArray<string>): Message =>
  ({
    id: MessageId.make(`m-${date}`),
    threadId: ThreadId.make("t-1"),
    internalDate: String(date),
    labelIds,
  }) as unknown as Message;

describe("threadCategory", () => {
  it("has no category when nothing is labelled — which is Primary", () => {
    expect(threadCategory([message(1, ["INBOX", "UNREAD"])])).toBe("none");
  });

  it("reads a single message's category", () => {
    expect(threadCategory([message(1, ["INBOX", "CATEGORY_PROMOTIONS"])])).toBe(
      "promotions",
    );
  });

  // The regression. A promotional first message, a real reply after it.
  it("follows the newest message, not the oldest", () => {
    const thread = [
      message(1000, ["CATEGORY_UPDATES"]),
      message(2000, ["CATEGORY_PERSONAL"]),
    ];

    expect(threadCategory(thread)).toBe("personal");
  });

  // Order of arrival must not decide it, so the sort is explicit rather than
  // inherited from however the API happened to serialize the thread.
  it("does not depend on the order the messages arrive in", () => {
    const newest = message(2000, ["CATEGORY_PERSONAL"]);
    const oldest = message(1000, ["CATEGORY_UPDATES"]);

    expect(threadCategory([oldest, newest])).toBe(
      threadCategory([newest, oldest]),
    );
  });

  // An uncategorized newest message is Primary's own signature, so it must not
  // fall through to an older message's label.
  it("skips uncategorized messages to reach the newest labelled one", () => {
    const thread = [
      message(1000, ["CATEGORY_PROMOTIONS"]),
      message(3000, ["INBOX"]),
    ];

    expect(threadCategory(thread)).toBe("promotions");
  });

  it("survives messages with no date or labels at all", () => {
    expect(() =>
      threadCategory([{ id: MessageId.make("m-x") } as unknown as Message]),
    ).not.toThrow();
  });
});
