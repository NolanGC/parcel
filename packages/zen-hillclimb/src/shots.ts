// The same two panes as the dashboard, as a picture.
//
// The dashboard is for a person: it is fast to click through and it records a
// verdict. This is for whoever has to act on that verdict — including an agent,
// which can read a png but cannot open localhost:4321. It renders the app pane
// and the Zen pane side by side into a self-contained page, screenshots it, and
// writes a manifest of what Zen thought it was doing.
//
// Self-contained matters: every image is inlined as a data uri out of the
// corpus, so the page renders identically with no server and no network, and
// nothing here ever calls out to the sender.
//
//   bun run shots --annotated        # everything marked bad or meh, current hash
//   bun run shots --ids a,b,c
//   bun run shots --random 12 --seed 7

import { mkdir, writeFile } from "node:fs/promises";

import { chromium } from "playwright-core";

import { ZEN_VERSION } from "@foldkit/zen";

import { latestByMessage, readAll } from "./annotations.ts";
import { Corpus, open } from "./corpus.ts";
import { convert } from "./runtime.ts";
import { type Section, sectionsOf } from "./sections.ts";
import { gitState, zenHash } from "./zen-hash.ts";

const PANE_WIDTH = 680;
/** Tall enough to show a whole newsletter, short enough that the png is still
 *  legible when something downscales it to fit a viewer. Past this the shot is
 *  cut and says so, which is a fair trade: a conversion that goes wrong goes
 *  wrong early. */
const MAX_PANE_HEIGHT = 2600;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const corpus = new Corpus(open());
const hash = await zenHash();
const git = await gitState();

const outDir = flag("out") ?? "/tmp/zen-shots";

/** Bytes for one image, as a data uri. Undefined when the app hasn't cached
 *  it — the shot then shows a broken image, which is the honest signal: the
 *  app has no bytes for it either. */
