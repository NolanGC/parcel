import { JSDOM } from "jsdom"
import createDOMPurify from "dompurify"

// DOMPurify needs a real DOM to feature-detect against. linkedom is lighter but
// silently no-ops (`isSupported` is undefined and sanitize returns input
// unchanged, `onclick` and all), so jsdom is not optional here.
const window = new JSDOM("").window
const purify = createDOMPurify(window)

// One reusable parser rather than a fresh JSDOM realm per email: same parse
// result, roughly half the cost, and nothing to garbage-collect afterwards.
const parser = new window.DOMParser()

// Never reach the Gleam side. Script/style content is not document text, and
// head metadata is not body content.
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "HEAD",
  "TITLE",
  "META",
  "LINK",
  "NOSCRIPT",
  "TEMPLATE",
  // Raw-text element: its markup-looking content is a form default value, not
  // document text, and passing it through hands `guard` a tag to adjudicate
  // that nothing in the document actually authored.
  "TEXTAREA",
])

// Only attributes some pure stage actually reads. Emails carry a lot of junk
// attributes (Outlook/vendor namespaces, tracking params); dropping them here
// keeps the wire payload small.
const KEEP_ATTRS = new Set([
  "align",
  "alt",
  // Legacy presentational colour, still everywhere in mail. `visibility` needs
  // it: a `<td>` can set white-on-white and then a `<font color="#444444">`
  // inside paints the text perfectly readable.
  "bgcolor",
  "color",
  "class",
  "colspan",
  "height",
  "hidden",
  "href",
  "id",
  "role",
  "rowspan",
  "src",
  "start",
  "style",
  "width",
])

// Untrusted input. A crafted email can nest thousands of divs deep, which would
// blow the stack in both this walker and the Gleam recursion downstream.
const MAX_DEPTH = 100
const MAX_NODES = 200_000

// jsdom notifies every ancestor on each insertion, so its parse cost grows with
// the square of nesting depth — 10k levels takes ten seconds, and past ~20k it
// overflows the stack. 300KB of `<div>` is therefore a cheap way to pin a core,
// so depth is checked against the raw string before jsdom ever sees it.
// The deepest of the real sample emails is 34; MAX_DEPTH already flattens
// anything past 100, so nothing legitimate comes near this.
const MAX_NESTING = 500

// Never close, so they must not count toward depth.
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])

const TAG_PATTERN = /<(\/)?([a-zA-Z][a-zA-Z0-9:-]*)/g

/// Upper bound on how deeply the document nests.
///
/// Deliberately an estimate: it ignores implicit closes and mismatched tags, so
/// it can only over-count, which is the safe direction for a guard. HTML has no
/// self-closing syntax outside foreign content, so `/>` needs no special case.
function estimateNesting(html) {
  let depth = 0
  let deepest = 0
  TAG_PATTERN.lastIndex = 0
  let match
  while ((match = TAG_PATTERN.exec(html)) !== null) {
    if (VOID_TAGS.has(match[2].toLowerCase())) continue
    if (match[1]) {
      if (depth > 0) depth -= 1
    } else if ((depth += 1) > deepest) {
      deepest = depth
      if (deepest > MAX_NESTING) return deepest
    }
  }
  return deepest
}

// Stylesheets are parsed as data, never executed, but an unbounded one would
// still be a cheap way to make the Gleam-side parser work forever.
const MAX_CSS = 200_000

const EMPTY_BODY = '{"css":"","tree":{"t":"body","a":{},"c":[]}}'

export function parseSanitize(html) {
  // `convert` is documented as total, so nothing may escape this boundary.
  // Pathological input does reach here: ~50k levels of nesting makes
  // DOMPurify hand back null instead of a body element, and jsdom can throw
  // outright on other malformed documents.
  try {
    if (estimateNesting(html) > MAX_NESTING) return textOnly(html)

    const body = purify.sanitize(html, {
      RETURN_DOM: true,
      WHOLE_DOCUMENT: false,
    })
    if (!body || !body.childNodes) return EMPTY_BODY

    const budget = { remaining: MAX_NODES }
    return JSON.stringify({
      css: extractStylesheets(html),
      tree: serializeElement(body, 0, budget),
    })
  } catch {
    return EMPTY_BODY
  }
}

/// Last resort for a document too deep to hand to a parser: keep the text,
/// discard the markup.
///
/// This is close to what the pipeline would have produced anyway — MAX_DEPTH
/// already drops structure past 100 levels — and it stays safe because every
/// byte lands in a text node. Anything tag-shaped that survives is escaped by
/// `guard`, so it renders as visible text and never as markup.
function textOnly(html) {
  const text = html.replace(/<[^>]*>/g, " ").slice(0, MAX_CSS)
  return JSON.stringify({
    css: "",
    tree: { t: "body", a: {}, c: [text] },
  })
}

/// Collect `<style>` contents from the *unsanitized* document.
///
/// DOMPurify drops `<style>` and `WHOLE_DOCUMENT: false` discards the head,
/// so the stylesheet has to be read before sanitizing. The text is only ever
/// parsed as data on the Gleam side — never injected anywhere — and email
/// hides real content behind these rules, including preheaders.
function extractStylesheets(html) {
  // A second parse is the most expensive thing this module does, and plenty of
  // mail has no `<style>` at all. `<style>` cannot be spelled any other way.
  if (!/<style[\s>]/i.test(html)) return ""
  try {
    const doc = parser.parseFromString(html, "text/html")
    let css = ""
    for (const style of doc.querySelectorAll("style")) {
      css += (style.textContent || "") + "\n"
      if (css.length > MAX_CSS) break
    }
    return css.slice(0, MAX_CSS)
  } catch {
    return ""
  }
}

function serializeElement(el, depth, budget) {
  return {
    t: el.tagName ? el.tagName.toLowerCase() : "div",
    a: serializeAttrs(el),
    c: serializeChildren(el, depth, budget),
  }
}

function serializeAttrs(el) {
  const out = {}
  if (!el.attributes) return out
  for (const attr of el.attributes) {
    const name = attr.name.toLowerCase()
    if (KEEP_ATTRS.has(name)) out[name] = attr.value
  }
  return out
}

function serializeChildren(el, depth, budget) {
  const out = []
  if (!el.childNodes) return out
  for (const child of el.childNodes) {
    if (budget.remaining <= 0) break
    budget.remaining -= 1

    // Node.TEXT_NODE === 3
    if (child.nodeType === 3) {
      const text = child.nodeValue
      if (text) out.push(text)
      continue
    }

    // Node.ELEMENT_NODE === 1 — everything else (comments, CDATA) is dropped.
    if (child.nodeType !== 1) continue
    if (SKIP_TAGS.has(child.tagName)) continue

    // Past the depth cap, keep the subtree's text but discard its structure
    // rather than recursing further.
    if (depth >= MAX_DEPTH) {
      const text = child.textContent
      if (text) out.push(text)
      continue
    }

    out.push(serializeElement(child, depth + 1, budget))
  }
  return out
}
