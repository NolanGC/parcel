/** Convert raw email HTML to Markdown.
 *
 *  Total: never throws. Worst case on pathological input is `""`.
 *  Requires a DOM (`DOMParser`), so main thread only — not a worker. */
export function convert_string(html: string): string
