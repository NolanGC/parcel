// Pure update-logic tests (Foldkit Story): messages in, model + commands
// out. No DOM, no network — nothing here proves a fetch actually behaves as
// modeled, but every fallible Command is driven down BOTH branches by
// resolving it with its Succeeded* and with its Failed* result.
//
// Covers:
// - init: cached session lands LoggedIn (and the login route bounces to the
//   inbox); no session gates the inbox route behind login; an OAuth
//   ?error= callback param surfaces on the login page.
// - Session transitions: cookie confirms → LoggedIn; cookie gone →
//   LoggedOut; a failed check leaves the signed-in user alone.
// - The login page's own three statuses, including the double-click and
//   click-while-checking guards.
// - The inbox load, the thread open, and the palette search, each resolved
//   to success and to failure.
// - Sign-out lands back on the marketing page.
//
// Does NOT cover:
// - Rendering (see scene.test.ts) or real command effects (HTTP).
// - The Google OAuth redirect flow itself.
import { UserId } from "@foldkit/backend";
import { Option } from "effect";
import { Story } from "foldkit";
import { type Url } from "foldkit/url";
import { describe, expect, test } from "vitest";

import {
  CompletedSignOut,
  FailedAuth,
  FailedCheckSession,
  SucceededCheckSession,
} from "./auth";
import { HistoryId, MessageId, PageToken, ThreadId } from "./Gmail";
import { GotInboxMessage, init, update, type Model } from "./main";
import { Inbox, Login } from "./page";
import * as SyncMachine from "./syncMachine";
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

const threadRow = {
  id: ThreadId.make("thread-1"),
  subject: "Hi",
  sender: "Ada",
  snippet: "hello",
  date: 1,
  isUnread: false,
  category: "none" as const,
};

const otherRow = {
  ...threadRow,
  id: ThreadId.make("thread-2"),
  subject: "Later",
};

const threadDetail = {
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

const inboxMessage = (message: Inbox.Message) => GotInboxMessage({ message });

// The inbox with one row already loaded. A plain update chain rather than a
// Story, because it is a fixture and asserts nothing.
const loadedInbox = (): Model => {
  const [model] = init(loggedInFlags, url("/inbox"));
  const [withThreads] = update(
    model,
    inboxMessage(Inbox.SucceededLoadInbox({ rows: [threadRow] })),
  );
  return withThreads;
};

describe("init", () => {
  test("a cached session lands logged in on the inbox", () => {
    const [model, commands] = init(loggedInFlags, url("/inbox"));

    expect(model._tag).toBe("LoggedIn");
    expect(model.route._tag).toBe("Inbox");
    // The boot-time CheckSession revalidation + the inbox boot (local
    // read, the store's size for the sync pill, and the sync machine's
    // checkpoint read).
    expect(commands.map((command) => command.name)).toEqual([
      "CheckSession",
      "LoadInbox",
      "ReadLocalSize",
      "CacheImageBatch",
      "ReadSyncCheckpoint",
    ]);
  });

  test("a cached session bounces the login route to the inbox", () => {
    const [model, commands] = init(loggedInFlags, url("/login"));

    expect(model._tag).toBe("LoggedIn");
    expect(model.route._tag).toBe("Inbox");
    // RedirectToInbox + CheckSession + the inbox boot.
    expect(commands.map((command) => command.name)).toEqual([
      "RedirectToInbox",
      "CheckSession",
      "LoadInbox",
      "ReadLocalSize",
      "CacheImageBatch",
      "ReadSyncCheckpoint",
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

    expect(asLoggedOut(model).loginPage.maybeError).toEqual(
      Option.some("Google sign-in was cancelled."),
    );
  });
});

// Routing and session transitions. These assert where the model lands, not
// what the resulting Commands do, so they step `update` directly — wrapping
// them in a Story would only add resolvers for the boot fan-out (SaveSession,
// the redirect, the inbox boot) that these tests say nothing about.
describe("session", () => {
  test("a confirmed cookie moves LoggedOut to LoggedIn on the inbox", () => {
    const [model] = init(loggedOutFlags, url("/login"));
    const [next] = update(
      model,
      SucceededCheckSession({ maybeSession: Option.some(session) }),
    );

    expect(next._tag).toBe("LoggedIn");
    expect(next.route._tag).toBe("Inbox");
  });

  test("a vanished cookie drops LoggedIn back to the landing page", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [next] = update(
      model,
      SucceededCheckSession({ maybeSession: Option.none() }),
    );

    expect(next._tag).toBe("LoggedOut");
    expect(next.route._tag).toBe("Home");
  });

  // A network hiccup is not a sign-out: the cached session has to survive
  // one, or every flaky revalidation would bounce the user to the landing
  // page mid-session.
  test("a failed session check leaves the signed-in user where they are", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [next] = update(model, FailedCheckSession({ error: "network down" }));

    expect(next._tag).toBe("LoggedIn");
    expect(next.route._tag).toBe("Inbox");
  });

  test("sign-out lands on the marketing page", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [next] = update(model, CompletedSignOut());

    expect(next._tag).toBe("LoggedOut");
    expect(next.route._tag).toBe("Home");
  });

  test("the inbox popover's sign-out runs the SignOut command", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [, commands] = update(
      model,
      inboxMessage(Inbox.ClickedAccountSignOut()),
    );

    expect(commands.map((command) => command.name)).toContain("SignOut");
  });
});

