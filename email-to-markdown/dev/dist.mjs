// Assemble `dist/` — the committed, browser-ready subset of the Gleam build.
//
// Two things happen here that a plain copy of `build/dev/javascript` would
// not do:
//
//   1. The Node FFI is replaced by the browser one. `dom.mjs` imports
//      `./dom_ffi.mjs`; the browser variant lands under that name so the
//      import resolves unchanged and jsdom never enters the bundle.
//   2. Only modules actually reachable from the public entry are copied.
//      The build tree also holds gleeunit, birdie, the compiled test
//      modules and the dev CLI — all of which would drag Node-only
//      dependencies into a browser bundle.
//
// Reachability is computed rather than listed so a new dependency in the
// Gleam source cannot silently produce a broken `dist/`.

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const buildDir = resolve(root, "build/dev/javascript")
const distDir = resolve(root, "dist")
const entry = resolve(buildDir, "email_to_markdown/email_to_markdown.mjs")

// The browser FFI is a source file, not a compiled one — Gleam copies it into
// the build tree verbatim alongside the Node variant it replaces.
const nodeFfi = resolve(buildDir, "email_to_markdown/email_to_markdown/dom_ffi.mjs")
const browserFfi = resolve(
  buildDir,
  "email_to_markdown/email_to_markdown/dom_ffi_browser.mjs",
)

const IMPORT_PATTERN = /(?:^|\s)(?:import|export)[^"']*?from\s*["']([^"']+)["']/g

/** Where a module's bytes are read from, which is not always where it lives. */
const sourceOf = (file) => (file === nodeFfi ? browserFfi : file)

const imports = (file) => {
  const text = readFileSync(sourceOf(file), "utf8")
  const out = []
  IMPORT_PATTERN.lastIndex = 0
  let match
  while ((match = IMPORT_PATTERN.exec(text)) !== null) {
    // Bare specifiers are npm packages — dompurify is the only one, and the
    // host bundler resolves it.
    if (match[1].startsWith(".")) out.push(resolve(dirname(file), match[1]))
  }
  return out
}

for (const file of [entry, nodeFfi, browserFfi]) {
  try {
    readFileSync(file)
  } catch {
    console.error(`missing build artefact: ${relative(root, file)}`)
    console.error("run `gleam build --target javascript` first")
    process.exit(1)
  }
}

const seen = new Set()
const queue = [entry]
while (queue.length > 0) {
  const file = queue.pop()
  if (seen.has(file)) continue
  seen.add(file)
  queue.push(...imports(file))
}

rmSync(distDir, { recursive: true, force: true })
for (const file of seen) {
  const target = resolve(distDir, relative(buildDir, file))
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(sourceOf(file), target)
}

// Types for the one exported function. Hand-written rather than inferred:
// without it TypeScript walks the whole compiled Gleam graph to type a
// function whose signature is `string -> string`.
writeFileSync(
  resolve(distDir, "email_to_markdown/email_to_markdown.d.mts"),
  [
    "/** Convert raw email HTML to Markdown.",
    " *",
    " *  Total: never throws. Worst case on pathological input is `\"\"`.",
    " *  Requires a DOM (`DOMParser`), so main thread only — not a worker. */",
    "export function convert_string(html: string): string",
    "",
  ].join("\n"),
)

console.log(`dist/: ${seen.size} modules`)
