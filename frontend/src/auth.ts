import { UserId } from "@foldkit/backend";
import { createAuthClient } from "better-auth/client";
import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { Command } from "foldkit";
import { m } from "foldkit/message";
import { load } from "foldkit/navigation";

import { API_URL } from "./config";

// The client-side session is a cached copy of the user profile; the actual
// authority is the http-only cookie BetterAuth set, which the server
// validates on every gated request.
export const Session = S.Struct({
  userId: UserId,
  email: S.String,
  name: S.String,
});
export type Session = typeof Session.Type;

const SESSION_STORAGE_KEY = "parcel-foldkit-session";

// MESSAGE

export const GotSession = m("GotSession", {
  maybeSession: S.Option(Session),
});
export const FailedCheckSession = m("FailedCheckSession", { error: S.String });
export const StartedGoogleRedirect = m("StartedGoogleRedirect");
export const FailedAuth = m("FailedAuth", { error: S.String });
export const CompletedSignOut = m("CompletedSignOut");
export const CompletedSessionPersistence = m("CompletedSessionPersistence");

// SERVICE

// The BetterAuth client wraps its REST endpoints (paths, redirect handling,
// error shapes) so upgrades don't silently change the wire contract under
// hand-rolled fetches. `credentials: "include"` makes the browser
// attach/store the session cookie across the frontend/chat-service origin
// split. As a service, commands stay pure descriptions and tests can
// provide a stub instead of a network.
const makeAuthClient = () =>
  createAuthClient({
    baseURL: API_URL,
    fetchOptions: { credentials: "include" },
  });

export class AuthClient extends Context.Service<
  AuthClient,
  ReturnType<typeof makeAuthClient>
>()("parcel/AuthClient", {
  make: Effect.sync(() => makeAuthClient()),
}) {
  static readonly layer: Layer.Layer<AuthClient> = Layer.effect(
    this,
    this.make,
  );
}

// API

const UserPayload = S.Struct({
  user: S.Struct({ id: UserId, email: S.String, name: S.String }),
});
const decodeUserPayload = S.decodeUnknownOption(UserPayload);

const toSession = (payload: typeof UserPayload.Type): Session => ({
  userId: payload.user.id,
  email: payload.user.email,
  name: payload.user.name,
});

const errorMessage = (
  error: { message?: string | undefined; statusText: string } | null,
  fallback: string,
): string => error?.message ?? error?.statusText ?? fallback;

// COMMAND

// Asks the server who the cookie belongs to. This is the boot-time
// authority; the localStorage copy only provides instant first paint.
export const CheckSession = Command.define(
  "CheckSession",
  GotSession,
  FailedCheckSession,
)(
  Effect.gen(function* () {
    const client = yield* AuthClient;
    const { data, error } = yield* Effect.tryPromise(() => client.getSession());
    if (error !== null) {
      return FailedCheckSession({
        error: errorMessage(error, "Could not check the session."),
      });
    }
    return GotSession({
      maybeSession: Option.map(decodeUserPayload(data), toSession),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(FailedCheckSession({ error: String(error) })),
    ),
  ),
);

// Sign-in is a full-page OAuth round-trip: BetterAuth answers this POST
// with Google's authorization URL, and `load` hands the tab over to it.
// Google sends the user back through the API worker's
// /api/auth/callback/google, which sets the session cookie and redirects to
// callbackURL — so success never produces a message here (the page has
// unloaded); the boot-time CheckSession on the return visit picks the
// session up. Only failures to *start* the flow report back, and a declined
// consent screen comes back as ?error= on errorCallbackURL (read in init).
// `disableRedirect` keeps the client's default auto-redirect plugin out of
// the way so foldkit's `load` owns the navigation.
export const SignInWithGoogle = Command.define(
  "SignInWithGoogle",
  StartedGoogleRedirect,
  FailedAuth,
)(
  Effect.gen(function* () {
    const client = yield* AuthClient;
    const { data, error } = yield* Effect.tryPromise(() =>
      client.signIn.social({
        provider: "google",
        callbackURL: `${window.location.origin}/inbox`,
        errorCallbackURL: `${window.location.origin}/login`,
        disableRedirect: true,
      }),
    );
    return yield* Option.match(
      Option.fromNullishOr(error === null ? data?.url : null),
      {
        onNone: () =>
          Effect.succeed(
            FailedAuth({
              error: errorMessage(error, "Could not start Google sign-in."),
            }),
          ),
        onSome: (url) => load(url).pipe(Effect.as(StartedGoogleRedirect())),
      },
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(FailedAuth({ error: String(error) })),
    ),
  ),
);

// Sign-out is best-effort: the client drops its state either way, and the
// server-side session expires on its own if the request never lands.
export const SignOut = Command.define(
  "SignOut",
  CompletedSignOut,
)(
  AuthClient.pipe(
    Effect.flatMap((client) => Effect.tryPromise(() => client.signOut())),
    // Ignored, not handled: the model transitions to logged-out on
    // CompletedSignOut regardless, so there is no branch to feed an error
    // into — but log it, or a dead endpoint would be invisible.
    Effect.tapError((error) =>
      Effect.logWarning("sign-out request failed", error),
    ),
    Effect.ignore,
    Effect.as(CompletedSignOut()),
  ),
);

// SESSION CACHE

// KeyValueStore abstracts the storage engine: the app provides the
// localStorage-backed layer below, tests can provide `layerMemory`. The
// schema store handles the JSON round-trip through `Session`.
export const sessionStorageLayer: Layer.Layer<KeyValueStore.KeyValueStore> =
  KeyValueStore.layerStorage(() => localStorage);

const sessionStore = Effect.map(KeyValueStore.KeyValueStore, (store) =>
  KeyValueStore.toSchemaStore(store, Session),
);

// Runs pre-boot as part of `flags`, before the runtime's `resources`
// exist — so it provides its own layer instead of using the R channel.
// A corrupt or unreadable cache is the same as no cache.
export const readStoredSession: Effect.Effect<Option.Option<Session>> =
  sessionStore.pipe(
    Effect.flatMap((store) => store.get(SESSION_STORAGE_KEY)),
    Effect.catch(() => Effect.succeedNone),
    Effect.provide(sessionStorageLayer),
  );

export const SaveSession = Command.define(
  "SaveSession",
  { session: Session },
  CompletedSessionPersistence,
)(({ session }) =>
  sessionStore.pipe(
    Effect.flatMap((store) => store.set(SESSION_STORAGE_KEY, session)),
    // Best-effort by design: a failed write (quota, blocked storage) only
    // costs the next visit its instant first paint — CheckSession remains
    // the authority. Log it so chronically broken storage is diagnosable.
    Effect.tapError((error) =>
      Effect.logWarning("session cache write failed", error),
    ),
    Effect.ignore,
    Effect.as(CompletedSessionPersistence()),
  ),
);

// Otel, better observability into cache evictions etc
export const ClearSession = Command.define(
  "ClearSession",
  CompletedSessionPersistence,
)(
  Effect.flatMap(KeyValueStore.KeyValueStore, (store) =>
    store.remove(SESSION_STORAGE_KEY),
  ).pipe(
    // Best-effort: if the eviction fails, the next boot paints logged-in
    // from the stale cache until GotSession(none) corrects it.
    Effect.tapError((error) =>
      Effect.logWarning("session cache eviction failed", error),
    ),
    Effect.ignore,
    Effect.as(CompletedSessionPersistence()),
  ),
);
