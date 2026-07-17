// View-rendering tests (Foldkit Scene): a model in, semantic queries
// (roles/labels/text) against the rendered view out. No real browser and no
// command execution.
//
// Covers:
// - Logged out: the login route renders the Google sign-in button; the
//   landing page links to sign-in.
// - Logged in: the landing page links to the inbox and offers sign-out.
//
// Does NOT cover:
// - The inbox sketch itself (static mock; heavy to snapshot semantically).
// - Click flows or anything visual: layout, styling, focus management.
import { UserId } from "@foldkit/backend";
import { Option } from "effect";
import { Scene } from "foldkit";
import { describe, test } from "vitest";

import { update, view, type Model } from "./main";
import { Inbox, Login } from "./page";
import { HomeRoute, LoginRoute } from "./route";

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
  loginPage: Login.init(false),
  inboxPage: Inbox.init(),
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
        loginPage: Login.init(false, Option.some("Google sign-in failed.")),
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
