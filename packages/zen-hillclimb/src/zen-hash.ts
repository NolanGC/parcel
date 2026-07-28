// Which rules produced this output.
//
// An annotation is only useful if you can tell what it was aimed at. "The
// quote chain isn't collapsing" against a build from three sessions ago is
// history; the same note against the current rules is a bug. So every
// annotation records a hash of Zen's source, and the loop becomes: annotate at
// hash X, change the rules, hash becomes Y, and anything still marked bad at X
// is worth re-checking.
//
// The version string in the package is the human-readable half of the pair —
// it says "different enough to care", the hash says "different at all".

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";

// …/packages/zen-hillclimb/src → …/packages → …/packages/zen/src
const ZEN_SRC = join(dirname(dirname(import.meta.dir)), "zen", "src");

export const zenHash = async (): Promise<string> => {
  const files = readdirSync(ZEN_SRC)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  const hasher = new Bun.CryptoHasher("sha256");
  for (const name of files) {
    hasher.update(name);
    hasher.update(await Bun.file(join(ZEN_SRC, name)).text());
  }
  return hasher.digest("hex").slice(0, 12);
};

/** The commit the rules were read from, so an annotation can be traced back to
 *  a diff. `dirty` matters more than the sha here: most hillclimbing happens
 *  on uncommitted changes. */
export const gitState = async (): Promise<{
  commit: string;
  dirty: boolean;
}> => {
  try {
    const commit = (await Bun.$`git rev-parse --short HEAD`.quiet()).stdout
      .toString()
      .trim();
    const status = (await Bun.$`git status --porcelain`.quiet()).stdout
      .toString()
      .trim();
    return { commit, dirty: status !== "" };
  } catch {
    return { commit: "unknown", dirty: false };
  }
};
