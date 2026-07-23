// Integration test against REAL infrastructure: deploys the full stack
// (Postgres branch + Drizzle migrations, Hyperdrive, BetterAuth secret,
// both Cloudflare workers) before the tests and destroys it after.
//
// Covers:
// - Deploy and teardown of the whole stack, including adoption of resources
//   stranded by earlier failed runs (`adopt: true`).
// - Stack outputs exist (website/api URLs, database branch id, Hyperdrive id).
// - Auth wiring: anonymous get-session answers null.
// - Real BetterAuth sessions: users and sessions are minted directly in
//   the stage's database by a test-only BetterAuth instance (the test-utils
//   plugin, per the Better Auth testing docs) and the resulting cookie is
//   accepted by the deployed worker. The app itself is Google-only — no
//   password endpoints exist on any stage, and OAuth consent can't run
//   headlessly, so this is the supported way to authenticate tests.
//
// Does NOT cover:
// - Google OAuth sign-in (the only real sign-in method; needs a browser).
// - Sign-out and session expiry.
// - The Website worker beyond deploying it, and none of the frontend.
// - Local dev mode (`alchemy dev`); the test always deploys to the cloud.
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Test from "alchemy/Test/Bun";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { testUtils } from "better-auth/plugins";
import { expect } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import pg from "pg";
import {
  Account,
  Session,
  User,
  Verification,
} from "../backend/src/auth-schema.ts";
import Stack from "../alchemy.run.ts";

// Opt-in guard: a bare `bun test` must never deploy real infrastructure.
// `bun run test:integ` sets INTEG=1.
if (process.env.INTEG !== "1") {
  console.log(
    "Skipping integration tests — run `bun run test:integ` (deploys real infrastructure).",
  );
  process.exit(0);
}

// Fresh auth secret per run, handed to the deploy below through the
// process env: alchemy.run.ts binds it to the test-stage worker as
// TEST_AUTH_SECRET, and the test-only BetterAuth instance in
// mintSessionCookie signs cookies with it — same secret + same database is
// what makes the deployed worker accept them.
const INTEG_AUTH_SECRET = crypto.randomUUID();
process.env.INTEG_AUTH_SECRET = INTEG_AUTH_SECRET;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Drizzle.providers(),
    Planetscale.providers(),
  ),
  // Always the shared remote state store (same as the main stack), local and
  // CI alike. This is what lets the "test" stage `.ref` the staging database
  // (see Db.ts) from any machine — local disk state wouldn't know staging
  // exists. All runs share the "test" stage; CI serializes them via the
  // workflow's concurrency group, and `adopt` (below) recovers a run stranded
  // mid-deploy. Don't run local integ while CI's integ job is mid-run — they
  // race on the same "test" stage.
  state: Cloudflare.state(),
  // Resource names are deterministic per stage, so anything a past run
  // stranded (failed teardown, lost local state) collides with the next
  // create. Adopt instead of failing: the run takes ownership and the
  // teardown finally deletes it.
  adopt: true,
});

// The `test` stage branches off the staging database (see Db.ts), so the
// deploy is mostly workers + Hyperdrive; the 5 min budget is headroom over
// the default 120s hook timeout for slow Cloudflare/PlanetScale API days,
// matching the test bodies below.
const stack = beforeAll(deploy(Stack), { timeout: 300_000 });

// Teardown must not leave paid resources behind, so ride out transient API
// failures. Destroy plans from state, so a retry only deletes whatever is
// still standing.
afterAll(
  destroy(Stack).pipe(
    Effect.retry({ times: 3, schedule: Schedule.spaced("10 seconds") }),
  ),
  { timeout: 300_000 },
);

const { getWhenReady } = Test;

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly setCookie: ReadonlyArray<string>;
}

// A freshly created Hyperdrive config takes a while to propagate to the
// edge; until then every DB-backed route 500s even though the worker itself
// answers (getWhenReady passes). `api` below throws on any 5xx, and only
// those failures are retried; 4xx and assertion failures are real bugs and
// surface immediately.
const isWarmupFailure = (error: unknown): boolean =>
  /failed \(5\d\d\)/.test(
    String(
      (error as { cause?: unknown }).cause ?? (error as { message?: unknown }),
    ),
  );

