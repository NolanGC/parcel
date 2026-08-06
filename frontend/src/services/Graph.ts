// The application's service graph — the single composition root.
//
// Everything the app does is a node in a directed, dependency-injected
// Effect service graph. This module is where that graph is *declared*: it
// is the one place you look to see what depends on what, and the one place
// the production wiring is assembled.
//
// The graph (edges point *to* the dependency):
//
//   ApiUrl ──────► AuthClient ──────► Gmail
//   ApiUrl       ─► ImageFetcher      Gmail ──► SyncEngine
//                 Compression ──► SyncEngine
//                 SqlLive ──────► SyncEngine
//                 SqlLive ──────► Search
//                 AuthClient ────► SessionStore (localStorage)
//                                    Policy ──► machine Commands
//
// Layers compose bottom-up: dependents are wrapped in their own Layer and
// merged. Layer memoization means a shared dependency (e.g. SqlLive used by
// both SyncEngine and Search) is built once.
//
// This module exposes:
//   - `AppLayer`  : the full production graph (consumed by entry.ts).
//   - `TestLayer` : the same graph with IO services swapped for scripted
//                   fakes, so end-to-end effect tests run headless.
//   - `graph`     : a human-readable description for diagnostics/tests.

import { Layer } from "effect";
import { AuthClient, sessionStorageLayer } from "../auth";
import { Compression } from "../compression";
import { LiveApiUrl } from "../config";
import { Gmail } from "../Gmail";
import { ImageFetcher } from "../images";
import { Search } from "../search";
import { SqlLive } from "../sql";
import { SyncEngine } from "../sync";
import { LivePolicy, Policy } from "./policy";
import { LivePreferences, Preferences } from "./preferences";

// The explicit dependency declaration: each service paired with the deps its
// Layer pulls in. Read it as documentation AND as the test-override map.
export const graph = [
  { service: "ApiUrl", providedBy: "config: LiveApiUrl", deps: [] },
  { service: "SessionStore", providedBy: "auth: sessionStorageLayer", deps: [] },
  { service: "AuthClient", providedBy: "auth: AuthClient.layer", deps: ["ApiUrl"] },
  { service: "Compression", providedBy: "compression: Compression.layer", deps: [] },
  { service: "ImageFetcher", providedBy: "images: ImageFetcher.layer", deps: ["ApiUrl"] },
  { service: "Gmail", providedBy: "Gmail: Gmail.layer", deps: ["AuthClient"] },
  { service: "SqlLive", providedBy: "sql: SqlLive", deps: [] },
  { service: "Policy", providedBy: "services/policy: LivePolicy", deps: [] },
  { service: "Preferences", providedBy: "services/preferences: LivePreferences", deps: ["SessionStore"] },
  { service: "Search", providedBy: "search: Search.layer", deps: ["SqlLive"] },
  { service: "SyncEngine", providedBy: "sync: SyncEngine.layer", deps: ["Gmail", "SqlLive", "Compression", "ImageFetcher"] },
] as const;

// ── PRODUCTION GRAPH ───────────────────────────────────────────────────────
//
// Boot is the one place a dead service (a migration failure, a missing
// VITE_API_URL) should surface as a crash rather than a silent stall, so the
// fallible database-backed services are orDie'd exactly as entry.ts did.

// NOTE: Layer.mergeAll does NOT wire one member's requirement from another
// member's output in Effect 4.0.0-beta. AuthClient, ImageFetcher and Gmail's
// internal AuthClient all require ApiUrl, so ApiUrl must be supplied with an
// explicit Layer.provide rather than left to be inferred.
export const AppLayer = Layer.mergeAll(
  sessionStorageLayer,
  AuthClient.layer,
  Compression.layer,
  ImageFetcher.layer,
  Gmail.layer,
  LivePolicy,
  LivePreferences,
  Layer.orDie(SqlLive),
  Layer.orDie(SyncEngine.layer),
  Layer.orDie(Search.layer),
).pipe(Layer.provide(LiveApiUrl));

// ── TEST GRAPH ─────────────────────────────────────────────────────────────
//
// Same shape, IO swapped for fakes. The test graph still needs the policy and
// session layers (pure), but replaces the SyncEngine with a scripted fake so
// machine commands run headless end-to-end.

export const makeTestLayer = (
  syncEngineLayer: Layer.Layer<SyncEngine>,
) => Layer.mergeAll(syncEngineLayer, LivePolicy);
