import { Effect } from "effect";

// Boot-phase instrumentation. Marks are cheap enough to keep in production
// (the perf bench reads them off a real build); the console report is
// dev-only. All times are relative to navigation start.

const hasPerformance = typeof performance !== "undefined";

export const BOOT_WORKER_SPAWN = "parcel:boot:worker-spawn";
export const BOOT_ENGINE_START = "parcel:boot:engine-start";
export const BOOT_ENGINE_READY = "parcel:boot:engine-ready";
export const BOOT_QUERY_START = "parcel:boot:query-start";
export const BOOT_QUERY_END = "parcel:boot:query-end";

export const markNow = (name: string): void => {
  if (hasPerformance) {
    performance.mark(name);
  }
};

export const mark = (name: string): Effect.Effect<void> =>
  Effect.sync(() => {
    markNow(name);
  });

const markAt = (name: string): number | undefined => {
  const entries = performance.getEntriesByName(name, "mark");
  return entries.length > 0 ? Math.round(entries[0]!.startTime) : undefined;
};

/** One dev-only table of the boot split, printed after the first inbox read
 *  lands. Reads the marks above; absent marks render as undefined rather than
 *  being an error, so a partial boot still reports what it has. */
export const logBootReport = (rowCount: number): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!import.meta.env.DEV || !hasPerformance) {
      return;
    }
    console.info("[parcel boot]", {
      workerSpawn: markAt(BOOT_WORKER_SPAWN),
      engineStart: markAt(BOOT_ENGINE_START),
      engineReady: markAt(BOOT_ENGINE_READY),
      queryStart: markAt(BOOT_QUERY_START),
      queryEnd: markAt(BOOT_QUERY_END),
      rows: rowCount,
    });
  });
