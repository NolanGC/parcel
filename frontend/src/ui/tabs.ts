import { Tabs as BaseTabs } from "@foldkit/ui";
import { Array as Arr, Effect, Match as M, Option, Schema as S } from "effect";
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
 * Behavior rides @foldkit/ui's Tabs: roving tabindex, arrow/Home/End
 * navigation, the tab/tablist/tabpanel roles, `aria-selected`, and the
 * tab-to-panel id pairing all come from there. This module supplies visuals
 * only, plus the rect measurement the pills need — taken when the pointer
 * enters the container and again on selection, because keyboard activation
 * can commit a tab before any pointer has entered. Until the first
 * measurement the selected tab carries a static bg-active of its own, so the
 * initial render is correct before any interaction and the pill takes over at
 * the same geometry.
 *
 * The base component owns the tab id scheme (`${id}-tab-${index}`), which is
 * what `tabId` below re-derives to find the elements to measure.
 */

// MODEL

export const Model = S.Struct({
  base: BaseTabs.Model,
  id: S.String,
  /** The active tab's label. The base component is stateless about the
   *  selection — it reads it back from `ViewInputs.selectedValue` — so the
   *  wrapper is where it lives. */
  selectedValue: S.String,
  /** Bumped on each container entry; keys the hover overlay so a new
   *  session remounts it (snap + fade-in) instead of sliding in stale. */
  session: S.Number,
  isPointerInside: S.Boolean,
  maybeHoverIndex: S.Option(S.Number),
  rects: S.Array(Rect),
});
export type Model = typeof Model.Type;

export type InitConfig = Readonly<{ id: string; selectedValue: string }>;

export const init = (config: InitConfig): Model => ({
  base: BaseTabs.init({ id: config.id }),
  id: config.id,
  selectedValue: config.selectedValue,
  session: 0,
  isPointerInside: false,
  maybeHoverIndex: Option.none(),
  rects: [],
});

const tabId = (id: string, index: number): string => `${id}-tab-${index}`;

// MESSAGE

export const GotBaseMessage = m("GotBaseMessage", {
  message: BaseTabs.Message,
});
export const EnteredContainer = m("EnteredContainer", {
  tabCount: S.Number,
});
export const ExitedContainer = m("ExitedContainer");
export const EnteredTab = m("EnteredTab", { index: S.Number });
export const MeasuredTabRects = m("MeasuredTabRects", { rects: S.Array(Rect) });

export const Message = S.Union([
  GotBaseMessage,
  EnteredContainer,
  ExitedContainer,
  EnteredTab,
  MeasuredTabRects,
]);
export type Message = typeof Message.Type;

// COMMAND

const MeasureTabRects = Command.define(
  "MeasureTabRects",
  { id: S.String, count: S.Number },
  MeasuredTabRects,
)(({ count, id }) =>
  Effect.sync(() => {
    const rects: Array<Rect> = [];
    for (let index = 0; index < count; index++) {
      const element = document.getElementById(tabId(id, index));
      rects.push(
        element instanceof HTMLElement ? measureRect(element) : ZERO_RECT,
      );
    }
    return MeasuredTabRects({ rects });
  }),
);

// UPDATE

// The base component pairs its view and update behind one Value-typed entry
// point; labels are plain strings here, so `string` is the Value.
const BaseTabsView = BaseTabs.create<string>();

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>];

