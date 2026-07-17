import { Effect, Match as M, Option, Schema as S, Stream } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { Command, Runtime, Subscription } from "foldkit";
import { html, type Document, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { UrlRequest, load, pushUrl, replaceUrl } from "foldkit/navigation";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";

import {
  AuthClient,
  CheckSession,
  ClearSession,
  CompletedSessionPersistence,
  CompletedSignOut,
  FailedCheckSession,
  GotSession,
  SaveSession,
  Session,
  SignOut,
  readStoredSession,
} from "./auth";
import { Inbox, Login } from "./page";
import {
  AppRoute,
  homeRouter,
  inboxRouter,
  loginRouter,
  urlToAppRoute,
} from "./route";
import { SyncEngine } from "./sync";

const APP_NAME = "parcel";

// MODEL

// Top-level union: the inbox route is gated on the session, everything
// else (the marketing landing, the sign-in page) is browsable logged out.
export const LoggedOut = ts("LoggedOut", {
  route: AppRoute,
  loginPage: Login.Model,
  inboxPage: Inbox.Model,
});
export type LoggedOut = typeof LoggedOut.Type;

export const LoggedIn = ts("LoggedIn", {
  route: AppRoute,
  session: Session,
  inboxPage: Inbox.Model,
});
export type LoggedIn = typeof LoggedIn.Type;

export const Model = S.Union([LoggedOut, LoggedIn]);
export type Model = typeof Model.Type;

// MESSAGE

export const CompletedNavigateInternal = m("CompletedNavigateInternal");
export const CompletedLoadExternal = m("CompletedLoadExternal");
export const ClickedLink = m("ClickedLink", {
  request: UrlRequest,
});
export const ChangedUrl = m("ChangedUrl", { url: Url });
export const GotLoginMessage = m("GotLoginMessage", {
  message: Login.Message,
});
export const GotInboxMessage = m("GotInboxMessage", {
  message: Inbox.Message,
});
export const ClickedSignOut = m("ClickedSignOut");

export const Message = S.Union([
  CompletedNavigateInternal,
  CompletedLoadExternal,
  ClickedLink,
  ChangedUrl,
  GotLoginMessage,
  GotInboxMessage,
  ClickedSignOut,
  GotSession,
  FailedCheckSession,
  CompletedSignOut,
  CompletedSessionPersistence,
]);
export type Message = typeof Message.Type;

// FLAGS

export const Flags = S.Struct({
  maybeSession: S.Option(Session),
});
export type Flags = typeof Flags.Type;

// The localStorage copy of the session gives an instant logged-in first
// paint; `CheckSession` then confirms against the cookie, which is the
// actual authority.
export const flags: Effect.Effect<Flags> = readStoredSession.pipe(
  Effect.map((maybeSession) => Flags.make({ maybeSession })),
);

// INIT

const initLoggedOut = (
  route: AppRoute,
  checkingSession: boolean,
  loginError: Option.Option<string> = Option.none(),
): LoggedOut =>
  LoggedOut({
    route,
    loginPage: Login.init(checkingSession, loginError),
    inboxPage: Inbox.init(),
  });

// A declined or failed Google round-trip lands back on /login?error=<code>
// (the errorCallbackURL in auth.ts); read it at boot so the page can say
// what happened instead of silently showing the button again.
const oauthErrorFromUrl = (url: Url): Option.Option<string> =>
  Option.map(
    Option.flatMap(url.search, (search) =>
      Option.fromNullishOr(new URLSearchParams(search).get("error")),
    ),
    (code) =>
      code === "access_denied"
        ? "Google sign-in was cancelled."
        : `Google sign-in failed (${code}).`,
  );

const initLoggedIn = (route: AppRoute, session: Session): LoggedIn =>
  LoggedIn({
    route,
    session,
    inboxPage: Inbox.init(),
  });

// Everything the app's commands can require; entry.ts provides the
// matching layers via `resources`.
export type AppResources =
  AuthClient | KeyValueStore.KeyValueStore | SyncEngine;

// The inbox page owns the LoadInbox command; wrapping its messages here
// keeps the parent/child message boundary intact.
const loadInboxCommands = (): ReadonlyArray<
  Command.Command<Message, never, AppResources>
> =>
  Command.mapMessages([Inbox.LoadInbox()], (message) =>
    GotInboxMessage({ message }),
  );

export const init: Runtime.RoutingApplicationInit<
  Model,
  Message,
  Flags,
  AppResources
> = (flags, url) => {
  const route = urlToAppRoute(url);

  // Pure: returns the starting model plus command *descriptions* — the
  // runtime executes them after boot. Every branch revalidates with
  // CheckSession because the cached session is only an optimistic first
  // paint; the cookie's verdict arrives later as GotSession.
  return Option.match(flags.maybeSession, {
    onNone: () =>
      route._tag === "Inbox"
        ? // No cached session but the URL asks for the gated inbox: start
          // on the login page instead (replaceUrl, so /inbox doesn't
          // pollute history) while the session check runs.
          ([
            initLoggedOut(LoginRouteValue, true),
            [RedirectToLogin(), CheckSession()],
          ] as const)
        : // No cached session on a public route: render it as requested.
          // This is also where a failed OAuth round-trip lands
          // (/login?error=...), so surface that error on the login page.
          ([
            initLoggedOut(route, true, oauthErrorFromUrl(url)),
            [CheckSession()],
          ] as const),
    onSome: (session) =>
      route._tag === "Login"
        ? // Cached session but the URL is /login: nothing to sign into —
          // bounce straight to the inbox.
          ([
            initLoggedIn(InboxRouteValue, session),
            [RedirectToInbox(), CheckSession(), ...loadInboxCommands()],
          ] as const)
        : // Cached session on any other route: paint logged-in
          // immediately; GotSession later confirms or evicts (the
          // "cached profile lied" transition in update). The inbox pull
          // starts on the optimistic session — a stale cookie surfaces as
          // the pull's own auth error, not a blank list.
          ([
            initLoggedIn(route, session),
            [CheckSession(), ...loadInboxCommands()],
          ] as const),
  });
};

const LoginRouteValue: AppRoute = { _tag: "Login" };
const InboxRouteValue: AppRoute = { _tag: "Inbox" };
const HomeRouteValue: AppRoute = { _tag: "Home" };

// COMMAND

const NavigateInternal = Command.define(
  "NavigateInternal",
  { url: S.String },
  CompletedNavigateInternal,
)(({ url }) => pushUrl(url).pipe(Effect.as(CompletedNavigateInternal())));

const LoadExternal = Command.define(
  "LoadExternal",
  { href: S.String },
  CompletedLoadExternal,
)(({ href }) => load(href).pipe(Effect.as(CompletedLoadExternal())));

const RedirectToLogin = Command.define(
  "RedirectToLogin",
  CompletedNavigateInternal,
)(replaceUrl(loginRouter()).pipe(Effect.as(CompletedNavigateInternal())));

const RedirectToInbox = Command.define(
  "RedirectToInbox",
  CompletedNavigateInternal,
)(replaceUrl(inboxRouter()).pipe(Effect.as(CompletedNavigateInternal())));

const RedirectToHome = Command.define(
  "RedirectToHome",
  CompletedNavigateInternal,
)(replaceUrl(homeRouter()).pipe(Effect.as(CompletedNavigateInternal())));

// UPDATE

type UpdateReturn = readonly [
  Model,
  ReadonlyArray<Command.Command<Message, never, AppResources>>,
];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

// Entering the logged-in world from anywhere: land in the inbox, persist
// the profile cache, and start the first real pull.
const enterLoggedIn = (session: Session): UpdateReturn => [
  initLoggedIn(InboxRouteValue, session),
  [SaveSession({ session }), RedirectToInbox(), ...loadInboxCommands()],
];

const leaveLoggedIn = (): UpdateReturn => [
  initLoggedOut(HomeRouteValue, false),
  [ClearSession(), RedirectToHome()],
];

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      CompletedNavigateInternal: () => [model, []],
      CompletedLoadExternal: () => [model, []],
      CompletedSessionPersistence: () => [model, []],

      ClickedLink: ({ request }) =>
        M.value(request).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            Internal: ({ url }) => [
              model,
              [NavigateInternal({ url: urlToString(url) })],
            ],
            External: ({ href }) => [model, [LoadExternal({ href })]],
          }),
        ),

      ChangedUrl: ({ url }) => {
        const route = urlToAppRoute(url);

        if (model._tag === "LoggedOut") {
          // The inbox is gated; everything else is browsable while logged
          // out.
          return route._tag === "Inbox"
            ? [model, [RedirectToLogin()]]
            : [evo(model, { route: () => route }), []];
        }

        if (route._tag === "Login") {
          return [model, [RedirectToInbox()]];
        }

        return [evo(model, { route: () => route }), []];
      },

      GotSession: ({ maybeSession }) =>
        M.value(model).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            LoggedOut: (loggedOut) =>
              Option.match(maybeSession, {
                onNone: (): UpdateReturn => [
                  evo(loggedOut, {
                    loginPage: (loginPage) =>
                      Login.setCheckingSession(loginPage, false),
                  }),
                  [],
                ],
                onSome: (session) => enterLoggedIn(session),
              }),
            LoggedIn: (loggedIn) =>
              Option.match(maybeSession, {
                // The cookie is gone or expired: the cached profile lied.
                onNone: () => leaveLoggedIn(),
                onSome: (session): UpdateReturn => [
                  evo(loggedIn, { session: () => session }),
                  [SaveSession({ session })],
                ],
              }),
          }),
        ),

      // A network failure isn't evidence the session is invalid, so stay
      // put; gated requests will surface real 401s on their own.
      FailedCheckSession: () =>
        model._tag === "LoggedOut"
          ? [
              evo(model, {
                loginPage: (loginPage) =>
                  Login.setCheckingSession(loginPage, false),
              }),
              [],
            ]
          : [model, []],

      GotLoginMessage: ({ message }) => {
        // Sign-in completes via a full-page OAuth redirect, not a submodel
        // message: the returning visit's boot-time CheckSession performs
        // the logged-in transition (GotSession above).
        if (model._tag !== "LoggedOut") return [model, []];
        const [loginPage, commands] = Login.update(model.loginPage, message);
        return [
          evo(model, { loginPage: () => loginPage }),
          Command.mapMessages(commands, (message) =>
            GotLoginMessage({ message }),
          ),
        ];
      },

      GotInboxMessage: ({ message }) => {
        const [inboxPage, commands] = Inbox.update(model.inboxPage, message);
        const mapped = [
          ...Command.mapMessages(commands, (message) =>
            GotInboxMessage({ message }),
          ),
          // The inbox's account popover offers sign-out, but the session is
          // this model's to end — the page only closes its popover.
          ...(message._tag === "InboxClickedSignOut" ? [SignOut()] : []),
        ];
        // The arms are intentionally identical: `evo` needs the union
        // narrowed to a concrete variant, and both variants carry inboxPage.
        return model._tag === "LoggedOut"
          ? [evo(model, { inboxPage: () => inboxPage }), mapped]
          : [evo(model, { inboxPage: () => inboxPage }), mapped];
      },

      ClickedSignOut: () => [model, [SignOut()]],
      CompletedSignOut: () => leaveLoggedIn(),
    }),
  );

