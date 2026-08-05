import { JSDOM, VirtualConsole } from "jsdom"
import { marked } from "marked"

const STRUCTURAL = new Set(["HTML", "HEAD", "BODY"])

// jsdom logs CSS it cannot parse, which is most of what hostile input carries.
const quiet = new VirtualConsole()

/// What our output contains as literal markup.
///
/// String assertions are not good enough here. `alt="&quot; onerror=&quot;…"`
/// contains the text `onerror` while being completely inert, and a regex over
/// the output reports that as a leak — twice, during the real red teaming.
/// The only question that matters is what the DOM ends up containing.
export function renderProbe(markdown) {
  return probe(markdown)
}

/// What our output turns into once a CommonMark renderer has had it.
///
/// The raw probe sees `<img>` and `<a>` but is blind to anything expressed in
/// Markdown syntax, which is exactly where link-destination breakouts live: a
/// stray `)` can close our destination early and leave the rest of the URL
/// parsed as a second, working link.
export function renderMarkdownProbe(markdown) {
  return probe(marked.parse(markdown, { async: false }))
}

function probe(html) {
  try {
    const doc = new JSDOM("<body>" + html + "</body>", {
      virtualConsole: quiet,
    }).window.document

    const els = [...doc.querySelectorAll("*")].filter(
      (e) => !STRUCTURAL.has(e.tagName),
    )

    const tags = [...new Set(els.map((e) => e.tagName.toLowerCase()))].sort()
    const handlers = [
      ...new Set(
        els.flatMap((e) =>
          [...e.attributes]
            .map((a) => a.name)
            .filter((n) => n.startsWith("on")),
        ),
      ),
    ].sort()

    // Anything a browser would fetch or navigate to without further action.
    const urls = els
      .map((e) => e.getAttribute("src") || e.getAttribute("href"))
      .filter(Boolean)

    return JSON.stringify({ tags, handlers, urls })
  } catch {
    return JSON.stringify({ tags: [], handlers: [], urls: [] })
  }
}
