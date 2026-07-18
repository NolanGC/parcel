// Click→paint benchmark for the inbox, run against a live dev server
// (`bun run dev`, web on :1337). Real headed Chrome (`channel: "chrome"`,
// no browser download), real OPFS store, real Gmail on the cold path.
//
//   bun perf                 # 10 samples per scenario, appends to ledger
//   bun perf --samples 5 --note "batch bodies query"
//
// Scenarios, in order, over the same top-N inbox threads:
//   cold-open        thread content evicted from SQLite right before the
//                    click, so opening takes loadThread's self-heal path
//                    (Gmail fetch → store → decompress → render)
//   warm-open        everything local (the cold pass just re-synced it)
//   warm-open-hover  600ms hover dwell on the row before clicking — the
//                    realistic human gesture, and the scenario any
//                    hover-prefetch work is trying to win
//
// Clock: t0 is a capture-phase pointerdown listener in the page; "content"
// is the detail pane visible + one more rAF (frame presented); "settled"
// is the last DOM mutation once 300ms of quiet follow it. Phases come from
// the app's own performance.marks (parcel:data:*, parcel:measure:*).
//
// Sign-in: the Chrome profile persists in perf/.chrome-profile — log in
// once in the bench window and later runs reuse the session.

import { $ } from "bun";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

const repoRoot = resolve(import.meta.dir, "../..");
const profileDir = resolve(repoRoot, "perf/.chrome-profile");
const ledgerPath = resolve(repoRoot, "perf/ledger.jsonl");

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const WEB = arg("--web") ?? "http://localhost:1337";
const API = arg("--api") ?? "http://localhost:1339";
const SAMPLES = Number(arg("--samples") ?? 10);
const NOTE = arg("--note") ?? "";

type Phases = {
  data: number | undefined;
  iframe: number | undefined;
  swap: number | undefined;
};

type Sample = {
  thread: string;
  subject: string;
  content: number;
  settled: number;
  phases: Phases;
  htmlBodies: number;
};

type RawResult = {
  t0: number;
  content: number;
  settled: number;
  subject: string;
  marks: ReadonlyArray<{ name: string; at: number }>;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

const quantile = (sorted: ReadonlyArray<number>, q: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];

const aggregate = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: round1(quantile(sorted, 0.5)),
    p75: round1(quantile(sorted, 0.75)),
    max: round1(sorted[sorted.length - 1] ?? 0),
  };
};

