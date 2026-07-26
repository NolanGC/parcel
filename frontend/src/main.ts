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
  SucceededCheckSession,
  SaveSession,
  Session,
  SignOut,
  readStoredSession,
} from "./auth";
import { Inbox, Login } from "./page";
import { landingView, notFoundView } from "./page/landing";
import {
  AppRoute,
  homeRouter,
  inboxRouter,
  loginRouter,
  urlToAppRoute,
} from "./route";
import { Search } from "./search";
import { SyncEngine } from "./sync";
import * as Ui from "./ui";

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
  SucceededCheckSession,
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

// Both `init` and `update` return the same pair: the next model plus
// command descriptions for the runtime to execute.
type UpdateReturn = readonly [
  Model,
  ReadonlyArray<Command.Command<Message, never, AppResources>>,
];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

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
  | AuthClient
  | KeyValueStore.KeyValueStore
  | SyncEngine
  | Search;

// The inbox page owns its boot (the first local read plus the sync
// machine's checkpoint read); wrapping its messages here keeps the
// parent/child message boundary intact.
const loadInboxCommands = (
  accountEmail: string,
): ReadonlyArray<Command.Command<Message, never, AppResources>> =>
  Command.mapMessages(Inbox.bootCommands(accountEmail), (message) =>
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
  // paint; the cookie's verdict arrives later as SucceededCheckSession.
  return Option.match(flags.maybeSession, {
    onNone: () => {
      // No cached session: render the route logged out, with the session
      // check still in flight so the login page can show a spinner.
      const browsable = (route: AppRoute): UpdateReturn => [
        initLoggedOut(route, true),
        [CheckSession()],
      ];

      return M.value(route).pipe(
        withUpdateReturn,
        M.tagsExhaustive({
          // The URL asks for the gated inbox: start on the login page
          // instead (replaceUrl, so /inbox doesn't pollute history) while
          // the session check runs.
          Inbox: () => [
            initLoggedOut(LoginRouteValue, true),
            [RedirectToLogin(), CheckSession()],
          ],
          // A failed OAuth round-trip lands here (/login?error=...), so
          // surface that error on the login page.
          Login: (login) => [
            initLoggedOut(login, true, oauthErrorFromUrl(url)),
            [CheckSession()],
          ],
          Home: browsable,
          NotFound: browsable,
        }),
      );
    },
    onSome: (session) => {
      // Cached session: paint logged-in immediately; SucceededCheckSession later
      // confirms or evicts (the "cached profile lied" transition in
      // update). The inbox pull starts on the optimistic session — a stale
      // cookie surfaces as the pull's own auth error, not a blank list.
      const optimistic = (route: AppRoute): UpdateReturn => [
        initLoggedIn(route, session),
        [CheckSession(), ...loadInboxCommands(session.email)],
      ];

      return M.value(route).pipe(
        withUpdateReturn,
        M.tagsExhaustive({
          // Nothing to sign into — bounce straight to the inbox.
          Login: () => [
            initLoggedIn(InboxRouteValue, session),
            [
              RedirectToInbox(),
              CheckSession(),
              ...loadInboxCommands(session.email),
            ],
          ],
          Inbox: optimistic,
          Home: optimistic,
          NotFound: optimistic,
        }),
      );
    },
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

// Entering the logged-in world from anywhere: land in the inbox, persist
// the profile cache, and start the first real pull.
const enterLoggedIn = (session: Session): UpdateReturn => [
  initLoggedIn(InboxRouteValue, session),
  [
    SaveSession({ session }),
    RedirectToInbox(),
    ...loadInboxCommands(session.email),
  ],
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

        return M.value(model).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            LoggedOut: (loggedOut) => {
              const stay = (route: AppRoute): UpdateReturn => [
                evo(loggedOut, { route: () => route }),
                [],
              ];

              return M.value(route).pipe(
                withUpdateReturn,
                M.tagsExhaustive({
                  // The inbox is gated; every other route is browsable
                  // while logged out.
                  Inbox: () => [loggedOut, [RedirectToLogin()]],
                  Home: stay,
                  Login: stay,
                  NotFound: stay,
                }),
              );
            },
            LoggedIn: (loggedIn) => {
              const stay = (route: AppRoute): UpdateReturn => [
                evo(loggedIn, { route: () => route }),
                [],
              ];

              return M.value(route).pipe(
                withUpdateReturn,
                M.tagsExhaustive({
                  // Nothing to sign into with a session in hand.
                  Login: () => [loggedIn, [RedirectToInbox()]],
                  Home: stay,
                  Inbox: stay,
                  NotFound: stay,
                }),
              );
            },
          }),
        );
      },

      SucceededCheckSession: ({ maybeSession }) =>
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
        M.value(model).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            LoggedOut: (loggedOut) => [
              evo(loggedOut, {
                loginPage: (loginPage) =>
                  Login.setCheckingSession(loginPage, false),
              }),
              [],
            ],
            LoggedIn: (loggedIn) => [loggedIn, []],
          }),
        ),

      GotLoginMessage: ({ message }) =>
        M.value(model).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            LoggedOut: (loggedOut) => {
              const [loginPage, commands] = Login.update(
                loggedOut.loginPage,
                message,
              );
              return [
                evo(loggedOut, { loginPage: () => loginPage }),
                Command.mapMessages(commands, (message) =>
                  GotLoginMessage({ message }),
                ),
              ];
            },
            // Sign-in completes via a full-page OAuth redirect, not a
            // submodel message: the returning visit's boot-time
            // CheckSession performs the logged-in transition (SucceededCheckSession
            // above).
            LoggedIn: (loggedIn) => [loggedIn, []],
          }),
        ),

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
        return M.value(model).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            LoggedOut: (m) => [evo(m, { inboxPage: () => inboxPage }), mapped],
            LoggedIn: (m) => [evo(m, { inboxPage: () => inboxPage }), mapped],
          }),
        );
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
const keyboardSubscriptions = Subscription.make<Model, Message>()((entry) => ({
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
                  GotInboxMessage({ message: Inbox.ToggledPalette() }),
                );
              }
              return Option.none();
            },
          }),
          Effect.sync(() => isInbox),
        ),
    },
  ),
  // j/k/Enter/Escape drive the inbox list (selection, open, close). Bare
  // keys only, and never while typing — the palette's input (or any
  // editable target) keeps its keystrokes.
  listKeys: entry(
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
              if (event.metaKey || event.ctrlKey || event.altKey) {
                return Option.none();
              }
              const target = event.target;
              if (
                target instanceof HTMLElement &&
                (target.tagName === "INPUT" ||
                  target.tagName === "TEXTAREA" ||
                  target.isContentEditable)
              ) {
                return Option.none();
              }
              const key = event.key;
              return key === "j" ||
                key === "k" ||
                key === "Enter" ||
                key === "Escape"
                ? Option.some(
                    GotInboxMessage({
                      message: Inbox.PressedListKey({ key }),
                    }),
                  )
                : Option.none();
            },
          }),
          Effect.sync(() => isInbox),
        ),
    },
  ),
}));