// The login page's own update. Its three statuses are what the button reads
// from, so each transition is asserted directly rather than through the shell.
describe("the login page", () => {
  test("clicking sign-in moves Ready to Redirecting and starts the flow", () => {
    const [next, commands] = Login.update(
      Login.init(Login.Ready()),
      Login.ClickedGoogleSignIn(),
    );

    expect(next.status._tag).toBe("Redirecting");
    expect(commands.map((command) => command.name)).toEqual([
      "SignInWithGoogle",
    ]);
  });

  // Double-clicking the button, or clicking it while the boot session check
  // is still running, must not fire a second redirect.
  test("clicking again while redirecting does not start a second flow", () => {
    const [next, commands] = Login.update(
      Login.init(Login.Redirecting()),
      Login.ClickedGoogleSignIn(),
    );

    expect(next.status._tag).toBe("Redirecting");
    expect(commands).toEqual([]);
  });

  test("clicking while the session check is in flight is ignored", () => {
    const [, commands] = Login.update(
      Login.init(Login.CheckingSession()),
      Login.ClickedGoogleSignIn(),
    );

    expect(commands).toEqual([]);
  });

  test("a failure to start the flow returns the button to Ready with the error", () => {
    const [next] = Login.update(
      Login.init(Login.Redirecting()),
      FailedAuth({ error: "popup blocked" }),
    );

    expect(next.status._tag).toBe("Ready");
    expect(next.maybeError).toEqual(Option.some("popup blocked"));
  });

  // The parent owns the session check, so it is the parent that tells the page
  // the check came back empty.
  test("a settled session check releases the button", () => {
    const settled = Login.settledSessionCheck(
      Login.init(Login.CheckingSession()),
    );

    expect(settled.status._tag).toBe("Ready");
  });

  test("a settled session check leaves an in-flight redirect alone", () => {
    const settled = Login.settledSessionCheck(Login.init(Login.Redirecting()));

    expect(settled.status._tag).toBe("Redirecting");
  });
});

// The inbox read has no single user action that issues it on its own — it
// rides the boot fan-out and the sync machine's progress — so both outcomes
// are asserted at the Message level rather than by resolving the Command.
describe("loading the inbox", () => {
  test("rows landing from the store put them on screen", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [next] = update(
      model,
      inboxMessage(Inbox.SucceededLoadInbox({ rows: [threadRow] })),
    );

    expect(next.inboxPage.threads._tag).toBe("Success");
  });

  test("a failed read surfaces the error instead of an empty list", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [next] = update(
      model,
      inboxMessage(Inbox.FailedLoadInbox({ error: "sqlite is unhappy" })),
    );

    expect(next.inboxPage.threads._tag).toBe("Failure");
  });
});

