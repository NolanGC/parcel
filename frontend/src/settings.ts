// The display settings: how the app is lit (appearance) and which rendition
// of a message is displayed (reading mode). Both are read pre-boot the same
// way the session and the list snapshot are (services/preferences.ts), which
// owns the localStorage persistence. This file keeps the schemas, the
// defaults, and the synchronous DOM-side effect (pinAppearance).

import { Schema as S } from "effect";
import { m } from "foldkit/message";

/**
 *   System  Follow the OS, and keep following it as it changes.
 *   Light   Pinned, whatever the OS is doing.
 *   Dark    Likewise.
 */
export const Appearance = S.Literals(["System", "Light", "Dark"]);
export type Appearance = typeof Appearance.Type;

export const DEFAULT_APPEARANCE: Appearance = "System";

/**
 *   html      The sender's own markup, sanitized and shown on the white it
 *             was written for. What the mail actually looks like, and the
 *             default.
 *   markdown  Our conversion of it: the sender's stylesheet is gone, so it
 *             follows the app's theme and reads like the rest of the window.
 */
export const ReadingMode = S.Literals(["html", "markdown"]);
export type ReadingMode = typeof ReadingMode.Type;

export const DEFAULT_READING_MODE: ReadingMode = "html";

export const APPEARANCE_STORAGE_KEY = "parcel-appearance";
export const READING_MODE_STORAGE_KEY = "parcel-reading-mode";

export const CompletedSettingsPersistence = m("CompletedSettingsPersistence");

/**
 * Pin the appearance on `<html>`.
 *
 * The class is the whole mechanism: the `light-dark()` tokens resolve against
 * the element's `color-scheme`, which `.light` / `.dark` set (styles.css).
 * `System` is the ABSENCE of both, which is why this removes before it adds.
 *
 * A plain function rather than something only the page's Command can do,
 * because boot has to do it too and has to do it synchronously — a remembered
 * appearance applied one frame late is a flash of the wrong theme on every
 * single load.
 */
export const pinAppearance = (appearance: Appearance): void => {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (appearance === "Light") {
    root.classList.add("light");
  }
  if (appearance === "Dark") {
    root.classList.add("dark");
  }
};
