// Cache tier sizes. The policy these serve, and the measurements behind it,
// are in docs/caching.md — the short version is that bodies are kept for
// every thread (they compress ~6.5x, so it's affordable) and only remote
// images are tiered, because hydrating them for the whole mailbox would be
// ~280,000 fetches and several gigabytes.

/** Newest N threads: remote images prefetched at sync time, so they render
 *  instantly and leak nothing about when you read them. */
export const HOT_THREAD_COUNT = 1000;

/** Threads whose images are kept because you opened them. Bounded so a heavy
 *  reader can't slowly re-acquire the multi-gigabyte problem the tiers exist
 *  to avoid; together with HOT_THREAD_COUNT this caps image storage at about
 *  2,000 threads' worth regardless of usage. */
export const OPENED_LRU_COUNT = 1000;
