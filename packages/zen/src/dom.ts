// The slice of the DOM Zen actually needs, and the capability that produces it.
//
// Zen runs in two places with two different DOM implementations: the browser's
// own `DOMParser` in the app, and happy-dom under `bun test` and the hillclimb
// dashboard. Rather than depend on either, it names the handful of properties
// it reads. Both implementations satisfy this structurally, so neither one is
// imported here — which is what keeps the package's runtime dependency list at
// exactly `effect`.
//
// Read-only on purpose. Pre-cleaning drops nodes by *not walking into them*
// (see preclean.ts) rather than by mutating the tree, so nothing here needs
// removeChild, and a caller can hand Zen a live document without Zen damaging
// the page it came from.

import { Context, Effect, Layer } from "effect";

import { ZenParseError } from "./types.ts";

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;

export interface DomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: ArrayLike<DomNode>;
  readonly textContent: string | null;
}

export interface DomElement extends DomNode {
  readonly tagName: string;
  getAttribute(name: string): string | null;
}

export interface DomDocument {
  readonly body: DomElement | null;
}

export const isElement = (node: DomNode): node is DomElement =>
  node.nodeType === ELEMENT_NODE;

export const isText = (node: DomNode): boolean => node.nodeType === TEXT_NODE;

export const isComment = (node: DomNode): boolean =>
  node.nodeType === COMMENT_NODE;

/** Lowercased tag name. Email html is written by a thousand different tools
 *  and `<TD>` is as common as `<td>`; every rule table in this package keys on
 *  the lowercase form so the callers never have to remember. */
export const tagOf = (element: DomElement): string =>
  element.tagName.toLowerCase();

export const children = (node: DomNode): ReadonlyArray<DomNode> =>
  Array.from(node.childNodes as ArrayLike<DomNode>);

/** Attribute lookup that treats absent and empty as the same thing, because
 *  for every attribute Zen reads (`src`, `href`, `role`, `class`) they mean
 *  the same thing. */
export const attr = (element: DomElement, name: string): string | undefined => {
  const value = element.getAttribute(name);
  return value === null || value === "" ? undefined : value;
};

/** Element descendants matching a predicate, in document order. */
export const descendants = (
  node: DomNode,
  matches: (element: DomElement) => boolean,
): ReadonlyArray<DomElement> => {
  const found: Array<DomElement> = [];
  const visit = (current: DomNode): void => {
    for (const child of children(current)) {
      if (isElement(child) && matches(child)) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
};

/** Anything that turns a string of html into a document. `DOMParser` in the
 *  browser, happy-dom's equivalent under test. */
export type ParseHtml = (html: string) => DomDocument;

const parseWith =
  (parse: ParseHtml) =>
  (html: string): Effect.Effect<DomDocument, ZenParseError> =>
    Effect.try({
      try: () => parse(html),
      catch: (cause) => new ZenParseError({ message: String(cause) }),
    });

/** The default is the ambient `DOMParser`, which covers the browser and any
 *  runtime with happy-dom's globals registered. Everything else builds a layer
 *  with `Dom.from` and hands in its own parser — that indirection is why
 *  happy-dom never appears in this package's runtime dependencies. */
export class Dom extends Context.Service<Dom>()("parcel/zen/Dom", {
  make: Effect.sync(() => ({
    parse: parseWith(
      (html) =>
        new DOMParser().parseFromString(html, "text/html") as DomDocument,
    ),
  })),
}) {
  static readonly layer: Layer.Layer<Dom> = Layer.effect(this, this.make);

  static readonly from = (parse: ParseHtml): Layer.Layer<Dom> =>
    Layer.sync(this, () => ({ parse: parseWith(parse) }));
}
