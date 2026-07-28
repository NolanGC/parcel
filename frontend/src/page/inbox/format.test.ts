// The sync pill's copy. These are pure string functions, so they're tested
// directly rather than through a rendered Scene — the claims they make are
// what matter (what's cached, how long is left), and asserting on them here
// is both sharper and less brittle than matching DOM text.
import { describe, expect, test } from "vitest";

import { THREADS_PER_SECOND, ThreadId } from "../../Gmail";
import { cleanSnippet } from "../../snippet";
import type { ThreadRow } from "../../sync";
import { HOT_THREAD_COUNT } from "../../tiers";
import { CompletedCacheImageBatch, init, update } from "./index";
import {
  formatBytes,
  formatEta,
  formatProgress,
  progressPercent,
  RECENT_READY_LINE,
  reconcileRows,
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

describe("RECENT_READY_LINE", () => {
  // The sentence names the tier size, so it has to read it from the same
  // constant the queue cutoff and the LRU eviction use.
  test("names the configured tier size rather than a hardcoded number", () => {
    expect(RECENT_READY_LINE).toContain(HOT_THREAD_COUNT.toLocaleString());
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

describe("cleanSnippet", () => {
  // Senders pad preheader text with invisible characters to push the preview
  // out of the row. They have layout width, so the truncation ellipsis lands
  // after a run of blank space — the gap this exists to remove. One real
  // message in the store carried 108 consecutive U+034F.
  test("strips the invisible padding senders use on preheaders", () => {
    const padded = "Uber Reserve \u034F\u034F\u034F\u200C\u200F\u034F";

    expect(cleanSnippet(padded)).toBe("Uber Reserve");
  });

  test("decodes the HTML entities Gmail returns the snippet escaped with", () => {
    expect(cleanSnippet("we&#39;ve matched &amp; ranked")).toBe(
      "we've matched & ranked",
    );
    expect(cleanSnippet("Tom &amp; Jerry &quot;live&quot;")).toBe(
      'Tom & Jerry "live"',
    );
    expect(cleanSnippet("caf&#xe9; hours")).toBe("café hours");
  });

  // &nbsp; decodes to U+00A0, which is whitespace but does not collapse on
  // its own — so the collapse has to happen after decoding, not before.
  test("collapses whitespace produced by decoding, not just literal runs", () => {
    expect(cleanSnippet("Sale&nbsp;&nbsp;&nbsp;today")).toBe("Sale today");
    expect(cleanSnippet("  spaced   out  ")).toBe("spaced out");
  });

  test("leaves an unrecognized entity alone rather than mangling it", () => {
    expect(cleanSnippet("50 &widget; off")).toBe("50 &widget; off");
  });

  test("leaves ordinary text untouched", () => {
    expect(cleanSnippet("Your receipt from Tuesday")).toBe(
      "Your receipt from Tuesday",
    );
  });
});

// Every refresh re-reads the whole list from SQLite, so the rows arriving here
// are always freshly decoded objects. Reconciliation is what turns that back
// into stable references, and stable references are the only reason the view's
// memoization slots ever hit — so these assertions are on identity (`toBe`),
// not equality.
describe("reconcileRows", () => {
  const row = (id: string, fields: Partial<ThreadRow> = {}): ThreadRow => ({
    id: ThreadId.make(id),
    subject: `Subject ${id}`,
    sender: `sender-${id}@example.com`,
    snippet: `Snippet ${id}`,
    date: 1_700_000_000_000,
    isUnread: false,
    category: "personal",
    ...fields,
  });

  test("keeps the array reference when nothing changed", () => {
    const previous = [row("a"), row("b"), row("c")];
    const next = [row("a"), row("b"), row("c")];

    expect(reconcileRows(previous, next)).toBe(previous);
  });

  test("reuses the untouched rows and replaces only the changed one", () => {
    const previous = [row("a"), row("b"), row("c")];
    const next = [row("a"), row("b", { isUnread: true }), row("c")];
    const reconciled = reconcileRows(previous, next);

    expect(reconciled).not.toBe(previous);
    expect(reconciled[0]).toBe(previous[0]);
    expect(reconciled[2]).toBe(previous[2]);
    expect(reconciled[1]).not.toBe(previous[1]);
    expect(reconciled[1]?.isUnread).toBe(true);
  });

  test("carries identity across a move, since rows match by id not position", () => {
    const previous = [row("a"), row("b")];
    const next = [row("b"), row("a")];
    const reconciled = reconcileRows(previous, next);

    expect(reconciled[0]).toBe(previous[1]);
    expect(reconciled[1]).toBe(previous[0]);
  });

  // The backfill case: new mail lands on top and everything below it keeps
  // the object it already had, so only the new row re-renders.
  test("prepends new rows without disturbing the ones already loaded", () => {
    const previous = [row("a"), row("b")];
    const next = [row("new"), row("a"), row("b")];
    const reconciled = reconcileRows(previous, next);

    expect(reconciled).toHaveLength(3);
    expect(reconciled[0]?.id).toBe("new");
    expect(reconciled[1]).toBe(previous[0]);
    expect(reconciled[2]).toBe(previous[1]);
  });

  test("does not hold the array reference when rows were removed", () => {
    const previous = [row("a"), row("b")];
    const reconciled = reconcileRows(previous, [row("a")]);

    expect(reconciled).not.toBe(previous);
    expect(reconciled[0]).toBe(previous[0]);
  });
});