// SUBSCRIPTIONS

// ⌘K / Ctrl+K opens the inbox's command palette. The listener only exists
// while the inbox route is active — the dependency flips the stream on and
// off as the route changes. `preventDefault` runs synchronously inside the
// mapper, before the browser's own search shortcut fires.
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  paletteShortcut: entry(
    { isInbox: S.Boolean },
    {
      modelToDependencies: (model) => ({
        isInbox: model.route._tag === "Inbox",
      }),
      dependenciesToStream: ({ isInbox }) =>
        Stream.when(
          Subscription.fromEventFilterMap<KeyboardEvent, Message>({
            target: window,
            type: "keydown",
            toMessage: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "k") {
                event.preventDefault();
                return Option.some(
                  GotInboxMessage({ message: Inbox.OpenedPalette() }),
                );
              }
              return Option.none();
            },
          }),
          Effect.sync(() => isInbox),
        ),
    },
  ),
}));
export const managedResources = undefined;

// VIEW

export const view = (model: Model): Document =>
  model._tag === "LoggedOut" ? loggedOutView(model) : loggedInView(model);

const inboxView = (inboxPage: Inbox.Model, session: Session): Html => {
  const h = html<Message>();

  return h.submodel({
    slotId: "inbox",
    model: inboxPage,
    view: Inbox.view,
    viewInputs: {
      profile: { name: session.name, email: session.email },
    },
    toParentMessage: (message) => GotInboxMessage({ message }),
  });
};