describe("opening a thread", () => {
  test("clicking a row loads that thread and shows it", () => {
    Story.story(
      update,
      Story.with(loadedInbox()),
      Story.message(
        inboxMessage(Inbox.ClickedRow({ id: threadRow.id, index: 0 })),
      ),
      Story.model((next) => {
        expect(next.inboxPage.screen._tag).toBe("OpeningThread");
      }),
      Story.Command.resolve(
        Inbox.LoadThread,
        Inbox.SucceededLoadThread({ detail: threadDetail }),
      ),
      Story.model((next) => {
        expect(next.inboxPage.screen._tag).toBe("ShowingThread");
      }),
      Story.Command.resolveAll(),
    );
  });

  test("a thread that fails to load drops back to the list with the error", () => {
    Story.story(
      update,
      Story.with(loadedInbox()),
      Story.message(
        inboxMessage(Inbox.ClickedRow({ id: threadRow.id, index: 0 })),
      ),
      Story.Command.resolve(
        Inbox.LoadThread,
        Inbox.FailedLoadThread({ error: "thread is gone" }),
      ),
      Story.model((next) => {
        const { screen } = next.inboxPage;
        if (screen._tag !== "ShowingList") {
          throw new Error(`Expected ShowingList, got ${screen._tag}`);
        }
        expect(screen.maybeError).toEqual(Option.some("thread is gone"));
      }),
      Story.Command.resolveAll(),
    );
  });

  // The regression this guards: rows used to be opened by list position, so
  // a refresh landing between paint and click opened whatever had moved into
  // that slot. The click carries the id, so the row it names is the row that
  // opens no matter how the list shifted underneath it.
  test("a row click opens the thread it named even after the list shifts", () => {
    Story.story(
      update,
      Story.with(loadedInbox()),
      // New mail arrives and takes over index 0.
      Story.message(
        inboxMessage(Inbox.SucceededLoadInbox({ rows: [otherRow, threadRow] })),
      ),
      // The click the user began before that refresh landed.
      Story.message(
        inboxMessage(Inbox.ClickedRow({ id: threadRow.id, index: 0 })),
      ),
      Story.model((next) => {
        const { screen } = next.inboxPage;
        if (screen._tag !== "OpeningThread") {
          throw new Error(`Expected OpeningThread, got ${screen._tag}`);
        }
        expect(screen.id).toBe(threadRow.id);
      }),
      Story.Command.resolve(
        Inbox.LoadThread,
        Inbox.SucceededLoadThread({ detail: threadDetail }),
      ),
      Story.Command.resolveAll(),
    );
  });
});

describe("list keyboard navigation", () => {
  test("j selects the first row and scrolls it into view; Enter opens it", () => {
    Story.story(
      update,
      Story.with(loadedInbox()),
      Story.message(inboxMessage(Inbox.PressedListKey({ key: "j" }))),
      Story.model((next) => {
        expect(next.inboxPage.maybeSelected).toEqual(Option.some(0));
      }),
      Story.Command.resolve(
        Inbox.ScrollListToRow,
        Inbox.CompletedScrollListToRow(),
      ),
      Story.message(inboxMessage(Inbox.PressedListKey({ key: "Enter" }))),
      Story.Command.resolve(
        Inbox.LoadThread,
        Inbox.SucceededLoadThread({ detail: threadDetail }),
      ),
      Story.model((next) => {
        expect(next.inboxPage.screen._tag).toBe("ShowingThread");
      }),
    );
  });

  test("hovering a row moves the list cursor to it", () => {
    Story.story(
      update,
      Story.with(loadedInbox()),
      Story.message(inboxMessage(Inbox.HoveredRow({ index: 0 }))),
      Story.model((next) => {
        expect(next.inboxPage.maybeSelected).toEqual(Option.some(0));
      }),
      Story.Command.resolveAll(),
    );
  });

  // The view memoizes the virtual list on exactly these two references
  // (see lazyVirtualList), so a hover that touched either would silently
  // rebuild the whole list — window math, spacers, container, boundary —
  // once per row the pointer crosses. That is the cost that made panning
  // the list feel heavier than panning a menu, and nothing in the types
  // stops a future handler from reintroducing it.
  test("hovering leaves the list and its rows untouched, so the view can skip them", () => {
    const model = loadedInbox();
    const [next] = update(model, inboxMessage(Inbox.HoveredRow({ index: 0 })));

    expect(next.inboxPage.maybeSelected).toEqual(Option.some(0));
    expect(next.inboxPage.list).toBe(model.inboxPage.list);
    expect(next.inboxPage.threads).toBe(model.inboxPage.threads);
  });

  test("Escape closes an open thread back to the list", () => {
    Story.story(
      update,
      Story.with(loadedInbox()),
      Story.message(
        inboxMessage(Inbox.ClickedRow({ id: threadRow.id, index: 0 })),
      ),
      Story.Command.resolve(
        Inbox.LoadThread,
        Inbox.SucceededLoadThread({ detail: threadDetail }),
      ),
      Story.message(inboxMessage(Inbox.PressedListKey({ key: "Escape" }))),
      Story.model((next) => {
        expect(next.inboxPage.screen._tag).toBe("ShowingList");
      }),
      Story.Command.resolveAll(),
    );
  });
});

