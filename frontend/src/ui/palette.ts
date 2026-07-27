import { Dialog as BaseDialog } from "@foldkit/ui";
import { Array as Arr, Effect, Match as M, Option, Schema as S } from "effect";
import { Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { evo } from "foldkit/struct";

import { icon, type IconNode, type IconView } from "./icon";
import { paletteBackdrop, palettePanel } from "./motion";
import { measureRect, Rect } from "./rect";
import { DIALOG_OFFSET, elevate, surface, type SurfaceLevel } from "./surface";
import { CommandIcon, Search01Icon } from "@hugeicons/core-free-icons";

/**
 * FoldkitUI · Palette — a ⌘K command palette composed from Fluid
 * Functionalism parts (FF ships no palette of its own):
 *
 * - Shell: FF's Dialog recipe — `substrate + 4` on the surface ladder, the
 *   slow-tier fade + scale-0.97 panel and backdrop from motion.ts — but
 *   anchored near the top of the viewport (Raycast-style) instead of
 *   centered, so results grow downward from a fixed input row.
 * - Results: ONE traveling `.fk-hover-overlay` carries the active state for
 *   both mouse and keyboard — arrows glide the highlight between rows
 *   exactly like panning does in Table/Menu.
 * - Labels: the active row lifts weight via `weightLabel`, no reflow.
 *
 * Behavior rides @foldkit/ui's Dialog (native <dialog>, focus trap, scroll
 * lock, Esc, animation lifecycle). This module does no matching: the parent
 * owns the query (`model.query`) and supplies `groups` already filtered and
 * ranked for it — the inbox's Search service. The view renders them in the
 * order given. DOM work is limited to re-measuring row rects (a Command,
 * same pattern as Menu). Items are plain strings, so this mirrors Menu's
 * `create<Item>()` factory: `update` returns the selected Item as an
 * out-value and closes itself.
 */

// MODEL

export const Model = S.Struct({
  dialog: BaseDialog.Model,
  query: S.String,
  /** Index into the flat filtered result list; mouse and arrows both move it. */
  activeIndex: S.Number,
  /** Bumped per open; keys the overlay so each open starts with a snap +
   *  fade-in instead of a slide from the previous session's rect. */
  session: S.Number,
  rects: S.Array(Rect),
});
export type Model = typeof Model.Type;

export type InitConfig = Readonly<{ id: string }>;

export const init = (config: InitConfig): Model => ({
  dialog: BaseDialog.init({
    id: config.id,
    isAnimated: true,
    // Focus lands in the query input as soon as the dialog opens.
    focusSelector: `#${config.id}-query`,
  }),
  query: "",
  activeIndex: 0,
  session: 0,
  rects: [],
});

const itemId = (id: string, index: number): string => `${id}-item-${index}`;

// MESSAGE

export const GotDialogMessage = m("GotDialogMessage", {
  message: BaseDialog.Message,
});
export const ChangedQuery = m("ChangedQuery", { query: S.String });
/** Arrow-key movement; `count` rides along because only the view knows the
 *  filtered result length. */
export const MovedActive = m("MovedActive", {
  delta: S.Number,
  count: S.Number,
});
export const PointedItem = m("PointedItem", { index: S.Number });
/** Click or Enter. The view resolves `activeIndex` to the concrete item, so
 *  update never needs to re-run the filter. */
export const SelectedItem = m("SelectedItem", { item: S.String });
export const MeasuredItemRects = m("MeasuredItemRects", {
  rects: S.Array(Rect),
});

export const Message = S.Union([
  GotDialogMessage,
  ChangedQuery,
  MovedActive,
  PointedItem,
  SelectedItem,
  MeasuredItemRects,
]);
export type Message = typeof Message.Type;

// COMMAND

// Measures the rendered result rows relative to the results container (the
// offsetParent). Row count is discovered by probing ids, so the command
// doesn't need to know the filter's output length.
export const MeasureItemRects = Command.define(
  "MeasureItemRects",
  { id: S.String },
  MeasuredItemRects,
)(({ id }) =>
  Effect.sync(() => {
    const rects: Array<Rect> = [];
    for (let index = 0; ; index++) {
      const element = document.getElementById(itemId(id, index));
      if (!(element instanceof HTMLElement)) break;
      rects.push(measureRect(element));
    }
    return MeasuredItemRects({ rects });
  }),
);

// VIEW INPUTS

export type PaletteItemSpec = Readonly<{
  icon?: IconView;
  /** Leading 28px avatar image; wins over `icon` when both are set. */
  avatarSrc?: string;
  label: string;
  /** Muted secondary line beside the label (sender, path, …). Squeezed
   *  before the label is when space runs out. */
  detail?: string;
  /** Trailing tag chip (category, kind) — a pill with a small icon. */
  tag?: Readonly<{ icon: IconView; label: string }>;
}>;

export type Group<Item extends string> = Readonly<{
  /** Empty renders no header — the shape for a single unlabeled result list. */
  label: string;
  items: ReadonlyArray<Item>;
}>;

export type ViewInputs<Item extends string> = Readonly<{
  groups: ReadonlyArray<Group<Item>>;
  itemSpec: (item: Item) => PaletteItemSpec;
  placeholder?: string;
  /** Shown when there are no items — the place a search error surfaces. */
  emptyLabel?: string;
  /** Surface level of the page under the palette; the panel settles at
   *  `substrate + 4` (dialog convention). */
  substrate: SurfaceLevel;
}>;

type FilteredGroup<Item extends string> = Readonly<{
  label: string;
  items: ReadonlyArray<Readonly<{ item: Item; flatIndex: number }>>;
}>;

// Numbers the rows so the overlay, the arrow keys, and ⌘1-9 all agree on
// what "the third result" means. The palette does no matching of its own —
// `groups` is already the answer to `model.query`.
const numberRows = <Item extends string>(
  groups: ReadonlyArray<Group<Item>>,
): ReadonlyArray<FilteredGroup<Item>> => {
  let flatIndex = 0;
  return groups.flatMap((group) =>
    Arr.isReadonlyArrayEmpty(group.items)
      ? []
      : [
          {
            label: group.label,
            items: group.items.map((item) => ({
              item,
              flatIndex: flatIndex++,
            })),
          },
        ],
  );
};

// CREATE

const searchIcon = icon(Search01Icon as IconNode);
const commandIcon = icon(CommandIcon as IconNode);

/** Bordered keycap chip (the mock's Kbd): reads as a physical key at any
 *  elevation because border and text ride the theme tokens. */
const kbd = (children: ReadonlyArray<Html | string>): Html => {
  const h = html<never>();
  return h.kbd(
    [
      h.Class(
        "inline-flex min-w-6 items-center justify-center rounded-md border border-border px-1.5 py-1 text-[11px] leading-none text-muted-foreground",
      ),
    ],
    children,
  );
};

export const create = <Item extends string>() => {
  type UpdateReturn = readonly [
    Model,
    ReadonlyArray<Command.Command<Message>>,
    Option.Option<Item>,
  ];

  const delegateDialog = (
    model: Model,
    result: ReturnType<typeof BaseDialog.update>,
  ): UpdateReturn => {
    const [dialog, commands] = result;
    return [
      evo(model, { dialog: () => dialog }),
      Command.mapMessages(commands, (message) => GotDialogMessage({ message })),
      Option.none(),
    ];
  };

  /** ⌘K semantics: opens with a fresh query, or closes when already open.
   *  Toggling (rather than re-opening) matters beyond UX — a re-open would
   *  reset state while the dialog's no-op open never re-fires the
   *  measurement trigger, stranding the overlay without rects. */
  const toggle = (model: Model): UpdateReturn =>
    model.dialog.isOpen
      ? delegateDialog(model, BaseDialog.close(model.dialog))
      : delegateDialog(
          evo(model, {
            query: () => "",
            activeIndex: () => 0,
            session: (session) => session + 1,
            rects: () => [],
          }),
          BaseDialog.open(model.dialog),
        );

  const withUpdateReturn = M.withReturnType<UpdateReturn>();

  const update = (model: Model, message: Message): UpdateReturn =>
    M.value(message).pipe(
      withUpdateReturn,
      M.tagsExhaustive({
        GotDialogMessage: ({ message }) => {
          const [dialog, commands] = BaseDialog.update(model.dialog, message);
          // Rows exist in the DOM once the show command completes; that's the
          // earliest correct moment to measure (same trigger discipline as
          // Menu's CompletedAnchorMenu).
          const isPanelReady = message._tag === "CompletedShowDialog";
          return [
            evo(model, { dialog: () => dialog }),
            [
              ...Command.mapMessages(commands, (message) =>
                GotDialogMessage({ message }),
              ),
              ...(isPanelReady
                ? [MeasureItemRects({ id: model.dialog.id })]
                : []),
            ],
            Option.none(),
          ];
        },

        ChangedQuery: ({ query }) => [
          evo(model, {
            query: () => query,
            activeIndex: () => 0,
          }),
          // Re-measure after the filtered list re-renders.
          [MeasureItemRects({ id: model.dialog.id })],
          Option.none(),
        ],

        MovedActive: ({ count, delta }) => {
          if (count === 0) return [model, [], Option.none()];
          // Clamped, not wrapped: Up at the top (or Down at the bottom) holds
          // still rather than jumping to the opposite end.
          const next = Math.max(
            0,
            Math.min(count - 1, model.activeIndex + delta),
          );
          return [evo(model, { activeIndex: () => next }), [], Option.none()];
        },

        PointedItem: ({ index }) => [
          evo(model, { activeIndex: () => index }),
          [],
          Option.none(),
        ],

        SelectedItem: ({ item }) => {
          const [next, commands] = delegateDialog(
            model,
            BaseDialog.close(model.dialog),
          );
          // Items originate from viewInputs.groups, so the string is a
          // round-tripped Item by construction.
          return [next, commands, Option.some(item as Item)];
        },

        MeasuredItemRects: ({ rects }) => [
          evo(model, { rects: () => Arr.copy(rects) }),
          [],
          Option.none(),
        ],
      }),
    );

  const view = Submodel.defineView<Model, Message, ViewInputs<Item>>(
    (model, viewInputs): Html => {
      const h = html<Message>();
      const {
        groups,
        itemSpec,
        placeholder = "Search…",
        emptyLabel = "No results",
        substrate,
      } = viewInputs;

      const filtered = numberRows(groups);
      const flat = filtered.flatMap((group) => group.items);
      const count = flat.length;
      const activeIndex = Math.min(model.activeIndex, Math.max(0, count - 1));

      const listboxId = `${model.dialog.id}-results`;
      const activeItemId =
        count === 0 ? undefined : itemId(model.dialog.id, activeIndex);

      const inputRow = h.div(
        [h.Class("flex h-12 items-center gap-3 border-b border-border px-5")],
        [
          searchIcon("h-[18px] w-[18px] shrink-0 text-muted-foreground"),
          h.input([
            h.Id(`${model.dialog.id}-query`),
            h.Type("text"),
            h.Value(model.query),
            h.Placeholder(placeholder),
            h.Autocomplete("off"),
            // Combobox semantics: the input owns the results list and
            // publishes which row the arrow keys have landed on. The visual
            // cue is the traveling overlay, which a screen reader can't see —
            // activedescendant is what makes the same state audible.
            h.Role("combobox"),
            h.AriaLabel(placeholder),
            h.AriaExpanded(count > 0),
            h.AriaControls(listboxId),
            h.AriaAutocomplete("list"),
            ...(activeItemId === undefined
              ? []
              : [h.AriaActiveDescendant(activeItemId)]),
            h.Class(
              // h-full + a fixed 24px line box: the caret's height is the
              // line-height, so an explicit leading well above the font size
              // keeps it from clipping regardless of the body's 100% leading.
              // outline-none is safe here: the dialog traps focus into this
              // input, so it is the only focusable thing on screen.
              "h-full w-full bg-transparent leading-6 text-foreground outline-none placeholder:text-muted-foreground/60",
            ),
            h.OnInput((query) => ChangedQuery({ query })),
            h.OnKeyDownPreventDefault((key, modifiers) => {
              if (key === "ArrowDown")
                return Option.some(MovedActive({ delta: 1, count }));
              if (key === "ArrowUp")
                return Option.some(MovedActive({ delta: -1, count }));
              // ⌘1…⌘9 jump-select the first nine results directly.
              if (modifiers.metaKey && key >= "1" && key <= "9") {
                const target = flat[Number(key) - 1];
                if (target !== undefined)
                  return Option.some(SelectedItem({ item: target.item }));
              }
              const active = flat[activeIndex];
              if (key === "Enter" && active !== undefined)
                return Option.some(SelectedItem({ item: active.item }));
              return Option.none();
            }),
          ]),
          kbd([commandIcon("h-3 w-3"), h.span([h.Class("ml-0.5")], ["K"])]),
        ],
      );

      const overlay = (() => {
        const rect = model.rects[activeIndex];
        if (count === 0 || rect === undefined) return h.empty;
        return h.keyed("div")(
          // Query in the key: each keystroke remounts the overlay so it
          // snaps to the new top result (fade-in) instead of visibly
          // sliding across the re-filtered list. Arrow keys and hover keep
          // the same key, so travel between rows still glides.
          `overlay-${model.session}-${model.query}`,
          [
            h.Role("presentation"),
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
      })();

      const itemRow = (item: Item, flatIndex: number): Html => {
        const spec = itemSpec(item);

        // Leading slot is a constant 24px box so labels align whether the
        // row leads with an avatar or an icon.
        const leading =
          spec.avatarSrc !== undefined
            ? h.img([
                h.Src(spec.avatarSrc),
                h.Alt(""),
                h.Class("h-6 w-6 shrink-0 rounded-full object-cover"),
              ])
            : h.span(
                [h.Class("flex h-6 w-6 shrink-0 items-center justify-center")],
                [
                  spec.icon === undefined
                    ? h.empty
                    : spec.icon("h-[18px] w-[18px] text-muted-foreground"),
                ],
              );

        // The traveling overlay is the ONLY active/hover signal. Text stays
        // at constant color and weight — lifting either on mouseover reads
        // as flicker when the pointer pans a dense list.
        return h.div(
          [
            h.Id(itemId(model.dialog.id, flatIndex)),
            h.Role("option"),
            h.AriaSelected(flatIndex === activeIndex),
            h.Class(
              "flex cursor-default items-center gap-3 rounded-lg px-3 py-1 text-foreground",
            ),
            h.OnMouseEnter(PointedItem({ index: flatIndex })),
            h.OnClick(SelectedItem({ item })),
          ],
          [
            leading,
            h.span(
              [h.Class("min-w-0 flex-1 truncate text-left")],
              [spec.label],
            ),
            spec.detail === undefined
              ? h.empty
              : h.span(
                  [
                    h.Class(
                      "min-w-0 max-w-[40%] shrink truncate text-[13px] text-muted-foreground",
                    ),
                  ],
                  [spec.detail],
                ),
            spec.tag === undefined
              ? h.empty
              : h.span(
                  [
                    h.Class(
                      "flex shrink-0 items-center gap-1.5 rounded-full bg-hover px-2.5 py-0.5 text-[12px] text-muted-foreground",
                    ),
                  ],
                  [spec.tag.icon("h-3.5 w-3.5", "2"), spec.tag.label],
                ),
            flatIndex < 9
              ? h.span(
                  [
                    h.Class(
                      "w-8 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/60",
                    ),
                  ],
                  [`⌘${flatIndex + 1}`],
                )
              : h.empty,
          ],
        );
      };

      // The listbox is rendered in both branches so `aria-controls` always
      // resolves to a live element; empty simply carries no options and the
      // status line announces why.
      const results = Arr.match(flat, {
        onEmpty: () =>
          h.div(
            [h.Class("px-5 py-10 text-center text-muted-foreground")],
            [
              h.div(
                [h.Id(listboxId), h.Role("listbox"), h.AriaLabel(placeholder)],
                [],
              ),
              h.div([h.Role("status")], [emptyLabel]),
            ],
          ),
        onNonEmpty: () =>
          h.div(
            [
              h.Id(listboxId),
              h.Role("listbox"),
              h.AriaLabel(placeholder),
              h.Class(
                "relative max-h-[min(480px,55vh)] overflow-y-auto px-2 pb-1.5 pt-1.5",
              ),
            ],
            [
              overlay,
              ...filtered.flatMap((group, groupIndex) => [
                // Groups after the first separate with a hairline rather
                // than stacking two labels against each other.
                ...(groupIndex === 0
                  ? []
                  : [
                      h.div(
                        [
                          h.Role("presentation"),
                          h.Class("mx-3 my-1.5 border-t border-border"),
                        ],
                        [],
                      ),
                    ]),
                group.label === ""
                  ? h.empty
                  : h.div(
                      [
                        h.Role("presentation"),
                        h.Class(
                          "px-3 pb-0.5 pt-1 text-[13px] text-muted-foreground/70",
                        ),
                      ],
                      [group.label],
                    ),
                ...group.items.map(({ item, flatIndex }) =>
                  itemRow(item, flatIndex),
                ),
              ]),
            ],
          ),
      });

      return h.submodel({
        slotId: `${model.dialog.id}-dialog`,
        model: model.dialog,
        view: BaseDialog.view,
        viewInputs: {
          toView: (render: BaseDialog.RenderInfo): Html =>
            h.dialog(
              [
                ...render.dialog,
                // NOTE: outline-none without a focus-visible: partner is
                // deliberate. The native <dialog> takes focus on open before
                // handing it to the query input; it is not a tab stop, so a
                // ring here would flash on open without marking anything the
                // user navigated to.
                h.Class("h-full w-full bg-transparent p-0 outline-none"),
              ],
              render.isVisible
                ? [
                    h.div(
                      [
                        ...render.backdrop,
                        h.Class(
                          `fixed inset-0 bg-black/40 dark:bg-black/80 ${paletteBackdrop}`,
                        ),
                      ],
                      [],
                    ),
                    h.div(
                      [
                        ...render.panel,
                        h.Class(
                          // Background sits at +1 rather than the dialog's
                          // usual +4: the palette reads best barely lifted
                          // off the page in dark mode (+4 and +2 were both
                          // too light a gray), and light mode barely
                          // registers the difference. The shadow keeps full
                          // dialog weight.
                          `fixed left-1/2 top-[16vh] w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl ${surface(
                            elevate(substrate, 1),
                            DIALOG_OFFSET,
                          )} ${palettePanel}`,
                        ),
                      ],
                      [inputRow, results],
                    ),
                  ]
                : [],
            ),
        },
        toParentMessage: (message: BaseDialog.Message) =>
          GotDialogMessage({ message }),
      });
    },
  );

  return { toggle, update, view } as const;
};
