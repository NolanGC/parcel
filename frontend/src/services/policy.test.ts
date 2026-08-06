// Tests for the Policy service: schema, defaults, and the pure computeDelay function.
import { Option } from "effect";
import { describe, expect, test } from "vitest";

import { BackoffPolicy, SyncPolicy, computeDelay, defaultBackoffPolicy, defaultSyncPolicy } from "./policy";

describe("BackoffPolicy defaults", () => {
  test("baseMs is 2_000", () => {
    expect(defaultBackoffPolicy.baseMs).toBe(2_000);
  });

  test("maxMs is 60_000", () => {
    expect(defaultBackoffPolicy.maxMs).toBe(60_000);
  });
});

describe("SyncPolicy defaults", () => {
  test("pollIntervalMs is 60_000", () => {
    expect(defaultSyncPolicy.pollIntervalMs).toBe(60_000);
  });

  test("tokenResetAttempts is 3", () => {
    expect(defaultSyncPolicy.tokenResetAttempts).toBe(3);
  });

  test("backoff matches defaultBackoffPolicy", () => {
    expect(defaultSyncPolicy.backoff).toEqual(defaultBackoffPolicy);
  });
});

describe("computeDelay", () => {
  test("first attempt returns baseMs", () => {
    expect(computeDelay(defaultBackoffPolicy, 1, Option.none())).toBe(2_000);
  });

  test("second attempt doubles the delay", () => {
    expect(computeDelay(defaultBackoffPolicy, 2, Option.none())).toBe(4_000);
  });

  test("third attempt quadruples the delay", () => {
    expect(computeDelay(defaultBackoffPolicy, 3, Option.none())).toBe(8_000);
  });

  test("delay is capped at maxMs", () => {
    // 2^30 = 1073741824, capped at 60_000
    expect(computeDelay(defaultBackoffPolicy, 31, Option.none())).toBe(60_000);
  });

  test("Retry-After overrides the exponential delay when larger", () => {
    const delay = computeDelay(defaultBackoffPolicy, 1, Option.some(5_000));
    expect(delay).toBe(5_000);
  });

  test("Retry-After is ignored when smaller than exponential", () => {
    // first attempt = 2_000, Retry-After = 500 -> 2_000
    const delay = computeDelay(defaultBackoffPolicy, 1, Option.some(500));
    expect(delay).toBe(2_000);
  });

  test("Retry-After also overrides the capped delay", () => {
    // capped at 60_000, Retry-After = 120_000 -> 120_000
    const delay = computeDelay(defaultBackoffPolicy, 31, Option.some(120_000));
    expect(delay).toBe(120_000);
  });

  test("zero Retry-After is treated as none", () => {
    const delay = computeDelay(defaultBackoffPolicy, 1, Option.none());
    expect(delay).toBe(2_000);
  });
});

describe("BackoffPolicy schema validation", () => {
  test("valid BackoffPolicy decodes correctly", () => {
    const result = BackoffPolicy.make({ baseMs: 1000, maxMs: 30000 });
    expect(result.baseMs).toBe(1000);
    expect(result.maxMs).toBe(30000);
  });

  test("invalid BackoffPolicy throws", () => {
    expect(() => BackoffPolicy.make({ baseMs: "foo" as any, maxMs: 30000 })).toThrow();
  });
});

describe("SyncPolicy schema validation", () => {
  test("valid SyncPolicy decodes correctly", () => {
    const result = SyncPolicy.make({
      backoff: { baseMs: 1000, maxMs: 30000 },
      pollIntervalMs: 30000,
      tokenResetAttempts: 5,
    });
    expect(result.backoff.baseMs).toBe(1000);
    expect(result.pollIntervalMs).toBe(30000);
    expect(result.tokenResetAttempts).toBe(5);
  });
});
