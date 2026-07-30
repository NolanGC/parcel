// Sets: runs of repeated structure the sender laid out as one thing — two
// article cards side by side, the fare lines of a receipt. Reported as line
// ranges, never deleted, same contract as quotes and boilerplate.

import { expect, test } from "bun:test";

import { convert } from "./helpers.ts";

/** A card the way mail builds one: its own table, a picture, a headline and a
 *  summary. `beside` is the float-and-align pair every sender uses to put two
 *  of them shoulder to shoulder, since mail has no flexbox. */
const card = (title: string, summary: string, options?: { beside?: boolean }) =>
  `<table ${options?.beside ? 'align="left" style="float:left"' : ""}><tr><td>` +
  `<img src="https://x.dev/${title.replaceAll(" ", "-")}.png" width="240" height="140">` +
  `<h3>${title}</h3><p>${summary}</p>` +
  `<p><a href="https://x.dev/read">Read more</a></p>` +
  `</td></tr></table>`;

/** A receipt line: one row, a label and an amount. */
const fareLine = (
  label: string,
  amount: string,
  options?: { icon?: boolean },
) =>
  `<table role="presentation"><tr><td>${label}</td>` +
  (options?.icon
    ? '<td><a href="https://x.dev/help"><img src="https://x.dev/i.png" width="12" height="12"></a></td>'
    : "") +
  `<td>${amount}</td></tr></table>`;

const setsOf = (groups: ReadonlyArray<{ group: number }>) =>
  new Set(groups.map((region) => region.group)).size;

test("two cards floated side by side are one set", async () => {
  const result = await convert(
    `<div>${card("Why young adults need a doctor", "A proactive approach to your health matters.", { beside: true })}` +
      `${card("How to choose between the ER and urgent care", "Know which option to use, and when.", { beside: true })}</div>`,
  );

  expect(setsOf(result.groups)).toBe(1);
  expect(result.groups.map((region) => region.index)).toEqual([0, 1]);
  expect(result.groups.every((region) => region.axis === "row")).toBe(true);
  expect(result.groups.every((region) => region.size === 2)).toBe(true);
});

// The rule that keeps a pair honest. Side by side is something a sender has to
// say; stacked, two blocks that each hold a picture and some words is every
// message ever written — a chess newsletter's content card and the social bar
// under it, a LinkedIn digest's headline and its "intended for" line.
test("two stacked blocks are not a set", async () => {
  const result = await convert(
    `<div>${card("Ending soon", "The July bot challenge is still live for a few more days.")}` +
      `${card("Follow us", "Find us on all the usual places for more of this.")}</div>`,
  );
  expect(result.groups).toEqual([]);
});

test("three stacked blocks of one shape are a set", async () => {
  const result = await convert(
    `<div>${card("First post", "Something a resident wrote about the lifts again.")}` +
      `${card("Second post", "Something else a resident wrote, about parking.")}` +
      `${card("Third post", "A third resident, selling a barely used airbed.")}</div>`,
  );

  expect(setsOf(result.groups)).toBe(1);
  expect(result.groups).toHaveLength(3);
  expect(result.groups.every((region) => region.axis === "column")).toBe(true);
});

test("ordinary paragraphs are never a set", async () => {
  const result = await convert(
    "<div><p>We are writing to let you know about a change to your plan.</p>" +
      "<p>The change takes effect at the end of the current billing period.</p>" +
      "<p>You do not need to do anything to keep your existing benefits.</p></div>",
  );
  expect(result.groups).toEqual([]);
});

// A footer's "Help · Privacy · Terms" is three matching cells and is furniture.
test("a bar of bare links is not a set", async () => {
  const result = await convert(
    '<div><table><tr><td><a href="https://x.dev/a">Help Center</a></td>' +
      '<td><a href="https://x.dev/b">Privacy</a></td>' +
      '<td><a href="https://x.dev/c">Terms</a></td></tr></table></div>',
  );
  expect(result.groups).toEqual([]);
});

test("a run of receipt lines is one set", async () => {
  const result = await convert(
    "<div>" +
      fareLine("Trip fare", "$11.31") +
      fareLine("Access for All Fee", "$0.10") +
      fareLine("Booking Fee", "$2.68") +
      fareLine("CA Driver Benefits", "$0.77") +
      "</div>",
  );

  expect(setsOf(result.groups)).toBe(1);
  expect(result.groups).toHaveLength(4);
  expect(result.groups.every((region) => region.axis === "column")).toBe(true);
});

