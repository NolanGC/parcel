/**
 * FoldkitUI · Motion — the Fluid Functionalism spring tiers as CSS classes.
 *
 * Three speeds cover the whole library ("the bigger the thing that moves,
 * the slower the spring"), and exits are one tier quicker than enters so a
 * dismissal reads as crisp and final rather than replaying the entrance in
 * reverse:
 *
 *   fast      80ms enter /  60ms exit — hover, fades, tooltips, popout panels
 *   moderate 160ms enter / 120ms exit — dropdown highlight, tabs, switches
 *   slow     240ms enter / 160ms exit — dialogs, side panels
 *
 * Foldkit's Animation lifecycle drives these through data attributes
 * (`data-closed`, `data-enter`, `data-leave`), so the exits-are-faster rule
 * holds by construction: the leave duration is baked into the class recipe.
 *
 * Every class string is a literal so Tailwind's scanner sees it. No view
 * hand-writes a duration — always compose from these tokens.
 */

/** Color/opacity hover transitions (fast tier). */
export const hoverTransition = "transition-colors duration-80 ease-out";

/** Fast-tier fade for elements that only change opacity. */
export const fadeTransition =
  "transition-opacity duration-80 ease-out data-[leave]:duration-60";

/** Popout panel opening downward from its trigger (dropdown, select).
 *  Enter: fade + 4px rise + subtle vertical settle, 80ms ease-out.
 *  Leave: 60ms, no bounce. Matches FF's DropdownContent choreography. */
export const popoutDown =
  "origin-top transition duration-80 ease-out data-[closed]:opacity-0 data-[closed]:-translate-y-1 data-[closed]:scale-y-[0.96] data-[leave]:duration-60 data-[leave]:ease-in";

/** Popout panel opening upward from its trigger (dock menus). */
export const popoutUp =
  "origin-bottom transition duration-80 ease-out data-[closed]:opacity-0 data-[closed]:translate-y-1 data-[closed]:scale-y-[0.96] data-[leave]:duration-60 data-[leave]:ease-in";

/** Command palette panel (moderate tier): a palette is summoned dozens of
 *  times a session, so it enters a tier quicker than a full dialog. */
export const palettePanel =
  "transition duration-160 ease-out data-[closed]:opacity-0 data-[closed]:scale-[0.98] data-[leave]:duration-120 data-[leave]:ease-in";

/** Command palette backdrop (moderate tier). */
export const paletteBackdrop =
  "transition-opacity duration-160 ease-out data-[closed]:opacity-0 data-[leave]:duration-120";

/** Dialog panel (slow tier): fade + scale from 0.97. */
export const dialogPanel =
  "transition duration-240 ease-out data-[closed]:opacity-0 data-[closed]:scale-[0.97] data-[leave]:duration-160 data-[leave]:ease-in";

/** Dialog backdrop (slow tier): plain fade. */
export const dialogBackdrop =
  "transition-opacity duration-240 ease-out data-[closed]:opacity-0 data-[leave]:duration-160";
