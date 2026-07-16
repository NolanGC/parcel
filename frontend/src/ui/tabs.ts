import { Effect, Option, Match as M, Schema as S } from "effect";
import { Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { evo } from "foldkit/struct";

import type { IconView } from "./icon";
import { weightLabel } from "./label";
import { hoverTransition } from "./motion";
import { measureRect, Rect, ZERO_RECT } from "./rect";

/**
 * FoldkitUI · Tabs — the Fluid Functionalism "subtle" tabs. Two traveling
 * pills under the tab labels:
 *
 * - The SELECTED pill (bg-active, moderate tier: 160ms) slides between tabs
 *   on selection and dims to 80% while another tab is hovered.
 * - The HOVER pill is the same `.fk-hover-overlay` treatment as Table/Menu
 *   (fast tier), suppressed while the pointer is on the selected tab so the
 *   two pills never stack.
 *
 * Labels lift weight on selection through `weightLabel` (no reflow) and
 * icons thicken their stroke — color/weight carry state, never new hues.
 *
 * Rects are measured when the pointer enters the container (same Command
 * pattern as Table). Until the first measurement the selected tab carries a
 * static bg-active of its own, so the initial render is correct before any
 * pointer interaction; the pill takes over seamlessly at the same geometry.
 */

// MODEL

export const Model = S.Struct({
  id: S.String,
  selectedIndex: S.Number,
  /** Bumped on each container entry; keys the hover overlay so a new
   *  session remounts it (snap + fade-in) instead of sliding in stale. */
  session: S.Number,
  isPointerInside: S.Boolean,
  maybeHoverIndex: S.Option(S.Number),
  rects: S.Array(Rect),
});
export type Model = typeof Model.Type;

export type InitConfig = Readonly<{ id: string; selectedIndex?: number }>;

export const init = (config: InitConfig): Model => ({
  id: config.id,
  selectedIndex: config.selectedIndex ?? 0,
  session: 0,
  isPointerInside: false,
  maybeHoverIndex: Option.none(),
  rects: [],
});

const tabId = (id: string, index: number): string => `${id}-tab-${index}`;

// MESSAGE

export const EnteredContainer = m("TabsEnteredContainer", {
  tabCount: S.Number,
});
export const LeftContainer = m("TabsLeftContainer");
export const EnteredTab = m("TabsEnteredTab", { index: S.Number });
export const ClickedTab = m("TabsClickedTab", {
  index: S.Number,
  tabCount: S.Number,
});
export const GotTabRects = m("TabsGotTabRects", { rects: S.Array(Rect) });

export const Message = S.Union([
  EnteredContainer,
  LeftContainer,
  EnteredTab,
  ClickedTab,
  GotTabRects,
]);
export type Message = typeof Message.Type;

// COMMAND

const MeasureTabRects = Command.define(
  "MeasureTabRects",
  { id: S.String, count: S.Number },
  GotTabRects,
)(({ count, id }) =>
  Effect.sync(() => {
    const rects: Array<Rect> = [];
    for (let index = 0; index < count; index++) {
      const element = document.getElementById(tabId(id, index));
      rects.push(
        element instanceof HTMLElement ? measureRect(element) : ZERO_RECT,
      );
    }
    return GotTabRects({ rects });
  }),
);

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>];

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      TabsEnteredContainer: ({ tabCount }) => [
        evo(model, {
          session: (session) => session + 1,
          isPointerInside: () => true,
          maybeHoverIndex: () => Option.none(),
        }),
        [MeasureTabRects({ id: model.id, count: tabCount })],
      ],

      TabsLeftContainer: () => [
        evo(model, {
          isPointerInside: () => false,
          // Unlike Table rows, tabs keep a visible selected pill — the hover
          // pill clears on exit so only the selection remains.
          maybeHoverIndex: () => Option.none(),
        }),
        [],
      ],

      TabsEnteredTab: ({ index }) => [
        evo(model, { maybeHoverIndex: () => Option.some(index) }),
        [],
      ],

      // Keyboard activation can land before any pointer entry, so selection
      // re-measures — with fresh rects the pill animates to the new tab.
      TabsClickedTab: ({ index, tabCount }) => [
        evo(model, { selectedIndex: () => index }),
        [MeasureTabRects({ id: model.id, count: tabCount })],
      ],

      TabsGotTabRects: ({ rects }) => [
        evo(model, { rects: () => [...rects] }),
        [],
      ],
    }),
  );

