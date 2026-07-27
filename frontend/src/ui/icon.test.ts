// The HugeIcons data is React-shaped: camelCase prop names, a `key` field,
// and a stroke weight baked into every path. All three are wrong as raw SVG,
// and all three fail *silently* — a `strokeLinejoin` attribute renders as
// nothing, and a per-path `stroke-width` quietly overrides the parameter
// callers pass. Hence a test on the produced attributes rather than on
// appearance.
import { expect, test } from "vitest";

import * as Icon from "../icons";

const rendered = (view: ReturnType<typeof Icon.mail>) =>
  view as unknown as {
    data: { attrs: Record<string, string> };
    children: ReadonlyArray<{ data?: { attrs?: Record<string, string> } }>;
  };

test("icon geometry renders as real SVG attributes", () => {
  const node = rendered(Icon.mail("size-4"));
  const childKeys = new Set(
    node.children.flatMap((child) => Object.keys(child.data?.attrs ?? {})),
  );

  expect(node.children.length).toBeGreaterThan(0);
  expect(childKeys).toContain("d");
  // Translated, not dropped.
  expect(childKeys).toContain("stroke-linejoin");
  // React bookkeeping, dropped.
  expect(childKeys).not.toContain("key");
});

test("stroke weight stays controllable from the call site", () => {
  // The set's own weight, so icons look as drawn by default.
  expect(rendered(Icon.mail("size-4")).data.attrs["stroke-width"]).toBe("1.5");
  // FF lifts to 2 for active/checked — which only works because the baked-in
  // per-path stroke-width is stripped rather than passed through.
  expect(rendered(Icon.mail("size-4", "2")).data.attrs["stroke-width"]).toBe(
    "2",
  );

  const childKeys = new Set(
    rendered(Icon.mail("size-4", "2")).children.flatMap((child) =>
      Object.keys(child.data?.attrs ?? {}),
    ),
  );
  expect(childKeys).not.toContain("stroke-width");
  expect(childKeys).not.toContain("strokeWidth");
});
