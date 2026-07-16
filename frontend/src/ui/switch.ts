import { html, type Html } from "foldkit/html";

/**
 * FoldkitUI · Switch — the Fluid Functionalism toggle, ported from the FF
 * Switch (34×20 track, 16px thumb with a 2px inset). The thumb is a pill
 * that stretches on hover (+2px) and squishes on press (+4px wide, −4px
 * tall); when checked it stays right-aligned, so the stretch grows leftward.
 * FF drives this with a spring — here the same geometry rides moderate-tier
 * CSS transitions (160ms), state via group-hover/group-active, so the whole
 * row is the pointer target just like FF's wrapper div.
 *
 * Stateless: `isChecked` comes from the parent model and the click sends
 * `onToggle` back up. Every geometry variant is a literal class string for
 * Tailwind's scanner.
 */

const TRACK_BASE =
  "relative h-5 w-[34px] shrink-0 rounded-full transition-colors duration-80 ease-out " +
  "group-focus-visible:ring-1 group-focus-visible:ring-focus-ring " +
  "group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background";

const THUMB_BASE =
  "absolute top-[2px] block h-4 rounded-full bg-white shadow-sm " +
  "transition-all duration-160 ease-out group-active:top-1 group-active:h-3";

// Unchecked: left edge pinned at the 2px inset; hover/press grow rightward.
const THUMB_OFF = "left-[2px] w-4 group-hover:w-[18px] group-active:w-5";

// Checked: right edge pinned at the far inset; hover/press grow leftward.
const THUMB_ON =
  "left-4 w-4 group-hover:left-[14px] group-hover:w-[18px] group-active:left-3 group-active:w-5";

export type SwitchConfig<Message> = Readonly<{
  label: string;
  isChecked: boolean;
  onToggle: Message;
  isDisabled?: boolean;
  className?: string;
}>;

export const switchToggle = <Message>(config: SwitchConfig<Message>): Html => {
  const h = html<Message>();
  const {
    label,
    isChecked,
    onToggle,
    isDisabled = false,
    className = "",
  } = config;

  return h.button(
    [
      h.Type("button"),
      h.Role("switch"),
      h.AriaChecked(isChecked),
      h.Class(
        `group flex cursor-pointer select-none items-center gap-2.5 outline-none ${
          isDisabled ? "pointer-events-none opacity-50" : ""
        } ${className}`,
      ),
      ...(isDisabled ? [h.Disabled(true)] : [h.OnClick(onToggle)]),
    ],
    [
      h.span(
        [h.Class(`${TRACK_BASE} ${isChecked ? "bg-focus-ring" : "bg-accent"}`)],
        [
          h.span(
            [h.Class(`${THUMB_BASE} ${isChecked ? THUMB_ON : THUMB_OFF}`)],
            [],
          ),
        ],
      ),
      h.span(
        [
          h.Class(
            `text-[13px] transition-colors duration-80 ease-out ${
              isChecked ? "text-foreground" : "text-muted-foreground"
            }`,
          ),
        ],
        [label],
      ),
    ],
  );
};
