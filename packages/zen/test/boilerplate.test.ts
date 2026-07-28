// The part of the message nobody wrote to you: legal tails, licence
// disclosures, unsubscribe footers, and template blocks the sender forgot to
// fill in. Reported as line ranges, never deleted — same contract as quotes.

import { expect, test } from "bun:test";

import { convert } from "./helpers.ts";

const paragraphs = (...texts: ReadonlyArray<string>) =>
  texts.map((text) => `<p>${text}</p>`).join("");

/** A message with enough substance above the footer to be a message. */
const body = paragraphs(
  "Earn $50 back. Just like that.",
  "We'll drop $50 back into your account when you sign up and spend $50.",
  "This offer ends on the thirtieth of September so please don't wait.",
);

const folded = (
  markdown: string,
  regions: ReadonlyArray<{ startLine: number; endLine: number }>,
) => {
  const hidden = new Set(
    regions.flatMap((region) =>
      Array.from(
        { length: region.endLine - region.startLine + 1 },
        (_, offset) => region.startLine + offset,
      ),
    ),
  );
  return markdown
    .split("\n")
    .filter((line, index) => !hidden.has(index) && line.trim() !== "")
    .join("\n");
};

test("the legal tail is folded and the offer is not", async () => {
  const result = await convert(
    body +
      paragraphs(
        "This is an advertisement.",
        "The Card is issued by The Bancorp Bank pursuant to a licence by Mastercard.",
        "PayPal is licensed by the Georgia Department of Banking, License # 34967.",
        "Unsubscribe from all marketing emails.",
      ),
  );

  expect(result.boilerplate.map((region) => region.kind)).toEqual(["footer"]);
  const kept = folded(result.markdown, result.boilerplate);
  expect(kept).toContain("Earn $50 back");
  expect(kept).not.toContain("Bancorp");
  expect(kept).not.toContain("Unsubscribe");
});

test("nothing is deleted — the markdown still holds every word", async () => {
  const result = await convert(body + paragraphs("Unsubscribe here."));
  expect(result.markdown).toContain("Unsubscribe here.");
});

// The guard that matters: a footer is only a footer if a message came first.
test("a mail about your preferences is not folded away", async () => {
  const result = await convert(
    paragraphs(
      "You asked to change how often we email you.",
      "Manage your preferences using the link below.",
    ),
  );
  expect(result.boilerplate).toEqual([]);
});

// "View in browser" sits at the top of most newsletters. Anchoring on it once
// folded 160 of 167 lines of a Kalshi mail six lines in, leaving the headline
// and nothing else.
test("a 'view in browser' line never anchors a footer", async () => {
  const result = await convert(
    paragraphs("View this email in your browser.") + body,
  );
  expect(result.boilerplate).toEqual([]);
});

test("a newsletter masthead does not fold the newsletter", async () => {
  const result = await convert(
    paragraphs(
      "The week ahead: what to watch",
      "From college football to redistricting, here are the markets that matter.",
      "By Terry Oldreal. View this email in your browser.",
    ) +
      paragraphs(
        "Congress returns this week and the redistricting fight resumes in earnest.",
        "College football opens on Saturday with three ranked matchups.",
      ) +
      paragraphs("Unsubscribe from these emails."),
  );

  const kept = folded(result.markdown, result.boilerplate);
  expect(kept).toContain("Congress returns");
  expect(kept).toContain("College football opens");
  expect(kept).not.toContain("Unsubscribe");
});

test("a message with no footer has no regions", async () => {
  const result = await convert(body);
  expect(result.boilerplate).toEqual([]);
});

test("the footer reaches back over the logo and link bar above it", async () => {
  const result = await convert(
    body +
      '<p><a href="https://x.dev"><img src="https://x.dev/logo.png" alt="Logo" width="200" height="60"></a></p>' +
      '<p><a href="https://x.dev/help">Help Center</a></p>' +
      paragraphs("This is an advertisement.", "Unsubscribe."),
  );

  const kept = folded(result.markdown, result.boilerplate);
  expect(kept).not.toContain("Help Center");
  expect(kept).not.toContain("Logo");
  expect(kept).toContain("Earn $50 back");
});

// "Get the Venmo Debit Card" is 24 characters. A rule that swallowed short
// link-only lines on the way back would have eaten the call to action.
test("a call to action is not mistaken for a footer link", async () => {
  const result = await convert(
    body +
      '<p><a href="https://x.dev/go">Get the Venmo Debit Card</a></p>' +
      paragraphs("Unsubscribe from all marketing emails."),
  );
  expect(folded(result.markdown, result.boilerplate)).toContain(
    "Get the Venmo Debit Card",
  );
});

// PLACEHOLDERS

test("an unfinished template block is its own region", async () => {
  const result = await convert(
    body +
      paragraphs(
        "Main Headline goes here.",
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
      ),
  );

  expect(result.boilerplate.map((region) => region.kind)).toEqual([
    "placeholder",
  ]);
  const kept = folded(result.markdown, result.boilerplate);
  expect(kept).not.toContain("Lorem ipsum");
  expect(kept).toContain("Earn $50 back");
});

test("an unsubstituted merge tag is a placeholder", async () => {
  const result = await convert(body + paragraphs("Hello {{first_name}},"));
  expect(result.boilerplate.map((region) => region.kind)).toEqual([
    "placeholder",
  ]);
});

test("a placeholder inside the footer is not reported twice", async () => {
  const result = await convert(
    body +
      paragraphs(
        "Unsubscribe from all marketing emails.",
        "Lorem ipsum dolor sit amet.",
      ),
  );
  expect(result.boilerplate.map((region) => region.kind)).toEqual(["footer"]);
});

test("detectBoilerplate off reports nothing", async () => {
  const result = await convert(
    body + paragraphs("Unsubscribe from all marketing emails."),
    { detectBoilerplate: false },
  );
  expect(result.boilerplate).toEqual([]);
});
