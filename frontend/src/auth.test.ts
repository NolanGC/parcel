// Tests for the auth module: session persistence, session checking, sign-out.
import { UserId } from "@foldkit/backend";
import { Option } from "effect";
import { Story } from "foldkit";
import { describe, expect, test } from "vitest";

import {
  CheckSession,
  ClearSession,
  CompletedSessionPersistence,
  FailedCheckSession,
  FailedAuth,
  SaveSession,
  Session,
  SignInWithGoogle,
  SignOut,
  StartedGoogleRedirect,
  SucceededCheckSession,
  CompletedSignOut,
  readStoredSession,
} from "./auth";
import { HistoryId, PageToken, ThreadId } from "./Gmail";
import { SucceededReadSyncCheckpoint } from "./syncMachine";

const sampleSession: Session = {
  userId: UserId.make("user-1"),
  email: "ada@example.com",
  name: "Ada",
};

describe("Session Schema", () => {
  test("session constructor works", () => {
    const session = Session.make({
      userId: UserId.make("user-1"),
      email: "ada@example.com",
      name: "Ada",
    });
    expect(session.email).toBe("ada@example.com");
    expect(session.name).toBe("Ada");
  });
});

describe("Session persistence", () => {
  test("SaveSession command has the right name", () => {
    const cmd = SaveSession({ session: sampleSession });
    expect(cmd.name).toBe("SaveSession");
    expect(cmd.args).toEqual({ session: sampleSession });
  });

  test("ClearSession command has the right name", () => {
    const cmd = ClearSession();
    expect(cmd.name).toBe("ClearSession");
  });

  test("CheckSession command has the right name", () => {
    const cmd = CheckSession();
    expect(cmd.name).toBe("CheckSession");
  });

  test("SignInWithGoogle command has the right name", () => {
    const cmd = SignInWithGoogle();
    expect(cmd.name).toBe("SignInWithGoogle");
  });

  test("SignOut command has the right name", () => {
    const cmd = SignOut();
    expect(cmd.name).toBe("SignOut");
  });
});

describe("Auth message schemas", () => {
  test("SucceededCheckSession with session", () => {
    const msg = SucceededCheckSession({
      maybeSession: Option.some(sampleSession),
    });
    expect(msg._tag).toBe("SucceededCheckSession");
    expect(msg.maybeSession._tag).toBe("Some");
    if (msg.maybeSession._tag === "Some") {
      expect(msg.maybeSession.value.email).toBe("ada@example.com");
    }
  });

  test("SucceededCheckSession without session", () => {
    const msg = SucceededCheckSession({ maybeSession: Option.none() });
    expect(msg._tag).toBe("SucceededCheckSession");
    expect(msg.maybeSession._tag).toBe("None");
  });

  test("FailedCheckSession carries error string", () => {
    const msg = FailedCheckSession({ error: "network error" });
    expect(msg._tag).toBe("FailedCheckSession");
    expect(msg.error).toBe("network error");
  });

  test("SignOut message schemas", () => {
    expect(CompletedSignOut()._tag).toBe("CompletedSignOut");
    expect(StartedGoogleRedirect()._tag).toBe("StartedGoogleRedirect");
    expect(FailedAuth({ error: "denied" }).error).toBe("denied");
    expect(CompletedSessionPersistence()._tag).toBe(
      "CompletedSessionPersistence",
    );
  });
});
