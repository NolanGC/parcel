import { Stage } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { BetterAuth, BetterAuthPg, makeAuthGate } from "./Auth.ts";

// NOTE: SSRF surface is slim on Workers (no private-network reach), but the
// scheme check keeps file:/data:/gopher: out regardless.
const PROXYABLE_PROTOCOLS = new Set(["http:", "https:"]);

// The API worker: BetterAuth (Google sign-in) today, the Gmail-backed mail API
// next. Gated routes get their session via `gate.sessionUser`.
//
// NOTE: Declared as a bare Tag with `.make()` attaching props below, so the
// name can be computed from `Stage`. `precreate` reads a literal `name` field
// raw, before Input/Output resolution, so a Stage-derived name only resolves
// as the whole props Effect that `.make()` accepts.
//
// NOTE: The tag string stays "TodoService", its name at first deploy. It is
// the resource identity in alchemy state, and changing it would plan a
// create+delete of the same deterministically-named worker.
export class ApiService extends Cloudflare.Worker<
  ApiService,
  Cloudflare.WorkerShape
>()("TodoService") {}

export default ApiService.make(
  Effect.gen(function* () {
    // NOTE: This module is bundled as the deployed worker's own script
    // (`main: import.meta.url`), so this body runs a second time inside the
    // Workers runtime on cold start, where `Stage` does not exist. Guarded the
    // way alchemy's own binding services are: a deployed worker never needs
    // its own name at runtime, only at precreate time on the CLI side.
    const stage = globalThis.__ALCHEMY_RUNTIME__ ? "" : yield* Stage;
    return {
      // Deterministic (stage-only, no random suffix) so alchemy.run.ts can
      // compute VITE_API_URL and FRONTEND_ORIGIN as plain strings before
      // either worker deploys — no circular dependency on each other's
      // Output. Sanitized the same way as in alchemy.run.ts so both sides
      // derive the identical DNS-safe name.
      name: `parcel-api-${stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      main: import.meta.url,
      dev: { port: 1339, strictPort: true },
      // Production serves on the apex's `api.` subdomain (zone adopted in
      // alchemy.run.ts); other stages stay on workers.dev. Must stay in
      // lockstep with `apiUrl` in alchemy.run.ts.
      domain: stage === "production" ? "api.parcelmail.dev" : undefined,
    };
  }),
  Effect.gen(function* () {
    const auth = yield* BetterAuth;
    const gate = makeAuthGate(auth);

    // Image proxy for the sync engine's deepest cache tier: the client can't
    // read cross-origin image bytes itself (no CORS on mail CDNs), so it
    // fetches them through here at sync time and stores them locally. Gated on
    // the session so this is not an open relay, and only the content-type
    // crosses back; upstream cookies and headers do not.
    const parseUrl = Option.liftThrowable((value: string) => new URL(value));

    const proxyImage = Effect.gen(function* () {
      const maybeUser = yield* gate.sessionUser;
      if (Option.isNone(maybeUser)) {
        return gate.unauthorized;
      }

      const request = yield* HttpServerRequest.HttpServerRequest;
      const maybeTarget = pipe(
        Option.fromNullishOr(
          new URL((request.source as Request).url).searchParams.get("url"),
        ),
        Option.flatMap(parseUrl),
        Option.filter((url) => PROXYABLE_PROTOCOLS.has(url.protocol)),
      );
      if (Option.isNone(maybeTarget)) {
        return HttpServerResponse.text("Bad url", { status: 400 });
      }

      const maybeUpstream = yield* Effect.tryPromise(() =>
        fetch(maybeTarget.value, { redirect: "follow" }),
      ).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeedNone),
      );
      if (Option.isNone(maybeUpstream) || !maybeUpstream.value.ok) {
        return HttpServerResponse.text("Upstream fetch failed", {
          status: 502,
        });
      }

      const upstream = maybeUpstream.value;
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        return HttpServerResponse.text("Not an image", { status: 415 });
      }
      return HttpServerResponse.fromWeb(
        new Response(upstream.body, {
          status: 200,
          headers: { "content-type": contentType },
        }),
      );
    }).pipe(Effect.catchTag("AuthError", gate.authUnavailable));

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          // Credentialed CORS + BetterAuth routes come from the shared auth
          // gate (see makeAuthGate in Auth.ts).
          HttpRouter.middleware(gate.cors, { global: true }),
          HttpRouter.add("GET", "/", HttpServerResponse.text("ok")),
          HttpRouter.add("*", "/api/auth/*", gate.handleAuthApi),
          HttpRouter.add("GET", "/api/proxy/image", proxyImage),
        ).pipe(Layer.provide(HttpPlatform.layer)),
      ),
    };
  }).pipe(
    // `Layer.fresh`: ConnectBinding captures the host worker it binds to,
    // and Effect memoizes layer builds globally — without `fresh`, another
    // worker's build could reuse this one and the Hyperdrive binding would
    // land on only one of them. Provided once here so BetterAuthPg gets the
    // shared binding.
    Effect.provide(BetterAuthPg),
    Effect.provide(Layer.fresh(Cloudflare.Hyperdrive.ConnectBinding)),
  ),
);
