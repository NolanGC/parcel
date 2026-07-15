import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";
import { adopt } from "alchemy/AdoptPolicy";

import { Hyperdrive, Postgres, PostgresLive } from "./backend/src/Db.ts";
import TodoServiceLive, { TodoService } from "./backend/src/TodoService.ts";

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
    const { branchId } = yield* Postgres;
    const hd = yield* Hyperdrive;
    const path = yield* Path;
    const stage = yield* Alchemy.Stage;
    const { dev } = yield* Alchemy.AlchemyContext;

    const isProduction = stage === "production";

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
    // before either resource deploys, so Website and TodoService never need
    // each other's live Output to configure VITE_API_URL / FRONTEND_ORIGIN —
    // no circular dependency, no bootstrap-order deploy required. Worker
    // names must be DNS-safe, so stage names like `dev_someone` are
    // sanitized. `alchemy dev` serves both workers locally on the strict
    // ports below, and production serves on parcelmail.dev, so only
    // non-production cloud stages (e.g. deploy:branch) need the subdomain.
    const subdomain = process.env.CLOUDFLARE_WORKERS_SUBDOMAIN;
    if (!dev && !isProduction && subdomain === undefined) {
      return yield* Effect.die(
        new Error(
          "CLOUDFLARE_WORKERS_SUBDOMAIN must be set for cloud deploys (see `wrangler whoami`).",
        ),
      );
    }
    const dnsSafeStage = stage.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const apiUrl = dev
      ? "http://localhost:1339"
      : isProduction
        ? "https://api.parcelmail.dev"
        : `https://parcel-api-${dnsSafeStage}.${subdomain}.workers.dev`;
    const websiteUrl = dev
      ? "http://localhost:1337"
      : isProduction
        ? "https://parcelmail.dev"
        : `https://parcel-web-${dnsSafeStage}.${subdomain}.workers.dev`;

    const api = yield* TodoService;

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

    return {
      apiUrl,
      websiteUrl,
      branchId,
      hyperdriveId: hd.hyperdriveId,
      nameServers: zone?.nameServers,
      zoneStatus: zone?.status,
    };
  }).pipe(Effect.provide(TodoServiceLive), Effect.provide(PostgresLive)),
);
