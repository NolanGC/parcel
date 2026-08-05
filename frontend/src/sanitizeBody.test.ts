// @vitest-environment jsdom
//
// NOTE: jsdom, against the project's happy-dom default. Not a preference —
// DOMPurify does not work under happy-dom at all: it derives an empty tag
// name for every node and so strips the entire document, including `<p>`.
// Reproduced outside vitest, so it is an upstream incompatibility rather than
// anything in the setup here. jsdom is DOMPurify's supported non-browser
// target, and the app itself runs in a real browser where neither applies.
//
// The body no longer renders in a sandboxed iframe, so prepareBody is the
// only thing between a hostile message and script execution in this document.
// These are not "nice to have" tests — they are the second half of that
// decision.

import { describe, expect, it } from "vitest";

import { prepareBody } from "./sanitizeBody";

const NO_URLS: ReadonlyMap<string, string> = new Map();

const prepare = (raw: string): string => prepareBody(raw, NO_URLS);

describe("script execution", () => {
  it("removes script tags", () => {
    const result = prepare(`<p>hi</p><script>alert(1)</script>`);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert(1)");
    expect(result).toContain("<p>hi</p>");
  });

  it("removes inline event handlers", () => {
    const result = prepare(
      `<img src="https://a.test/x.png" onerror="alert(1)">`,
    );
    expect(result).not.toContain("onerror");
    expect(result).not.toContain("alert(1)");
  });

  it("removes javascript: hrefs", () => {
    const result = prepare(`<a href="javascript:alert(1)">click</a>`);
    expect(result).not.toContain("javascript:");
  });

  it("removes scripts nested in svg", () => {
    const result = prepare(`<svg><script>alert(1)</script></svg>`);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert(1)");
  });

  it("removes svg animation that navigates", () => {
    const result = prepare(
      `<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>`,
    );
    expect(result).not.toContain("javascript:");
  });

  it("neutralizes the mXSS namespace-confusion vector", () => {
    // The classic: markup that re-parses differently once it is serialized
    // and reinserted, which is exactly what this module does to it.
    const result = prepare(
      `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`,
    );
    expect(result).not.toContain("onerror");
  });

  it("removes iframes and objects", () => {
    const result = prepare(
      `<iframe src="https://evil.test"></iframe><object data="x"></object><embed src="y">`,
    );
    expect(result).not.toContain("<iframe");
    expect(result).not.toContain("<object");
    expect(result).not.toContain("<embed");
  });
});

describe("document hijacking", () => {
  it("removes base, which would repoint every relative url on the page", () => {
    const result = prepare(`<base href="https://evil.test/"><p>hi</p>`);
    expect(result).not.toContain("<base");
    expect(result).toContain("<p>hi</p>");
  });

  it("removes form controls", () => {
    const result = prepare(
      `<form action="https://evil.test"><input name="password"><button>Sign in</button></form>`,
    );
    expect(result).not.toContain("<form");
    expect(result).not.toContain("<input");
    expect(result).not.toContain("<button");
  });

  it("strips @import, which would fetch on open", () => {
    const result = prepare(
      `<style>@import url("https://evil.test/track.css");p{color:red}</style>`,
    );
    expect(result).not.toContain("@import");
    expect(result).toContain("p{color:red}");
  });
});

