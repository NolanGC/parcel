// The prefetch walks every message in the hot window, so whatever
// remoteImageUrls returns is requested for mail the user has never opened.
// An open tracker in that list is a read receipt the sender would not
// otherwise have had, which is why these cases are pinned to the real urls
// observed failing in production rather than to invented ones.
import { describe, expect, test } from "vitest";

import { remoteImageUrls } from "./images";

const img = (attributes: string) =>
  `<html><body><img ${attributes}></body></html>`;

describe("remoteImageUrls", () => {
  test("keeps ordinary remote images", () => {
    const body = img('src="https://cdn.example.com/logo.png" width="120"');

    expect(remoteImageUrls(body)).toEqual(["https://cdn.example.com/logo.png"]);
  });

  test("skips the open trackers seen in production", () => {
    const body = [
      img('src="https://url3396.theinformation.com/wf/open?upn=u001.K3h9"'),
      img('src="https://mail8.glassdoor.com/wf/open?upn=u001.abc"'),
      img('src="https://www.glassdoor.com/brand-views?o=brandview-pixel&p=ey"'),
      img('src="http://li.wayfair.com/imp?s=124126000&sz=2x1"'),
    ].join("");

    expect(remoteImageUrls(body)).toEqual([]);
  });

  // The logos alongside those beacons are real images and must survive, even
  // though they carry the same email-campaign query parameters.
  test("keeps campaign-tagged images that are not trackers", () => {
    const body = img(
      'src="https://media.glassdoor.com/sql/7927/infosys-squareLogo.png?utm_medium=email&utm_source=jobalert"',
    );

    expect(remoteImageUrls(body)).toEqual([
      "https://media.glassdoor.com/sql/7927/infosys-squareLogo.png?utm_medium=email&utm_source=jobalert",
    ]);
  });

  test("skips images that declare themselves a pixel", () => {
    const width = img('src="https://t.example.com/a.gif" width="1" height="1"');
    const height = img('src="https://t.example.com/b.gif" height="1"');
    const styled = img('src="https://t.example.com/c.gif" style="width:1px"');

    expect(remoteImageUrls(width)).toEqual([]);
    expect(remoteImageUrls(height)).toEqual([]);
    expect(remoteImageUrls(styled)).toEqual([]);
  });

  test("a tracker among real images removes only the tracker", () => {
    const body = [
      img('src="https://cdn.example.com/hero.jpg" width="600"'),
      img('src="https://track.example.com/wf/open?upn=u001.x" width="1"'),
      img('src="https://cdn.example.com/footer.png" width="300"'),
    ].join("");

    expect(remoteImageUrls(body)).toEqual([
      "https://cdn.example.com/hero.jpg",
      "https://cdn.example.com/footer.png",
    ]);
  });

  test("still ignores non-http sources", () => {
    const body = [
      img('src="cid:logo@example"'),
      img('src="data:image/png;base64,iVBOR"'),
    ].join("");

    expect(remoteImageUrls(body)).toEqual([]);
  });

  test("decodes entity-escaped urls before matching", () => {
    const body = img('src="https://cdn.example.com/a.png?x=1&amp;y=2"');

    expect(remoteImageUrls(body)).toEqual([
      "https://cdn.example.com/a.png?x=1&y=2",
    ]);
  });
});

// Both of these came out of the real store: they were fetched successfully and
// returned tens of kilobytes of real image, so a filter that drops them is
// removing content the reader is meant to see.
describe("remoteImageUrls false positives found against the real store", () => {
  test("keeps artwork whose filename merely contains 'pixel'", () => {
    const url =
      "https://production-codepen-email-assets.codepenassets.com/cdn-cgi/image/width=600,quality=90,format=auto/codepen-spark/pixel-grid-clip-path-shape.png";

    expect(remoteImageUrls(`<img src="${url}">`)).toEqual([url]);
  });

  // The dimension scan must read the tag's attributes, not the url's query.
  test("does not read a CDN sizing parameter as the tag's own width", () => {
    const url =
      "https://cdn.example.com/cdn-cgi/image/width=1,quality=90/a.png";

    expect(remoteImageUrls(`<img src="${url}" width="600">`)).toEqual([url]);
  });

  test("still catches a genuine pixel path or query", () => {
    expect(
      remoteImageUrls('<img src="https://t.example.com/pixel.gif">'),
    ).toEqual([]);
    expect(
      remoteImageUrls('<img src="https://t.example.com/pixel/x?a=1">'),
    ).toEqual([]);
    expect(
      remoteImageUrls('<img src="https://t.example.com/x?pixel=1">'),
    ).toEqual([]);
  });
});
