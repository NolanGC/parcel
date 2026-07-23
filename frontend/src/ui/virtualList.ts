/**
 * FoldkitUI · VirtualList — re-export of @foldkit/ui's headless virtual list.
 *
 * The base handles windowing (only the visible slice plus overscan is
 * mounted), the scroll/resize subscription, and scroll-to-index. Consumers
 * draw their own row chrome via `itemToView` and, if they want one, their own
 * traveling hover overlay on top (the inbox does — see page/inbox.ts).
 */
export * from "@foldkit/ui/virtualList";
