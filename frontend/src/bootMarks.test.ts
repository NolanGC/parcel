// Verifiability for the boot-telemetry helpers. bootMarks is intentionally a
// small, stateless module (it reads the global `performance` API and is
// invoked synchronously at module-eval in sql.ts), so it is not a Context
// service — forcing one would add indirection without any swap/test benefit.
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
  BOOT_ENGINE_START,
  logBootReport,
  mark,
  markNow,
} from "./bootMarks";

describe("bootMarks", () => {
  test("markNow writes a performance mark", () => {
    const before = performance.getEntriesByName(BOOT_ENGINE_START, "mark").length;
    markNow(BOOT_ENGINE_START);
    const after = performance.getEntriesByName(BOOT_ENGINE_START, "mark").length;
    expect(after).toBe(before + 1);
  });

  test("mark is an Effect that records the mark", async () => {
    await Effect.runPromise(mark(BOOT_ENGINE_START));
    const marks = performance.getEntriesByName(BOOT_ENGINE_START, "mark");
    expect(marks.length).toBeGreaterThan(0);
  });

  test("logBootReport does not throw in a non-DEV env", async () => {
    const original = import.meta.env.DEV;
    await Effect.runPromise(logBootReport(42));
    expect(original).toBeFalsy(); // non-DEV test env
  });
});
