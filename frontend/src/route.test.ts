// Tests for the route module: route constructors and parser.
import { Option } from "effect";
import { describe, expect, test } from "vitest";
import { type Url } from "foldkit/url";

import {
  AppRoute,
  HomeRoute,
  InboxRoute,
  LoginRoute,
  NotFoundRoute,
  homeRouter,
  inboxRouter,
  loginRouter,
  urlToAppRoute,
} from "./route";

const url = (pathname: string, search?: string): Url => ({
  protocol: "http:",
  host: "localhost",
  port: Option.none(),
  pathname,
  search: Option.fromNullishOr(search),
  hash: Option.none(),
});

describe("Route constructors", () => {
  test("HomeRoute creates a Home route", () => {
    expect(HomeRoute()).toEqual({ _tag: "Home" });
  });

  test("LoginRoute creates a Login route", () => {
    expect(LoginRoute()).toEqual({ _tag: "Login" });
  });

  test("InboxRoute creates an Inbox route", () => {
    expect(InboxRoute()).toEqual({ _tag: "Inbox" });
  });

  test("NotFoundRoute carries the path", () => {
    expect(NotFoundRoute({ path: "/unknown" })).toEqual({
      _tag: "NotFound",
      path: "/unknown",
    });
  });
});

describe("AppRoute constructors produce tagged values", () => {
  test("HomeRoute produces _tag: Home", () => {
    expect(HomeRoute()._tag).toBe("Home");
  });
  test("LoginRoute produces _tag: Login", () => {
    expect(LoginRoute()._tag).toBe("Login");
  });
  test("InboxRoute produces _tag: Inbox", () => {
    expect(InboxRoute()._tag).toBe("Inbox");
  });
  test("NotFoundRoute produces _tag: NotFound with path", () => {
    const route = NotFoundRoute({ path: "/x" });
    expect(route._tag).toBe("NotFound");
    expect(route.path).toBe("/x");
  });
});

describe("URL routing", () => {
  test("home route matches /", () => {
    const route = urlToAppRoute(url("/"));
    expect(route._tag).toBe("Home");
  });

  test("login route matches /login", () => {
    const route = urlToAppRoute(url("/login"));
    expect(route._tag).toBe("Login");
  });

  test("inbox route matches /inbox", () => {
    const route = urlToAppRoute(url("/inbox"));
    expect(route._tag).toBe("Inbox");
  });

  test("unknown path falls back to NotFound", () => {
    const route = urlToAppRoute(url("/unknown/path"));
    expect(route._tag).toBe("NotFound");
    if (route._tag === "NotFound") {
      expect(route.path).toBe("/unknown/path");
    }
  });

  test("search params do not affect routing", () => {
    const route = urlToAppRoute(url("/inbox", "?foo=bar"));
    expect(route._tag).toBe("Inbox");
  });
});