const retryWhileWarmingUp = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.retry({
      while: isWarmupFailure,
      times: 24,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

// Error bodies are plain text ("Todo not found"), success bodies JSON.
const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const api = (
  apiUrl: string,
  path: string,
  options: {
    readonly method?: string;
    readonly cookie?: string;
    readonly body?: unknown;
  } = {},
) =>
  retryWhileWarmingUp(
    Effect.tryPromise(async (): Promise<ApiResponse> => {
      const method = options.method ?? "GET";
      const response = await fetch(new URL(path, apiUrl), {
        method,
        headers: {
          ...(options.body !== undefined && {
            "content-type": "application/json",
          }),
          ...(options.cookie !== undefined && { cookie: options.cookie }),
        },
        ...(options.body !== undefined && {
          body: JSON.stringify(options.body),
        }),
      });
      const text = await response.text();
      if (response.status >= 500) {
        throw new Error(
          `${method} ${path} failed (${response.status}): ${text}`,
        );
      }
      return {
        status: response.status,
        body: text === "" ? undefined : parseBody(text),
        setCookie: response.headers.getSetCookie(),
      };
    }),
  );

// The database origin the stack exposes on the test stage (undefined on
// every other stage — see alchemy.run.ts).
type DbOrigin = Cloudflare.Hyperdrive.Origin;

// Creates a real user + session directly in the stage's database through a
// test-only BetterAuth instance (test-utils plugin) and returns the session
// cookie, so requests below authenticate exactly like a browser that
// completed the Google flow — same user row, session row, and signed
// cookie; no auth HTTP endpoints involved (none that mint sessions are
// deployed). Retried because a freshly provisioned branch can refuse the
// first direct connections.
const mintSessionCookie = (apiUrl: string, dbOrigin: DbOrigin) =>
  Effect.tryPromise(async () => {
    const pool = new pg.Pool({
      host: dbOrigin.host,
      port: "port" in dbOrigin ? dbOrigin.port : undefined,
      database: dbOrigin.database,
      user: dbOrigin.user,
      password: Redacted.value(dbOrigin.password),
      ssl: true,
      max: 1,
    });
    try {
      const auth = betterAuth({
        database: drizzleAdapter(drizzle({ client: pool }), {
          provider: "pg",
          schema: {
            user: User,
            session: Session,
            account: Account,
            verification: Verification,
          },
        }),
        secret: INTEG_AUTH_SECRET,
        baseURL: apiUrl,
        basePath: "/api/auth",
        // Must mirror the worker's cloud cookie attributes (Auth.ts): the
        // secure flag is what puts the __Secure- prefix on the cookie name
        // the worker looks up.
        advanced: {
          defaultCookieAttributes: { sameSite: "none", secure: true },
        },
        plugins: [testUtils()],
      });
      const ctx = await auth.$context;
      const user = ctx.test.createUser({
        email: `integ-${crypto.randomUUID()}@example.com`,
        name: "Integ Tester",
      });
      await ctx.test.saveUser(user);
      const { headers } = await ctx.test.login({ userId: user.id });
      const cookie = headers.get("cookie");
      if (cookie === null || cookie === "") {
        throw new Error("test-utils login returned no session cookie");
      }
      return cookie;
    } finally {
      await pool.end();
    }
  }).pipe(Effect.retry({ times: 4, schedule: Schedule.spaced("5 seconds") }));

test(
  "stack exposes frontend, api, hyperdrive, and database branch ids",
  Effect.gen(function* () {
    const { websiteUrl, apiUrl, branchId, hyperdriveId } = yield* stack;

    expect(websiteUrl).toBeString();
    expect(apiUrl).toBeString();
    expect(branchId).toBeString();
    expect(hyperdriveId).toBeString();
  }),
);

test(
  "the deployed worker resolves sessions minted by the test-utils instance",
  Effect.gen(function* () {
    const { apiUrl, dbOrigin } = yield* stack;
    yield* getWhenReady(apiUrl);

    // Anonymous get-session answers null: the worker is up, auth-wired,
    // and not leaking a session to strangers.
    const anonymous = yield* api(apiUrl, "/api/auth/get-session");
    expect(anonymous.status).toBe(200);
    expect(anonymous.body ?? null).toBeNull();

    expect(dbOrigin).toBeDefined();
    const cookie = yield* mintSessionCookie(apiUrl, dbOrigin!);
    const session = yield* api(apiUrl, "/api/auth/get-session", { cookie });
    expect(session.status).toBe(200);
    const body = session.body as {
      readonly user?: { readonly email?: string; readonly name?: string };
    };
    expect(body.user?.name).toBe("Integ Tester");
    expect(body.user?.email).toContain("@example.com");
  }),
  { timeout: 300_000 },
);