// The inbox list's scroll/resize tracking. The base VirtualList owns the
// subscription (a MutationObserver reattaches it as the container mounts and
// unmounts); we only lift it into this model/message context. Its scrollTop
// drives the visible window and the traveling hover overlay.
const listScrollSubscriptions = Subscription.lift(Ui.VirtualList.subscriptions)<
  Model,
  Message
>({
  toChildModel: (model) => model.inboxPage.list,
  toParentMessage: (message) =>
    GotInboxMessage({ message: Inbox.GotListMessage({ message }) }),
});

export const subscriptions = Subscription.aggregate<Model, Message>()(
  keyboardSubscriptions,
  listScrollSubscriptions,
);

export const managedResources = undefined;

// VIEW

export const view = (model: Model): Document =>
  M.value(model).pipe(
    M.withReturnType<Document>(),
    M.tagsExhaustive({
      LoggedOut: loggedOutView,
      LoggedIn: loggedInView,
    }),
  );

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

// The 404 renders identically whether or not there's a session, so both
// route matchers land here rather than each carrying a copy.
const notFoundDocument = (path: string): Document => {
  const h = html<Message>();

  return {
    title: "Not Found",
    body: h.div(
      [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
      [notFoundView("Page not found", `No route for ${path}.`)],
    ),
  };
};

const loggedOutView = (model: LoggedOut): Document =>
  M.value(model.route).pipe(
    M.withReturnType<Document>(),
    M.tagsExhaustive({
      Home: () => ({
        title: APP_NAME,
        body: landingView(false, ClickedSignOut()),
      }),
      // Redirect in flight; render the landing rather than a flash of the
      // gated inbox.
      Inbox: () => ({
        title: APP_NAME,
        body: landingView(false, ClickedSignOut()),
      }),
      Login: () => ({
        title: `Sign in — ${APP_NAME}`,
        body: loginView(model),
      }),
      NotFound: ({ path }) => notFoundDocument(path),
    }),
  );

const loginView = (model: LoggedOut): Html => {
  const h = html<Message>();

  return h.submodel({
    slotId: "login",
    model: model.loginPage,
    view: Login.view,
    toParentMessage: (message) => GotLoginMessage({ message }),
  });
};

const loggedInView = (model: LoggedIn): Document =>
  M.value(model.route).pipe(
    M.withReturnType<Document>(),
    M.tagsExhaustive({
      Home: () => ({
        title: APP_NAME,
        body: landingView(true, ClickedSignOut()),
      }),
      // Redirect to the inbox in flight.
      Login: () => ({
        title: APP_NAME,
        body: landingView(true, ClickedSignOut()),
      }),
      // The inbox is a full-window design; no app chrome around it.
      Inbox: () => ({
        title: `Inbox — ${APP_NAME}`,
        body: inboxView(model.inboxPage, model.session),
      }),
      NotFound: ({ path }) => notFoundDocument(path),
    }),
  );
