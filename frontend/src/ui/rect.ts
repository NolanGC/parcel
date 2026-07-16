import { Schema as S } from "effect";

/**
 * FoldkitUI · Rect — the shared layout-rect schema for the traveling hover
 * overlays (Table, Menu). Both overlays must agree on this shape and on how
 * it's measured, since they share the `.fk-hover-overlay` CSS.
 *
 * Rects come from offset* values: relative to the positioned container
 * (the offsetParent), unaffected by ancestor scroll position or CSS
 * transforms — unlike getBoundingClientRect. The trade-off is that offset*
 * values are integer-rounded, so an overlay can overhang its container's
 * fractional height by a pixel; containers that scroll clip the overhang
 * with `overflow-clip` (see ui/menu.ts).
 */

export const Rect = S.Struct({
  top: S.Number,
  left: S.Number,
  width: S.Number,
  height: S.Number,
});
export type Rect = typeof Rect.Type;

export const ZERO_RECT: Rect = { top: 0, left: 0, width: 0, height: 0 };

/** Layout rect of an element relative to its offsetParent. */
export const measureRect = (element: HTMLElement): Rect => ({
  top: element.offsetTop,
  left: element.offsetLeft,
  width: element.offsetWidth,
  height: element.offsetHeight,
});
