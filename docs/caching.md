# Caching policy

**Every email is readable offline. Images are best-effort.**

One storage rule, one tiering rule. Everything below is why.

## What we store

| | Kept for |
|---|---|
| Metadata (subject, sender, date, snippet, labels) | every thread |
| Message body | every message, gzipped |
| `cid:` inline images | every message |
| Remote images (`<img src="https://…">`) | newest 1,000 threads + a 1,000-thread LRU of what you've opened |

## Why bodies are kept for everything

Measured against a real 20,751-thread mailbox (`bun sql --tables`):

```
message_bodies   22,057 rows   1131.2 MB   ← 91% of the database
thread_vectors   13,550 rows     26.7 MB
message_attach.      47 rows     14.4 MB
messages         22,061 rows      7.3 MB
threads          20,751 rows      5.8 MB
file 1241.0 MB
```

Bodies are effectively the whole database. They also compress **6.5x**
(measured with `Bun.gzipSync` over 400 sampled real bodies: 20.1 MB → 3.1 MB,
84.7% saved), because HTML email is enormously redundant.

That single fact is what makes this policy possible: 1,131 MB of bodies
becomes ~173 MB, and the database drops from ~1,241 MB to **~285 MB**. At
that size there is no reason to drop bodies for old mail, so we don't — and
"can I read this on a plane" gets one answer instead of depending on how old
the thread is.

Bodies are stored as a BLOB with the codec recorded per row, so every read is
self-describing: legacy plaintext, bodies too short to be worth compressing,
and gzip all come back through the same path with no "is this old data?"
branch anywhere.

## Why remote images are the exception

Sampling 2,000 real bodies:

```
with remote images   99% of messages
per message          avg 12.7   p50 11   p90 22   max 79
whole store          ~280,000 fetches
```

Bodies cost one fetch per message and that fetch is already happening.
Remote images cost *another ~12.7*, each a separate proxied request — roughly
**8 GB** and hours of wall-clock to hydrate the whole store. Thirty times the
entire compressed database.

So images are the one thing that genuinely cannot be kept for everything, and
therefore the only thing that gets tiered.

`cid:` inline images are unaffected: they arrive inside the `format=full`
payload we already fetch, so they cost nothing extra. They're also nearly
extinct in modern mail — 2 references across 2,000 sampled messages, 47 rows
and 14 MB in the whole store.

## The two image tiers

- **Recent (newest 1,000 threads).** Prefetched at sync time. Renders
  instantly and works with no network.
- **Opened (1,000-thread LRU).** Anything you open caches its images and
  stays cached until 1,000 other threads have been opened since.

The LRU bound is what stops a heavy reader from slowly re-acquiring the
multi-gigabyte problem this policy exists to avoid. Both tiers together cap
image storage at ~2,000 threads' worth regardless of usage.

Everything outside both tiers fetches images live on open, through the proxy.

## Hydration

Two pipelines, running concurrently, because they are bound by different
resources and do not trade against each other:

- **Bodies** — bound by Gmail's quota (250 units/user/sec, `threads.get`
  costs 10, so ~19 threads/sec). Walks the mailbox newest-first and never
  waits on anything else.
- **Images** — bound by the proxy and the sender's CDN, which touch Gmail's
  quota not at all. Hydrates HOT threads and services opens.

The dependency between them is per-thread, not per-phase: you need a body's
HTML to know its image URLs, so images trail bodies by one thread — not by
one stage. The first page of bodies lands, its images start fetching while
the body pipeline is already on the next page, and images for the newest
1,000 finish long before the backfill does.

Sequencing them instead would leave the image pipeline idle for the length
of the whole backfill, waiting on a quota it was never going to consume.

Where the two do interact, bodies win by construction:

- **Bandwidth.** Image concurrency is set below body concurrency (single
  digits against the body pipeline's 20) so bodies stay ahead. Priority
  lives in the concurrency numbers, not in ordering.
- **SQLite writes.** The body pipeline batches one transaction per 25-thread
  chunk to avoid an fsync per statement. Image writes batch per thread — all
  of a thread's images plus its `images_cached_at` stamp commit together —
  so they interleave with the body pipeline's transactions at thread
  granularity rather than per row.

There is deliberately no "go back and fill in the remaining images" pass.
That's the 280,000-fetch number above; on-demand caching covers the mail you
actually read, at zero cost for the mail you never touch.

## Privacy falls out of this

Remote images always go through the image proxy in `backend/src/ApiService.ts`
rather than being fetched by the browser, so senders see Cloudflare's IP
instead of yours, with no cookies or client headers attached. The client
couldn't cache them otherwise regardless — mail CDNs send no CORS headers, so
a browser `fetch()` to them returns an opaque response whose bytes can't be
read.

For the newest 1,000 the fetch happens at *sync* time, not open time, so the
sender learns nothing about whether or when you read the mail. This is the
same strategy as Apple's Mail Privacy Protection, and it's why prefetching
beats blocking: images still render.

Tracking pixels are not separately detectable and we don't try. The tracking
URL is frequently a real, visible image (a logo at a path unique to you), and
dimensions are only knowable after a fetch — by which point the fetch has
already reported the open. Proxying everything is the defense.

## Measuring

`bun sql` reads the real OPFS store directly (no browser, no dev server):

```
bun sql --tables            # size breakdown, the table above
bun sql "SELECT …"          # one shot
bun sql --refresh           # re-snapshot after changes
bun sql --wipe              # empty the store (Chrome must be quit)
```

## Where this lives

| | |
|---|---|
| Tier sizes | `frontend/src/tiers.ts` |
| Body compression | `frontend/src/compression.ts` |
| URL extraction, proxy fetch | `frontend/src/images.ts` |
| Prefetch queue, LRU eviction | `cacheImageBatch` in `frontend/src/sync.ts` |
| The prefetch loop | `CacheImageBatch` in `frontend/src/page/inbox/index.ts` |
| The proxy | `proxyImage` in `backend/src/ApiService.ts` |

The queue is not a separate table: `threads.images_cached_at` is `0` for
pending and a timestamp once done, and `threads.images_used_at` is the LRU
stamp (`0` = never opened). Opening a thread stamps it, which is what puts a
cold thread into the queue at all — and the reason the *second* open of an
old thread is the instant one.
