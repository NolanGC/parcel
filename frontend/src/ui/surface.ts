import { Schema as S } from "effect";

/**
 * FoldkitUI · Surfaces — the Fluid Functionalism 8-level elevation ladder.
 *
 * Elevation is communicated differently per theme: light mode flattens to
 * white after step 2 and lets the shadow carry depth; dark mode climbs an
 * additive white-opacity ladder. Components never pick colors — they pick a
 * *level*, and the CSS tokens (styles.css) resolve it per theme.
 *
 * Foldkit has no React-style context, so the substrate is an explicit
 * parameter: a view that opens a panel passes its own level, and the panel
 * computes `elevate(substrate, offset)`.
 *
 * The lookup tables hold literal class names because Tailwind's static
 * scanner can't see template-literal classes (`bg-surface-${n}` would never
 * generate the utility).
 */

/** A rung on the ladder: an integer 1–8, branded so arbitrary numbers can't
 *  pose as levels. Construct with `SurfaceLevel.make(n)` (validated) or let
 *  `elevate`/`surface` clamp free-form arithmetic onto the ladder. */
export const SurfaceLevel = S.Number.check(
  S.isInt(),
  S.isBetween({ minimum: 1, maximum: 8 }),
).pipe(S.brand("SurfaceLevel"));
export type SurfaceLevel = typeof SurfaceLevel.Type;

// `satisfies` keeps the maps exhaustive over the ladder; the wider indexable
// alias is safe because every index passing through `clamp` has been
// schema-validated onto 1–8.
type LadderStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const SURFACE_BG: Record<number, string> = {
  1: "bg-surface-1",
  2: "bg-surface-2",
  3: "bg-surface-3",
  4: "bg-surface-4",
  5: "bg-surface-5",
  6: "bg-surface-6",
  7: "bg-surface-7",
  8: "bg-surface-8",
} satisfies Record<LadderStep, string>;

const SURFACE_SHADOW: Record<number, string> = {
  1: "shadow-surface-1",
  2: "shadow-surface-2",
  3: "shadow-surface-3",
  4: "shadow-surface-4",
  5: "shadow-surface-5",
  6: "shadow-surface-6",
  7: "shadow-surface-7",
  8: "shadow-surface-8",
} satisfies Record<LadderStep, string>;

// Trusted construction: the arithmetic pins the value onto the ladder, and
// the schema's int/between checks verify it at runtime.
const clamp = (level: number): SurfaceLevel =>
  SurfaceLevel.make(Math.round(Math.max(1, Math.min(8, level))));

/** Background + shadow classes for a surface level. Pass a separate
 *  `shadowLevel` when the component should keep a constant shadow weight
 *  regardless of nesting — a popover reads `shadow-surface-3` whether it
 *  opens on the page or inside a dialog, even though its background tracks
 *  the substrate. */
export const surface = (
  bgLevel: number,
  shadowLevel: number = bgLevel,
): string =>
  `${SURFACE_BG[clamp(bgLevel)]} ${SURFACE_SHADOW[clamp(shadowLevel)]}`;

/** Steps above the current substrate, clamped to the ladder's ceiling. */
export const elevate = (substrate: number, offset: number): SurfaceLevel =>
  clamp(substrate + offset);

/** Conventional offsets (fluid-functionalism surfaces doc). */
export const POPOUT_OFFSET = 2;
export const DIALOG_OFFSET = 4;
