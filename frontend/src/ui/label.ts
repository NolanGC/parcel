import { html, type Html } from "foldkit/html";

/**
 * FoldkitUI · Typography — Geist variable weight tokens and the ghost-span
 * pattern for animating font weight without reflow.
 *
 * A heavier weight is wider; animating it on a bare text node shifts layout.
 * `weightLabel` stacks two grid spans: an invisible copy at the heaviest
 * weight reserves the width, while the visible copy animates
 * `font-variation-settings`. Geist exposes only the `wght` axis; `normal`
 * matches the body's Medium base weight.
 */

export const fontWeights = {
  normal: "'wght' 500",
  medium: "'wght' 500",
  semibold: "'wght' 600",
  bold: "'wght' 700",
} as const;

/** A label whose weight animates between normal and semibold (80ms) without
 *  shifting the layout around it. */
export const weightLabel = (config: {
  label: string;
  isBold: boolean;
  className?: string;
}): Html => {
  const h = html<never>();
  const { label, isBold, className = "" } = config;

  return h.span(
    [h.Class(`inline-grid ${className}`)],
    [
      // Invisible bold sizer: reserves the widest layout.
      h.span(
        [
          h.Class("col-start-1 row-start-1 invisible"),
          h.Style({ fontVariationSettings: fontWeights.semibold }),
          h.AriaHidden(true),
        ],
        [label],
      ),
      h.span(
        [
          h.Class(
            "col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80",
          ),
          h.Style({
            fontVariationSettings: isBold
              ? fontWeights.semibold
              : fontWeights.normal,
          }),
        ],
        [label],
      ),
    ],
  );
};
