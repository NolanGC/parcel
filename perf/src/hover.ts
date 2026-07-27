// Hover-travel profiler for the inbox's traveling highlight, run against a
// live dev server (`bun run dev`, web on :1337).
//
//   bun perf:hover                    # pan down the list, report frames
//   bun perf:hover --steps 120 --step-ms 12
//
// The click→paint bench answers "how long until content appears". This one
// answers a different question: while the overlay is gliding, does the page
// actually produce frames? It pans the pointer down the list in small steps
// and records, per animation frame, the delta since the previous frame, plus
// every long task and its attribution.
//
// `dropped` counts frames longer than 1.5 budgets, which is the thing the eye
// reads as chop. Long tasks are reported separately because a single 80ms task
// drops five frames at once and says "script", where a flat run of slow frames
// with no long tasks says the cost is in style/layout/paint instead.
//
// Sign-in reuses the same persistent Chrome profile as `bun perf`.
//
// KNOW WHAT THIS CANNOT SEE before trusting a clean run:
//
//   - It drives its own Chrome profile, so it gets its own OPFS store. Any
//     cost that scales with the size of the local store is invisible here no
//     matter how long it samples, because this store is not yours.
//   - Frame budget is inferred from the observed median. On a 120Hz panel a
//     60Hz threshold hides every drop worth finding.
//   - A laptop on battery is the single loudest confound. macOS Low Power
//     Mode clamps Chrome to 30fps, which shows up as a suspiciously uniform
//     33.3ms median with nothing blocking behind it. That is the machine, not
//     the app. Plug in before reading anything into a run.
//
// This harness reported a clean 120Hz with zero long tasks across every
// gesture while the real tab was visibly choppy. A five-second rAF plus
// longtask capture pasted into the actual browser found it in one go. Reach
// for that first; use this to compare gestures once you know what you chase.

import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

const repoRoot = resolve(import.meta.dir, "../..");
const profileDir = resolve(repoRoot, "perf/.chrome-profile");

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const WEB = arg("--web") ?? "http://localhost:1337";
const API = arg("--api") ?? "http://localhost:1339";
const STEPS = Number(arg("--steps") ?? 90);
const STEP_MS = Number(arg("--step-ms") ?? 14);
const SETTLE_MS = Number(arg("--settle-ms") ?? 2_500);

const FRAME_BUDGET_MS = 16.7;
const DROP_FACTOR = 1.5;

type LongTask = {
  start: number;
  duration: number;
  attribution: string;
};

type Recording = {
  frames: ReadonlyArray<number>;
  longTasks: ReadonlyArray<LongTask>;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

const quantile = (sorted: ReadonlyArray<number>, q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;

const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// The in-page recorder. `start()` begins sampling rAF deltas and long tasks;
// `stop()` returns them. Frame deltas are recorded rather than timestamps so
// the report needs no clock alignment with the driver process.
const installRecorder = (page: Page) =>
  page.evaluate(() => {
    const w = window as any;
    w.__hover = {
      start() {
        const state: any = { frames: [], longTasks: [], running: true };
        w.__hoverState = state;

        state.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const attribution =
              (entry as any).attribution?.[0]?.name ?? "unknown";
            state.longTasks.push({
              start: entry.startTime,
              duration: entry.duration,
              attribution,
            });
          }
        });
        try {
          state.observer.observe({ entryTypes: ["longtask"] });
        } catch {
          // longtask unsupported; frames alone still tell the story.
        }

        let previous: number | undefined;
        const tick = (now: number) => {
          if (!state.running) return;
          if (previous !== undefined) {
            state.frames.push(now - previous);
          }
          previous = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      stop() {
        const state = w.__hoverState;
        state.running = false;
        state.observer?.disconnect();
        return {
          frames: state.frames,
          longTasks: state.longTasks,
        };
      },
    };
  });

const report = (label: string, recording: Recording): void => {
  const frames = [...recording.frames].sort((a, b) => a - b);
  // Infer the display's budget rather than assuming 60Hz: on a 120Hz panel a
  // 16.7ms threshold is two full frames and hides every drop that matters.
  const median = quantile(frames, 0.5);
  const budget = median < 12 ? 8.33 : FRAME_BUDGET_MS;
  const dropped = recording.frames.filter(
    (delta) => delta > budget * DROP_FACTOR,
  );
  const worst = [...recording.longTasks]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5);

  const totalLongTaskMs = recording.longTasks.reduce(
    (sum, task) => sum + task.duration,
    0,
  );

  console.log(`\n── ${label} ──`);
  console.log(`frames        ${recording.frames.length}`);
  console.log(
    `frame ms      median ${round1(quantile(frames, 0.5))}  ` +
      `p75 ${round1(quantile(frames, 0.75))}  ` +
      `p95 ${round1(quantile(frames, 0.95))}  ` +
      `max ${round1(frames[frames.length - 1] ?? 0)}`,
  );
  console.log(
    `dropped       ${dropped.length} / ${recording.frames.length} ` +
      `(${round1((100 * dropped.length) / Math.max(1, recording.frames.length))}%) ` +
      `vs ${budget}ms budget`,
  );
  console.log(
    `long tasks    ${recording.longTasks.length}, ${round1(totalLongTaskMs)}ms total`,
  );
  for (const task of worst) {
    console.log(`  ${round1(task.duration)}ms  ${task.attribution}`);
  }
  if (recording.longTasks.length === 0 && dropped.length > 0) {
    console.log(
      "  no long tasks behind the dropped frames — the cost is in " +
        "style/layout/paint, not in our script",
    );
  }
};

