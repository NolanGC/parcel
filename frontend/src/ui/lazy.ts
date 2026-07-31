import { createKeyedLazy, type Html } from "foldkit/html";

/**
 * FoldkitUI · Lazy — a keyed memo cache with a ceiling on how much it retains.
 *
 * `createKeyedLazy` never evicts. Its Map holds one entry per key for the life
 * of the page, and each entry pins both its arguments and its VNode — and a
 * VNode carries snabbdom's mutable `.elm`, which points at a real DOM node.
 * Once a virtualized list unmounts that node, the entry is the only thing
 * still referencing it: a detached subtree, retained forever.
 *
 * That is fine for a key space the size of a UI (tabs, panels). It is a leak
 * for one the size of a mailbox, where the key is a thread id and scrolling
 * mints new ones indefinitely.
 *
 * Eviction is by wholesale reset rather than LRU, because the pieces an LRU
 * would need — foldkit's `resolveOrCache`, and the boundary/dedupe bookkeeping
 * it performs — are module-private. Reaching into them would mean deep-
 * importing framework internals to reimplement a cache-hit protocol whose
 * invariants are not ours to keep. Dropping the whole cache needs none of
 * that: a fresh `createKeyedLazy` is exactly a cold one, and the only cost is
 * that the next render rebuilds the visible window once per `capacity` new
 * keys. For a list, that is ~20 rows every few hundred threads scrolled.
 *
 * NOTE: This is the one place `foldkit(lazy-view-stable-references)` is
 * suppressed, and it is suppressed knowingly. The rule guards against a slot
 * built inside a view — "cold cache on every call", memoization that never
 * hits. That is not this: the slot lives in a closure created once at module
 * scope, and is replaced only on crossing `capacity`, so a hit rate of
 * (capacity - 1) / capacity survives. The rule cannot express "recreated
 * rarely", and there is no public way to evict from a keyed slot, so bounding
 * what the cache retains and satisfying the rule are mutually exclusive. Every
 * caller must still bind the result to a module-scope const, exactly as the
 * rule requires of the thing it is standing in for.
 */
export const createCappedKeyedLazy = (capacity: number) => {
  // oxlint-disable-next-line foldkit/lazy-view-stable-references
  let lazy = createKeyedLazy();
  let keys = new Set<PropertyKey>();

  return <Args extends ReadonlyArray<unknown>>(
    key: PropertyKey,
    fn: (...args: Args) => Html,
    args: Args,
  ): Html => {
    if (!keys.has(key)) {
      // NOTE: Reset before adding, so a render never spans two caches: every
      // key this render asks for after the reset is rebuilt into the new one,
      // and none of them can hit a slot the old cache still owns.
      if (keys.size >= capacity) {
        // oxlint-disable-next-line foldkit/lazy-view-stable-references
        lazy = createKeyedLazy();
        keys = new Set();
      }
      keys.add(key);
    }

    return lazy(key, fn, args);
  };
};
