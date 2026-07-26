// The sync pill's copy. These are pure string functions, so they're tested
// directly rather than through a rendered Scene — the claims they make are
// what matter (what's cached, how long is left), and asserting on them here
// is both sharper and less brittle than matching DOM text.
import { describe, expect, test } from "vitest";

import { THREADS_PER_SECOND } from "../../Gmail";
import { HOT_THREAD_COUNT } from "../../tiers";
import { CompletedCacheImageBatch, init, update } from "./index";
import {
  formatBytes,
  formatEta,
  formatProgress,
  progressPercent,
  recentReadyLine,
} from "./model";

describe("formatEta", () => {
  // The estimate is quota-derived: THREADS_PER_SECOND is what the token
  // bucket sustains, and the bucket — not concurrency — binds the backfill.
  test("scales with the quota rate rather than a hardcoded guess", () => {
    expect(formatEta(THREADS_PER_SECOND * 60)).toBe("about 1 min");
    expect(formatEta(THREADS_PER_SECOND * 600)).toBe("about 10 min");
    expect(formatEta(THREADS_PER_SECOND * 7200)).toBe("about 2 hr");
  });

  test("collapses anything under a minute rather than counting seconds", () => {
    expect(formatEta(1)).toBe("under a minute");
    expect(formatEta(THREADS_PER_SECOND * 59)).toBe("under a minute");
  });

  test("a finished backfill reads as done, not as a negative duration", () => {
    expect(formatEta(0)).toBe("under a minute");
  });
});

describe("formatProgress", () => {
  test("reads as a fraction of the mailbox plus the time left", () => {
    const line = formatProgress(20_701, 30_424);

    expect(line).toContain("20,701 of 30,424 threads");
    expect(line).toContain("about 8 min left");
  });

  // total_estimate is Gmail's own label count and drifts, so syncedCount can
  // pass it. Without the clamp the eta reads as a negative duration.
  test("stays sane when the count passes a stale estimate", () => {
    expect(formatProgress(30_012, 30_000)).toContain("under a minute left");
  });
});

describe("progressPercent", () => {
  test("rounds to a whole percent", () => {
    expect(progressPercent(20_701, 30_424)).toBe(68);
  });

  // A bar wider than its track, and a division by zero at boot, are the two
  // ways this renders visibly wrong.
  test("clamps to 0–100 for stale estimates and an empty mailbox", () => {
    expect(progressPercent(30_012, 30_000)).toBe(100);
    expect(progressPercent(0, 0)).toBe(0);
  });
});

describe("formatBytes", () => {
  test("reads in MB until a gigabyte, then GB with one decimal", () => {
    expect(formatBytes(285 * 1_048_576)).toBe("285 MB");
    expect(formatBytes(1_241 * 1_048_576)).toBe("1.2 GB");
  });
});

describe("recentReadyLine", () => {
  // The sentence names the tier size, so it has to read it from the same
  // constant the queue cutoff and the LRU eviction use.
  test("names the configured tier size rather than a hardcoded number", () => {
    expect(recentReadyLine()).toContain(HOT_THREAD_COUNT.toLocaleString());
  });
});

describe("the recent-ready milestone", () => {
  const batch = (isRecentReady: boolean) =>
    CompletedCacheImageBatch({ isRecentReady });

  test("starts false and turns on when the window is covered", () => {
    expect(init().isRecentReady).toBe(false);

    const [reached] = update(init(), batch(true));

    expect(reached.isRecentReady).toBe(true);
  });

  // New mail lands in the hot window with its images seconds behind, so the
  // engine reports false again the moment anything arrives. Without the latch
  // the milestone would blink off and on for every incoming message.
  test("stays on once reached, even when a later batch reports false", () => {
    const [reached] = update(init(), batch(true));
    const [afterNewMail] = update(reached, batch(false));

    expect(afterNewMail.isRecentReady).toBe(true);
  });
});
