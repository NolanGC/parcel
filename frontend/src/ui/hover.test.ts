// Pure-update tests for the traveling hover overlays: the behavioral
// invariants that make panning read as continuous motion. No DOM, no commands
// executed — models in, models + issued commands out.
//
// Covers:
// - Menu: the hover index tracks activations but SURVIVES deactivation (the
//   deadspace fix — the base menu clears its active index in the gaps between
//   items); opening resets rects/hover but measurement waits for
//   CompletedAnchorMenu, when the portaled panel actually exists.
// - Inbox list: the hover-session state machine (positioning itself is pure
//   arithmetic off the VirtualList scroll, so only the session/claim rules
//   have behavior worth pinning) — entry starts a fresh session, leave keeps
//   the cursor for the in-place fade, and the keyboard/pointer claim.
import { Menu as BaseMenu } from "@foldkit/ui";
import { Option } from "effect";
import { describe, expect, test } from "vitest";

import { ThreadId } from "../Gmail";
import * as Inbox from "../page/inbox";
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

describe("Inbox list hover session", () => {
  const rows = [3, 4, 5].map((n) => ({
    id: ThreadId.make(`thread-${n}`),
    subject: "Hi",
    sender: "Ada",
    snippet: "hello",
    date: n,
    unread: false,
    category: "none" as const,
  }));

  // A list with real rows, pointer inside, cursor mouse-held at `index`.
  const hoveredAt = (index: number): Inbox.Model => {
    const [loaded] = Inbox.update(Inbox.init(), Inbox.GotThreads({ rows }));
    const [entered] = Inbox.update(loaded, Inbox.EnteredList());
    const [next] = Inbox.update(entered, Inbox.HoveredRow({ index }));
    return next;
  };

  test("entering the list starts a fresh session with no cursor", () => {
    const [left] = Inbox.update(hoveredAt(1), Inbox.LeftList());
    const [next] = Inbox.update(left, Inbox.EnteredList());
    // Remounts the overlay (snap + fade-in) instead of sliding from row 1.
    expect(next.hoverSession).toBe(left.hoverSession + 1);
    expect(Option.isNone(next.selected)).toBe(true);
    expect(next.isPointerInside).toBe(true);
  });

  test("leaving keeps the cursor so the overlay fades out in place", () => {
    const [next] = Inbox.update(hoveredAt(1), Inbox.LeftList());
    expect(next.selected).toEqual(Option.some(1));
    expect(next.isPointerInside).toBe(false);
  });

  test("a keyboard-held cursor survives the pointer re-entering", () => {
    const [claimed] = Inbox.update(
      hoveredAt(1),
      Inbox.PressedListKey({ key: "j" }),
    );
    expect(claimed.keyboardControlled).toBe(true);
    const [next] = Inbox.update(claimed, Inbox.EnteredList());
    expect(next.selected).toEqual(claimed.selected);
  });

  test("real mouse motion over a row reclaims the overlay", () => {
    const [claimed] = Inbox.update(
      hoveredAt(1),
      Inbox.PressedListKey({ key: "j" }),
    );
    const [next] = Inbox.update(claimed, Inbox.HoveredRow({ index: 1 }));
    expect(next.keyboardControlled).toBe(false);
    expect(next.selected).toEqual(Option.some(1));
  });
});