// VIEW

export type TabSpec = Readonly<{
  icon: IconView;
  label: string;
  /** Trailing detail (a count). */
  detail?: string;
  /** Content color for the icon (category accents are not theme tokens). */
  iconClass?: string;
}>;

// `tabs` carries primitive labels and `tabSpec` resolves each to its icon
// and detail — functions may only sit at the top level of viewInputs (the
// submodel boundary auto-scopes them there), so the specs can't ride inside
// the array. Same shape as Menu's items/itemSpec.
export type ViewInputs = Readonly<{
  tabs: ReadonlyArray<string>;
  tabSpec: (label: string) => TabSpec;
  className?: string;
}>;

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, viewInputs): Html => {
    const h = html<Message>();
    const { tabs, tabSpec, className = "" } = viewInputs;
    const tabCount = tabs.length;

    const selectedRect = model.rects[model.selectedIndex];
    const hoverIndex = Option.getOrNull(model.maybeHoverIndex);
    const isHoveringElsewhere =
      hoverIndex !== null && hoverIndex !== model.selectedIndex;

    // Selected pill: moderate tier, dims while another tab is hovered.
    const selectedPill =
      selectedRect === undefined
        ? h.empty
        : h.div(
            [
              h.Class(
                `pointer-events-none absolute rounded-lg bg-active transition-all duration-160 ease-out ${
                  isHoveringElsewhere ? "opacity-80" : ""
                }`,
              ),
              h.Style({
                top: `${selectedRect.top}px`,
                left: `${selectedRect.left}px`,
                width: `${selectedRect.width}px`,
                height: `${selectedRect.height}px`,
              }),
            ],
            [],
          );

    // Hover pill: the shared traveling-overlay treatment, suppressed over
    // the selected tab so the pills never stack.
    const hoverPill =
      hoverIndex === null || !isHoveringElsewhere
        ? h.empty
        : (() => {
            const rect = model.rects[hoverIndex];
            if (rect === undefined) return h.empty;
            return h.keyed("div")(
              `hover-${model.session}`,
              [
                h.Class("fk-hover-overlay rounded-lg"),
                ...(model.isPointerInside
                  ? []
                  : [h.DataAttribute("hidden", "")]),
                h.Style({
                  top: `${rect.top}px`,
                  left: `${rect.left}px`,
                  width: `${rect.width}px`,
                  height: `${rect.height}px`,
                }),
              ],
              [],
            );
          })();

    const tabViews = tabs.map((label, index) => {
      const tab = tabSpec(label);
      const isSelected = index === model.selectedIndex;
      const isActive = isSelected || hoverIndex === index;

      return h.button(
        [
          h.Type("button"),
          h.Id(tabId(model.id, index)),
          h.Role("tab"),
          h.AriaSelected(isSelected),
          h.OnMouseEnter(EnteredTab({ index })),
          h.OnClick(ClickedTab({ index, tabCount })),
          h.Class(
            // Static bg-active stands in for the pill until rects exist.
            `relative z-10 flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-3 outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${hoverTransition} ${
              isActive ? "text-foreground" : "text-muted-foreground"
            } ${isSelected && selectedRect === undefined ? "bg-active" : ""}`,
          ),
        ],
        [
          tab.icon(
            `h-[18px] w-[18px] shrink-0 ${tab.iconClass ?? ""}`,
            isActive ? "2.25" : "1.75",
          ),
          weightLabel({ label: tab.label, isBold: isSelected }),
          tab.detail === undefined
            ? h.empty
            : h.span([h.Class("text-muted-foreground/60")], [tab.detail]),
        ],
      );
    });

    return h.div(
      [
        h.Class(`relative flex items-center gap-0.5 ${className}`),
        h.Role("tablist"),
        h.OnMouseEnter(EnteredContainer({ tabCount })),
        h.OnMouseLeave(LeftContainer()),
      ],
      [selectedPill, hoverPill, ...tabViews],
    );
  },
);
