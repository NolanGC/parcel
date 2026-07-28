// The hillclimb dashboard.
//
// Two panes, the same message: on the left what the app renders today (an
// untrusted document in a sandboxed iframe), on the right what Zen makes of
// it. Underneath, a box to say what's wrong. That's the whole tool. The value
// isn't the rendering — it's that a person can go through fifty real messages
// in ten minutes and leave a written trail of every place the conversion lost
// something, keyed to the exact rules that produced it.
//
// Plain Bun.serve and a static page, in the mold of perf/. This is a local
// instrument, not an application: no build step, no framework, and the only
// Effect in it is the one call into Zen.

import { Effect, Layer, ManagedRuntime } from "effect";
import { Window } from "happy-dom";

import {
  Dom,
  type DomDocument,
  renderMarkdown,
  Zen,
  ZEN_VERSION,
} from "@foldkit/zen";

import {
  type Annotation,
  append,
  latestByMessage,
  readAll,
} from "./annotations.ts";
import { Corpus, open } from "./corpus.ts";
import { gitState, zenHash } from "./zen-hash.ts";

const PORT = 4321;

const window = new Window({ url: "https://localhost" });

const happyDom = Dom.from(
  (html) =>
    new window.DOMParser().parseFromString(
      html,
      "text/html",
    ) as unknown as DomDocument,
);

const runtime = ManagedRuntime.make(Zen.layer.pipe(Layer.provide(happyDom)));

const corpus = new Corpus(open());
const hash = await zenHash();
const git = await gitState();

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status });

const staticFile = (name: string): Response =>
  new Response(Bun.file(new URL(`./static/${name}`, import.meta.url)));

/** Point every image the app has bytes for at this server, so both panes show
 *  what the app would show and neither one calls out to the sender. An
 *  uncached remote url is left alone: it loads live, which is honest about
 *  what the app would have to do too. */
const localizeImages = (html: string, messageId: string): string => {
  const local = (src: string): string =>
    `/api/image/${messageId}?src=${encodeURIComponent(src)}`;

  return [
    ...corpus.imageUrls(messageId),
    ...corpus.contentIds(messageId).map((id) => `cid:${id}`),
  ].reduce((rewritten, src) => rewritten.replaceAll(src, local(src)), html);
};

type Section = Readonly<{
  kind: "content" | "fold";
  foldKind?: string;
  summary?: string;
  html: string;
}>;

type Region = Readonly<{
  kind: string;
  startLine: number;
  endLine: number;
  attribution?: string;
}>;

/** Split the markdown at every foldable boundary and render each piece on its
 *  own, so the dashboard can collapse quoted replies and legal tails the way a
 *  reading client would. This is the demonstration that the line ranges Zen
 *  reports are sufficient to build a reading UI on: if a region is off by a
 *  line, it shows up here as a sentence on the wrong side of the fold. */
const sectionsOf = (
  markdown: string,
  quotes: ReadonlyArray<Region>,
  boilerplate: ReadonlyArray<Region>,
): ReadonlyArray<Section> => {
  const lines = markdown.split("\n");
  const summaryFor = (region: Region): string => {
    if (region.attribution !== undefined) return region.attribution;
    if (region.kind === "footer") return "legal, licences and unsubscribe";
    if (region.kind === "placeholder") return "unfinished template block";
    return `quoted (${region.kind})`;
  };

  const ordered = [...quotes, ...boilerplate].sort(
    (a, b) => a.startLine - b.startLine,
  );
  const sections: Array<Section> = [];
  let cursor = 0;

  const content = (from: number, to: number): void => {
    const text = lines.slice(from, to).join("\n").trim();
    if (text !== "")
      sections.push({ kind: "content", html: renderMarkdown(text) });
  };

  for (const region of ordered) {
    if (region.startLine < cursor) continue;
    content(cursor, region.startLine);
    sections.push({
      kind: "fold",
      foldKind: region.kind,
      summary: summaryFor(region),
      html: renderMarkdown(
        lines.slice(region.startLine, region.endLine + 1).join("\n"),
      ),
    });
    cursor = region.endLine + 1;
  }
  content(cursor, lines.length);

  return sections;
};

