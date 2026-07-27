import {
  Array as Arr,
  Effect,
  Match as M,
  Option,
  Schema as S,
  Stream,
  pipe,
} from "effect";
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
import { APP_NAME } from "./config";
import { Inbox, Login } from "./page";
import { landingView, notFoundView } from "./page/landing";
import {
  AppRoute,
  HomeRoute,
  InboxRoute,
  LoginRoute,
  homeRouter,
  inboxRouter,
  loginRouter,
  urlToAppRoute,
} from "./route";
import { Search } from "./search";
import { SyncEngine } from "./sync";
import * as Ui from "./ui";

// MODEL

// The inbox route is gated on the session; the landing and sign-in pages are
// browsable logged out.
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

// NOTE: The localStorage copy of the session only buys an instant logged-in
// first paint. `CheckSession` confirms against the cookie, which is the
// authority, and every init branch issues it.
export const flags: Effect.Effect<Flags> = readStoredSession.pipe(
  Effect.map((maybeSession) => Flags.make({ maybeSession })),
);

// INIT

// Everything the app's commands can require; entry.ts provides the matching
// layers via `resources`.
export type AppResources =
  | AuthClient
  | KeyValueStore.KeyValueStore
  | SyncEngine
  | Search;

type UpdateReturn = readonly [
  Model,
  ReadonlyArray<Command.Command<Message, never, AppResources>>,
];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

const initLoggedOut = (
  route: AppRoute,
  status: Login.Status,
  maybeLoginError: Option.Option<string> = Option.none(),
): LoggedOut =>
  LoggedOut({
    route,
    loginPage: Login.init(status, maybeLoginError),
    inboxPage: Inbox.init(),
  });

const initLoggedIn = (route: AppRoute, session: Session): LoggedIn =>
  LoggedIn({ route, session, inboxPage: Inbox.init() });

const ACCESS_DENIED = "access_denied";

const oauthErrorMessage = (code: string): string =>
  code === ACCESS_DENIED
    ? "Google sign-in was cancelled."
    : `Google sign-in failed (${code}).`;

// A declined or failed Google round-trip lands back on /login?error=<code>
// (the errorCallbackURL in auth.ts).
const oauthErrorFromUrl = (url: Url): Option.Option<string> =>
  pipe(
    url.search,
    Option.flatMap((search) =>
      Option.fromNullishOr(new URLSearchParams(search).get("error")),
    ),
    Option.map(oauthErrorMessage),
  );

