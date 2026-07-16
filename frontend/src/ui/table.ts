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
  rects: S.Array(Rect),
});
export type Model = typeof Model.Type;

export type InitConfig = Readonly<{ id: string }>;

export const init = (config: InitConfig): Model => ({
  id: config.id,
  session: 0,
  isPointerInside: false,
  maybeRowIndex: Option.none(),
  rects: [],
});

const rowId = (id: string, index: number): string => `${id}-row-${index}`;

// MESSAGE

export const EnteredContainer = m("EnteredContainer", { rowCount: S.Number });
export const LeftContainer = m("LeftContainer");
export const EnteredRow = m("EnteredRow", { index: S.Number });
export const GotRowRects = m("GotRowRects", { rects: S.Array(Rect) });

export const Message = S.Union([
  EnteredContainer,
  LeftContainer,
  EnteredRow,
  GotRowRects,
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
          // of sliding from wherever the last session ended.
          maybeRowIndex: () => Option.none(),
        }),
        [MeasureRowRects({ id: model.id, count: rowCount })],
      ],

      LeftContainer: () => [evo(model, { isPointerInside: () => false }), []],

      EnteredRow: ({ index }) => [
        evo(model, { maybeRowIndex: () => Option.some(index) }),
        [],
      ],

      GotRowRects: ({ rects }) => [evo(model, { rects: () => [...rects] }), []],
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
        [h.Id(rowId(model.id, index)), h.OnMouseEnter(EnteredRow({ index }))],
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
            ...(model.isPointerInside ? [] : [h.DataAttribute("hidden", "")]),
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
