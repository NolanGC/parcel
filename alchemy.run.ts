import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import { adopt } from "alchemy/AdoptPolicy";

import { Hyperdrive, Postgres, PostgresLive } from "./backend/src/Db.ts";
import ApiServiceLive, { ApiService } from "./backend/src/ApiService.ts";

export default Alchemy.Stack(
  "Parcel",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { branchId, origin } = yield* Postgres;
    const hd = yield* Hyperdrive;
    const path = yield* Path;
    const stage = yield* Alchemy.Stage;
    const { dev } = yield* Alchemy.AlchemyContext;

    // dev serves both workers locally; production serves on the custom
    // domain; every other cloud stage (deploy:branch, PR previews) is a
    // preview served on the workers.dev subdomain. Deriving the mode once
    // keeps the URL and zone/subdomain rules from each re-deciding it.
    const mode: "dev" | "production" | "preview" = dev
      ? "dev"
      : stage === "production"
        ? "production"
        : "preview";
    const isProduction = mode === "production";

    // Only production serves on the custom domain, so only production manages
    // the zone. Adopted (created in the Cloudflare dashboard) rather than
    // created — wrangler's OAuth token can't create zones, and gating it here
    // also keeps staging/PR deploys from needing zone permissions.
    const zone = isProduction
      ? yield* Cloudflare.Zone.Zone("MyZone", {
          name: "parcelmail.dev",
        }).pipe(adopt(true))
      : undefined;

    // The account's workers.dev subdomain — fixed for this Cloudflare
    // account (`wrangler whoami` / dashboard), not per-stage. Set in .env
    // locally and in CI env for cloud deploys. Combined with each worker's
    // deterministic `name` (below), this makes both URLs plain strings known
    // before either resource deploys, so Website and ApiService never need
    // each other's live Output to configure VITE_API_URL / FRONTEND_ORIGIN —
    // no circular dependency, no bootstrap-order deploy required. Worker
    // names must be DNS-safe, so stage names like `dev_someone` are
    // sanitized. `alchemy dev` serves both workers locally on the strict
    // ports below, and production serves on parcelmail.dev, so only
    // non-production cloud stages (e.g. deploy:branch) need the subdomain.
    const subdomain = yield* Config.option(
      Config.string("CLOUDFLARE_WORKERS_SUBDOMAIN"),
    );
    if (mode === "preview" && Option.isNone(subdomain)) {
      return yield* Effect.die(
        new Error(
          "CLOUDFLARE_WORKERS_SUBDOMAIN must be set for cloud deploys (see `wrangler whoami`).",
        ),
      );
    }
    const dnsSafeStage = stage.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const url = (worker: "api" | "web") =>
      Match.value(mode).pipe(
        Match.when("dev", () =>
          worker === "api" ? "http://localhost:1339" : "http://localhost:1337",
        ),
        Match.when("production", () =>
          worker === "api"
            ? "https://api.parcelmail.dev"
            : "https://parcelmail.dev",
        ),
        Match.when(
          "preview",
          () =>
            `https://parcel-${worker}-${dnsSafeStage}.${Option.getOrThrow(subdomain)}.workers.dev`,
        ),
        Match.exhaustive,
      );
    const apiUrl = url("api");
    const websiteUrl = url("web");

    const api = yield* ApiService;

    yield* Cloudflare.Website.Vite("Website", {
      name: `parcel-web-${dnsSafeStage}`,
      rootDir: path.resolve(import.meta.dirname, "frontend"),
      dev: { port: 1337, strictPort: true },
      assets: {
        notFoundHandling: "single-page-application",
      },
      env: {
        VITE_API_URL: apiUrl,
      },
      domain: isProduction ? "parcelmail.dev" : undefined,
    });

    yield* api.bind("FRONTEND_ORIGIN", {
      bindings: [
        { type: "plain_text", name: "FRONTEND_ORIGIN", text: websiteUrl },
      ],
    });

    // The worker's own public origin. It cannot derive this from request
    // URLs: under `alchemy dev` the request URL inside workerd carries the
    // proxy's random internal port (e.g. 127.0.0.1:56385), and OAuth
    // callbacks must be built from the exact origin registered with Google.
    yield* api.bind("API_ORIGIN", {
      bindings: [{ type: "plain_text", name: "API_ORIGIN", text: apiUrl }],
    });

    // Google OAuth credentials, from .env locally and CI env for cloud
    // deploys (Google Cloud Console → APIs & Services → Credentials). Google
    // is the only sign-in method, so a production deploy without them would
    // ship a worker nobody can log into — fail the deploy instead. Other
    // stages may deploy without them (the integ-test stage doesn't use
    // Google at all); Auth.ts just leaves the provider off.
    const googleClientId = yield* Config.option(
      Config.string("GOOGLE_CLIENT_ID"),
    );
    const googleClientSecret = yield* Config.option(
      Config.string("GOOGLE_CLIENT_SECRET"),
    );
    const googleOAuth = Option.all({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    });
    if (isProduction && Option.isNone(googleOAuth)) {
      return yield* Effect.die(
        new Error(
          "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set for production deploys — Google is the only sign-in method.",
        ),
      );
    }
    if (Option.isSome(googleOAuth)) {
      yield* api.bind("GOOGLE_OAUTH", {
        bindings: [
          {
            type: "plain_text",
            name: "GOOGLE_CLIENT_ID",
            text: googleOAuth.value.clientId,
          },
          {
            type: "secret_text",
            name: "GOOGLE_CLIENT_SECRET",
            text: googleOAuth.value.clientSecret,
          },
        ],
      });
    }

    // The integ tests (test/integ.test.ts) mint session cookies with their
    // own test-only BetterAuth instance (test-utils plugin) over this
    // stage's database — an OAuth consent screen can't run headlessly, and
    // no other auth method is deployed. For the worker to accept those
    // cookies it must sign with the same secret: the test run generates one
    // (INTEG_AUTH_SECRET in its own process env) and this binding overrides
    // the per-stage Random secret with it, on the "test" stage only.
    const integAuthSecret = yield* Config.option(
      Config.string("INTEG_AUTH_SECRET"),
    );
    if (stage === "test" && Option.isSome(integAuthSecret)) {
      yield* api.bind("TEST_AUTH_SECRET", {
        bindings: [
          {
            type: "secret_text",
            name: "TEST_AUTH_SECRET",
            text: integAuthSecret.value,
          },
        ],
      });
    }

    return {
      apiUrl,
      websiteUrl,
      branchId,
      hyperdriveId: hd.hyperdriveId,
      nameServers: zone?.nameServers,
      zoneStatus: zone?.status,
      // Only the integ-test stage exposes the database origin: the tests
      // connect to it directly to persist users/sessions through their
      // test-only BetterAuth instance. Undefined everywhere else so real
      // deploys never surface database credentials in outputs.
      dbOrigin: stage === "test" ? origin : undefined,
    };
  }).pipe(Effect.provide(ApiServiceLive), Effect.provide(PostgresLive)),
);
