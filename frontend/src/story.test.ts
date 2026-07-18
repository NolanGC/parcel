// Pure update-logic tests (Foldkit Story): messages in, model + commands
// out. No DOM, no network — nothing here proves a fetch actually behaves as
// modeled.
//
// Covers:
// - init: cached session lands LoggedIn (and the login route bounces to the
//   inbox); no session gates the inbox route behind login; an OAuth
//   ?error= callback param surfaces on the login page.
// - GotSession transitions: cookie confirms → LoggedIn; cookie gone →
//   LoggedOut.
// - Sign-out lands back on the marketing page.
//
// Does NOT cover:
// - Rendering (see scene.test.ts) or real command effects (HTTP).
// - The Google OAuth redirect flow itself.
import { UserId } from "@foldkit/backend";
import { Option } from "effect";
import { type Url } from "foldkit/url";
import { describe, expect, test } from "vitest";

import { CompletedSignOut, GotSession } from "./auth";
import { MessageId, ThreadId } from "./Gmail";
import { GotInboxMessage, init, update, type Model } from "./main";
import { Inbox } from "./page";
import * as Ui from "./ui";

const session = {
  userId: UserId.make("user-1"),
  email: "ada@example.com",
  name: "Ada",
};
const loggedInFlags = { maybeSession: Option.some(session) };
const loggedOutFlags = { maybeSession: Option.none<typeof session>() };

const url = (pathname: string, search?: string): Url => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.fromNullishOr(search),
  hash: Option.none(),
});

const asLoggedOut = (model: Model): Extract<Model, { _tag: "LoggedOut" }> => {
  if (model._tag !== "LoggedOut") {
    throw new Error(`Expected LoggedOut model, got ${model._tag}`);
  }
  return model;
};

describe("init", () => {
  test("a cached session lands logged in on the inbox", () => {
    const [model, commands] = init(loggedInFlags, url("/inbox"));

    expect(model._tag).toBe("LoggedIn");
    expect(model.route._tag).toBe("Inbox");
    // The boot-time CheckSession revalidation + the first inbox pull.
    expect(commands.map((command) => command.name)).toEqual([
      "CheckSession",
      "LoadInbox",
    ]);
  });

  test("a cached session bounces the login route to the inbox", () => {
    const [model, commands] = init(loggedInFlags, url("/login"));

    expect(model._tag).toBe("LoggedIn");
    expect(model.route._tag).toBe("Inbox");
    // RedirectToInbox + CheckSession + the first inbox pull.
    expect(commands.map((command) => command.name)).toEqual([
      "RedirectToInbox",
      "CheckSession",
      "LoadInbox",
    ]);
  });

  test("without a session the inbox route redirects to login", () => {
    const [model, commands] = init(loggedOutFlags, url("/inbox"));

    expect(model._tag).toBe("LoggedOut");
    expect(model.route._tag).toBe("Login");
    // RedirectToLogin + CheckSession.
    expect(commands).toHaveLength(2);
  });

  test("the landing page is browsable while logged out", () => {
    const [model] = init(loggedOutFlags, url("/"));

    expect(model._tag).toBe("LoggedOut");
    expect(model.route._tag).toBe("Home");
  });

  test("a declined OAuth round-trip surfaces on the login page", () => {
    const [model] = init(loggedOutFlags, url("/login", "?error=access_denied"));

    expect(asLoggedOut(model).loginPage.error).toEqual(
      Option.some("Google sign-in was cancelled."),
    );
  });
});