const withUpdateReturn = M.withReturnType<UpdateReturn>();

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      GotBaseMessage: ({ message }) => {
        const [base, commands, maybeSelected] = BaseTabsView.update(
          model.base,
          message,
        );
        const stepped = evo(model, { base: () => base });
        const mapped = Command.mapMessages(commands, (message) =>
          GotBaseMessage({ message }),
        );
        // A commit re-measures: keyboard activation can select a tab before
        // any pointer has entered the container, so without this the pill
        // would have no rects to travel between.
        return Option.match(maybeSelected, {
          onNone: (): UpdateReturn => [stepped, mapped],
          onSome: ({ value }) => [
            evo(stepped, { selectedValue: () => value }),
            [
              ...mapped,
              MeasureTabRects({ id: model.id, count: model.rects.length }),
            ],
          ],
        });
      },

      EnteredContainer: ({ tabCount }) => [
        evo(model, {
          session: (session) => session + 1,
          isPointerInside: () => true,
          maybeHoverIndex: () => Option.none(),
        }),
        [MeasureTabRects({ id: model.id, count: tabCount })],
      ],

      ExitedContainer: () => [
        evo(model, {
          isPointerInside: () => false,
          // Unlike Table rows, tabs keep a visible selected pill — the hover
          // pill clears on exit so only the selection remains.
          maybeHoverIndex: () => Option.none(),
        }),
        [],
      ],

      EnteredTab: ({ index }) => [
        evo(model, { maybeHoverIndex: () => Option.some(index) }),
        [],
      ],

      MeasuredTabRects: ({ rects }) => [
        evo(model, { rects: () => Arr.copy(rects) }),
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
  /** Names the tablist for screen readers; the base component requires it. */
  ariaLabel: string;
  className?: string;
}>;

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, viewInputs): Html => {
    const h = html<Message>();
    const { tabs, tabSpec, ariaLabel, className = "" } = viewInputs;
    const tabCount = tabs.length;
    const hoverIndex = Option.getOrNull(model.maybeHoverIndex);

    return h.submodel({
      slotId: `${model.id}-base`,
      model: model.base,
      view: BaseTabsView.view,
      viewInputs: {
        tabs,
        selectedValue: model.selectedValue,
        ariaLabel,
        toView: (render: BaseTabs.RenderInfo<string>): Html => {
          const maybeSelectedRect = Arr.get(model.rects, render.activeIndex);
          const isHoveringElsewhere =
            hoverIndex !== null && hoverIndex !== render.activeIndex;

          // Selected pill: moderate tier, dims while another tab is hovered.
          const selectedPill = Option.match(maybeSelectedRect, {
            onNone: () => h.empty,
            onSome: (selectedRect) =>
              h.div(
                [
                  h.Role("presentation"),
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
              ),
          });

          // Hover pill: the shared traveling-overlay treatment, suppressed
          // over the selected tab so the pills never stack.
          const hoverPill =
            hoverIndex === null || !isHoveringElsewhere
              ? h.empty
              : Option.match(Arr.get(model.rects, hoverIndex), {
                  onNone: () => h.empty,
                  onSome: (rect) =>
                    h.keyed("div")(
                      `hover-${model.session}`,
                      [
                        h.Role("presentation"),
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
                    ),
                });

          const tabViews = render.tabs.map((info) => {
            const tab = tabSpec(info.value);
            const isActive = info.isActive || hoverIndex === info.index;

            return h.button(
              [
                // The base bundle carries Id, Role, AriaSelected,
                // AriaControls, the roving tabindex, and the click/key
                // handlers — everything that makes this a real tab.
                ...info.tab,
                h.OnMouseEnter(EnteredTab({ index: info.index })),
                h.Class(
                  // Static bg-active stands in for the pill until rects exist.
                  `relative z-10 flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-3 outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${hoverTransition} ${
                    isActive ? "text-foreground" : "text-muted-foreground"
                  } ${
                    info.isActive && Option.isNone(maybeSelectedRect)
                      ? "bg-active"
                      : ""
                  }`,
                ),
              ],
              [
                tab.icon(
                  `h-[18px] w-[18px] shrink-0 ${tab.iconClass ?? ""}`,
                  isActive ? "2.25" : "1.75",
                ),
                weightLabel({ label: tab.label, isBold: info.isActive }),
                tab.detail === undefined
                  ? h.empty
                  : h.span([h.Class("text-muted-foreground/60")], [tab.detail]),
              ],
            );
          });

          const maybeActiveTab = Arr.get(render.tabs, render.activeIndex);

          return h.div(
            [h.Class("contents")],
            [
              h.div(
                [
                  ...render.tablist,
                  h.Class(`relative flex items-center gap-0.5 ${className}`),
                  h.OnMouseEnter(EnteredContainer({ tabCount })),
                  h.OnMouseLeave(ExitedContainer()),
                ],
                [selectedPill, hoverPill, ...tabViews],
              ),
              // The panel each tab's aria-controls points at. These tabs
              // filter a list that lives outside this submodel, so the panel
              // is an empty labelled region rather than a content container —
              // it exists so the tab-to-panel pairing resolves.
              Option.match(maybeActiveTab, {
                onNone: () => h.empty,
                onSome: (activeTab) =>
                  h.div([...activeTab.panel, h.Class("hidden")], []),
              }),
            ],
          );
        },
      },
      toParentMessage: (message: BaseTabs.Message) =>
        GotBaseMessage({ message }),
    });
  },
);
