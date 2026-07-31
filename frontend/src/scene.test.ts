// View tests (Foldkit Scene): a model in, semantic queries (roles, labels,
// text) against the rendered view out. No real browser.
//
// Covers:
// - Logged out: the login route renders the Google sign-in button; the
//   landing page links to sign-in.
// - Logged in: the landing page links to the inbox and offers sign-out.
// - The inbox across every state its Model can be in: loading, failed,
//   populated, empty, an open thread, the palette open, and the sync pill.
// - Interactions, driven by clicking rather than by handing `update` a
//   Message: the sign-in button through both of its outcomes, and closing an
//   open thread.
//
// Does NOT cover:
// - Anything visual: layout, styling, focus management.
// - Opening a thread, or any row interaction. Rows live in the VirtualList,
//   whose container is Unmeasured without a ResizeObserver, so the virtual
//   window renders none of them. story.test.ts drives those.
// - Interactions whose Commands fan out into @foldkit/ui internals (opening
//   the palette, the account popover). Resolving another package's Commands
//   would couple these tests to its internals without saying anything about
//   this app; the Model-constructed states below cover the rendering.
import { UserId } from "@foldkit/backend";
import { Option } from "effect";
import { AsyncData, Scene } from "foldkit";
import { describe, expect, test } from "vitest";

import { FailedAuth, SignInWithGoogle, StartedGoogleRedirect } from "./auth";
import { HistoryId, MessageId, ThreadId } from "./Gmail";
import { update, view, type Model } from "./main";
import { Inbox, Login } from "./page";
import { HomeRoute, InboxRoute, LoginRoute } from "./route";
import * as SyncMachine from "./syncMachine";
import * as Ui from "./ui";

const loggedInModel: Model = {
  _tag: "LoggedIn",
  route: HomeRoute(),
  session: {
    userId: UserId.make("user-ada"),
    email: "ada@example.com",
    name: "Ada",
  },
  inboxPage: Inbox.init(),
};

const loggedOutModel: Model = {
  _tag: "LoggedOut",
  route: LoginRoute(),
  loginPage: Login.init(Login.Ready()),
  inboxPage: Inbox.init(),
};

// The Scene locators find nodes by their accessible surface, which is exactly
// what a decorative overlay does not have. This walks the rendered tree
// instead, structurally typed so it needs nothing from foldkit's internals.
type RenderedNode = Readonly<{
  data?: Readonly<{
    props?: Readonly<Record<string, unknown>>;
    class?: Readonly<Record<string, boolean>>;
  }>;
  children?: ReadonlyArray<RenderedNode | string | undefined>;
}>;

