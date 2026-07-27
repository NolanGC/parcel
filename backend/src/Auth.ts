import type { RuntimeContext } from "alchemy";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import pg from "pg";

import { Account, Session, User, Verification } from "./auth-schema.ts";
import { UserId } from "./Protocol.ts";
import { Hyperdrive } from "./Db.ts";

export class AuthError extends Data.TaggedError("AuthError")<{
  cause: unknown;
}> {}

export type AuthUser = {
  readonly id: UserId;
  readonly name: string;
  readonly email: string;
};

type MakeAuthOptions = {
  secret: string;
  baseOrigin: string;
  maybeFrontendOrigin: Option.Option<string>;
  isLocal: boolean;
  maybeGoogle: Option.Option<{ clientId: string; clientSecret: string }>;
};

// NOTE: Exactly one origin may make credentialed requests, the frontend bound
// as FRONTEND_ORIGIN. A wildcard would let any site ride the SameSite=None
// session cookie, and even a dev-localhost entry would let a local process hit
// production with it. Option.none means the binding is missing: deny all.
//
// The packaged desktop app is the one exception, since Tauri serves the same
// bundle from a fixed local origin. Allowing it does not reopen the wildcard
// hole: browsers can't fake these origins, and each Tauri app has its own
// webview cookie jar. Under `alchemy dev` the shell loads localhost:1337
// directly and never reaches this branch.
const DESKTOP_ORIGINS: ReadonlySet<string> = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
]);

const makeIsAllowedOrigin =
  (maybeFrontendOrigin: Option.Option<string>) =>
  (origin: string): boolean =>
    DESKTOP_ORIGINS.has(origin) ||
    Option.exists(maybeFrontendOrigin, (allowed) => allowed === origin);

// Worker env values are untyped, and a binding that is missing reads as either
// undefined or "". Both mean "not configured".
const envText = (value: unknown): Option.Option<string> =>
  Option.filter(
    Option.fromNullishOr(value as string | undefined),
    (text) => text !== "",
  );

const makeAuth = (pool: pg.Pool, options: MakeAuthOptions) => {
  const isAllowedOrigin = makeIsAllowedOrigin(options.maybeFrontendOrigin);
  return betterAuth({
    database: drizzleAdapter(drizzle({ client: pool }), {
      provider: "pg",
      schema: {
        user: User,
        session: Session,
        account: Account,
        verification: Verification,
      },
    }),
    secret: options.secret,
    baseURL: options.baseOrigin,
    basePath: "/api/auth",
    // Google is the only sign-in method; email+password stays at its
    // disabled default everywhere. The integ tests never need it: they mint
    // sessions with a test-only BetterAuth instance (test-utils plugin)
    // over this same database and secret — see test/integ.test.ts.
    socialProviders: Option.match(options.maybeGoogle, {
      onNone: () => ({}),
      onSome: ({ clientId, clientSecret }) => ({
        google: {
          clientId,
          clientSecret,
          // NOTE: Gmail access outlives the sign-in hour, so the app needs a
          // refresh token, and Google only issues one when access is
          // "offline" AND a consent screen was shown. `select_account` keeps
          // the chooser on shared machines. Tokens land on the `account` row.
          accessType: "offline" as const,
          prompt: "select_account consent" as const,
          // Sign-in doubles as the Gmail grant. Read-only for now; wider
          // scopes (send, modify) can be requested later per user via
          // `linkSocial({ provider: "google", scopes: [...] })` without
          // re-onboarding everyone.
          scope: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      }),
    }),
    session: {
      // Short-lived signed cookie holding the session payload, so gated
      // requests validate without a database round-trip until it expires.
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    // BetterAuth checks the Origin header of state-changing requests
    // against this list; echoing the (validated) request origin keeps it in
    // lockstep with the CORS policy in ChatService.
    trustedOrigins: (request) =>
      Arr.fromOption(
        Option.filter(
          Option.fromNullishOr(request?.headers.get("origin")),
          isAllowedOrigin,
        ),
      ),
    // Prod: the frontend and this worker are different workers.dev sites,
    // so the session cookie must be `SameSite=None; Secure` to cross sites.
    // Dev: both origins are localhost (same-site), and Safari refuses
    // `Secure` cookies over plain http, so keep the defaults there.
    advanced: options.isLocal
      ? {}
      : {
          defaultCookieAttributes: {
            sameSite: "none",
            secure: true,
          },
        },
  });
};

type AuthInstance = ReturnType<typeof makeAuth>;

export type BetterAuthApi = {
  /**
   * Whether `origin` may make credentialed requests against this worker.
   * Reads the worker environment when called, so only invoke it inside a
   * request handler (where the runtime env exists).
   */
  isAllowedOrigin: (origin: string) => boolean;
  withAuth: <A>(
    requestUrl: string,
    use: (auth: AuthInstance) => Promise<A>,
  ) => Effect.Effect<A, AuthError, RuntimeContext>;
  /** Resolve the session cookie on `request` to its user, if any. */
  sessionUser: (
    request: Request,
  ) => Effect.Effect<Option.Option<AuthUser>, AuthError, RuntimeContext>;
};

/**
 * Effect-native BetterAuth for workers. `withAuth` builds a per-invocation
 * BetterAuth instance over the shared Hyperdrive connection: pg sockets
 * cannot be reused across Worker invocations, so a fresh single-connection
 * pool is opened per request (cheap — Hyperdrive does the real pooling
 * server-side) and closed when the effect settles.
 */
export class BetterAuth extends Context.Service<BetterAuth, BetterAuthApi>()(
  "BetterAuth",
) {}

/**
 * Request-level helpers shared by every worker that gates routes on the
 * BetterAuth session. Build once per worker from the yielded `BetterAuth`
 * service.
 */
export const makeAuthGate = (auth: BetterAuthApi) => {
  // Resolve the caller's session from the request cookie. Runs on every
  // gated route; BetterAuth's cookie cache answers most lookups without
  // touching the database.
  const sessionUser: Effect.Effect<
    Option.Option<AuthUser>,
    AuthError,
    RuntimeContext | HttpServerRequest.HttpServerRequest
  > = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* auth.sessionUser(request.source as Request);
  });

  const unauthorized = HttpServerResponse.text("Unauthorized", {
    status: 401,
  });

  // The auth backend failing is a server-side outage, not a client
  // problem: log it and degrade to a 503 instead of crashing the handler.
  const authUnavailable = (error: AuthError) =>
    Effect.logError("Auth backend unavailable", error.cause).pipe(
      Effect.as(
        HttpServerResponse.text("Service unavailable", { status: 503 }),
      ),
    );

  // Credentialed CORS: the session cookie only flows cross-origin when the
  // specific origin is echoed back (a wildcard is invalid with
  // credentials); the allowlist is the deployed frontend.
  const cors = HttpMiddleware.cors({
    allowedOrigins: auth.isAllowedOrigin,
    credentials: true,
  });

  // BetterAuth owns everything under /api/auth/* (sign-up, sign-in,
  // sign-out, get-session, and OAuth callbacks later); mount this on that
  // route.
  const handleAuthApi = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const source = request.source as Request;
    const response = yield* auth.withAuth(source.url, (instance) =>
      instance.handler(source),
    );
    return HttpServerResponse.fromWeb(response);
  }).pipe(Effect.catchTag("AuthError", authUnavailable));

  return { sessionUser, unauthorized, authUnavailable, cors, handleAuthApi };
};

