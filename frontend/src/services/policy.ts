// Retry and timing policies for the sync machine.
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
// Used by the pure machine edge callbacks (which cannot access Effect
// services) AND as the default for the live Layer, so the two cannot
// disagree.

export const defaultBackoffPolicy: BackoffPolicy = {
  baseMs: 2_000,
  maxMs: 60_000,
};

export const defaultSyncPolicy: SyncPolicy = {
  backoff: defaultBackoffPolicy,
  pollIntervalMs: 60_000,
  tokenResetAttempts: 3,
};

// SERVICE
//
// The value yielded by `yield* Policy` is the SyncPolicy struct.

export class Policy extends Context.Service<Policy, SyncPolicy>()(
  "parcel/Policy",
  { make: Effect.sync(() => defaultSyncPolicy) },
) {}

export const LivePolicy: Layer.Layer<Policy> = Layer.effect(
  Policy,
  Policy.make,
);

/** Exponential backoff: doubled per attempt, capped, never shorter than
 *  a Retry-After Google actually asked for. Pure projection of BackoffPolicy. */
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
