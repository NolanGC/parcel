// Pure-update tests for the Menu's traveling hover overlay: the behavioral
// invariants that make panning read as continuous motion. No DOM, no commands
// executed — models in, models + issued commands out.
//
// Covers: the hover index tracks activations but SURVIVES deactivation (the
// deadspace fix — the base menu clears its active index in the gaps between
// items); opening resets rects/hover but measurement waits for
// CompletedAnchorMenu, when the portaled panel actually exists.
//
// (The inbox list's overlay is math-driven off the VirtualList scroll
// position, not a measured-rect submodel, so it has no pure-update surface to
// test here — it's exercised by the inbox story/scene tests instead.)
import { Menu as BaseMenu } from "@foldkit/ui";
import { Option } from "effect";
import { describe, expect, test } from "vitest";

import * as Menu from "./menu";

describe("Ui.Menu hover overlay", () => {
  const { update } = Menu.create<"a" | "b" | "c">();
  const rect = { top: 4, left: 4, width: 100, height: 30 };

  const activated = (index: number): Menu.Message => ({
    _tag: "ActivatedItem",
    index,
    activationTrigger: "Pointer",
  });

  test("hover index tracks the base menu's activations", () => {
    const [next] = update(
      Menu.init({ id: "m", isAnimated: false }),
      activated(2),
    );
    expect(next.maybeHoverIndex).toEqual(Option.some(2));
    expect(next.menu.maybeActiveItemIndex).toEqual(Option.some(2));
  });

  test("hover index SURVIVES deactivation in the gap between items", () => {
    const [hovered] = update(
      Menu.init({ id: "m", isAnimated: false }),
      activated(2),
    );
    const [next] = update(hovered, { _tag: "DeactivatedItem" });
    // The base menu clears its active index…
    expect(Option.isNone(next.menu.maybeActiveItemIndex)).toBe(true);
    // …but the overlay stays put: no deadspace blink.
    expect(next.maybeHoverIndex).toEqual(Option.some(2));
  });

  test("opening resets rects and hover, but does not measure yet", () => {
    const stale: Menu.Model = {
      ...Menu.init({ id: "m", isAnimated: false }),
      rects: [rect],
      maybeHoverIndex: Option.some(1),
    };
    const [next, commands] = update(stale, {
      _tag: "Opened",
      maybeActiveItemIndex: Option.none(),
    });
    expect(next.rects).toEqual([]);
    expect(Option.isNone(next.maybeHoverIndex)).toBe(true);
    // The portaled panel is not in the DOM yet on Opened.
    expect(commands.map((command) => command.name)).not.toContain(
      "MeasureMenuItemRects",
    );
  });

  test("measurement runs once the panel is anchored", () => {
    const [opened] = update(Menu.init({ id: "m", isAnimated: false }), {
      _tag: "Opened",
      maybeActiveItemIndex: Option.none(),
    });
    const [, commands] = update(opened, BaseMenu.CompletedAnchorMenu());
    expect(commands.map((command) => command.name)).toContain(
      "MeasureMenuItemRects",
    );
  });

  test("measured rects land in the model", () => {
    const [next] = update(
      Menu.init({ id: "m", isAnimated: false }),
      Menu.GotItemRects({ rects: [rect] }),
    );
    expect(next.rects).toEqual([rect]);
  });
});