// The inbox page owns its boot (the first local read plus the sync machine's
// checkpoint read); wrapping its messages here keeps the parent/child message
// boundary intact.
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

  return Option.match(flags.maybeSession, {
    onNone: () => {
      const browsable = (route: AppRoute): UpdateReturn => [
        initLoggedOut(route, Login.CheckingSession()),
        [CheckSession()],
      ];

      return M.value(route).pipe(
        withUpdateReturn,
        M.tagsExhaustive({
          // The gated inbox: start on the login page instead, replaced rather
          // than pushed so /inbox doesn't pollute history.
          Inbox: () => [
            initLoggedOut(LoginRoute(), Login.CheckingSession()),
            [RedirectToLogin(), CheckSession()],
          ],
          Login: (login) => [
            initLoggedOut(
              login,
              Login.CheckingSession(),
              oauthErrorFromUrl(url),
            ),
            [CheckSession()],
          ],
          Home: browsable,
          NotFound: browsable,
        }),
      );
    },
    // NOTE: The inbox pull starts on the cached session rather than waiting
    // for CheckSession, so a stale cookie surfaces as the pull's own auth
    // error instead of a blank list.
    onSome: (session) => {
      const optimistic = (route: AppRoute): UpdateReturn => [
        initLoggedIn(route, session),
        [CheckSession(), ...loadInboxCommands(session.email)],
      ];

      return M.value(route).pipe(
        withUpdateReturn,
        M.tagsExhaustive({
          Login: () => [
            initLoggedIn(InboxRoute(), session),
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

const enterLoggedIn = (session: Session): UpdateReturn => [
  initLoggedIn(InboxRoute(), session),
  [
    SaveSession({ session }),
    RedirectToInbox(),
    ...loadInboxCommands(session.email),
  ],
];

const leaveLoggedIn = (): UpdateReturn => [
  initLoggedOut(HomeRoute(), Login.Ready()),
  [ClearSession(), RedirectToHome()],
];

const settleLoginSessionCheck = (loggedOut: LoggedOut): UpdateReturn => [
  evo(loggedOut, { loginPage: Login.settledSessionCheck }),
  [],
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
                onNone: () => settleLoginSessionCheck(loggedOut),
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

      // NOTE: A network failure isn't evidence the session is invalid, so stay
      // put; gated requests surface real 401s on their own.
      FailedCheckSession: () =>
        M.value(model).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            LoggedOut: settleLoginSessionCheck,
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
            // NOTE: Sign-in completes via a full-page OAuth redirect, not a
            // submodel message. The returning visit's boot CheckSession
            // performs the logged-in transition.
            LoggedIn: (loggedIn) => [loggedIn, []],
          }),
        ),

      GotInboxMessage: ({ message }) => {
        const [inboxPage, commands] = Inbox.update(model.inboxPage, message);
        // The inbox's account popover offers sign-out, but the session is this
        // model's to end; the page only closes its popover.
        const maybeSignOut = Option.liftPredicate(
          SignOut(),
          () => message._tag === "ClickedAccountSignOut",
        );
        const mapped = [
          ...Command.mapMessages(commands, (message) =>
            GotInboxMessage({ message }),
          ),
          ...Arr.fromOption(maybeSignOut),
        ];

        // NOTE: The arms are identical because `evo` needs the union narrowed
        // to a concrete variant, and both variants carry inboxPage.
        return M.value(model).pipe(
          withUpdateReturn,
          M.tagsExhaustive({
            LoggedOut: (state) => [
              evo(state, { inboxPage: () => inboxPage }),
              mapped,
            ],
            LoggedIn: (state) => [
              evo(state, { inboxPage: () => inboxPage }),
              mapped,
            ],
          }),
        );
      },

      ClickedSignOut: () => [model, [SignOut()]],
      CompletedSignOut: () => leaveLoggedIn(),
    }),
  );

// SUBSCRIPTIONS

const decodeListKey = S.decodeUnknownOption(Inbox.ListKey);

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable);

// NOTE: preventDefault runs synchronously inside the mapper, before the
// browser's own find shortcut fires.
const toPaletteShortcutMessage = (
  event: KeyboardEvent,
): Option.Option<Message> => {
  if (!(event.metaKey || event.ctrlKey) || event.key !== "k") {
    return Option.none();
  }
  event.preventDefault();
  return Option.some(GotInboxMessage({ message: Inbox.ToggledPalette() }));
};

// j/k/Enter/Escape drive the inbox list. Bare keys only, and never while
// typing: the palette's input (or any editable target) keeps its keystrokes.
const toListKeyMessage = (event: KeyboardEvent): Option.Option<Message> => {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    isTypingTarget(event.target)
  ) {
    return Option.none();
  }
  return Option.map(decodeListKey(event.key), (key) =>
    GotInboxMessage({ message: Inbox.PressedListKey({ key }) }),
  );
};

// The listeners only exist while the inbox route is active; the dependency
// flips each stream on and off as the route changes.
const keyboardSubscriptions = Subscription.make<Model, Message>()((entry) => {
  const whileInbox = (
    toMessage: (event: KeyboardEvent) => Option.Option<Message>,
  ) =>
    entry(
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
              toMessage,
            }),
            Effect.sync(() => isInbox),
          ),
      },
    );

  return {
    paletteShortcut: whileInbox(toPaletteShortcutMessage),
    listKeys: whileInbox(toListKeyMessage),
  };
});

// The inbox list's scroll/resize tracking. The base VirtualList owns the
// subscription (a MutationObserver reattaches it as the container mounts and
// unmounts); we only lift it into this model/message context.
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

const landingDocument = (isLoggedIn: boolean): Document => ({
  title: APP_NAME,
  body: landingView(isLoggedIn, ClickedSignOut()),
});

const notFoundDocument = (path: string): Document => ({
  title: "Not Found",
  body: notFoundView<Message>(path),
});

const loginView = (model: LoggedOut): Html => {
  const h = html<Message>();

  return h.submodel({
    slotId: "login",
    model: model.loginPage,
    view: Login.view,
    toParentMessage: (message) => GotLoginMessage({ message }),
  });
};

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

const loggedOutView = (model: LoggedOut): Document =>
  M.value(model.route).pipe(
    M.withReturnType<Document>(),
    M.tagsExhaustive({
      Home: () => landingDocument(false),
      // Redirect in flight; render the landing rather than a flash of the
      // gated inbox.
      Inbox: () => landingDocument(false),
      Login: () => ({
        title: `Sign in — ${APP_NAME}`,
        body: loginView(model),
      }),
      NotFound: ({ path }) => notFoundDocument(path),
    }),
  );

const loggedInView = (model: LoggedIn): Document =>
  M.value(model.route).pipe(
    M.withReturnType<Document>(),
    M.tagsExhaustive({
      Home: () => landingDocument(true),
      // Redirect to the inbox in flight.
      Login: () => landingDocument(true),
      // The inbox is a full-window design; no app chrome around it.
      Inbox: () => ({
        title: `Inbox — ${APP_NAME}`,
        body: inboxView(model.inboxPage, model.session),
      }),
      NotFound: ({ path }) => notFoundDocument(path),
    }),
  );