const dataUri = (messageId: string, src: string): string | undefined => {
  const asset = corpus.asset(messageId, src);
  if (asset === undefined) return undefined;
  return `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
};

/** The app pane carries a message's original attribute text — often not even
 *  valid html, since senders write a literal `&` in a query string instead of
 *  `&amp;`. Zen's own render pass writes valid html, so the same url comes back
 *  with every `&` escaped. Replacing only the literal form silently missed
 *  every cached image whose url had a query string: the Zen pane rendered
 *  those with a broken image, the app pane rendered the same bytes fine, and
 *  the difference was this tool's, not Zen's. */
const inlineImages = (html: string, messageId: string): string =>
  [
    ...corpus.imageUrls(messageId),
    ...corpus.contentIds(messageId).map((id) => `cid:${id}`),
  ].reduce((rewritten, src) => {
    const uri = dataUri(messageId, src);
    if (uri === undefined) return rewritten;
    return rewritten
      .replaceAll(src, uri)
      .replaceAll(src.replaceAll("&", "&amp;"), uri);
  }, html);

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const paneOf = (sections: ReadonlyArray<Section>): string =>
  sections
    .map((section) => {
      if (section.kind === "content") return section.html;
      // Sets are drawn, not folded: the whole reason to look at a picture of
      // this pane is to see whether the message got its shape back.
      if (section.kind === "set") {
        const units = (section.units ?? [])
          .map((html) => `<div class="set-unit">${html}</div>`)
          .join("");
        return `<div class="set ${section.axis ?? "column"}" data-set="${escapeHtml(section.summary ?? "set")}">${units}</div>`;
      }
      return `<div class="fold"><div class="fold-label">▸ ${escapeHtml(section.summary ?? section.foldKind ?? "folded")}</div>${section.html}</div>`;
    })
    .join("\n");

/** Both panes get the same width, the same type and the same image rule, so a
 *  difference in the picture is a difference in the conversion rather than a
 *  difference in how it was displayed. `img{max-width:100%;height:auto}` is
 *  what a reading pane does, and it is the rule that makes a declared
 *  `width`/`height` on an `<img>` mean what the sender meant. */
const PAGE_CSS = `
  *{box-sizing:border-box}
  body{margin:0;background:#eef0f3;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111}
  .head{padding:10px 16px;background:#1c2027;color:#e6e9ef;font-size:13px;display:flex;gap:14px;align-items:baseline}
  .head b{font-size:14px}
  .head span{opacity:.65}
  .cols{display:flex;gap:12px;padding:12px;align-items:flex-start}
  .pane{width:${PANE_WIDTH}px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.14)}
  .pane h2{margin:0;padding:8px 14px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#5b6472;background:#f6f7f9;border-bottom:1px solid #e3e6ea}
  .body{padding:14px;max-height:${MAX_PANE_HEIGHT}px;overflow:hidden;position:relative}
  .body img{max-width:100%;height:auto}
  iframe{width:100%;border:0;display:block}
  .zen{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;word-break:break-word}
  .zen h1{font-size:20px}.zen h2{font-size:17px}.zen h3{font-size:15px}
  .zen table{border-collapse:collapse;margin:10px 0;font-size:13px}
  .zen th,.zen td{border:1px solid #ccd2da;padding:4px 8px;text-align:left}
  .zen th{background:#f4f6f8}
  .zen blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d4d9e0;color:#5b6472}
  .zen hr{border:0;border-top:1px solid #e3e6ea;margin:14px 0}
  .zen a{color:#2a5bd7}
  .fold{margin:10px 0;padding:8px 10px;border:1px dashed #c3c9d2;border-radius:6px;background:#fafbfc;color:#79828f;font-size:13px}
  .fold-label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9aa3af;margin-bottom:4px}
  .set{display:grid;gap:12px;margin:14px 0;position:relative}
  .set.row{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
  .set::before{content:attr(data-set);position:absolute;top:-9px;left:8px;
    background:#fff;padding:0 6px;font-size:11px;color:#9aa3af}
  .set-unit{border:1px solid #e2e6ea;border-radius:10px;padding:12px}
  .set-unit>:first-child{margin-top:0}
  .set-unit>:last-child{margin-bottom:0}
  .cut{position:absolute;left:0;right:0;bottom:0;padding:4px 14px;background:linear-gradient(rgba(255,255,255,0),#fff 60%);color:#9aa3af;font-size:11px;text-align:right}
`;

const pageFor = (
  subject: string,
  emailHtml: string,
  zenHtml: string,
  stats: string,
): string => `<!doctype html>
<meta charset="utf-8">
<style>${PAGE_CSS}</style>
<div class="head"><b>${escapeHtml(subject || "(no subject)")}</b><span>${escapeHtml(stats)}</span></div>
<div class="cols">
  <section class="pane"><h2>app · original html</h2><div class="body"><iframe id="src" sandbox="allow-same-origin"></iframe><div class="cut" id="cut-a"></div></div></section>
  <section class="pane"><h2>zen · markdown → html</h2><div class="body"><div class="zen">${zenHtml}</div><div class="cut" id="cut-b"></div></div></section>
</div>
<script id="payload" type="application/json">${JSON.stringify(emailHtml).replaceAll("<", "\\u003c")}</script>
<script>
  // srcdoc through JSON rather than an attribute: a real email is full of
  // quotes and angle brackets, and attribute escaping is exactly the kind of
  // detail that would silently change the thing being measured.
  const frame = document.getElementById("src");
  window.shotReady = new Promise((resolve) => {
    frame.addEventListener("load", async () => {
      const doc = frame.contentDocument;
      // An iframe with no src fires one load for its initial about:blank, and
      // it can arrive after this listener is attached but before srcdoc has
      // navigated. Measuring that one sizes the pane to an empty document and
      // resolves the shot early, so the picture comes out blank while every
      // number in the manifest still looks right. Only the srcdoc load counts.
      if (doc.location.href !== "about:srcdoc") return;
      // Mail sets \`height: 100% !important\` on html and body constantly — it
      // is how you fill the window in a client that gives you one. Measured
      // against an iframe that is 150px tall by default, "100%" is 150px, and
      // the pane comes out blank with the message clipped just under it. So
      // the height is released (at !important, to beat the sender's) before
      // anything is measured, and the frame is opened to its maximum first so
      // nothing inside is laid out against a height it will not keep.
      frame.style.height = "${MAX_PANE_HEIGHT}px";
      for (const element of [doc.documentElement, doc.body]) {
        element.style.setProperty("height", "auto", "important");
        element.style.setProperty("margin", "0", "important");
      }
      await Promise.all(
        [...doc.images].map((image) =>
          image.complete
            ? null
            : new Promise((done) => {
                image.addEventListener("load", done);
                image.addEventListener("error", done);
              }),
        ),
      );
      const height = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
      frame.style.height = Math.min(height, ${MAX_PANE_HEIGHT} - 28) + "px";
      window.measuredHeight = height;
      if (height > ${MAX_PANE_HEIGHT} - 28) document.getElementById("cut-a").textContent = "cut at ${MAX_PANE_HEIGHT}px";
      const zen = document.querySelector(".zen");
      if (zen.scrollHeight > ${MAX_PANE_HEIGHT} - 28) document.getElementById("cut-b").textContent = "cut at ${MAX_PANE_HEIGHT}px";
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    // Nothing about a blank pane looks like a failure: the shot is written, the
    // manifest is complete, and only the picture is wrong. So the wait has a
    // floor, and measuredHeight is left for the tool to check afterwards.
    setTimeout(resolve, 8000);
  });
  // Attached first, assigned second: a load event fired between the two would
  // be missed, and the one that would be missed is the only one that matters.
  frame.srcdoc = JSON.parse(document.getElementById("payload").textContent);
</script>`;

const idsToShoot = async (): Promise<ReadonlyArray<string>> => {
  const explicit = flag("ids");
  if (explicit !== undefined) return explicit.split(",").map((id) => id.trim());

  if (args.includes("--annotated")) {
    const latest = latestByMessage(await readAll());
    return [...latest.values()]
      .filter((record) => record.zenHash === hash && record.verdict !== "good")
      .map((record) => record.messageId);
  }

  const count = Number(flag("random") ?? 8);
  // Deterministic by default, so two runs of the tool are comparable and a
  // fix can be checked against the same messages that showed the problem.
  let seed = Number(flag("seed") ?? 1);
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pool = corpus.list(600, 0, "");
  const picked: Array<string> = [];
  const seen = new Set<number>();
  while (picked.length < Math.min(count, pool.length)) {
    const index = Math.floor(random() * pool.length);
    if (seen.has(index)) continue;
    seen.add(index);
    const summary = pool[index];
    if (summary !== undefined) picked.push(summary.messageId);
  }
  return picked;
};

const ids = await idsToShoot();
if (ids.length === 0) {
  console.error("nothing to shoot");
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });

/** A page per message rather than one page reused.
 *
 *  Reusing it does not work: replacing the content of a page that already holds
 *  a loaded srcdoc iframe leaves the second message's frame stuck at its
 *  default 150px, so every shot after the first came out blank — with a
 *  complete manifest and a plausible png beside it. A page costs a few
 *  milliseconds against ~10ms of conversion, and this tool exists to be
 *  believed. */
const newPage = async () => {
  const page = await browser.newPage({
    viewport: { width: PANE_WIDTH * 2 + 40, height: 900 },
    deviceScaleFactor: 1,
  });
  // Everything that should render is already a data uri. Anything still asking
  // for the network is an image the app never cached, and letting it out would
  // tell the sender their mail had been opened — by a screenshot tool, months
  // later. Failing immediately also keeps a message full of dead tracker hosts
  // from spending a minute in DNS before its shot is taken.
  await page.route("**/*", (route) =>
    route.request().url().startsWith("data:")
      ? route.continue()
      : route.abort(),
  );
  return page;
};

type Manifest = {
  messageId: string;
  subject: string;
  shot: string;
  error?: string;
  ms?: number;
  bytes?: { html: number; markdown: number };
  counts?: {
    images: number;
    links: number;
    quotes: number;
    boilerplate: number;
    tables: number;
  };
};

const manifest: Array<Manifest> = [];

for (const [index, messageId] of ids.entries()) {
  const body = corpus.body(messageId);
  const subject = corpus.subject(messageId);
  if (body === undefined) {
    manifest.push({ messageId, subject, shot: "", error: "no body" });
    continue;
  }

  // Convert the message exactly as it arrived. Inlining runs on the *rendered*
  // output of both panes instead, because a data uri substituted before
  // conversion would be measured as part of the markdown — and a 2MB
  // "converted" size that is really this tool's own base64 would discredit the
  // one number the package is arguing about.
  const html = body.html;
  const started = performance.now();
  const result = await convert(html);
  const ms = performance.now() - started;

  const shot = `${String(index + 1).padStart(2, "0")}-${messageId}.png`;

  if ("error" in result) {
    manifest.push({ messageId, subject, shot: "", error: result.error });
    console.log(`  ${shot}  FAILED  ${result.error}`);
    continue;
  }

  const sections = sectionsOf(
    result.markdown,
    result.quotes,
    result.boilerplate,
    result.groups,
  );
  // Tables survive as tables only when tables.ts called them data, so counting
  // pipe-headers in the markdown is the cheapest read on that decision.
  const tables = (result.markdown.match(/^\|\s*---/gm) ?? []).length;

  const stats =
    `${(html.length / 1024).toFixed(0)}KB → ${(result.markdown.length / 1024).toFixed(1)}KB · ` +
    `${result.images.length} img · ${result.links.length} links · ${tables} tables · ${ms.toFixed(1)}ms`;

  const page = await newPage();
  await page.setContent(
    pageFor(
      subject,
      inlineImages(html, messageId),
      inlineImages(paneOf(sections), messageId),
      stats,
    ),
    { waitUntil: "load" },
  );
  await page.evaluate("window.shotReady");
  const measured = (await page.evaluate(
    "[window.measuredHeight ?? 0, document.getElementById('src').getBoundingClientRect().height]",
  )) as [number, number];
  await page.screenshot({ path: `${outDir}/${shot}`, fullPage: true });

  await page.close();

  await writeFile(
    `${outDir}/${shot.replace(/\.png$/, ".md")}`,
    result.markdown,
    "utf8",
  );

  manifest.push({
    messageId,
    subject,
    shot,
    ms,
    bytes: { html: html.length, markdown: result.markdown.length },
    counts: {
      images: result.images.length,
      links: result.links.length,
      quotes: result.quotes.length,
      boilerplate: result.boilerplate.length,
      tables,
    },
  });
  console.log(
    `  ${shot}  ${subject.slice(0, 50)}  ${stats}` +
      (measured[1] > 60 ? "" : "  ⚠ app pane did not size"),
  );
}

await browser.close();

await writeFile(
  `${outDir}/manifest.json`,
  `${JSON.stringify({ zenVersion: ZEN_VERSION, zenHash: hash, commit: git.commit, dirty: git.dirty, shots: manifest }, null, 2)}\n`,
  "utf8",
);

console.log(
  `\n${manifest.length} shots → ${outDir}  (zen ${ZEN_VERSION}@${hash})`,
);
