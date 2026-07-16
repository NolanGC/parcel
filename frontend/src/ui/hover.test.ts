// Pure-update tests for the traveling hover overlays (Ui.Table, Ui.Menu):
// the behavioral invariants that make panning read as continuous motion.
// No DOM, no commands executed — models in, models + issued commands out.
//
// Covers:
// - Table: a container entry starts a fresh session (bump + cleared row +
//   measure command); leaving keeps the row index so the overlay fades in
//   place; entering a row retargets it.
// - Menu: the hover index tracks activations but SURVIVES deactivation (the
//   deadspace fix — the base menu clears its active index in the gaps
//   between items); opening resets rects/hover but measurement waits for
//   CompletedAnchorMenu, when the portaled panel actually exists.
import { Menu as BaseMenu } from "@foldkit/ui";
import { Option } from "effect";
import { describe, expect, test } from "vitest";

import * as Menu from "./menu";
import * as Table from "./table";

describe("Ui.Table hover session", () => {
  const model: Table.Model = {
    ...Table.init({ id: "t" }),
    session: 3,
    isPointerInside: true,
    maybeRowIndex: Option.some(2),
    rects: [{ top: 0, left: 0, width: 10, height: 10 }],
  };

  test("entering the container starts a fresh session and measures rows", () => {
    const [next, commands] = Table.update(
      model,
      Table.EnteredContainer({ rowCount: 5 }),
    );
    expect(next.session).toBe(4);
    expect(next.isPointerInside).toBe(true);
    // Cleared so the overlay snaps to the first hovered row instead of
    // sliding from the previous session's rect.
    expect(Option.isNone(next.maybeRowIndex)).toBe(true);
    expect(commands.map((command) => command.name)).toEqual([
      "MeasureRowRects",
    ]);
  });

  test("leaving the container keeps the row so the overlay fades in place", () => {
    const [next, commands] = Table.update(model, Table.LeftContainer());
    expect(next.isPointerInside).toBe(false);
    expect(next.maybeRowIndex).toEqual(Option.some(2));
    expect(commands).toEqual([]);
  });

  test("entering a row retargets the overlay", () => {
    const [next] = Table.update(model, Table.EnteredRow({ index: 4 }));
    expect(next.maybeRowIndex).toEqual(Option.some(4));
  });
});

describe("Ui.Menu hover overlay", () => {
  const { update } = Menu.create<"a" | "b" | "c">();
  const rect = { top: 4, left: 4, width: 100, height: 30 };

  const activated = (index: number): Menu.Message => ({
    _tag: "ActivatedItem",
    index,
    activationTrigger: "Pointer",
  });

  test("hover index tracks the base menu's activations", () => {
    const [next] = update(Menu.init({ id: "m", isAnimated: false }), activated(2));
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
