import { Popover as BasePopover } from "@foldkit/ui";
import { Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";

import { popoutDown, popoutUp } from "./motion";
import { elevate, POPOUT_OFFSET, surface, type SurfaceLevel } from "./surface";

/**
 * FoldkitUI · Popover — Fluid Functionalism dressing for @foldkit/ui's
 * headless Popover: an arbitrary trigger with a free-form floating panel.
 * The panel wears the same popout recipe as Menu's (`substrate + 2` on the
 * surface ladder, shadow pinned at 3, fast-tier enter/exit), so a popover
 * and a menu opening side by side read as the same species.
 *
 * The behavior (anchoring, focus, blur-to-close, Esc, animation lifecycle)
 * is entirely the base submodel's; model and update pass straight through.
 * Panel content arrives as a top-level `toPanelContent` function so
 * interactive Html stays inside the parent's dispatch boundary (the same
 * contract as the base Dialog/Popover `toView`).
 */

export const Model = BasePopover.Model;
export type Model = typeof BasePopover.Model.Type;

export const Message = BasePopover.Message;
export type Message = typeof BasePopover.Message.Type;

export type OutMessage = BasePopover.OutMessage;

export const init = BasePopover.init;
export const update = BasePopover.update;
export const close = BasePopover.close;

// VIEW INPUTS

export type ViewInputs = Readonly<{
  /** Trigger content — static Html; the base popover renders the button
   *  element (and its ARIA/keyboard wiring) around it. */
  buttonContent: Html;
  buttonClassName?: string;
  ariaLabel?: string;
  /** The surface level of the container the popover opens from. The panel
   *  settles at `substrate + 2`; its shadow stays pinned at level 3. */
  substrate: SurfaceLevel;
  /** Which way the panel opens; drives anchor placement and the motion
   *  origin. Defaults to "down". */
  opens?: "down" | "up";
  /** Literal width class for the panel. Defaults to "w-64". */
  widthClassName?: string;
  toPanelContent: () => Html;
}>;

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, viewInputs): Html => {
    const h = html<Message>();
    const {
      buttonContent,
      buttonClassName = "",
      ariaLabel,
      substrate,
      opens = "down",
      widthClassName = "w-64",
      toPanelContent,
    } = viewInputs;

    return h.submodel({
      slotId: `${model.id}-base`,
      model,
      view: BasePopover.view,
      viewInputs: {
        anchor: {
          placement: opens === "down" ? "bottom-end" : "top-end",
          gap: 6,
        },
        ...(ariaLabel === undefined ? {} : { ariaLabel }),
        toView: (render: BasePopover.RenderInfo): Html =>
          h.div(
            [],
            [
              h.button(
                [...render.button, h.Class(buttonClassName)],
                [buttonContent],
              ),
              ...(render.isVisible
                ? [
                    h.div(
                      [
                        ...render.panel,
                        // z-50: anchored panels portal ahead of the app root
                        // and would paint under it otherwise.
                        h.Class(
                          `z-50 ${widthClassName} rounded-xl p-1 outline-none ${surface(
                            elevate(substrate, POPOUT_OFFSET),
                            3,
                          )} ${opens === "down" ? popoutDown : popoutUp}`,
                        ),
                      ],
                      [toPanelContent()],
                    ),
                  ]
                : []),
            ],
          ),
      },
      toParentMessage: (message: BasePopover.Message): Message => message,
    });
  },
);
