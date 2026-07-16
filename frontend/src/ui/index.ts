/**
 * FoldkitUI — reusable, Fluid Functionalism–flavored building blocks for
 * foldkit views.
 *
 * The system in one breath: colors come from the 8-level surface ladder and
 * the surface-relative overlay states (surface.ts + styles.css); motion
 * comes from three spring tiers with faster exits (motion.ts); state changes
 * lift text weight without reflow (label.ts); components pick levels and
 * tiers, never raw colors or durations.
 */

export * from "./button";
export * from "./icon";
export * from "./label";
export * from "./motion";
export * from "./surface";
export * as Menu from "./menu";
export * as Table from "./table";