const loggedOutView = (model: LoggedOut): Document => {
  const h = html<Message>();

  return M.value(model.route).pipe(
    M.withReturnType<Document>(),
    M.tagsExhaustive({
      Home: () => ({ title: APP_NAME, body: landingView(false) }),
      // Redirect in flight; render the landing rather than a flash of the
      // gated inbox.
      Inbox: () => ({ title: APP_NAME, body: landingView(false) }),
      Login: () => ({
        title: `Sign in — ${APP_NAME}`,
        body: loginView(model),
      }),
      NotFound: ({ path }) => ({
        title: "Not Found",
        body: h.div(
          [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
          [notFoundView("Page not found", `No route for ${path}.`)],
        ),
      }),
    }),
  );
};

const loginView = (model: LoggedOut): Html => {
  const h = html<Message>();

  return h.submodel({
    slotId: "login",
    model: model.loginPage,
    view: Login.view,
    toParentMessage: (message) => GotLoginMessage({ message }),
  });
};

const loggedInView = (model: LoggedIn): Document => {
  const h = html<Message>();

  return M.value(model.route).pipe(
    M.withReturnType<Document>(),
    M.tagsExhaustive({
      Home: () => ({ title: APP_NAME, body: landingView(true) }),
      // Redirect to the inbox in flight.
      Login: () => ({ title: APP_NAME, body: landingView(true) }),
      // The inbox is a full-window design; no app chrome around it.
      Inbox: () => ({
        title: `Inbox — ${APP_NAME}`,
        body: inboxView(model.inboxPage, model.session),
      }),
      NotFound: ({ path }) => ({
        title: "Not Found",
        body: h.div(
          [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
          [notFoundView("Page not found", `No route for ${path}.`)],
        ),
      }),
    }),
  );
};

// The marketing landing: the only public page besides sign-in. Static
// content served from the SPA bundle.
const landingView = (isLoggedIn: boolean): Html => {
  const h = html<Message>();

  return h.main(
    [h.Class("min-h-screen bg-neutral-950 px-6 py-24 text-neutral-100")],
    [
      h.div(
        [h.Class("mx-auto max-w-xl")],
        [
          h.h1([h.Class("text-3xl font-bold")], [APP_NAME]),
          h.p(
            [h.Class("mt-3 text-neutral-400")],
            [
              "A fast, keyboard-first email client for your Gmail. Sign in with Google and your inbox is ready — nothing to configure.",
            ],
          ),
          h.a(
            [
              h.Href(isLoggedIn ? inboxRouter() : loginRouter()),
              h.Class("mt-8 inline-block underline underline-offset-4"),
            ],
            [isLoggedIn ? "Open your inbox →" : "Sign in with Google →"],
          ),
          isLoggedIn
            ? h.button(
                [
                  h.Type("button"),
                  h.OnClick(ClickedSignOut()),
                  h.Class(
                    "mt-6 block text-sm text-neutral-400 underline underline-offset-4 hover:text-neutral-200",
                  ),
                ],
                ["Sign out"],
              )
            : h.empty,
        ],
      ),
    ],
  );
};

const notFoundView = (heading: string, detail: string): Html => {
  const h = html<Message>();

  return h.section(
    [h.Class("mx-auto max-w-5xl px-4 py-10")],
    [
      h.div(
        [h.Class("border border-neutral-800 bg-neutral-900 p-4")],
        [
          h.h1([h.Class("text-2xl font-bold")], [heading]),
          h.p([h.Class("mt-2 text-neutral-400")], [detail]),
          h.a(
            [
              h.Href(homeRouter()),
              h.Class(
                "mt-4 inline-block border border-neutral-700 bg-neutral-800 px-4 py-2 font-medium text-neutral-100 hover:bg-neutral-700",
              ),
            ],
            ["Back home"],
          ),
        ],
      ),
    ],
  );
};
