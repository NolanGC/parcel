// The three ways a message says "not this copy" — and the one way it says
// "this picture is over here instead". All four were found by putting Zen's
// output next to the real rendering and looking at it.

import { expect, test } from "bun:test";

import { convert, markdown } from "./helpers.ts";

// A conditional comment whose condition is false in every browser, opened with
// the `<!-->` that makes the block live html. Google writes `[if false]`, other
// senders `[if !mso]`; only the shape decides whether a browser shows it.
test("a downlevel-revealed block is content whatever its condition says", async () => {
  for (const condition of ["!mso", "false", "(!mso)&(!IE)"]) {
    expect(
      await markdown(
        `<p>Before</p><!--[if ${condition}]><!--><p>Revealed</p><!--<![endif]--><p>After</p>`,
      ),
    ).toBe("Before\n\nRevealed\n\nAfter");
  }
});

test("an outlook-only block is not content", async () => {
  expect(
    await markdown("<p>Before</p><!--[if mso]><p>Outlook</p><![endif]-->"),
  ).toBe("Before");
});

// The desktop/mobile alternate: both copies ship, a stylesheet rule hides one.
const alternates = (rule: string) =>
  `<style>${rule}</style><table><tr class="mobile"><td>Call<br>555-0100</td></tr><tr><td>Call 555-0100</td></tr></table>`;

test("a row hidden by a class in the stylesheet is not converted twice", async () => {
  expect(await markdown(alternates(".mobile{display:none}"))).toBe(
    "Call 555-0100",
  );
});

test("an id hidden by the stylesheet is dropped too", async () => {
  expect(
    await markdown(
      '<style>#gone{display:none}</style><p id="gone">Hidden</p><p>Shown</p>',
    ),
  ).toBe("Shown");
});

// Everything below is a rule that must NOT fire, because the cost of a mistake
// here is a deleted message rather than a repeated one.
test("a rule inside @media hides nothing — the copy it hides depends on width", async () => {
  expect(
    await markdown(
      alternates("@media (max-width:600px){.mobile{display:none}}"),
    ),
  ).toBe("Call  \n555-0100\n\nCall 555-0100");
});

test("a selector needing layout or interaction hides nothing", async () => {
  for (const rule of [
    ".card:hover .mobile{display:none}",
    "div .mobile{display:none}",
  ]) {
    expect(await markdown(alternates(rule))).toContain("Call  \n555-0100");
  }
});

test("a stylesheet that hides every row does not resurrect them", async () => {
  expect(
    await markdown(
      '<style>.gone{display:none}</style><table><tr class="gone"><td>Hidden</td></tr></table>',
    ),
  ).toBe("");
});

test("a table with no rows at all still gives up its content", async () => {
  expect(await markdown("<table><div>Loose</div></table>")).toBe("Loose");
});

// The html 4 spelling of a background picture. Outlook honours the attribute
// and not the property, so the bulletproof recipe emits the attribute alone.
test("a picture delivered by the background attribute is content", async () => {
  const result = await convert(
    '<table><tr><td background="https://x.dev/sofa.jpg" width="296" height="296" alt="Mozter Platform Bed" style="background-size:cover"></td></tr></table>',
  );
  expect(result.images).toHaveLength(1);
  expect(result.images[0]?.src).toBe("https://x.dev/sofa.jpg");
  // The alt on a <td> is invalid html and senders write it anyway — it is the
  // only place the product name appears in the message.
  expect(result.markdown).toContain("Mozter Platform Bed");
});

test("an icon-sized background attribute is still furniture", async () => {
  expect(
    await convert(
      '<table><tr><td background="https://x.dev/dot.gif" width="8" height="8"></td></tr></table>',
    ).then((result) => result.images),
  ).toHaveLength(0);
});

test("a background attribute with no declared size is not a picture", async () => {
  expect(
    await convert(
      '<table><tr><td background="https://x.dev/texture.png"></td></tr></table>',
    ).then((result) => result.images),
  ).toHaveLength(0);
});
