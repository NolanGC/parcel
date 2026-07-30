// Splitting converted markdown at its foldable boundaries.
//
// Shared by the dashboard and the screenshot tool, because both are making the
// same claim: that the line ranges Zen reports are sufficient to build a
// reading UI on. If a region is off by a line, it shows up in either one as a
// sentence on the wrong side of the fold.

import { renderMarkdown } from "@foldkit/zen";

export type Section = Readonly<{
  kind: "content" | "fold" | "set";
  foldKind?: string;
  summary?: string;
  html: string;
  /** Sets only: how the sender laid the units out, and each unit's own html.
   *  `html` stays filled with the units run together, so a consumer that
   *  doesn't know about sets still shows every word. */
  axis?: "row" | "column";
  units?: ReadonlyArray<string>;
}>;

export type Region = Readonly<{
  kind: string;
  startLine: number;
  endLine: number;
  attribution?: string;
}>;

/** One unit of a set, as Zen reports it. */
export type GroupUnit = Readonly<{
  group: number;
  index: number;
  size: number;
  axis: "row" | "column";
  startLine: number;
  endLine: number;
}>;

const summaryFor = (region: Region): string => {
  if (region.attribution !== undefined) return region.attribution;
  if (region.kind === "footer") return "legal, licences and unsubscribe";
  if (region.kind === "placeholder") return "unfinished template block";
  return `quoted (${region.kind})`;
};

/** The units of one set, collected into the span they cover together. */
type SetSpan = Readonly<{
  startLine: number;
  endLine: number;
  axis: "row" | "column";
  units: ReadonlyArray<GroupUnit>;
}>;

const setSpans = (groups: ReadonlyArray<GroupUnit>): ReadonlyArray<SetSpan> => {
  const byId = new Map<number, Array<GroupUnit>>();
  for (const unit of groups) {
    const existing = byId.get(unit.group);
    if (existing === undefined) byId.set(unit.group, [unit]);
    else existing.push(unit);
  }

  return [...byId.values()].map((units) => {
    const ordered = [...units].sort((a, b) => a.index - b.index);
    return {
      startLine: Math.min(...ordered.map((unit) => unit.startLine)),
      endLine: Math.max(...ordered.map((unit) => unit.endLine)),
      axis: ordered[0]?.axis ?? "column",
      units: ordered,
    };
  });
};

export const sectionsOf = (
  markdown: string,
  quotes: ReadonlyArray<Region>,
  boilerplate: ReadonlyArray<Region>,
  groups: ReadonlyArray<GroupUnit> = [],
): ReadonlyArray<Section> => {
  const lines = markdown.split("\n");
  const render = (from: number, to: number): string =>
    renderMarkdown(lines.slice(from, to + 1).join("\n"));

  const folds = [...quotes, ...boilerplate];

  // A fold wins over a set that runs into it — both are ranges over the same
  // markdown, and a card drawn half inside a collapsed footer would appear
  // twice. Clipped rather than discarded, because the overlap is usually one
  // line: the footer's backward reach absorbs a trailing "Read more", which is
  // a link-only line short enough to look like footer furniture, and dropping
  // the whole set over that would hide two real cards.
  const clip = (span: SetSpan): SetSpan | undefined => {
    const limit = Math.min(
      ...folds
        .filter((fold) => fold.startLine > span.startLine)
        .map((fold) => fold.startLine - 1),
      span.endLine,
    );
    const units = span.units
      .filter((unit) => unit.startLine <= limit)
      .map((unit) => ({ ...unit, endLine: Math.min(unit.endLine, limit) }));
    if (units.length < 2) return undefined;
    return { ...span, endLine: limit, units };
  };

  const ordered = [
    ...folds.map((region) => ({
      region,
      set: undefined as SetSpan | undefined,
    })),
    ...setSpans(groups)
      .map(clip)
      .filter((span): span is SetSpan => span !== undefined)
      .map((set) => ({ region: undefined, set })),
  ].sort(
    (a, b) =>
      (a.region?.startLine ?? a.set?.startLine ?? 0) -
      (b.region?.startLine ?? b.set?.startLine ?? 0),
  );

  const sections: Array<Section> = [];
  let cursor = 0;

  const content = (from: number, to: number): void => {
    const text = lines.slice(from, to).join("\n").trim();
    if (text !== "")
      sections.push({ kind: "content", html: renderMarkdown(text) });
  };

  for (const entry of ordered) {
    const start = entry.region?.startLine ?? entry.set?.startLine ?? 0;
    if (start < cursor) continue;
    content(cursor, start);

    if (entry.region !== undefined) {
      sections.push({
        kind: "fold",
        foldKind: entry.region.kind,
        summary: summaryFor(entry.region),
        html: render(entry.region.startLine, entry.region.endLine),
      });
      cursor = entry.region.endLine + 1;
      continue;
    }

    const set = entry.set;
    if (set === undefined) continue;
    sections.push({
      kind: "set",
      axis: set.axis,
      summary: `${set.units.length} ${set.axis === "row" ? "side by side" : "stacked"}`,
      units: set.units.map((unit) => render(unit.startLine, unit.endLine)),
      html: render(set.startLine, set.endLine),
    });
    cursor = set.endLine + 1;
  }
  content(cursor, lines.length);

  return sections;
};