const findRendered = (
  node: RenderedNode,
  isMatch: (candidate: RenderedNode) => boolean,
): RenderedNode | undefined => {
  if (isMatch(node)) {
    return node;
  }
  for (const child of node.children ?? []) {
    if (child === undefined || typeof child === "string") {
      continue;
    }
    const found = findRendered(child, isMatch);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

describe("view", () => {
  test("logged out, the login route renders the Google sign-in", () => {
    Scene.scene(
      { update, view },
      Scene.with(loggedOutModel),
      Scene.expect(Scene.role("heading", { name: "Sign in" })).toExist(),
      Scene.expect(
        Scene.role("button", { name: "Continue with Google" }),
      ).toBeEnabled(),
    );
  });

  test("a sign-in error renders as an alert", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...loggedOutModel,
        loginPage: Login.init(
          Login.Ready(),
          Option.some("Google sign-in failed."),
        ),
      }),
      Scene.expect(Scene.role("alert")).toExist(),
      Scene.expect(Scene.text("Google sign-in failed.")).toExist(),
    );
  });

  test("logged out, the landing page links to sign in", () => {
    Scene.scene(
      { update, view },
      Scene.with({ ...loggedOutModel, route: HomeRoute() }),
      Scene.expect(
        Scene.role("link", { name: "Sign in with Google →" }),
      ).toExist(),
    );
  });

  test("logged in, the landing page opens the inbox and offers sign out", () => {
    Scene.scene(
      { update, view },
      Scene.with(loggedInModel),
      Scene.expect(Scene.role("link", { name: "Open your inbox →" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Sign out" })).toExist(),
    );
  });
});

// Interaction tests: the same views driven by clicks rather than by handing
// `update` a Message. What these add over the Story tests is the wiring in
// between, so a button that stops dispatching (or an attribute that stops
// reflecting the Model) fails here.
describe("signing in", () => {
  test("clicking Continue with Google starts the redirect and disables the button", () => {
    Scene.scene(
      { update, view },
      Scene.with(loggedOutModel),
      Scene.click(Scene.role("button", { name: "Continue with Google" })),
      Scene.expect(
        Scene.role("button", { name: "Redirecting to Google…" }),
      ).toBeDisabled(),
      Scene.Command.resolve(SignInWithGoogle, StartedGoogleRedirect()),
    );
  });

  // The button is the only way into the OAuth flow, so a failure to even
  // start it has to come back to the page rather than leaving a dead button
  // spinning.
  test("a failure to start the flow re-enables the button and reports why", () => {
    Scene.scene(
      { update, view },
      Scene.with(loggedOutModel),
      Scene.click(Scene.role("button", { name: "Continue with Google" })),
      Scene.Command.resolve(
        SignInWithGoogle,
        FailedAuth({ error: "popup blocked" }),
      ),
      Scene.expect(
        Scene.role("button", { name: "Continue with Google" }),
      ).toBeEnabled(),
      Scene.expect(Scene.role("alert")).toHaveText("popup blocked"),
    );
  });

  // While the boot session check is still in flight the button must not be
  // clickable: a valid cookie would otherwise send the user to Google to
  // re-authorize a session they already have.
  test("the button waits while the boot session check is still in flight", () => {
    Scene.scene(
      { update, view },
      Scene.with({
        ...loggedOutModel,
        loginPage: Login.init(Login.CheckingSession()),
      }),
      Scene.expect(
        Scene.role("button", { name: "Checking session…" }),
      ).toBeDisabled(),
    );
  });
});

// The inbox across the states its Model can express. Every one of these
// renders through the real view, so a branch that throws or loses its
// landmarks fails here rather than in a browser.
describe("the inbox", () => {
  const threadRow = {
    id: ThreadId.make("thread-1"),
    subject: "Hi",
    sender: "Ada",
    snippet: "hello",
    date: 1,
    isUnread: false,
    isStarred: false,
    category: "none" as const,
  };

  const openThreadDetail = {
    id: ThreadId.make("thread-1"),
    subject: "Hi",
    messages: [
      {
        id: MessageId.make("m1"),
        fromName: "Ada",
        fromEmail: "ada@example.com",
        date: 1,
        bodyKind: "plain" as const,
        body: "hello there",
        rfc822MessageId: "",
        references: "",
      },
    ],
  };

  const inboxWith = (page: Partial<Inbox.Model>): Model => ({
    _tag: "LoggedIn",
    route: InboxRoute(),
    session: {
      userId: UserId.make("user-ada"),
      email: "ada@example.com",
      name: "Ada",
    },
    inboxPage: { ...Inbox.init(), ...page },
  });

  // The list container starts Unmeasured — no ResizeObserver fires in a
  // Scene — so the virtual window is empty; the assertion is that the list
  // container is present and the submodel's viewInputs pass foldkit's walker.
  test("with rows, it renders the list section", () => {
    Scene.scene(
      { update, view },
      Scene.with(inboxWith({ threads: AsyncData.succeed([threadRow]) })),
      Scene.expect(Scene.role("list")).toExist(),
    );
  });

  // Where the overlay sits is the whole reason it tracks scrolling. Inside
  // the scroll container the browser moves it with the rows; rendered beside
  // the container it has to chase scrollTop through a scroll Message, which
  // native scrolling never waits for, so the highlight trails the row it is
  // highlighting. That is structure, not styling, so assert the tree rather
  // than trusting the viewInputs wiring.
  test("the hover overlay renders inside the list's scroll container", () => {
    Scene.scene(
      { update, view },
      Scene.with(
        inboxWith({
          threads: AsyncData.succeed([threadRow]),
          maybeSelected: Option.some(0),
          isPointerInside: true,
        }),
      ),
      Scene.tap(({ html }) => {
        const container = findRendered(
          html,
          (node) => node.data?.props?.["id"] === Inbox.LIST_ID,
        );

        expect(container).toBeDefined();
        expect(
          container === undefined
            ? undefined
            : findRendered(
                container,
                (node) => node.data?.class?.["fk-hover-overlay"] === true,
              ),
        ).toBeDefined();
      }),
    );
  });

  test("while loading, it says so instead of rendering an empty inbox", () => {
    Scene.scene(
      { update, view },
      Scene.with(inboxWith({ threads: AsyncData.Loading() })),
      Scene.expect(Scene.text("Loading your inbox…")).toExist(),
    );
  });

  test("a failed load surfaces the error", () => {
    Scene.scene(
      { update, view },
      Scene.with(inboxWith({ threads: AsyncData.fail("sqlite is unhappy") })),
      Scene.expect(Scene.text("sqlite is unhappy")).toExist(),
    );
  });

  // A cold store while the sync machine is still filling it is early, not
  // empty — the two say different things and the view has to tell them apart.
  test("an empty store reads as empty only once syncing has settled", () => {
    Scene.scene(
      { update, view },
      Scene.with(
        inboxWith({
          threads: AsyncData.succeed([]),
          sync: SyncMachine.Settled({
            historyId: HistoryId.make("1"),
            lastSyncedAt: 0,
          }),
        }),
      ),
      Scene.expect(Scene.text("Nothing here.")).toExist(),
    );
  });

  // The pop-in regression: the machine boots Cold, and Cold used to render
  // nothing, so the pill appeared a beat after first paint and shoved the
  // toolbar sideways. Every state has to put a status on screen.
  test("the sync pill is on screen from the very first paint, in Cold", () => {
    Scene.scene(
      { update, view },
      Scene.with(
        inboxWith({
          threads: AsyncData.succeed([threadRow]),
          sync: SyncMachine.Cold({ attempt: 0 }),
        }),
      ),
      Scene.expect(Scene.role("status")).toExist(),
      Scene.expect(Scene.text("Starting…")).toExist(),
    );
  });

  test("an open thread renders its messages", () => {
    Scene.scene(
      { update, view },
      Scene.with(
        inboxWith({
          threads: AsyncData.succeed([threadRow]),
          screen: Inbox.ShowingThread({ detail: openThreadDetail }),
        }),
      ),
      Scene.expect(Scene.text("hello there")).toExist(),
    );
  });

  // The close-lag regression: the open thread used to REPLACE the list, so
  // every close rebuilt the VirtualList from nothing — cheap at the top of
  // the mailbox, brutal once scrolled deep, because the fresh container comes
  // back at scrollTop 0 behind a spacer as tall as everything above it. The
  // thread now paints over a list that stays mounted, which is what makes
  // closing free.
  test("the list stays mounted underneath an open thread", () => {
    Scene.scene(
      { update, view },
      Scene.with(
        inboxWith({
          threads: AsyncData.succeed([threadRow]),
          screen: Inbox.ShowingThread({ detail: openThreadDetail }),
        }),
      ),
      Scene.expect(Scene.text("hello there")).toExist(),
      Scene.expect(Scene.role("list")).toExist(),
    );
  });

  // Closing is the one thread-detail interaction that is entirely ours: it
  // issues no Commands, so what it proves is the back button's wiring and
  // that the list underneath survived the round trip.
  // NOTE: Opening a thread is driven from the Story tests instead. Rows live
  // in the VirtualList, whose container is Unmeasured in a Scene, so the
  // virtual window renders no rows to click.
  test("the back button closes an open thread and returns to the list", () => {
    Scene.scene(
      { update, view },
      Scene.with(
        inboxWith({
          threads: AsyncData.succeed([threadRow]),
          screen: Inbox.ShowingThread({ detail: openThreadDetail }),
        }),
      ),
      Scene.expect(Scene.text("hello there")).toExist(),
      Scene.click(Scene.role("button", { name: "Back to inbox" })),
      Scene.expect(Scene.text("hello there")).not.toExist(),
      Scene.expect(Scene.role("list")).toExist(),
    );
  });

  // The palette is a combobox over a listbox: the input has to be reachable
  // by role, which is exactly what a hand-rolled version would have lost.
  test("the open palette exposes a combobox and its results as options", () => {
    const opened = Ui.Palette.init({ id: "inbox-palette" });

    Scene.scene(
      { update, view },
      Scene.with(
        inboxWith({
          threads: AsyncData.succeed([threadRow]),
          searchResults: [threadRow],
          palette: {
            ...opened,
            dialog: {
              ...opened.dialog,
              isOpen: true,
              animation: { ...opened.dialog.animation, isShowing: true },
            },
          },
        }),
      ),
      Scene.expect(Scene.role("combobox")).toExist(),
      Scene.expect(Scene.role("listbox")).toExist(),
      Scene.expect(Scene.role("option", { name: /Hi/ })).toExist(),
    );
  });
});
