import { Array as A, Option, Record as R } from "effect";
import { html, type Html } from "foldkit/html";

/**
 * FoldkitUI · Icon — HugeIcons stroke-rounded geometry, no React wrapper.
 *
 * `@hugeicons/core-free-icons` exports every icon as pure data: an array of
 * `[tag, attrs]` tuples, which is the same shape lucide used and so renders
 * through the foldkit SVG DSL the same way. The free set *is* the
 * stroke-rounded style, so there is no variant to select.
 *
 * Two adjustments the data needs. Its attribute keys are React props
 * (`strokeLinejoin`), which SVG spells kebab-case; and every path carries a
 * baked-in `stroke`/`strokeWidth`, which would override the root element and
 * make the weight unadjustable. Both are handled in `svgAttributes` below, so
 * icons stay sized by utility classes and weighted by a parameter — which is
 * what lets active/checked states lift to 2 the way Fluid Functionalism does.
 */

type H = ReturnType<typeof html<never>>;

/** One icon as `@hugeicons/core-free-icons` ships it. */
export type IconNode = ReadonlyArray<
  readonly [string, Readonly<Record<string, string | number>>]
>;

/** The SVG child elements these icons are drawn with. */
const svgElements = (h: H): Readonly<Record<string, H["path"]>> => ({
  path: h.path,
  circle: h.circle,
  rect: h.rect,
  line: h.line,
  polyline: h.polyline,
  polygon: h.polygon,
  ellipse: h.ellipse,
});

// `stroke` and `strokeWidth` are dropped rather than translated: they are
// baked into every path at the set's design weight, and a per-path value
// beats the root element's, so keeping them would make `strokeWidth` here
// silently do nothing. `key` is React bookkeeping and not an SVG attribute
// at all.
const DROPPED_ATTRIBUTES = new Set(["stroke", "strokeWidth", "key"]);

const kebabCase = (key: string): string =>
  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const svgAttributes = (h: H, attrs: Readonly<Record<string, unknown>>) =>
  R.toEntries(attrs)
    .filter(([key]) => !DROPPED_ATTRIBUTES.has(key))
    .map(([key, value]) => h.Attribute(kebabCase(key), String(value)));

const iconChildren = (h: H, node: IconNode): ReadonlyArray<Html> =>
  A.getSomes(
    node.map(([tag, attrs]) =>
      R.get(svgElements(h), tag).pipe(
        Option.map((element) => element(svgAttributes(h, attrs), [])),
      ),
    ),
  );

/** Renders an icon with FF's conventions: stroked in currentColor, sized by
 *  `className` (e.g. `size-4`), aria-hidden. The default weight is the one
 *  HugeIcons draws at, so icons look as designed unless a caller lifts them. */
export const icon =
  (node: IconNode) =>
  (className: string, strokeWidth = "1.5"): Html => {
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

export type IconView = ReturnType<typeof icon>;
