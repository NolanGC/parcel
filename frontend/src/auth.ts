import { UserId } from "@foldkit/backend";
import { createAuthClient } from "better-auth/client";
import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { Command } from "foldkit";
import { m } from "foldkit/message";
import { load } from "foldkit/navigation";

import { ApiUrl } from "./config";

// The client-side session is a cached copy of the user profile. The authority
// is the http-only cookie BetterAuth set, which the server validates on every
// gated request.
export const Session = S.Struct({
  userId: UserId,
  email: S.String,
  name: S.String,
});
export type Session = typeof Session.Type;

const SESSION_STORAGE_KEY = "parcel-foldkit-session";

// MESSAGE

export const SucceededCheckSession = m("SucceededCheckSession", {
  maybeSession: S.Option(Session),
});
export const FailedCheckSession = m("FailedCheckSession", { error: S.String });
export const StartedGoogleRedirect = m("StartedGoogleRedirect");
export const FailedAuth = m("FailedAuth", { error: S.String });
export const CompletedSignOut = m("CompletedSignOut");
export const CompletedSessionPersistence = m("CompletedSessionPersistence");

// SERVICE

// NOTE: `credentials: "include"` is what carries the session cookie across the
// frontend/API origin split.
export class AuthClient extends Context.Service<
  AuthClient,
  ReturnType<typeof createAuthClient>
>()("parcel/AuthClient", {
  make: Effect.gen(function* () {
    const apiUrl = yield* ApiUrl;
    return createAuthClient({
      baseURL: apiUrl,
      fetchOptions: { credentials: "include" },
    });
  }),
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

/** Asks the server who the cookie belongs to: the boot-time authority. */
export const CheckSession = Command.define(
  "CheckSession",
  SucceededCheckSession,
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
    return SucceededCheckSession({
      maybeSession: Option.map(decodeUserPayload(data), toSession),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(FailedCheckSession({ error: String(error) })),
    ),
  ),
);

/**
 * Starts the full-page OAuth round-trip. Success never produces a message
 * here: `load` unloads the page, and the return visit's boot-time
 * `CheckSession` picks the session up. Only failures to *start* the flow
 * report back.
 */
// NOTE: `disableRedirect` keeps the client's auto-redirect plugin out of the
// way so foldkit's `load` owns the navigation.
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

/** Best-effort: the client drops its state either way, and the server-side
 *  session expires on its own if the request never lands. */
export const SignOut = Command.define(
  "SignOut",
  CompletedSignOut,
)(
  AuthClient.pipe(
    Effect.flatMap((client) => Effect.tryPromise(() => client.signOut())),
    Effect.tapError((error) =>
      Effect.logWarning("sign-out request failed", error),
    ),
    Effect.ignore,
    Effect.as(CompletedSignOut()),
  ),
);

// SESSION CACHE

export const sessionStorageLayer: Layer.Layer<KeyValueStore.KeyValueStore> =
  KeyValueStore.layerStorage(() => localStorage);

const sessionStore = Effect.map(KeyValueStore.KeyValueStore, (store) =>
  KeyValueStore.toSchemaStore(store, Session),
);

// NOTE: Runs pre-boot as part of `flags`, before the runtime's `resources`
// exist, so it provides its own layer instead of using the R channel. A
// corrupt or unreadable cache is the same as no cache.
export const readStoredSession: Effect.Effect<Option.Option<Session>> =
  sessionStore.pipe(
    Effect.flatMap((store) => store.get(SESSION_STORAGE_KEY)),
    Effect.catch(() => Effect.succeedNone),
    Effect.provide(sessionStorageLayer),
  );

/** Best-effort: a failed write only costs the next visit its instant first
 *  paint, and `CheckSession` remains the authority. */
export const SaveSession = Command.define(
  "SaveSession",
  { session: Session },
  CompletedSessionPersistence,
)(({ session }) =>
  sessionStore.pipe(
    Effect.flatMap((store) => store.set(SESSION_STORAGE_KEY, session)),
    Effect.tapError((error) =>
      Effect.logWarning("session cache write failed", error),
    ),
    Effect.ignore,
    Effect.as(CompletedSessionPersistence()),
  ),
);

/** Best-effort: if the eviction fails, the next boot paints logged-in from the
 *  stale cache until `SucceededCheckSession(none)` corrects it. */
export const ClearSession = Command.define(
  "ClearSession",
  CompletedSessionPersistence,
)(
  Effect.flatMap(KeyValueStore.KeyValueStore, (store) =>
    store.remove(SESSION_STORAGE_KEY),
  ).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("session cache eviction failed", error),
    ),
    Effect.ignore,
    Effect.as(CompletedSessionPersistence()),
  ),
);