const emailDetail = async (messageId: string): Promise<Response> => {
  const body = corpus.body(messageId);
  if (body === undefined) return json({ error: "no body" }, 404);

  const html = localizeImages(body.html, messageId);
  const started = performance.now();

  // A conversion that throws on a real message is the most valuable thing this
  // tool can find, so it comes back as a result to look at rather than a 500
  // that only shows up in the terminal.
  const result = await runtime
    .runPromise(
      Effect.gen(function* () {
        const zen = yield* Zen;
        return yield* zen.convert(html);
      }),
    )
    .catch((cause: unknown) => ({ error: String(cause) }) as const);

  const ms = performance.now() - started;

  if ("error" in result) {
    return json({
      messageId,
      subject: corpus.subject(messageId),
      html,
      error: result.error,
      zenVersion: ZEN_VERSION,
      zenHash: hash,
      ms,
    });
  }

  return json({
    messageId,
    subject: corpus.subject(messageId),
    html,
    markdown: result.markdown,
    sections: sectionsOf(result.markdown, result.quotes, result.boilerplate),
    meta: {
      quotes: result.quotes,
      boilerplate: result.boilerplate,
      images: result.images,
      links: result.links,
    },
    bytes: { html: html.length, markdown: result.markdown.length },
    zenVersion: ZEN_VERSION,
    zenHash: hash,
    ms,
  });
};

const emailList = async (url: URL): Promise<Response> => {
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const query = url.searchParams.get("q") ?? "";

  const latest = latestByMessage(await readAll());
  const emails = corpus.list(limit, offset, query).map((summary) => {
    const annotation = latest.get(summary.messageId);
    return {
      ...summary,
      verdict: annotation?.verdict,
      staleVerdict: annotation !== undefined && annotation.zenHash !== hash,
    };
  });

  return json({ zenVersion: ZEN_VERSION, zenHash: hash, emails });
};

const saveAnnotation = async (request: Request): Promise<Response> => {
  const payload = (await request.json()) as {
    messageId?: string;
    verdict?: string;
    note?: string;
  };
  if (payload.messageId === undefined)
    return json({ error: "no message" }, 400);

  const record: Annotation = {
    at: new Date().toISOString(),
    messageId: payload.messageId,
    subject: corpus.subject(payload.messageId),
    zenVersion: ZEN_VERSION,
    zenHash: hash,
    commit: git.commit,
    dirty: git.dirty,
    verdict:
      payload.verdict === "good" || payload.verdict === "bad"
        ? payload.verdict
        : "meh",
    note: payload.note ?? "",
  };

  await append(record);
  return json(record);
};

const image = (messageId: string, url: URL): Response => {
  const src = url.searchParams.get("src");
  const asset = src === null ? undefined : corpus.asset(messageId, src);
  // A missing image renders broken in both panes, which is the correct signal:
  // the app doesn't have those bytes either.
  return asset === undefined
    ? new Response("not cached", { status: 404 })
    : new Response(asset.bytes, {
        headers: {
          "content-type": asset.mimeType,
          "cache-control": "max-age=3600",
        },
      });
};

Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") return staticFile("index.html");
    if (path === "/app.js") return staticFile("app.js");
    if (path === "/style.css") return staticFile("style.css");

    if (path === "/api/emails") return emailList(url);

    const detail = /^\/api\/email\/([^/]+)$/.exec(path);
    if (detail?.[1] !== undefined) return emailDetail(detail[1]);

    const asset = /^\/api\/image\/([^/]+)$/.exec(path);
    if (asset?.[1] !== undefined) return image(asset[1], url);

    if (path === "/api/annotations") {
      if (request.method === "POST") return saveAnnotation(request);
      const messageId = url.searchParams.get("messageId");
      const all = await readAll();
      return json(
        messageId === null
          ? all
          : all.filter((record) => record.messageId === messageId).reverse(),
      );
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(
  `zen-hillclimb  http://localhost:${PORT}  zen ${ZEN_VERSION}@${hash}${git.dirty ? " (dirty)" : ""}`,
);
