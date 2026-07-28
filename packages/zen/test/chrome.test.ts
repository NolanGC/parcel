// Chrome vs content: the judgment that decides whether a LinkedIn digest
// reads like a digest or like a column of giant disembodied thumbs-up icons.

import { expect, test } from "bun:test";

import { convert, markdown } from "./helpers.ts";

const img = (attrs: string) => `<p>Text${` <img ${attrs}>`}</p>`;

test("an icon-sized image is furniture", async () => {
  expect(
    await markdown(
      img('src="https://x.dev/bell.png" alt="Notifications icon" height="25"'),
    ),
  ).toBe("Text");
});

test("a reaction glyph is furniture", async () => {
  expect(
    await markdown(
      img(
        'src="https://x.dev/like.png" alt="LIKE" style="height: 16px; width: 16px;"',
      ),
    ),
  ).toBe("Text");
});

test("an avatar is furniture — the name is already written beside it", async () => {
  expect(
    await markdown(
      img('src="https://x.dev/face.jpg" alt="Ada" width="72" height="72"'),
    ),
  ).toBe("Text");
});

test("a photograph is content", async () => {
  const result = await convert(
    img('src="https://x.dev/hero.jpg" alt="Hero" width="448" height="252"'),
  );
  expect(result.images).toHaveLength(1);
  expect(result.markdown).toBe("Text ![Hero](https://x.dev/hero.jpg =448x252)");
});

// Image-sliced newsletter layouts are full of wide, short strips that really do
// carry the content, so smallness has to be small in both directions.
test("a wide short strip is content, not a spacer", async () => {
  const result = await convert(
    img('src="https://x.dev/banner.png" alt="Sale" width="600" height="90"'),
  );
  expect(result.images).toHaveLength(1);
});

test("an undeclared image is kept, because there is nothing to judge it by", async () => {
  const result = await convert(
    img('src="https://x.dev/mystery.png" alt="logo"'),
  );
  expect(result.images).toHaveLength(1);
});

test("max-width is a constraint, not a declared size", async () => {
  const result = await convert(
    img('src="https://x.dev/hero.jpg" alt="Hero" style="max-width: 20px;"'),
  );
  expect(result.images).toHaveLength(1);
});

test("dropChrome off converts the message exactly as sent", async () => {
  const result = await convert(
    img('src="https://x.dev/bell.png" alt="Notifications icon" height="25"'),
    { dropChrome: false },
  );
  expect(result.images).toHaveLength(1);
});

// A header bar of icon links is the worst thing a digest can turn into: once
// the icons go, the anchors are left holding nothing.
test("a link whose only content was an icon goes with it", async () => {
  expect(
    await markdown(
      '<p>Hi</p><a href="https://x.dev/msgs"> <img src="https://x.dev/m.png" alt="Messaging icon" height="25"> </a>',
    ),
  ).toBe("Hi");
});

test("a link that still has text survives losing its icon", async () => {
  expect(
    await markdown(
      '<a href="https://x.dev/go"><img src="https://x.dev/m.png" alt="icon" height="24">Read more</a>',
    ),
  ).toBe("[Read more](https://x.dev/go)");
});

// LAYOUT ROWS

test("a row of short cells is one line, because it was one line", async () => {
  expect(
    await markdown(
      '<table role="presentation"><tr><td>149</td><td>·</td><td>115 Comments</td></tr></table>',
    ),
  ).toBe("149 · 115 Comments");
});

test("a row of prose cells stays as separate blocks", async () => {
  const long = "This is a full sentence of newsletter body copy that runs on. ";
  const result = await markdown(
    `<table role="presentation"><tr><td>${long}</td><td>${long}</td></tr></table>`,
  );
  expect(result.split("\n\n")).toHaveLength(2);
});

test("a row whose cell holds a heading is a page layout", async () => {
  expect(
    await markdown(
      '<table role="presentation"><tr><td><h2>Title</h2></td><td>Aside</td></tr></table>',
    ),
  ).toBe("## Title\n\nAside");
});

// TRIM REGRESSION
//
// A single text node is both the first and last inline in its run, and an
// earlier version read the original node twice — so trimming the end quietly
// undid trimming the start, leaving `** bold**`, which no dialect renders.
test("a run that is one text node is trimmed at both ends", async () => {
  expect(await markdown("<p><b> spaced </b></p>")).toBe("**spaced**");
  expect(await markdown('<a href="https://x.dev">&nbsp;Go&nbsp;</a>')).toBe(
    "[Go](https://x.dev)",
  );
});

// BACKGROUND PICTURES
//
// Email uses `background-size: cover` for anything that has to be cropped —
// video thumbnails, hero banners, card art — because it's the only cropping
// tool that works across clients. A converter that reads only <img> loses them
// silently: the LinkedIn digest carries all three of its video thumbnails this
// way, on empty <td>s, inside a link.

const cover = (url: string, size: string) =>
  `background-size: cover; background-repeat: no-repeat; ` +
  `background-image: url(&quot;${url}&quot;); ${size}`;

test("a cover background on a sized cell is a picture", async () => {
  expect(
    await markdown(
      `<table role="presentation"><tr><td height="252" style="${cover("https://x.dev/thumb.jpg", "height: 252px;")}"></td></tr></table>`,
    ),
  ).toBe("![](https://x.dev/thumb.jpg =x252)");
});

test("a background inside a link is still a picture", async () => {
  const result = await convert(
    `<a href="https://x.dev/watch"><table role="presentation"><tr>` +
      `<td height="252" style="${cover("https://x.dev/thumb.jpg", "height: 252px;")}"></td>` +
      `</tr></table></a>`,
  );
  expect(result.images.map((image) => image.src)).toEqual([
    "https://x.dev/thumb.jpg",
  ]);
});

test("a background with no declared size is not judged at all", async () => {
  const result = await convert(
    `<div style="background-image: url(&quot;https://x.dev/tile.png&quot;)"></div>`,
  );
  expect(result.images).toEqual([]);
});

test("a repeating tile is a texture, not a picture", async () => {
  const result = await convert(
    `<div height="400" style="background-repeat: repeat; background-image: url(&quot;https://x.dev/tile.png&quot;); height: 400px;"></div>`,
  );
  expect(result.images).toEqual([]);
});

test("an icon-sized background is furniture like any other icon", async () => {
  const result = await convert(
    `<div height="20" style="${cover("https://x.dev/dot.png", "height: 20px;")}"></div>`,
  );
  expect(result.images).toEqual([]);
});

test("a background is counted once, not once per walk", async () => {
  const result = await convert(
    `<div height="300" style="${cover("https://x.dev/hero.jpg", "height: 300px;")}">Caption</div>`,
  );
  expect(result.images).toHaveLength(1);
});
