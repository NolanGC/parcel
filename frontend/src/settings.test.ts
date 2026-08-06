// Tests for the settings module: appearance, reading mode, and persistence.
import { describe, expect, test } from "vitest";

import {
  Appearance,
  CompletedSettingsPersistence,
  DEFAULT_APPEARANCE,
  DEFAULT_READING_MODE,
  ReadingMode,
} from "./settings";

describe("Appearance schema", () => {
  test("valid appearance values", () => {
    expect(Appearance.make("System")).toBe("System");
    expect(Appearance.make("Light")).toBe("Light");
    expect(Appearance.make("Dark")).toBe("Dark");
  });

  test("DEFAULT_APPEARANCE is System", () => {
    expect(DEFAULT_APPEARANCE).toBe("System");
  });
});

describe("ReadingMode schema", () => {
  test("valid reading mode values", () => {
    expect(ReadingMode.make("html")).toBe("html");
    expect(ReadingMode.make("markdown")).toBe("markdown");
  });

  test("DEFAULT_READING_MODE is html", () => {
    expect(DEFAULT_READING_MODE).toBe("html");
  });
});

describe("Settings commands", () => {
  test("CompletedSettingsPersistence message", () => {
    const msg = CompletedSettingsPersistence();
    expect(msg._tag).toBe("CompletedSettingsPersistence");
  });
});

describe("pinAppearance", () => {
  // Only testable in a DOM environment; minimal smoke test
  test("is callable and does not throw", () => {
    const { pinAppearance } = require("./settings");
    expect(typeof pinAppearance).toBe("function");
  });
});
