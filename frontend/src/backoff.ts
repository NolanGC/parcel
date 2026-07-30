// How long to wait before trying Gmail again.
//
// Shared by the two machines that talk to Gmail — the sync (syncMachine.ts)
// and the outbox drain (outboxMachine.ts) — because they are backing off the
// same service for the same reasons, and two sets of constants would drift
// into two different ideas of what "too fast" means.

import { Option } from "effect";

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Exponential in the consecutive-failure count, capped, and never shorter
 * than a Retry-After Google actually asked for.
 *
 * `attempt` counts from 1 for the first retry.
 */
export const backoffDelayMs = (
  attempt: number,
  maybeRetryAfterMs: Option.Option<number>,
): number => {
  const exponential = Math.min(
    BACKOFF_BASE_MS * 2 ** (attempt - 1),
    BACKOFF_MAX_MS,
  );
  return Math.max(
    exponential,
    Option.getOrElse(maybeRetryAfterMs, () => 0),
  );
};
