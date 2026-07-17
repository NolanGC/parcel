import { html, type Html } from "foldkit/html";

/**
 * FoldkitUI · Badge — the Fluid Functionalism badge as foldkit view helpers.
 *
 * Two variants: `solid` tints its background with the badge color (15%
 * color-mix into the page background), `dot` is a bordered chip led by a
 * small colored indicator. Badge colors are content colors — like the
 * avatar tiles, they sit deliberately outside the surface token system, so
 * the palette is FF's literal hex values applied through inline style (the
 * classes stay token-driven).
 */

/** FF's badge palette (Tailwind 500s). `gray` is special-cased below: solid
 *  falls back to the accent token, dot to the muted text token, so a neutral
 *  badge tracks the theme instead of pinning a hex. */
export const BADGE_COLORS = {
  gray: "#a3a3a3",
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  yellow: "#eab308",
  lime: "#84cc16",
  green: "#22c55e",
  emerald: "#10b981",
  teal: "#14b8a6",
  cyan: "#06b6d4",
  blue: "#3b82f6",
  indigo: "#6366f1",
  violet: "#8b5cf6",
  purple: "#a855f7",
  fuchsia: "#d946ef",
  pink: "#ec4899",
  rose: "#f43f5e",
} as const;

export type BadgeColor = keyof typeof BADGE_COLORS;
export type BadgeVariant = "solid" | "dot";
export type BadgeSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center whitespace-nowrap rounded-md font-medium";

const VARIANT: Record<BadgeVariant, string> = {
  solid: "",
  dot: "border border-border text-foreground",
};

const SIZE: Record<BadgeSize, string> = {
  sm: "h-5 gap-1 px-2 text-[11px]",
  md: "h-6 gap-1.5 px-2.5 text-[12px]",
  lg: "h-7 gap-1.5 px-3 text-[13px]",
};

/** Indicator diameter per badge size (FF: 6/7/8px). Literal classes so
 *  Tailwind's scanner sees them. */
const DOT_SIZE: Record<BadgeSize, string> = {
  sm: "h-1.5 w-1.5",
  md: "h-[7px] w-[7px]",
  lg: "h-2 w-2",
};

const dotColor = (color: BadgeColor): string =>
  color === "gray" ? "var(--muted-foreground)" : BADGE_COLORS[color];

export type BadgeDotConfig = Readonly<{
  color: BadgeColor;
  size?: BadgeSize;
  ariaLabel?: string;
}>;

/** The dot indicator on its own — a standalone status mark (an unread row,
 *  a live signal) styled exactly like the leading dot of a `dot` badge. */
export const badgeDot = (config: BadgeDotConfig): Html => {
  const h = html();
  const { color, size = "md", ariaLabel } = config;

  return h.span(
    [
      h.Class(`shrink-0 rounded-full ${DOT_SIZE[size]}`),
      h.Style({ backgroundColor: dotColor(color) }),
      ...(ariaLabel === undefined ? [] : [h.AriaLabel(ariaLabel)]),
    ],
    [],
  );
};

export type BadgeConfig = Readonly<{
  variant?: BadgeVariant;
  size?: BadgeSize;
  color?: BadgeColor;
  className?: string;
}>;

export const badge = (
  config: BadgeConfig,
  children: ReadonlyArray<Html | string>,
): Html => {
  const h = html();
  const {
    variant = "solid",
    size = "md",
    color = "gray",
    className = "",
  } = config;

  const colorStyle: Record<string, string> =
    variant === "solid"
      ? color === "gray"
        ? { backgroundColor: "var(--accent)", color: "var(--foreground)" }
        : {
            color: "var(--foreground)",
            backgroundColor: `color-mix(in srgb, ${BADGE_COLORS[color]} 15%, var(--background))`,
          }
      : {};

  return h.span(
    [
      h.Class(`${BASE} ${VARIANT[variant]} ${SIZE[size]} ${className}`),
      h.Style(colorStyle),
    ],
    [
      ...(variant === "dot" ? [badgeDot({ color, size })] : []),
      h.span([], children),
    ],
  );
};
