// Tidying the finished lines, without losing anyone's place.
//
// The serializer errs toward separation — a blank line before every block,
// whether or not the block turned out to be empty — because it's writing
// blind. What comes out is correct but loose: runs of blank lines where a
// layout table contributed nothing, a blank line at the top from the wrapper
// div, trailing space at the end of every paragraph.
//
// The catch is that quote regions, images and links are all recorded as line
// numbers, so deleting a line silently moves every one of them. Everything
// here therefore builds an old-line to new-line map and remaps the metadata
// through it, rather than editing the text and hoping.

import type { QuoteSpan } from "./serialize.ts";
import type { ZenImage, ZenLink } from "./types.ts";

/** Trailing whitespace is noise except when it's two spaces, which is a hard
 *  break — the difference between an address block and one run-on line. */
const trimRight = (line: string): string =>
  /\S {2,}$/.test(line) ? `${line.trimEnd()}  ` : line.trimEnd();

export type Postprocessed = Readonly<{
  markdown: string;
  spans: ReadonlyArray<QuoteSpan>;
  images: ReadonlyArray<ZenImage>;
  links: ReadonlyArray<ZenLink>;
  lines: ReadonlyArray<string>;
}>;

export const postprocess = (
  rawLines: ReadonlyArray<string>,
  spans: ReadonlyArray<QuoteSpan>,
  images: ReadonlyArray<ZenImage>,
  links: ReadonlyArray<ZenLink>,
): Postprocessed => {
  const trimmed = rawLines.map(trimRight);

  // `keptFor[old]` is the index the old line now occupies. A dropped line maps
  // to wherever its content moved *toward* — the next surviving line — so a
  // region that began on a blank line still starts at its first real line.
  const lines: Array<string> = [];
  const keptFor: Array<number> = [];

  for (const line of trimmed) {
    const isBlank = line.trim() === "";
    const previousBlank =
      lines.length === 0 || lines[lines.length - 1]?.trim() === "";
    if (isBlank && previousBlank) {
      keptFor.push(lines.length);
      continue;
    }
    keptFor.push(lines.length);
    lines.push(line);
  }

  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }

  const last = Math.max(0, lines.length - 1);
  const remap = (line: number): number =>
    Math.min(last, Math.max(0, keptFor[line] ?? last));

  return {
    markdown: lines.join("\n"),
    lines,
    spans: spans
      .map(
        (span): QuoteSpan => ({
          mark: span.mark,
          startLine: remap(span.startLine),
          endLine: remap(span.endLine),
        }),
      )
      .filter((span) => span.endLine >= span.startLine),
    images: images.map(
      (image): ZenImage => ({ ...image, line: remap(image.line) }),
    ),
    links: links.map((link): ZenLink => ({ ...link, line: remap(link.line) })),
  };
};