export const BetterAuthPg = Layer.effect(
  BetterAuth,
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const env = yield* Cloudflare.Workers.WorkerEnvironment;
    const secretResource = yield* Alchemy.Random("BetterAuthSecret");
    // Registers a `secret_text` binding at deploy time and reads it back
    // from the worker environment at runtime.
    const secret = yield* Output.named(
      Output.asOutput(secretResource.text),
      "BETTER_AUTH_SECRET",
    );

    // NOTE: Read lazily. These bindings only exist at runtime and this layer
    // also builds at plan time. Absent means the first deploy of a fresh stage
    // ran before the Website URL existed.
    const maybeFrontendOrigin = (): Option.Option<string> =>
      Option.map(envText(env.FRONTEND_ORIGIN), (raw) => new URL(raw).origin);

    // Google OAuth credentials, bound from the deploy machine's env. None
    // means the stage deployed without them (only the integ-test stage
    // legitimately does), and the provider is simply not offered.
    const maybeGoogle = (): Option.Option<{
      clientId: string;
      clientSecret: string;
    }> =>
      Option.all({
        clientId: envText(env.GOOGLE_CLIENT_ID),
        clientSecret: envText(env.GOOGLE_CLIENT_SECRET),
      });

    const withAuth = <A>(
      requestUrl: string,
      use: (auth: AuthInstance) => Promise<A>,
    ) =>
      Effect.gen(function* () {
        // NOTE: The bound public origin, not the request URL. Under `alchemy
        // dev` the request URL inside workerd carries the proxy's random
        // internal port, and Google rejects OAuth callbacks built from
        // anything but the exact registered origin. The request URL is only a
        // fallback for a missing binding.
        const baseOrigin = new URL(
          Option.getOrElse(envText(env.API_ORIGIN), () => requestUrl),
        ).origin;
        const connectionString = Redacted.value(yield* conn.connectionString);
        // The integ-test stage overrides the per-stage Random secret with
        // one the test run generated (TEST_AUTH_SECRET, bound in
        // alchemy.run.ts only for that stage), so the tests' test-utils
        // BetterAuth instance can sign session cookies this worker accepts.
        const secretValue =
          Option.getOrUndefined(envText(env.TEST_AUTH_SECRET)) ??
          Redacted.value(yield* secret);
        const maybeFrontend = maybeFrontendOrigin();
        const pool = new pg.Pool({ connectionString, max: 1 });
        return yield* Effect.tryPromise({
          try: () =>
            use(
              makeAuth(pool, {
                secret: secretValue,
                baseOrigin,
                maybeFrontendOrigin: maybeFrontend,
                isLocal: /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(
                  baseOrigin,
                ),
                maybeGoogle: maybeGoogle(),
              }),
            ),
          catch: (cause) => new AuthError({ cause }),
        }).pipe(
          Effect.ensuring(Effect.promise(() => pool.end()).pipe(Effect.ignore)),
        );
      });

    return {
      isAllowedOrigin: (origin: string) =>
        makeIsAllowedOrigin(maybeFrontendOrigin())(origin),
      withAuth,
      sessionUser: (request: Request) =>
        withAuth(request.url, (auth) =>
          auth.api.getSession({ headers: request.headers }),
        ).pipe(
          Effect.map((result) =>
            Option.map(
              Option.fromNullishOr(result),
              // BetterAuth just verified the session cookie, so this is the
              // authoritative place to mint the branded id.
              ({ user }): AuthUser => ({
                id: UserId.make(user.id),
                name: user.name,
                email: user.email,
              }),
            ),
          ),
        ),
    };
  }),
);
