import { html, type Html } from "foldkit/html";

/**
 * FoldkitUI · Loader — the braille dot spinner, replicated from
 * grixate/dot-loaders (the ten-frame U+2800 cycle) rather than depended on.
 *
 * The animation is entirely CSS (`.fk-braille` in styles.css): no model
 * state, no timer message, no per-frame re-render. That matters more here
 * than usual — this spins during the backfill, which is already the busiest
 * the app ever gets, and a 12.5Hz message loop would be competing with the
 * sync for the same main thread.
 *
 * Decorative by construction: the glyph is a pseudo-element, so it is not in
 * the accessibility tree and screen readers never read a spinner frame. The
 * surrounding label is what carries the meaning.
 */
export const brailleLoader = (className = ""): Html => {
  const h = html<never>();
  return h.span(
    [
      h.Class(`fk-braille inline-block leading-none tabular-nums ${className}`),
      h.AriaHidden(true),
    ],
    [],
  );
};