// Searching is driven by a keystroke in the palette input rather than by
// opening the dialog: a query produces exactly the re-measure and the search,
// where opening also fans out the dialog's show/animation commands that say
// nothing about search.
describe("palette search", () => {
  const typed = (query: string) =>
    inboxMessage(
      Inbox.GotPaletteMessage({ message: Ui.Palette.ChangedQuery({ query }) }),
    );

  const settleMeasure = Story.Command.resolve(
    Ui.Palette.MeasureItemRects,
    Ui.Palette.MeasuredItemRects({ rects: [] }),
  );

  test("a query runs a search and the results land in the model", () => {
    Story.story(
      update,
      Story.with(loadedInbox()),
      Story.message(typed("ada")),
      Story.model((next) => {
        // The seq the in-flight search will answer with.
        expect(next.inboxPage.searchSeq).toBe(1);
      }),
      settleMeasure,
      Story.Command.resolve(
        Inbox.RunSearch,
        Inbox.SucceededSearch({ seq: 1, rows: [threadRow] }),
      ),
      Story.model((next) => {
        expect(next.inboxPage.searchResults).toEqual([threadRow]);
        expect(next.inboxPage.maybeSearchError).toEqual(Option.none());
      }),
      Story.Command.resolveAll(),
    );
  });

  test("a failed search clears the results and shows the error", () => {
    Story.story(
      update,
      Story.with(loadedInbox()),
      Story.message(typed("ada")),
      settleMeasure,
      Story.Command.resolve(
        Inbox.RunSearch,
        Inbox.FailedSearch({ seq: 1, error: "index missing" }),
      ),
      Story.model((next) => {
        expect(next.inboxPage.searchResults).toEqual([]);
        expect(next.inboxPage.maybeSearchError).toEqual(
          Option.some("index missing"),
        );
      }),
      Story.Command.resolveAll(),
    );
  });

  // The seq guard: a reply to an earlier keystroke must not overwrite the
  // results the user is currently looking at.
  test("a search reply that lost the race to a later keystroke is dropped", () => {
    Story.story(
      update,
      Story.with(loadedInbox()),
      Story.message(typed("ada")),
      settleMeasure,
      Story.Command.resolve(
        Inbox.RunSearch,
        Inbox.SucceededSearch({ seq: 1, rows: [threadRow] }),
      ),
      // A stale reply carrying the seq of an earlier search.
      Story.message(
        inboxMessage(Inbox.SucceededSearch({ seq: 0, rows: [otherRow] })),
      ),
      Story.model((next) => {
        expect(next.inboxPage.searchResults).toEqual([threadRow]);
      }),
      Story.Command.resolveAll(),
    );
  });
});

// The newest threads land first — the backfill walks newest-first and a
// resumed walk re-lists from the top — but the list only repaints when the
// page says it is worth re-decoding the store. Under the priority window
// every page repaints, so a fresh mailbox fills visibly instead of sitting
// on the prime's handful of rows until the 200-stride is crossed.
describe("backfill list refresh", () => {
  const backfillingAt = (syncedCount: number) =>
    SyncMachine.Backfilling({
      historyId: HistoryId.make("1"),
      maybePageToken: Option.some(PageToken.make("page-2")),
      syncedCount,
      totalEstimate: 30000,
      attempt: 0,
    });

  const batchLanding = (syncedCount: number) =>
    inboxMessage(
      Inbox.GotSyncMessage({
        message: SyncMachine.CompletedSyncBatch({
          syncedCount,
          maybeNextPageToken: Option.some(PageToken.make("page-3")),
        }),
      }),
    );

  const refreshesAfter = (before: number, after: number): boolean => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const seeded: Model = {
      ...model,
      inboxPage: { ...model.inboxPage, sync: backfillingAt(before) },
    };
    const [, commands] = update(seeded, batchLanding(after));
    return commands.some((command) => command.name === "LoadInbox");
  };

  test("every page repaints while inside the priority window", () => {
    expect(refreshesAfter(15, 100)).toBe(true);
    expect(refreshesAfter(100, 200)).toBe(true);
    expect(refreshesAfter(400, 500)).toBe(true);
  });

  test("past the window it falls back to the stride", () => {
    // 600 → 700 crosses no 200-boundary, so it holds.
    expect(refreshesAfter(600, 700)).toBe(false);
    // 700 → 800 does.
    expect(refreshesAfter(700, 800)).toBe(true);
  });
});
