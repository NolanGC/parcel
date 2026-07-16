import { Menu as BaseMenu } from "@foldkit/ui";
import { Effect, Option, Schema as S } from "effect";
import { Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { evo } from "foldkit/struct";
import { Check } from "lucide";

import { icon, type IconView } from "./icon";
import { weightLabel } from "./label";
import { hoverTransition, popoutDown, popoutUp } from "./motion";
import { measureRect, Rect } from "./rect";
import { elevate, POPOUT_OFFSET, surface, type SurfaceLevel } from "./surface";

/**
 * FoldkitUI · Menu — Fluid Functionalism styling for @foldkit/ui's Menu
 * submodel. The behavior (keyboard nav, typeahead, anchoring, animation
 * lifecycle) comes from the base submodel; this module supplies the FF look:
 *
 * - Panel: `substrate + 2` on the surface ladder, shadow pinned at level 3
 *   so a menu reads as a popover at any depth (surfaces doc convention).
 * - Items: the same traveling hover overlay as Ui.Table. Items carry no
 *   hover background of their own; ONE `.fk-hover-overlay` glides between
 *   item rects, and — unlike the base menu's active index, which clears in
 *   the gaps between items — the overlay's index persists, so panning
 *   reads as continuous motion instead of per-item blinks (no deadspace).
 * - Motion: fast tier — 80ms enter (fade + 4px slide + scaleY 0.96), 60ms
 *   exit, baked into the panel classes.
 *
 * Mechanics: item rects are measured through a Command when the panel opens
 * (offset* coords relative to the group, which is the offsetParent). The
 * overlay element rides in the base menu's group-heading slot — the one
 * hook that renders a real element inside the panel — as a zero-footprint
 * `display: contents` heading over a single group. It mounts on the first
 * hover (snap + fade-in via `@starting-style`) and then retargets, exactly
 * like the Table.
 *
 * This module mirrors the base Menu's shape (`Model`/`init`/`create`), so
 * callers wire it the same way and get the overlay for free.
 */

// MODEL

export const Model = S.Struct({
  menu: BaseMenu.Model,
  /** Item layout rects, measured when the panel opens. */
  rects: S.Array(Rect),
  /** The item under (or last under) the pointer / keyboard cursor. Kept
   *  when the base menu deactivates in the gaps between items, so the
   *  overlay stays put instead of blinking out. */
  maybeHoverIndex: S.Option(S.Number),
});
export type Model = typeof Model.Type;

export const init = (config: BaseMenu.InitConfig): Model => ({
  menu: BaseMenu.init(config),
  rects: [],
  maybeHoverIndex: Option.none(),
});

// MESSAGE

// Tag is prefixed because this message is unioned with the base menu's own
// messages — a bare "GotItemRects" could collide with a future upstream tag.
export const GotItemRects = m("MenuGotItemRects", { rects: S.Array(Rect) });

export const Message = S.Union([BaseMenu.Message, GotItemRects]);
export type Message = typeof Message.Type;

// COMMAND

// Measures every item's layout rect relative to the group container (the
// offsetParent, since the group is position: relative). Runs after the
// panel has rendered, so the elements exist.
const MeasureItemRects = Command.define(
  "MeasureMenuItemRects",
  { id: S.String },
  GotItemRects,
)(({ id }) =>
  Effect.sync(() => {
    const rects: Array<Rect> = [];
    for (let index = 0; ; index++) {
      const element = document.getElementById(`${id}-item-${index}`);
      if (!(element instanceof HTMLElement)) break;
      rects.push(measureRect(element));
    }
    return GotItemRects({ rects });
  }),
);

// ITEM STYLING

export type MenuItemSpec = Readonly<{
  /** Leading icon slot (16px). Lucide by default — pass any icon view. */
  icon?: IconView;
  label: string;
  /** Trailing detail (a count, a shortcut hint). */
  detail?: string;
  isChecked?: boolean;
}>;

const checkIcon = icon(Check);

// No hover background on the item itself — the traveling overlay carries
// hover. Checked keeps its persistent `bg-active`.
const itemRow = (
  spec: MenuItemSpec,
  context: Readonly<{ isActive: boolean; isDisabled: boolean }>,
): BaseMenu.ItemConfig => {
  const h = html<never>();
  const isChecked = spec.isChecked === true;
  const isLifted = context.isActive || isChecked;

  return {
    className: `flex w-full cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] ${hoverTransition} ${
      isChecked ? "bg-active" : ""
    } ${isLifted ? "text-foreground" : "text-muted-foreground"}`,
    content: h.div(
      [h.Class("flex w-full items-center gap-2.5")],
      [
        spec.icon === undefined
          ? h.empty
          : spec.icon(`h-4 w-4 shrink-0 ${hoverTransition}`),
        weightLabel({
          label: spec.label,
          isBold: isChecked,
          className: "flex-1 text-left",
        }),
        spec.detail === undefined
          ? h.empty
          : h.span(
              [h.Class("text-[12px] text-muted-foreground")],
              [spec.detail],
            ),
        isChecked ? checkIcon("h-4 w-4 shrink-0", "2.5") : h.empty,
      ],
    ),
  };
};

// VIEW INPUTS

export type ViewInputs<Item extends string> = Readonly<{
  items: ReadonlyArray<Item>;
  itemSpec: (item: Item) => MenuItemSpec;
  buttonContent: Html;
  buttonClassName?: string;
  ariaLabel?: string;
  /** The surface level of the container the menu opens from. The panel
   *  settles at `substrate + 2`; its shadow stays pinned at level 3. */
  substrate: SurfaceLevel;
  /** Which way the panel opens; drives anchor placement and the motion
   *  origin. Defaults to "down". */
  opens?: "down" | "up";
  /** Literal width class for the panel. Defaults to "w-64". */
  widthClassName?: string;
}>;

const overlayView = (model: Model): Html => {
  const h = html<never>();
  return Option.match(model.maybeHoverIndex, {
    onNone: () => h.empty,
    onSome: (index) => {
      const rect = model.rects[index];
      if (rect === undefined) return h.empty;
      return h.div(
        [
          h.Class("fk-hover-overlay rounded-lg"),
          h.Style({
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }),
        ],
        [],
      );
    },
  });
};

const baseViewInputs = <Item extends string>(
  model: Model,
  viewInputs: ViewInputs<Item>,
): BaseMenu.ViewInputs<Item> => {
  const {
    items,
    itemSpec,
    buttonContent,
    buttonClassName = "",
    ariaLabel,
    substrate,
    opens = "down",
    widthClassName = "w-64",
  } = viewInputs;

  return {
    items,
    itemToConfig: (item, context) => itemRow(itemSpec(item), context),
    buttonContent,
    buttonClassName,
    ariaLabel,
    itemsClassName: `z-50 ${widthClassName} rounded-xl p-1 outline-none ${surface(
      elevate(substrate, POPOUT_OFFSET),
      3,
    )} ${opens === "down" ? popoutDown : popoutUp}`,
    itemsScrollClassName: "max-h-[min(480px,60vh)] overflow-y-auto",
    // One group wrapping every item, whose "heading" is the traveling
    // overlay: a zero-footprint (display: contents) slot that puts a real,
    // absolutely-positioned element inside the panel. The group is the
    // positioning context, so the overlay scrolls with the items.
    // overflow-clip: offset* rects are integer-rounded, so the overlay on
    // the last item can overhang the group's fractional height by a pixel —
    // unclipped, that overhang gives the scroll container a scrollbar.
    itemGroupKey: () => "items",
    groupToHeading: () => ({
      content: overlayView(model),
      className: "contents",
    }),
    groupClassName: "relative flex flex-col gap-0.5 overflow-clip",
    anchor: {
      placement: opens === "down" ? "bottom-start" : "top",
      gap: 6,
    },
  };
};

// CREATE

export const create = <Item extends string>() => {
  const base = BaseMenu.create<Item>();

  const update = (
    model: Model,
    message: Message,
  ): readonly [
    Model,
    ReadonlyArray<Command.Command<Message>>,
    Option.Option<BaseMenu.OutMessage<Item>>,
  ] => {
    if (message._tag === "MenuGotItemRects") {
      return [
        evo(model, { rects: () => [...message.rects] }),
        [],
        Option.none(),
      ];
    }

    const [menu, commands, maybeSelected] = base.update(model.menu, message);
    const isOpening = message._tag === "Opened";
    // Items can only be measured once the portaled panel is in the DOM,
    // which the base menu signals by completing its anchor command.
    const isPanelReady = message._tag === "CompletedAnchorMenu";

    return [
      evo(model, {
        menu: () => menu,
        // Stale rects from the previous open would misplace the overlay.
        rects: (rects) => (isOpening ? [] : rects),
        // Track the base menu's active item, but keep the last one when it
        // deactivates (pointer in the gap between items) — that persistence
        // is what removes the deadspace blink.
        maybeHoverIndex: (previous) =>
          Option.isSome(menu.maybeActiveItemIndex)
            ? menu.maybeActiveItemIndex
            : isOpening
              ? Option.none()
              : previous,
      }),
      [
        ...Command.mapMessages(commands, (message): Message => message),
        ...(isPanelReady ? [MeasureItemRects({ id: menu.id })] : []),
      ],
      maybeSelected,
    ];
  };

  const view = Submodel.defineView<Model, Message, ViewInputs<Item>>(
    (model, viewInputs): Html => {
      const h = html<Message>();
      return h.submodel({
        slotId: `${model.menu.id}-base`,
        model: model.menu,
        view: base.view,
        viewInputs: baseViewInputs(model, viewInputs),
        toParentMessage: (message: BaseMenu.Message): Message => message,
      });
    },
  );

  return { update, view } as const;
};