describe("update", () => {
  test("a confirmed cookie moves LoggedOut to LoggedIn on the inbox", () => {
    const [model] = init(loggedOutFlags, url("/login"));
    const [next] = update(
      model,
      GotSession({ maybeSession: Option.some(session) }),
    );

    expect(next._tag).toBe("LoggedIn");
    expect(next.route._tag).toBe("Inbox");
  });

  test("a vanished cookie drops LoggedIn back to the landing page", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [next] = update(model, GotSession({ maybeSession: Option.none() }));

    expect(next._tag).toBe("LoggedOut");
    expect(next.route._tag).toBe("Home");
  });

  test("sign-out lands on the marketing page", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [next] = update(model, CompletedSignOut());

    expect(next._tag).toBe("LoggedOut");
    expect(next.route._tag).toBe("Home");
  });

  test("clicking a list row issues LoadThread for that thread", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [, commands] = update(
      model,
      GotInboxMessage({
        message: Inbox.GotListMessage({
          message: Ui.Table.ClickedRow({ key: "thread-1" }),
        }),
      }),
    );

    expect(commands.map((command) => command.name)).toContain("LoadThread");
  });

  test("hovering a row starts the dwell timer; dwell prefetches it", () => {
    const threadRow = {
      id: ThreadId.make("thread-1"),
      subject: "Hi",
      sender: "Ada",
      snippet: "hello",
      date: 1,
      unread: false,
      category: "none" as const,
    };
    const inboxMessage = (message: Inbox.Message) =>
      GotInboxMessage({ message });

    const [model] = init(loggedInFlags, url("/inbox"));
    const [withThreads] = update(
      model,
      inboxMessage(Inbox.GotThreads({ rows: [threadRow] })),
    );
    const [hovered, hoverCommands] = update(
      withThreads,
      inboxMessage(
        Inbox.GotListMessage({ message: Ui.Table.EnteredRow({ index: 0 }) }),
      ),
    );
    expect(hoverCommands.map((command) => command.name)).toContain(
      "StartDwell",
    );

    const [, dwellCommands] = update(
      hovered,
      inboxMessage(Inbox.DwellElapsed({ id: threadRow.id })),
    );
    expect(dwellCommands.map((command) => command.name)).toContain(
      "LoadThread",
    );
  });

  test("a prefetched thread mounts silently and swaps on click", () => {
    const threadRow = {
      id: ThreadId.make("thread-1"),
      subject: "Hi",
      sender: "Ada",
      snippet: "hello",
      date: 1,
      unread: false,
      category: "none" as const,
    };
    const detail = {
      id: threadRow.id,
      subject: "Hi",
      messages: [
        {
          id: MessageId.make("m1"),
          fromName: "Ada",
          fromEmail: "ada@example.com",
          date: 1,
          bodyKind: "plain" as const,
          body: "hello",
        },
      ],
    };
    const inboxMessage = (message: Inbox.Message) =>
      GotInboxMessage({ message });

    const [model] = init(loggedInFlags, url("/inbox"));
    const [withThreads] = update(
      model,
      inboxMessage(Inbox.GotThreads({ rows: [threadRow] })),
    );
    const [hovered] = update(
      withThreads,
      inboxMessage(
        Inbox.GotListMessage({ message: Ui.Table.EnteredRow({ index: 0 }) }),
      ),
    );
    const [loading] = update(
      hovered,
      inboxMessage(Inbox.DwellElapsed({ id: threadRow.id })),
    );

    // The prefetch result mounts invisibly: no scroll reset, no swap.
    const [mounted, mountCommands] = update(
      loading,
      inboxMessage(Inbox.GotThread({ detail })),
    );
    expect(mountCommands.map((command) => command.name)).not.toContain(
      "ResetScroll",
    );

    // The click commits; an all-plain (already-ready) thread swaps now.
    const [, clickCommands] = update(
      mounted,
      inboxMessage(
        Inbox.GotListMessage({
          message: Ui.Table.ClickedRow({ key: "thread-1" }),
        }),
      ),
    );
    expect(clickCommands.map((command) => command.name)).toContain(
      "ResetScroll",
    );
  });

  test("j selects the first row and Enter opens it", () => {
    const threadRow = {
      id: ThreadId.make("thread-1"),
      subject: "Hi",
      sender: "Ada",
      snippet: "hello",
      date: 1,
      unread: false,
      category: "none" as const,
    };
    const inboxMessage = (message: Inbox.Message) =>
      GotInboxMessage({ message });

    const [model] = init(loggedInFlags, url("/inbox"));
    const [withThreads] = update(
      model,
      inboxMessage(Inbox.GotThreads({ rows: [threadRow] })),
    );
    const [selected, moveCommands] = update(
      withThreads,
      inboxMessage(Inbox.PressedListKey({ key: "j" })),
    );
    // Moving the cursor scrolls it into view and starts the prefetch dwell.
    expect(moveCommands.map((command) => command.name)).toEqual([
      "ScrollRowIntoView",
      "StartDwell",
    ]);

    const [, openCommands] = update(
      selected,
      inboxMessage(Inbox.PressedListKey({ key: "Enter" })),
    );
    expect(openCommands.map((command) => command.name)).toContain("LoadThread");
  });

  test("an open prefetches the adjacent thread into standby", () => {
    const row = (n: number) => ({
      id: ThreadId.make(`thread-${n}`),
      subject: `S${n}`,
      sender: "Ada",
      snippet: "hello",
      date: n,
      unread: false,
      category: "none" as const,
    });
    const inboxMessage = (message: Inbox.Message) =>
      GotInboxMessage({ message });

    const [model] = init(loggedInFlags, url("/inbox"));
    const [withThreads] = update(
      model,
      inboxMessage(Inbox.GotThreads({ rows: [row(1), row(2)] })),
    );
    const [, openCommands] = update(
      withThreads,
      inboxMessage(
        Inbox.GotListMessage({
          message: Ui.Table.ClickedRow({ key: "thread-1" }),
        }),
      ),
    );
    expect(openCommands.map((command) => command.name)).toContain(
      "PrefetchStandby",
    );
  });

  test("the inbox popover's sign-out runs the SignOut command", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [, commands] = update(
      model,
      GotInboxMessage({ message: Inbox.ClickedSignOut() }),
    );

    expect(commands.map((command) => command.name)).toContain("SignOut");
  });
});