describe("styling survives", () => {
  // A regression guard with teeth: the tempting "hardening" here is to forbid
  // <style> outright, which is cure53's own advice for untrusted css. It is
  // the wrong call for mail — it silently flattens every newsletter — and is
  // only safe to ignore because the result renders in a shadow root.
  it("keeps style blocks", () => {
    const result = prepare(
      `<style>.wrap{background:#fff;padding:20px}</style><div class="wrap">hi</div>`,
    );
    expect(result).toContain("<style>");
    expect(result).toContain(".wrap{background:#fff;padding:20px}");
    expect(result).toContain(`class="wrap"`);
  });

  // The regression that actually happened while writing this. A mail body is
  // a whole document, so the parser hoists `<style>` into a `<head>` — and
  // DOMPurify's default is to return the body alone, which silently discards
  // the sender's entire stylesheet. Nothing else here would have caught it:
  // the output is well-formed, safe, and unstyled.
  it("keeps a stylesheet the parser hoists into head", () => {
    const result = prepare(
      `<html><head><style>.wrap{color:#333}</style></head><body><div class="wrap">hi</div></body></html>`,
    );
    expect(result).toContain(".wrap{color:#333}");
    expect(result).toContain(`class="wrap"`);
  });

  it("keeps a stylesheet that merely leads the fragment", () => {
    const result = prepare(`<style>.a{color:red}</style><p>hi</p>`);
    expect(result).toContain(".a{color:red}");
  });

  it("unwraps html, head and body rather than emitting them", () => {
    const result = prepare(`<html><head></head><body><p>hi</p></body></html>`);
    expect(result).toBe(`<p>hi</p>`);
  });

  it("drops the sender's document title, which has no head to hide in", () => {
    const result = prepare(
      `<html><head><title>Newsletter #4</title></head><body><p>hi</p></body></html>`,
    );
    expect(result).not.toContain("Newsletter #4");
    expect(result).toContain("<p>hi</p>");
  });

  it("keeps inline styles and table layout", () => {
    const result = prepare(
      `<table width="600"><tr><td style="padding:12px;color:#333">hi</td></tr></table>`,
    );
    expect(result).toContain(`style="padding:12px;color:#333"`);
    expect(result).toContain(`width="600"`);
  });
});

describe("image localization", () => {
  const local = new Map([
    ["https://cdn.test/hero.png", "blob:app/hero"],
    ["cid:logo@sender", "blob:app/logo"],
  ]);

  it("swaps cached remote images for blobs", () => {
    const result = prepareBody(`<img src="https://cdn.test/hero.png">`, local);
    expect(result).toContain(`src="blob:app/hero"`);
  });

  it("swaps cid: attachments for blobs", () => {
    const result = prepareBody(`<img src="cid:logo@sender">`, local);
    expect(result).toContain(`src="blob:app/logo"`);
  });

  it("swaps the legacy background attribute", () => {
    const result = prepareBody(
      `<table><tr><td background="https://cdn.test/hero.png">hi</td></tr></table>`,
      local,
    );
    expect(result).toContain(`background="blob:app/hero"`);
  });

  it("swaps a url inside an inline style", () => {
    const result = prepareBody(
      `<div style="background:url('https://cdn.test/hero.png') no-repeat">hi</div>`,
      local,
    );
    expect(result).toContain("blob:app/hero");
    expect(result).toContain("no-repeat");
  });

  it("leaves the same url alone in text", () => {
    // The bug in the replaceAll this replaced: a message ABOUT a url had the
    // url rewritten in its own prose.
    const result = prepareBody(
      `<p>Fetch it from https://cdn.test/hero.png today</p>`,
      local,
    );
    expect(result).toContain("https://cdn.test/hero.png");
    expect(result).not.toContain("blob:app/hero");
  });

  it("leaves the same url alone in an href", () => {
    const result = prepareBody(
      `<a href="https://cdn.test/hero.png">the image</a>`,
      local,
    );
    expect(result).toContain(`href="https://cdn.test/hero.png"`);
  });

  it("leaves uncached images pointing at their origin", () => {
    const result = prepareBody(`<img src="https://cdn.test/other.png">`, local);
    expect(result).toContain(`src="https://cdn.test/other.png"`);
  });

  it("keeps data: images", () => {
    const result = prepare(
      `<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">`,
    );
    expect(result).toContain("data:image/png;base64,");
  });
});

describe("links", () => {
  it("opens every link in a new tab, without window.opener", () => {
    const result = prepare(`<a href="https://example.test/a">a</a>`);
    expect(result).toContain(`target="_blank"`);
    expect(result).toContain(`rel="noopener noreferrer"`);
  });

  it("overrides a target the sender chose", () => {
    const result = prepare(
      `<a href="https://example.test/a" target="_top">a</a>`,
    );
    expect(result).not.toContain(`target="_top"`);
    expect(result).toContain(`target="_blank"`);
  });

  it("keeps mailto links", () => {
    const result = prepare(`<a href="mailto:someone@example.test">mail</a>`);
    expect(result).toContain("mailto:someone@example.test");
  });
});

describe("shape", () => {
  it("does not wrap the body in the serialization holder", () => {
    expect(prepare(`<p>hi</p>`)).toBe(`<p>hi</p>`);
  });

  it("handles an empty body", () => {
    expect(prepare("")).toBe("");
  });
});
