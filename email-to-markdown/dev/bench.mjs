// Timing over the local sample corpus.
//
//   node dev/bench.mjs [runs]
//
// `samples/` holds real mail and is gitignored, so this reports nothing if it
// is absent. Prints per-email milliseconds and a total, plus a hash of every
// output so a performance change that alters behaviour is immediately visible.

import * as etm from "../build/dev/javascript/email_to_markdown/email_to_markdown.mjs"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"

const RUNS = Number(process.argv[2] ?? 5)
const DIR = new URL("../samples/", import.meta.url)

let names
try {
  names = readdirSync(DIR).filter((n) => n.endsWith(".INPUT.html")).sort()
} catch {
  console.log("no samples/ directory — nothing to measure")
  process.exit(0)
}

const inputs = names.map((n) => [n, readFileSync(new URL(n, DIR), "utf8")])

for (const [, html] of inputs) etm.convert_string(html)

let total = 0
const digest = createHash("sha256")
for (const [name, html] of inputs) {
  let best = Infinity
  let out = ""
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    out = etm.convert_string(html)
    best = Math.min(best, performance.now() - t)
  }
  digest.update(name).update(out)
  total += best
  const label = name.replace(".INPUT.html", "")
  console.log(
    `${label.padEnd(34)} ${String(html.length).padStart(7)}b  ${best.toFixed(1).padStart(7)}ms`,
  )
}

console.log(`${"".padEnd(34)} ${"total".padStart(8)}  ${total.toFixed(1).padStart(7)}ms`)
console.log(`output digest ${digest.digest("hex").slice(0, 16)}`)