const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// The in-page half of the clock. Installed once; `arm()` before each
// click, then poll `__benchState.done` and read `result()`.
const installClock = (page: Page) =>
  page.evaluate(() => {
    const w = window as any;
    w.__bench = {
      arm() {
        performance.clearMarks();
        const state: any = { done: false };
        w.__benchState = state;
        addEventListener(
          "pointerdown",
          () => {
            state.t0 = performance.now();
          },
          { once: true, capture: true },
        );
        const paneVisible = () => {
          const el = document.getElementById("inbox-detail-pane");
          return el !== null && !el.classList.contains("invisible");
        };
        const observer = new MutationObserver(() => {
          state.lastMutation = performance.now();
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        let paintPending = false;
        const tick = () => {
          if (state.t0 === undefined) {
            requestAnimationFrame(tick);
            return;
          }
          if (state.content === undefined) {
            // The frame where the pane turns visible commits this rAF;
            // the *next* rAF is the first one after that frame presented.
            if (paneVisible() && !paintPending) {
              paintPending = true;
              requestAnimationFrame(() => {
                state.content = performance.now() - state.t0;
              });
            }
          } else {
            const last = state.lastMutation ?? state.t0;
            if (performance.now() - last >= 300) {
              state.settled = last - state.t0;
              observer.disconnect();
              state.done = true;
              return;
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      result() {
        const state = w.__benchState;
        return {
          t0: state.t0,
          content: state.content,
          settled: state.settled,
          subject:
            document
              .querySelector("#inbox-detail-pane h1")
              ?.textContent?.trim() ?? "",
          marks: performance
            .getEntriesByType("mark")
            .map((mark) => ({ name: mark.name, at: mark.startTime })),
        };
      },
    };
  });

const phasesOf = (raw: RawResult): { phases: Phases; htmlBodies: number } => {
  const rel = (at: number | undefined) =>
    at === undefined ? undefined : at - raw.t0;
  const dataEnd = rel(raw.marks.find((m) => m.name === "parcel:data:end")?.at);
  const measures = raw.marks.filter((m) =>
    m.name.startsWith("parcel:measure:"),
  );
  const lastMeasure =
    measures.length === 0
      ? undefined
      : rel(Math.max(...measures.map((m) => m.at)));
  // A negative mark means the work ran before the click (hover prefetch);
  // no marks at all means a standby hit (no load, measures pre-click and
  // cleared). Either way there's no post-click phase to attribute — the
  // whole open is the swap.
  const prefetched =
    (dataEnd !== undefined && dataEnd < 0) ||
    (lastMeasure !== undefined && lastMeasure < 0) ||
    (dataEnd === undefined && measures.length === 0);
  return {
    phases: prefetched
      ? { data: 0, iframe: 0, swap: round1(raw.content) }
      : {
          data: dataEnd === undefined ? undefined : round1(dataEnd),
          iframe:
            lastMeasure === undefined || dataEnd === undefined
              ? undefined
              : round1(lastMeasure - dataEnd),
          swap: round1(raw.content - (lastMeasure ?? dataEnd ?? 0)),
        },
    htmlBodies: measures.length,
  };
};

const runSample = async (
  page: Page,
  index: number,
  thread: string,
  options: { hoverMs?: number; evict?: boolean },
): Promise<Sample> => {
  if (options.evict === true) {
    await page.evaluate(
      (id) => (window as any).__parcelPerf.makeThreadCold(id),
      thread,
    );
  }
  await page.evaluate(() => (window as any).__bench.arm());
  const row = page.locator(`#inbox-list-row-${index}`);
  if (options.hoverMs !== undefined) {
    await row.hover();
    await page.waitForTimeout(options.hoverMs);
  }
  await row.click();
  await page.waitForFunction(
    () => (window as any).__benchState?.done === true,
    undefined,
    { timeout: 120_000 },
  );
  const raw = (await page.evaluate(() =>
    (window as any).__bench.result(),
  )) as RawResult;

  await page
    .locator("#inbox-detail-pane")
    .getByRole("button", { name: "Inbox" })
    .click();
  await page.waitForFunction(() => {
    const el = document.getElementById("inbox-detail-pane");
    return el === null || el.classList.contains("invisible");
  });
  await page.waitForTimeout(150);

  const { phases, htmlBodies } = phasesOf(raw);
  return {
    thread,
    subject: raw.subject,
    content: round1(raw.content),
    settled: round1(raw.settled),
    phases,
    htmlBodies,
  };
};

const runScenario = async (
  page: Page,
  name: string,
  threads: ReadonlyArray<string>,
  options: { hoverMs?: number; evict?: boolean; reverse?: boolean },
) => {
  console.log(`\n${name}`);
  const samples: Array<Sample> = [];
  // Reverse order defeats the app's adjacent-thread standby prefetch
  // (which always holds the *next* row): without it, opening sample i
  // caches sample i+1 in memory before the evict, and "cold" isn't.
  const order = threads.map((_, i) => i);
  if (options.reverse === true) order.reverse();
  for (const i of order) {
    const sample = await runSample(page, i, threads[i]!, options);
    samples.push(sample);
    console.log(
      `  [${samples.length}/${threads.length}] content ${sample.content}ms  settled ${sample.settled}ms` +
        `  (data ${sample.phases.data ?? "—"} / iframe ${sample.phases.iframe ?? "—"} / swap ${sample.phases.swap ?? "—"})` +
        `  ${sample.subject.slice(0, 48)}`,
    );
  }
  return {
    samples,
    content: aggregate(samples.map((s) => s.content)),
    settled: aggregate(samples.map((s) => s.settled)),
  };
};

const main = async () => {
  await fetch(WEB).catch(() =>
    die(`Dev server not reachable at ${WEB} — start it with \`bun run dev\`.`),
  );

  const commit = (
    await $`git -C ${repoRoot} rev-parse --short HEAD`.text()
  ).trim();
  const branch = (
    await $`git -C ${repoRoot} branch --show-current`.text()
  ).trim();
  const dirty =
    (await $`git -C ${repoRoot} status --porcelain`.text()).trim().length > 0;

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // PARCEL_COOKIE (bare `<token>.<sig>` from the browser's BetterAuth
  // session cookie, in the root .env) skips the manual sign-in: injected
  // on the API origin, where the backend reads it.
  const cookie = process.env.PARCEL_COOKIE;
  if (cookie !== undefined && cookie.length > 0) {
    await context.addCookies([
      { name: "better-auth.session_token", value: cookie, url: API },
    ]);
  }

  try {
    await page.goto(`${WEB}/inbox`);
    const firstRow = page.locator("#inbox-list-row-0");
    const visible = await firstRow
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) {
      console.log(
        "No inbox visible — sign in with Google in the bench window " +
          "(one time; the profile persists) and open the inbox…",
      );
      await firstRow.waitFor({ timeout: 300_000 });
    }

    // Let boot-time sync + hydration finish before measuring, so
    // background fetches can't warm an evicted thread mid-scenario.
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});
    await page.waitForFunction(
      () => (window as any).__parcelPerf !== undefined,
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(1_000);

    const ids = (await page.evaluate(() =>
      (window as any).__parcelPerf.topThreads(),
    )) as Array<string>;
    if (ids.length === 0) die("No threads in the local store.");
    const threads = ids.slice(0, SAMPLES);
    if (threads.length < SAMPLES) {
      console.warn(
        `Only ${threads.length} threads available (asked ${SAMPLES}).`,
      );
    }

    await installClock(page);

    const scenarios = {
      "cold-open": await runScenario(page, "cold-open", threads, {
        evict: true,
        reverse: true,
      }),
      "warm-open": await runScenario(page, "warm-open", threads, {}),
      "warm-open-hover": await runScenario(page, "warm-open-hover", threads, {
        hoverMs: 600,
      }),
    };

    const record = {
      at: new Date().toISOString(),
      commit,
      branch,
      dirty,
      note: NOTE,
      target: {
        web: WEB,
        mode: WEB.includes("localhost") ? "dev" : "deployed",
      },
      env: {
        os: `${process.platform}-${(await $`uname -r`.text()).trim()}`,
        chrome: context.browser()?.version() ?? "unknown",
        headed: true,
      },
      scenarios,
    };
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);

    console.log("\nsummary (ms)");
    console.log(
      "scenario           content med/p75/max     settled med/p75/max",
    );
    for (const [name, s] of Object.entries(scenarios)) {
      const c = s.content;
      const t = s.settled;
      console.log(
        `${name.padEnd(18)} ${String(c.median).padStart(7)}/${c.p75}/${c.max}` +
          `        ${String(t.median).padStart(7)}/${t.p75}/${t.max}`,
      );
    }
    console.log(
      `\nrecorded → perf/ledger.jsonl  (commit ${commit}${dirty ? ", DIRTY" : ""}${NOTE ? `, "${NOTE}"` : ""})`,
    );
    if (dirty) {
      console.log(
        "note: dirty tree — this record won't qualify for commit-to-commit comparison.",
      );
    }
  } finally {
    await context.close();
  }
};

await main();
