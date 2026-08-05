import { Option } from "effect";
import { describe, expect, test } from "vitest";

import {
  domainKey,
  emailDomain,
  isConsumerMailDomain,
  logoDomains,
  personKey,
  registrableDomain,
} from "./avatars";

describe("emailDomain", () => {
  test("takes the part after the last @, lowercased", () => {
    expect(emailDomain("Ada@Example.COM")).toEqual(Option.some("example.com"));
  });

  // Real From headers are not always addresses, and a malformed one must cost
  // that sender a picture rather than fail the pass.
  test("rejects anything that is not recognizably an address", () => {
    expect(emailDomain("no-at-sign")).toEqual(Option.none());
    expect(emailDomain("trailing@")).toEqual(Option.none());
    expect(emailDomain("localhost@localhost")).toEqual(Option.none());
  });
});

describe("registrableDomain", () => {
  test("leaves a two-label domain alone", () => {
    expect(registrableDomain("stripe.com")).toBe("stripe.com");
  });

  test("climbs to the parent a bulk sender's subdomain hangs off", () => {
    expect(registrableDomain("em.stripe.com")).toBe("stripe.com");
    expect(registrableDomain("mail.notifications.github.com")).toBe(
      "github.com",
    );
  });

  test("keeps both labels of a multi-part public suffix", () => {
    expect(registrableDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
  });
});

describe("logoDomains", () => {
  test("tries the sending domain first, then its parent", () => {
    expect(logoDomains("no-reply@em.stripe.com")).toEqual([
      "em.stripe.com",
      "stripe.com",
    ]);
  });

  test("does not repeat itself when the two are the same", () => {
    expect(logoDomains("no-reply@stripe.com")).toEqual(["stripe.com"]);
  });

  // The whole point of the denylist: a favicon here is the mail provider's
  // logo, so every human would wear the same one.
  test("refuses mailbox providers", () => {
    expect(logoDomains("ada@gmail.com")).toEqual([]);
    expect(logoDomains("ada@icloud.com")).toEqual([]);
    expect(isConsumerMailDomain("proton.me")).toBe(true);
    expect(isConsumerMailDomain("stripe.com")).toBe(false);
  });

  test("refuses an address it cannot read", () => {
    expect(logoDomains("not-an-address")).toEqual([]);
  });
});

describe("keys", () => {
  // The prefix is what lets one table hold both sources without the reader
  // having to know which kind it asked for.
  test("are namespaced by source and normalized", () => {
    expect(personKey("  Ada@Example.com ")).toBe("person:ada@example.com");
    expect(domainKey("stripe.com")).toBe("domain:stripe.com");
  });
});
