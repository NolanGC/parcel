// Pathological-input stress harness.
//
//   node dev/stress.mjs
//
// One row per shape that could make `convert` blow up rather than merely be
// slow. `convert` is documented as total, so a THROW here is a bug, and so is
// a row that takes tens of seconds — a single 300KB message should not be able
// to pin a core.
//
// This is what surfaced the stack overflow in `guard.enforce` (50k escaped
// angle brackets), the quadratic in `format_urls` (50k bare URLs, 93 seconds),
// and jsdom's quadratic insert path (50k nested divs, 29 seconds).

import * as etm from "../build/dev/javascript/email_to_markdown/email_to_markdown.mjs"

const repeat = (s, n) => s.repeat(n)

const cases = {
  "50k escaped <": "<p>" + repeat("&lt;", 50000) + "</p>",
  "50k escaped >": "<p>" + repeat("&gt;", 50000) + "</p>",
  "50k bare urls": "<p>" + repeat("https://x.test/a ", 50000) + "</p>",
  "50k non-scheme http": "<p>" + repeat("httpd ", 50000) + "</p>",
  "50k siblings": "<div>" + repeat("<p>x</p>", 50000) + "</div>",
  "50k nested divs": repeat("<div>", 50000) + "x" + repeat("</div>", 50000),
  "200k spaces": "<p>a" + repeat(" ", 200000) + "b</p>",
  "50k table rows":
    "<table><tr><th>a</th><th>b</th></tr>" +
    repeat("<tr><td>1</td><td>2</td></tr>", 50000) +
    "</table>",
  "wide row 5k cells":
    "<table><tr>" +
    repeat("<th>h</th>", 5000) +
    "</tr><tr>" +
    repeat("<td>c</td>", 5000) +
    "</tr></table>",
  "colspan 100 x 200":
    "<table>" + repeat('<tr><td colspan="100">a</td><td>b</td></tr>', 200) + "</table>",
  "50k style rules":
    "<style>" + repeat(".c{color:red}", 50000) + '</style><p class="c">x</p>',
  "2k nested lists": repeat("<ul><li>", 2000) + "x" + repeat("</li></ul>", 2000),
  "50k open brackets": "<p>" + repeat("[", 50000) + "https://x.test</p>",
  "100k word line": "<p>" + repeat("word ", 100000) + "</p>",
  "50k backticks": "<p>" + repeat("`", 50000) + "</p>",
  "50k pre backticks": "<pre>" + repeat("`", 50000) + "</pre>",
  // Stylesheet amplification: matched declarations are copied onto every
  // element the selector hits, so rule size multiplies by the match count.
  "css many decls x5k":
    `<style>div{${Array.from({ length: 2000 }, (_, i) => `--v${i}:${repeat("x", 40)}`).join(";")}}</style>` +
    repeat("<div>x</div>", 5000),
  "css huge value x5k":
    `<style>div{color:${repeat("x", 150000)}}</style>` + repeat("<div>x</div>", 5000),
}

let worst = 0
for (const [name, html] of Object.entries(cases)) {
  const started = performance.now()
  let result
  try {
    result = `ok ${etm.convert_string(html).length}b`
  } catch (err) {
    result = `THROW ${err.constructor.name}: ${String(err.message).slice(0, 60)}`
  }
  const ms = performance.now() - started
  worst = Math.max(worst, ms)
  console.log(
    `${name.padEnd(21)} ${ms.toFixed(0).padStart(7)}ms  ${result}`,
  )
}
console.log(`\nworst ${worst.toFixed(0)}ms`)
