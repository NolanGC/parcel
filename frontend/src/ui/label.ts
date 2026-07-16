import { html, type Html } from "foldkit/html";

/**
 * FoldkitUI · Typography — Inter variable weight tokens and the ghost-span
 * pattern for animating font weight without reflow.
 *
 * A heavier weight is wider; animating it on a bare text node shifts layout.
 * `weightLabel` stacks two grid spans: an invisible copy at the heaviest
 * weight reserves the width, while the visible copy animates
 * `font-variation-settings`. Each weight pairs a tighter optical size so the
 * advance width barely changes (FF holds the delta to ~±0.5px).
 */

export const fontWeights = {
  normal: "'wght' 400, 'opsz' 14",
  medium: "'wght' 450, 'opsz' 15",
  semibold: "'wght' 550, 'opsz' 20",
  bold: "'wght' 700, 'opsz' 25",
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
