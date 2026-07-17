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
import { GotInboxMessage, init, update, type Model } from "./main";
import { Inbox } from "./page";

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

  test("the inbox popover's sign-out runs the SignOut command", () => {
    const [model] = init(loggedInFlags, url("/inbox"));
    const [, commands] = update(
      model,
      GotInboxMessage({ message: Inbox.ClickedSignOut() }),
    );

    expect(commands.map((command) => command.name)).toContain("SignOut");
  });
});