// Senders decorate some units and not others, and the decoration gets a cell of
// its own. Counting cells rather than cells-with-words split one real Uber
// receipt into a run of four and three strays.
test("a decorative extra cell does not break the run", async () => {
  const result = await convert(
    "<div>" +
      fareLine("Trip fare", "$11.31") +
      fareLine("Access for All Fee", "$0.10", { icon: true }) +
      fareLine("Booking Fee", "$2.68", { icon: true }) +
      fareLine("CA Driver Benefits", "$0.77") +
      "</div>",
  );
  expect(result.groups).toHaveLength(4);
});

// The walk stops looking once it is inside a unit, so an outer set that
// swallows an inner one doesn't merely mis-describe the message — it hides the
// real cards. Innermost has to win.
test("cards inside a section win over the sections holding them", async () => {
  const inner =
    card("Why young adults need a doctor", "A proactive approach matters.", {
      beside: true,
    }) +
    card("How to choose between the ER and urgent care", "Know which, when.", {
      beside: true,
    });

  const result = await convert(
    "<div>" +
      `<table><tr><td><h2>Make your appointment</h2><img src="https://x.dev/a.png" width="200" height="90"><p>Let us match you with the right provider today.</p></td></tr></table>` +
      `<table><tr><td><h2>Recent blog articles</h2>${inner}</td></tr></table>` +
      "</div>",
  );

  expect(setsOf(result.groups)).toBe(1);
  expect(result.groups.every((region) => region.axis === "row")).toBe(true);
  const first = result.groups[0];
  expect(first).toBeDefined();
  const lines = result.markdown.split("\n");
  expect(
    lines.slice(first?.startLine, (first?.endLine ?? 0) + 1).join("\n"),
  ).toContain("Why young adults");
});

// A card ends with "Read more", which is link-only and short enough to read as
// footer furniture. On a real Providence mail the footer's backward reach
// swallowed the second card's link while the first kept its own, so one of two
// identical cards came out a line shorter than the other.
test("a footer does not reach back into the set above it", async () => {
  const result = await convert(
    "<p>Providence offers a primary care experience that fits your life.</p>" +
      "<p>Even as a new patient there are providers available within 30 days.</p>" +
      "<p>We are here to support your care, whatever comes up next.</p>" +
      `<div>${card("Why young adults need a doctor", "A proactive approach to your health matters.", { beside: true })}` +
      `${card("How to choose between the ER and urgent care", "Know which option to use, and when.", { beside: true })}</div>` +
      '<p><a href="https://x.dev/u">Unsubscribe</a> · Privacy policy</p>' +
      "<p>©2026 Providence. All rights reserved.</p>",
  );

  const footer = result.boilerplate.find((region) => region.kind === "footer");
  expect(footer).toBeDefined();
  const lastUnit = result.groups[result.groups.length - 1];
  expect(lastUnit).toBeDefined();
  // The fold starts after the last card, not inside it.
  expect(footer?.startLine).toBeGreaterThan(lastUnit?.endLine ?? 0);

  const lines = result.markdown.split("\n");
  for (const unit of result.groups) {
    expect(lines.slice(unit.startLine, unit.endLine + 1).join("\n")).toContain(
      "Read more",
    );
  }
});

test("detectGroups off reports nothing", async () => {
  const html = `<div>${card("One", "The first of two cards sitting side by side here.", { beside: true })}${card("Two", "The second of two cards sitting side by side.", { beside: true })}</div>`;
  const result = await convert(html, { detectGroups: false });
  expect(result.groups).toEqual([]);
});

// The whole contract: groups are an annotation, so turning detection off must
// not change a character of the markdown.
test("nothing is deleted — the markdown is identical either way", async () => {
  const html = `<div>${card("One", "The first of two cards sitting side by side here.", { beside: true })}${card("Two", "The second of two cards sitting side by side.", { beside: true })}</div>`;
  const on = await convert(html);
  const off = await convert(html, { detectGroups: false });
  expect(on.markdown).toBe(off.markdown);
});
