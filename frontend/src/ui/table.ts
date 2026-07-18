import { Effect, Option, Match as M, Schema as S } from "effect";
import { Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { evo } from "foldkit/struct";

import { measureRect, Rect, ZERO_RECT } from "./rect";

/**
 * FoldkitUI · Table — the Fluid Functionalism list/table hover treatment.
 *
 * Rows carry no hover style. Instead the container renders ONE absolutely
 * positioned `--hover` overlay that *travels* between row rects (fast tier:
 * 80ms position, 60ms exit fade). Panning across rows reads as continuous
 * motion instead of per-row background blinks — the highlight has object
 * permanence, which is what makes FF's tables feel high-fps.
 *
 * Mechanics (mirroring FF's `useProximityHover` + overlay):
 * - Entering the container starts a hover session: rects are measured
 *   through a Command (offsetTop/offsetLeft, so ancestor scroll and
 *   transforms don't skew them — the container is the offsetParent).
 * - Entering a row retargets the overlay; CSS transitions redirect from the
 *   in-flight position, so fast panning glides instead of restarting.
 * - Leaving the container keeps the overlay mounted and fades it out one
 *   tier faster (`data-hidden`); re-entering starts a fresh session so the
 *   overlay snaps to the new row and fades in (`@starting-style`).
 *
 * There is only one overlay, not one per input device. A caller can drive
 * it without a real pointer event via `KeyboardMoved` (j/k navigation) —
 * that claims the overlay and keeps it visible regardless of the pointer.
 * Only a genuine `EnteredRow` (actual mouse motion) hands control back, so
 * moving the mouse always wins over a stale keyboard position.
 *
 * The overlay visuals live in styles.css under `.fk-hover-overlay`.
 */

// MODEL

export const Model = S.Struct({
  id: S.String,
  /** Bumped on each container entry; keys the overlay so a new session
   *  remounts it (snap + fade-in) instead of sliding from a stale rect. */
  session: S.Number,
  isPointerInside: S.Boolean,
  /** The row under (or last under) the pointer. Kept on leave so the
   *  overlay can fade out in place. */
  maybeRowIndex: S.Option(S.Number),
  /** True once a keyboard move has claimed the overlay: it then stays
   *  visible at maybeRowIndex regardless of the pointer, until a real
   *  mouse-entered-row event reclaims it (see EnteredRow). */
  keyboardControlled: S.Boolean,
  rects: S.Array(Rect),
});
export type Model = typeof Model.Type;

export type InitConfig = Readonly<{ id: string }>;

export const init = (config: InitConfig): Model => ({
  id: config.id,
  session: 0,
  isPointerInside: false,
  maybeRowIndex: Option.none(),
  keyboardControlled: false,
  rects: [],
});

const rowId = (id: string, index: number): string => `${id}-row-${index}`;

// MESSAGE

export const EnteredContainer = m("EnteredContainer", { rowCount: S.Number });
export const LeftContainer = m("LeftContainer");
export const EnteredRow = m("EnteredRow", { index: S.Number });
/** A caller-driven move — j/k navigation, not a real pointer event. Claims
 *  the overlay for the keyboard; only an actual EnteredRow (real mouse
 *  motion) hands it back (see the module doc). */
export const KeyboardMoved = m("TableKeyboardMoved", {
  index: S.Number,
  rowCount: S.Number,
});
export const GotRowRects = m("GotRowRects", { rects: S.Array(Rect) });
/** A row was clicked, identified by its TableChild key. The Table itself
 *  has no opinion about what a click means — parents watch for this tag
 *  in their wrapper message (row content passed through viewInputs must
 *  stay inert: submodel inputs may not carry nested event handlers). */
export const ClickedRow = m("TableClickedRow", { key: S.String });

export const Message = S.Union([
  EnteredContainer,
  LeftContainer,
  EnteredRow,
  KeyboardMoved,
  GotRowRects,
  ClickedRow,
]);
export type Message = typeof Message.Type;

// COMMAND

// Measures every row's layout rect relative to the container (the
// offsetParent, since the container is position: relative — see ui/rect.ts
// for why offset* coords).
const MeasureRowRects = Command.define(
  "MeasureRowRects",
  { id: S.String, count: S.Number },
  GotRowRects,
)(({ count, id }) =>
  Effect.sync(() => {
    const rects: Array<Rect> = [];
    for (let index = 0; index < count; index++) {
      const element = document.getElementById(rowId(id, index));
      rects.push(
        element instanceof HTMLElement ? measureRect(element) : ZERO_RECT,
      );
    }
    return GotRowRects({ rects });
  }),
);

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>];

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      EnteredContainer: ({ rowCount }) => [
        evo(model, {
          session: (session) => session + 1,
          isPointerInside: () => true,
          // Cleared so the overlay stays unmounted until the first row is
          // entered — it then mounts at that row (snap + fade-in) instead
          // of sliding from wherever the last session ended. Skipped while
          // the keyboard holds the overlay: the pointer merely entering the
          // container's padding shouldn't blank a cursor it hasn't reclaimed.
          maybeRowIndex: () =>
            model.keyboardControlled ? model.maybeRowIndex : Option.none(),
        }),
        [MeasureRowRects({ id: model.id, count: rowCount })],
      ],

      LeftContainer: () => [evo(model, { isPointerInside: () => false }), []],

      // Real pointer motion always reclaims the overlay from the keyboard.
      EnteredRow: ({ index }) => [
        evo(model, {
          maybeRowIndex: () => Option.some(index),
          keyboardControlled: () => false,
        }),
        [],
      ],

      KeyboardMoved: ({ index, rowCount }) => [
        evo(model, {
          maybeRowIndex: () => Option.some(index),
          keyboardControlled: () => true,
        }),
        model.rects.length === rowCount
          ? []
          : [MeasureRowRects({ id: model.id, count: rowCount })],
      ],

      GotRowRects: ({ rects }) => [evo(model, { rects: () => [...rects] }), []],

      // Meaningful only to the parent (which intercepts it); the Table's
      // own hover state is untouched by a click.
      TableClickedRow: () => [model, []],
    }),
  );

