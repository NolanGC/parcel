import { html, type Html } from "foldkit/html";

import { hoverTransition } from "./motion";

/**
 * FoldkitUI · Button — Fluid Functionalism button variants as foldkit view
 * helpers. Colors ride the surface-relative overlay tokens (bg-hover /
 * bg-active) so every variant works at any elevation; motion is the fast
 * tier (80ms color transitions); focus is the shared token ring.
 */

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg" | "icon-sm" | "icon";

const BASE =
  "inline-flex cursor-pointer items-center justify-center outline-none select-none disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-1 focus-visible:ring-focus-ring rounded-lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80",
  secondary: "bg-accent text-foreground hover:bg-accent/80 active:bg-accent",
  tertiary:
    "border border-border bg-transparent text-foreground hover:bg-hover active:bg-active",
  ghost:
    "bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground active:bg-active",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 gap-1 px-3 text-[12px]",
  md: "h-8 gap-1.5 px-4 text-[13px]",
  lg: "h-9 gap-1.5 px-5 text-[14px]",
  "icon-sm": "h-7 w-7 p-0",
  icon: "h-8 w-8 p-0",
};

/** The composed class string for a variant/size — for elements that render
 *  their own button (e.g. a Menu trigger) but should look like `button`. */
export const buttonClasses = (
  variant: ButtonVariant,
  size: ButtonSize,
): string => `${BASE} ${hoverTransition} ${VARIANT[variant]} ${SIZE[size]}`;

export type ButtonConfig<Message> = Readonly<{
  variant?: ButtonVariant;
  size?: ButtonSize;
  onClick?: Message;
  ariaLabel?: string;
  isDisabled?: boolean;
  className?: string;
}>;

export const button = <Message>(
  config: ButtonConfig<Message>,
  children: ReadonlyArray<Html | string>,
): Html => {
  const h = html<Message>();
  const {
    variant = "primary",
    size = "md",
    onClick,
    ariaLabel,
    isDisabled = false,
    className = "",
  } = config;

  return h.button(
    [
      h.Type("button"),
      h.Class(
        `${BASE} ${hoverTransition} ${VARIANT[variant]} ${SIZE[size]} ${className}`,
      ),
      ...(ariaLabel === undefined ? [] : [h.AriaLabel(ariaLabel)]),
      ...(isDisabled ? [h.Disabled(true)] : []),
      ...(onClick === undefined ? [] : [h.OnClick(onClick)]),
    ],
    children,
  );
};
