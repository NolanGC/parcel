// Retry and timing policies for the sync and outbox machines.
//
// Defined as an Effect service so the constants are configurable at the
// Layer boundary — tests replace the live values with deterministic ones
// instead of mocking free-function imports.

import { Context, Effect, Layer, Option, Schema as S } from "effect";

// SCHEMA

export const BackoffPolicy = S.Struct({
  /** Base delay in ms for exponential backoff. Doubled per attempt. */
  baseMs: S.Number,
  /** Cap in ms — the delay never exceeds this. */
  maxMs: S.Number,
});
export type BackoffPolicy = typeof BackoffPolicy.Type;

export const SyncPolicy = S.Struct({
  backoff: BackoffPolicy,
  /** How long between poll ticks once settled (ms). */
  pollIntervalMs: S.Number,
  /** After this many consecutive failures the stored page token is dropped. */
  tokenResetAttempts: S.Number,
});
export type SyncPolicy = typeof SyncPolicy.Type;

// DEFAULT VALUES
//
// Used by the pure machine edge callbacks (cannot access Effect services)
// AND as the values for the default Layer. Defined once here so they cannot
// disagree. Both are exported for test assertions.

export const defaultBackoffPolicy: BackoffPolicy = {
  baseMs: 2_000,
  maxMs: 60_000,
};

export const defaultSyncPolicy: SyncPolicy = {
  backoff: defaultBackoffPolicy,
  pollIntervalMs: 60_000,
  tokenResetAttempts: 3,
};

// SERVICE TAG
//
// WARNING: Effect 4.0.0-beta.97 Context.Service API with Schema fields
// auto-derives the struct type from the schema — no manual constructor.

export class Policy extends Context.Service<Policy>()("parcel/Policy", {
  backoff: BackoffPolicy,
  pollIntervalMs: S.Number,
  tokenResetAttempts: S.Number,
}) {}

// LIVE LAYER

export const LivePolicy: Layer.Layer<Policy> = Layer.succeed(
  Policy,
  new Policy(defaultSyncPolicy),
);

/** Exponential backoff: doubled per attempt, capped, never shorter than
 *  a Retry-After Google actually asked for.
 *
 *  Pure data function on the BackoffPolicy schema — a projection of the
 *  config, not a free-standing helper. */
export const computeDelay = (
  policy: BackoffPolicy,
  attempt: number,
  maybeRetryAfterMs: Option.Option<number>,
): number => {
  const exponential = Math.min(
    policy.baseMs * 2 ** (attempt - 1),
    policy.maxMs,
  );
  return Math.max(
    exponential,
    Option.getOrElse(maybeRetryAfterMs, () => 0),
  );
};
