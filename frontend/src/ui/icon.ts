import { Array as A, Option, Record as R } from "effect";
import type { IconNode } from "lucide";
import { html, type Html } from "foldkit/html";

/**
 * FoldkitUI · Icon — real lucide geometry without the React wrapper.
 *
 * Fluid Functionalism renders lucide-react behind a name→component registry
 * (size 16, strokeWidth 1.5 resting / 2 active). We take the same approach
 * one level lower: the framework-agnostic `lucide` package exports every
 * icon as pure data (`IconNode` — an array of `[tag, attrs]` tuples), and
 * `icon` renders any of them through the foldkit SVG DSL. Icons are sized
 * by utility classes and stroke weight is a parameter, so active/checked
 * states can lift to strokeWidth 2 the way FF does.
 */

type H = ReturnType<typeof html<never>>;

/** The SVG child elements lucide icons are drawn with. */
const svgElements = (h: H): Readonly<Record<string, H["path"]>> => ({
  path: h.path,
  circle: h.circle,
  rect: h.rect,
  line: h.line,
  polyline: h.polyline,
  polygon: h.polygon,
  ellipse: h.ellipse,
});

const iconChildren = (h: H, node: IconNode): ReadonlyArray<Html> =>
  A.getSomes(
    node.map(([tag, attrs]) =>
      R.get(svgElements(h), tag).pipe(
        Option.map((element) =>
          element(
            R.toEntries(attrs).map(([key, value]) =>
              h.Attribute(key, String(value)),
            ),
            [],
          ),
        ),
      ),
    ),
  );

/** Renders a lucide `IconNode` with FF's icon conventions: stroked in
 *  currentColor, sized by `className` (e.g. `size-4`), aria-hidden. */
export const icon =
  (node: IconNode) =>
  (className: string, strokeWidth = "2"): Html => {
    const h = html<never>();
    return h.svg(
      [
        h.ViewBox("0 0 24 24"),
        h.Fill("none"),
        h.Stroke("currentColor"),
        h.StrokeWidth(strokeWidth),
        h.StrokeLinecap("round"),
        h.StrokeLinejoin("round"),
        h.AriaHidden(true),
        h.Class(className),
      ],
      iconChildren(h, node),
    );
  };

/** Same geometry rendered solid — FF draws brand marks (e.g. the apple)
 *  with `fill` and no stroke. */
export const iconFilled =
  (node: IconNode) =>
  (className: string): Html => {
    const h = html<never>();
    return h.svg(
      [
        h.ViewBox("0 0 24 24"),
        h.Fill("currentColor"),
        h.Stroke("none"),
        h.AriaHidden(true),
        h.Class(className),
      ],
      iconChildren(h, node),
    );
  };

export type IconView = ReturnType<typeof icon>;
