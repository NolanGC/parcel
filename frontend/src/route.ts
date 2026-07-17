import { Schema as S, pipe } from "effect";
import { Route } from "foldkit";
import { literal, r } from "foldkit/route";

export const HomeRoute = r("Home");
export const LoginRoute = r("Login");
export const InboxRoute = r("Inbox");
export const NotFoundRoute = r("NotFound", { path: S.String });

export const AppRoute = S.Union([
  HomeRoute,
  LoginRoute,
  InboxRoute,
  NotFoundRoute,
]);

export type HomeRoute = typeof HomeRoute.Type;
export type LoginRoute = typeof LoginRoute.Type;
export type InboxRoute = typeof InboxRoute.Type;
export type NotFoundRoute = typeof NotFoundRoute.Type;
export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(HomeRoute));
export const loginRouter = pipe(literal("login"), Route.mapTo(LoginRoute));
export const inboxRouter = pipe(literal("inbox"), Route.mapTo(InboxRoute));

const routeParser = Route.oneOf(inboxRouter, loginRouter, homeRouter);

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  NotFoundRoute,
);