// VIEW

/** One entry in the table: a hover-tracked row, or static content rendered
 *  between rows (section headers, separators) that the overlay glides past. */
export type TableChild =
  | Readonly<{ kind: "row"; key: string; content: Html }>
  | Readonly<{ kind: "static"; key: string; content: Html }>;

export type ViewInputs = Readonly<{
  children: ReadonlyArray<TableChild>;
  className?: string;
  /** Extra classes for the traveling overlay (e.g. a radius). */
  overlayClassName?: string;
}>;

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, viewInputs): Html => {
    const h = html<Message>();
    const { children, className = "", overlayClassName = "" } = viewInputs;

    const rowCount = children.filter((child) => child.kind === "row").length;

    let rowIndex = -1;
    const renderedChildren = children.map((child) => {
      if (child.kind === "static") {
        return h.keyed("div")(child.key, [], [child.content]);
      }
      rowIndex += 1;
      const index = rowIndex;
      return h.keyed("div")(
        child.key,
        [
          h.Id(rowId(model.id, index)),
          h.OnMouseEnter(EnteredRow({ index })),
          h.OnClick(ClickedRow({ key: child.key })),
        ],
        [child.content],
      );
    });

    const overlay = Option.match(model.maybeRowIndex, {
      onNone: () => h.empty,
      onSome: (index) => {
        const rect = model.rects[index];
        if (rect === undefined) return h.empty;
        return h.keyed("div")(
          `overlay-${model.session}`,
          [
            h.Class(`fk-hover-overlay ${overlayClassName}`),
            ...(model.isPointerInside || model.keyboardControlled
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
      },
    });

    return h.div(
      [
        h.Class(`relative ${className}`),
        h.OnMouseEnter(EnteredContainer({ rowCount })),
        h.OnMouseLeave(LeftContainer()),
      ],
      [overlay, ...renderedChildren],
    );
  },
);
