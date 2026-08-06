// Tests for the Preferences service: every localStorage-backed preference
// behind one service. These assert the Command shapes/messages and boot-read
// wiring; the actual localStorage round-trip is exercised by the integration
// tests through happy-dom.
import { UserId } from "@foldkit/backend";
import { describe, expect, test } from "vitest";
import { HistoryId, MessageId, PageToken, ThreadId } from "../Gmail";

import {
  ClearSession,
  ClearSnapshot,
  SaveAppearance,
  SaveReadingMode,
  SaveSession,
  SaveSnapshot,
  readStoredSession,
  readStoredSnapshot,
} from "./preferences";

import { Session } from "../auth";
import { InboxSnapshot } from "../inboxSnapshot";

const sampleSession: Session = {
  userId: UserId.make("user-1"),
  email: "ada@example.com",
  name: "Ada",
};

const row = {
  id: ThreadId.make("thread-1"),
  subject: "Hi",
  sender: "Ada",
  senderEmail: "ada@example.com",
  snippet: "hello",
  date: 1,
  isUnread: false,
  category: "none" as const,
};

describe("Preferences commands", () => {
  test("SaveSession command has the right shape", () => {
    const cmd = SaveSession({ session: sampleSession });
    expect(cmd.name).toBe("SaveSession");
    expect(cmd.args).toEqual({ session: sampleSession });
  });

  test("ClearSession command has the right name", () => {
    expect(ClearSession().name).toBe("ClearSession");
  });

  test("SaveSnapshot command has the right shape", () => {
    const snapshot: InboxSnapshot = { email: "ada@example.com", rows: [row] };
    const cmd = SaveSnapshot({ snapshot });
    expect(cmd.name).toBe("SaveSnapshot");
    expect(cmd.args).toEqual({ snapshot });
  });

  test("ClearSnapshot command has the right name", () => {
    expect(ClearSnapshot().name).toBe("ClearSnapshot");
  });

  test("SaveAppearance command has the right shape", () => {
    const cmd = SaveAppearance({ appearance: "Dark" });
    expect(cmd.name).toBe("SaveAppearance");
    expect(cmd.args).toEqual({ appearance: "Dark" });
  });

  test("SaveReadingMode command has the right shape", () => {
    const cmd = SaveReadingMode({ mode: "markdown" });
    expect(cmd.name).toBe("SaveReadingMode");
    expect(cmd.args).toEqual({ mode: "markdown" });
  });
});

describe("Preferences boot reads", () => {
  test("readStoredSession is an effect", () => {
    expect(typeof readStoredSession).toBe("object");
  });

  test("readStoredSnapshot is an effect", () => {
    expect(typeof readStoredSnapshot).toBe("object");
  });
});