type Geometry = { x: number; top: number; travel: number };

const listGeometry = async (page: Page): Promise<Geometry> => {
  const list = page.locator("[data-virtual-list-id]").first();
  const box = await list.boundingBox();
  if (box === null) {
    return die("Could not find the virtual list container.");
  }
  return { x: box.x + box.width / 2, top: box.y + 8, travel: box.height - 16 };
};

const record = async (
  page: Page,
  gesture: () => Promise<void>,
): Promise<Recording> => {
  await page.evaluate(() => (window as any).__hover.start());
  await gesture();
  return (await page.evaluate(() =>
    (window as any).__hover.stop(),
  )) as Recording;
};

// A steady pan down the list: the gesture the overlay is built for, and the
// one that retargets the highlight on every row boundary crossed.
const pan = async (
  page: Page,
  steps: number,
  stepMs: number,
): Promise<void> => {
  const { x, top, travel } = await listGeometry(page);
  await page.mouse.move(x, top);
  await page.waitForTimeout(150);
  for (let step = 0; step < steps; step++) {
    await page.mouse.move(x, top + (travel * step) / steps);
    await page.waitForTimeout(stepMs);
  }
};

// Wheel scrolling with the pointer parked over the list. This is the case the
// steady pan misses: rows move under a stationary cursor, so the browser fires
// mouseenter on each row that passes beneath it AND every scroll event
// invalidates the list, all while the overlay is mid-transition.
const scrollUnderPointer = async (
  page: Page,
  steps: number,
  stepMs: number,
): Promise<void> => {
  const { x, top, travel } = await listGeometry(page);
  await page.mouse.move(x, top + travel / 2);
  await page.waitForTimeout(150);
  for (let step = 0; step < steps; step++) {
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(stepMs);
  }
};

// Pan and scroll at once: both inputs competing, which is what a trackpad
// actually produces when reading down a long list.
const panWhileScrolling = async (
  page: Page,
  steps: number,
  stepMs: number,
): Promise<void> => {
  const { x, top, travel } = await listGeometry(page);
  await page.mouse.move(x, top);
  await page.waitForTimeout(150);
  for (let step = 0; step < steps; step++) {
    await page.mouse.move(x, top + (travel * (step % 30)) / 30);
    await page.mouse.wheel(0, 30);
    await page.waitForTimeout(stepMs);
  }
};

const main = async () => {
  await fetch(WEB).catch(() =>
    die(`Dev server not reachable at ${WEB} — start it with \`bun run dev\`.`),
  );

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const cookie = process.env.PARCEL_COOKIE;
  if (cookie !== undefined && cookie.length > 0) {
    const name = API.startsWith("https:")
      ? "__Secure-better-auth.session_token"
      : "better-auth.session_token";
    await context.addCookies([{ name, value: cookie, url: API }]);
  }

  try {
    console.log(`Opening ${WEB}/inbox …`);
    await page.goto(`${WEB}/inbox`);

    const firstRow = page.locator('[data-virtual-list-item-index="0"]');
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

    // A fixed settle rather than `networkidle`: the app runs a perpetual
    // image-cache poll alongside the sync engine, so the network never goes
    // quiet and waiting on it just burns the whole timeout in silence.
    console.log(`Inbox up. Settling ${SETTLE_MS}ms before measuring…`);
    await page.waitForTimeout(SETTLE_MS);

    await installRecorder(page);

    const scenarios: ReadonlyArray<{
      label: string;
      run: () => Promise<void>;
    }> = [
      { label: "slow pan", run: () => pan(page, STEPS, STEP_MS) },
      { label: "fast pan", run: () => pan(page, 300, 2) },
      {
        label: "scroll under pointer",
        run: () => scrollUnderPointer(page, 120, 8),
      },
      {
        label: "pan while scrolling",
        run: () => panWhileScrolling(page, 150, 6),
      },
      // Long enough to catch the app's periodic background work. The short
      // scenarios above each sample about a second, which is how a ~350ms task
      // firing every four seconds hid from this harness completely while
      // being plainly visible to a hand-run recording in the real tab.
      { label: "sustained pan (15s)", run: () => pan(page, 750, 18) },
    ];

    // One warm-up so the first scenario isn't paying for a cold window.
    console.log("Warm-up…");
    await pan(page, 30, 8);

    for (const scenario of scenarios) {
      console.log(`${scenario.label}… (leave the mouse alone)`);
      const recording = await record(page, scenario.run);
      report(scenario.label, recording);
      await page.waitForTimeout(400);
    }
  } finally {
    await context.close();
  }
};

await main();
