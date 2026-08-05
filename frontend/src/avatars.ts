// Sender avatars: which image a sender gets, and how its bytes reach the DOM.
//
// Gmail shows two different things in this slot and it is worth being precise
// about which is which, because they come from different places and only one
// of them costs a scope:
//
//  - A FACE, for someone whose Google profile photo you are entitled to see.
//    That is the People API (People.ts), and it needs the contacts scopes.
//  - A LOGO, for a company. That is the sending domain's own favicon, fetched
//    through the image proxy the mail images already use. No scope, no third
//    party: the request goes to the sender's own server, which knows perfectly
//    well that it mails you.
//
// Anything that resolves to neither keeps the letter tile, which is also what
// Gmail does for a stranger.

import { Array as Arr, Option } from "effect";

/** How a sender is keyed in the `avatars` table. The prefix is what lets one
 *  table serve both sources: `person:` rows are keyed by address because a
 *  photo belongs to a human, `domain:` rows by domain because a logo belongs
 *  to a company and every address at it shares one. */
export const personKey = (email: string): string =>
  `person:${email.trim().toLowerCase()}`;

export const domainKey = (domain: string): string => `domain:${domain}`;

/** The domain half of an address, lowercased. `None` for anything that is not
 *  recognizably an address — a malformed From header is common enough in real
 *  mail that it must not be an error. */
export const emailDomain = (email: string): Option.Option<string> => {
  const at = email.lastIndexOf("@");
  const domain =
    at === -1
      ? ""
      : email
          .slice(at + 1)
          .trim()
          .toLowerCase();
  return domain === "" || !domain.includes(".")
    ? Option.none()
    : Option.some(domain);
};

// Mailbox providers. A favicon here is the PROVIDER's logo, not the sender's,
// so fetching one would stamp the Gmail logo on every human who writes to you
// — worse than the initial it replaced, and wrong in a way that looks like a
// bug rather than a gap. These fall through to a People photo or the tile.
const CONSUMER_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
]);

export const isConsumerMailDomain = (domain: string): boolean =>
  CONSUMER_MAIL_DOMAINS.has(domain);

// Multi-part public suffixes we actually meet in mail. A full PSL is ~10,000
// entries and several hundred KB, which is not worth shipping to shave a
// handful of wrong guesses: guessing wrong costs one 404 that the negative
// cache then remembers.
const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "co.jp",
  "or.jp",
  "ne.jp",
  "co.kr",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "com.br",
  "com.mx",
  "com.cn",
  "co.in",
  "co.za",
  "com.sg",
]);

/** The registrable domain: `em.stripe.com` → `stripe.com`. Bulk senders mail
 *  from a subdomain that serves no site of its own, so the parent is where the
 *  logo actually lives. */
export const registrableDomain = (domain: string): string => {
  const parts = domain.split(".");
  if (parts.length <= 2) {
    return domain;
  }
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
};

/** The domains worth trying for one sender, nearest first, deduplicated. Empty
 *  when the address is unusable or belongs to a mailbox provider. */
export const logoDomains = (email: string): ReadonlyArray<string> =>
  Option.match(emailDomain(email), {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (domain) =>
      isConsumerMailDomain(domain)
        ? []
        : Arr.dedupe([domain, registrableDomain(domain)]),
  });

/** Where a domain's logo is fetched from. Its own server — no aggregator, so
 *  nobody but the sender learns who mails you. */
export const faviconUrl = (domain: string): string =>
  `https://${domain}/favicon.ico`;

// THE BLOB REGISTRY
//
// Bytes reach the DOM as blob: urls rather than data: URIs for the reason
// already established for mail images (sync.ts): inlining base64 into markup
// is slow and, at this many rows, can OOM the tab.
//
// NOTE: A url is created ONCE per key and never changes for the life of the
// tab. That stability is load-bearing, not incidental — the url is passed into
// a memoized row's arguments, which are compared by reference, so a fresh url
// per render would cost every row its memo hit.

const MAX_LIVE_AVATARS = 300;

const liveUrls = new Map<string, string>();

/** The blob url for a key, if its bytes have been loaded. */
export const avatarUrl = (key: string): Option.Option<string> =>
  Option.fromNullishOr(liveUrls.get(key));

/** The url for a sender: their photo if we have one, else their company's
 *  logo. `None` means the letter tile, which is a real answer and not a
 *  failure. */
export const senderAvatarUrl = (email: string): Option.Option<string> =>
  Option.orElse(avatarUrl(personKey(email)), () =>
    Arr.findFirst(logoDomains(email), (domain) =>
      Option.isSome(avatarUrl(domainKey(domain))),
    ).pipe(Option.flatMap((domain) => avatarUrl(domainKey(domain)))),
  );

/**
 * Publish one key's bytes, returning whether anything new was registered.
 *
 * NOTE: Bounded and evicting, for the same reason the row memo cache is
 * (ui/lazy.ts): a map keyed by sender over an unbounded mailbox is a leak with
 * a slow fuse, and a blob url pins its bytes until it is revoked. Insertion
 * order is eviction order — an avatar is small and re-registering an evicted
 * one costs a local SELECT, so the extra bookkeeping for a true LRU would buy
 * nothing here.
 */
export const registerAvatar = (
  key: string,
  mimeType: string,
  bytes: Uint8Array,
): boolean => {
  if (liveUrls.has(key)) {
    return false;
  }
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
  );
  liveUrls.set(key, url);
  while (liveUrls.size > MAX_LIVE_AVATARS) {
    const oldest = liveUrls.keys().next();
    if (oldest.done === true) {
      break;
    }
    const evicted = liveUrls.get(oldest.value);
    if (evicted !== undefined) {
      URL.revokeObjectURL(evicted);
    }
    liveUrls.delete(oldest.value);
  }
  return true;
};
