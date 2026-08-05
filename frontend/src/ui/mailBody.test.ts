// @vitest-environment jsdom
//
// jsdom for `HTMLElement`, which this module extends at import time.
//
// These assert the CSS contract, not the rendering — no test environment
// resolves `light-dark()`, so what a browser does with these declarations was
// verified in Chrome by hand: with `color-scheme:inherit` the shadow root
// follows both the pinned `.light`/`.dark` classes and the System default,
// and without it every value collapses to its light branch.

import { describe, expect, it } from "vitest";

import { mailBodyStyle } from "./mailBody";

describe("app surface", () => {
  const style = mailBodyStyle("app");

  // The one declaration the whole theming fix rests on. `all:initial` resets
  // color-scheme to `normal`, which pins light-dark() to light forever;
  // restoring inheritance is what re-links the shadow root to the app.
  it("restores color-scheme after the reset", () => {
    expect(style).toContain("all:initial");
    expect(style).toContain("color-scheme:inherit");
    expect(style.indexOf("all:initial")).toBeLessThan(
      style.indexOf("color-scheme:inherit"),
    );
  });

  it("states every colour in both themes", () => {
    const colours = style.match(/(?:color|background|border[a-z-]*):[^;}]+/g);

    expect(colours).not.toBeNull();
    for (const declaration of colours ?? []) {
      // `none` and the shorthand resets carry no colour of their own.
      if (!/#|rgb/.test(declaration)) {
        continue;
      }
      expect(declaration).toContain("light-dark(");
    }
  });
});

describe("paper surface", () => {
  const style = mailBodyStyle("paper");

  // The sender's own html keeps its baked-in colours, which were written for
  // white. Theming it would leave grey text on near-black.
  it("is fixed, and does not follow the theme", () => {
    expect(style).not.toContain("light-dark(");
    expect(style).not.toContain("color-scheme");
    expect(style).toContain("color:#1f2937");
  });
});

// The host is what a message could otherwise escape through.
describe("both surfaces", () => {
  it.each(["app", "paper"] as const)("contains %s", (surface) => {
    expect(mailBodyStyle(surface)).toContain("contain:layout paint");
  });
});
