// The wire format of an outgoing message. Everything here is pure string
// work, so the assertions are on the bytes a recipient's client will actually
// see — the one place in the app where a mistake is unrecoverable, because a
// sent message cannot be fixed by re-syncing.

import { Option } from "effect";
import { describe, expect, test } from "vitest";

import {
  base64UrlToBytes,
  buildRfc2822,
  bytesToBase64Url,
  encodeHeaderValue,
  replyReferences,
  replySubject,
  toRawMessage,
} from "./mime";

const utf8 = new TextDecoder();
const encoder = new TextEncoder();

const BOUNDARY = "test-boundary";

const message = (overrides: Partial<Parameters<typeof buildRfc2822>[0]> = {}) =>
  buildRfc2822({
    from: "ada@example.com",
    to: ["grace@example.com"],
    subject: "Hello",
    bodyMarkdown: "**hi**",
    bodyHtml: "<p><strong>hi</strong></p>",
    maybeInReplyTo: Option.none(),
    references: "",
    boundary: BOUNDARY,
    ...overrides,
  });

// The parts are base64, so reading one back is the only way to assert on what
// was actually put in it.
const partBodies = (raw: string): ReadonlyArray<string> =>
  raw
    .split(`--${BOUNDARY}`)
    .slice(1, -1)
    .map((part) => part.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim())
    .map((encoded) => atob(encoded.replace(/\r\n/g, "")));

describe("base64url", () => {
  test("round-trips through the decoder Gmail bodies use", () => {
    const bytes = encoder.encode("héllo — wörld 🌍");

    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });

  // The whole reason for the brand: btoa's alphabet is not Gmail's.
  test("uses the url alphabet, not btoa's", () => {
    const bytes = new Uint8Array([251, 255, 190]);

    expect(bytesToBase64Url(bytes)).toBe("-_--");
  });

  test("survives a body far past the argument limit of fromCharCode", () => {
    const bytes = encoder.encode("x".repeat(200_000));

    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });
});

describe("header encoding", () => {
  test("ascii is left exactly as typed", () => {
    expect(encodeHeaderValue("Re: lunch")).toBe("Re: lunch");
  });

  test("anything else becomes an RFC 2047 encoded-word", () => {
    const encoded = encodeHeaderValue("Grüße");

    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true);
    expect(encoded.endsWith("?=")).toBe(true);
  });

  // Each word is capped at 75 characters, so a long one is several folded
  // onto continuation lines.
  test("a long non-ascii subject folds into several words", () => {
    const encoded = encodeHeaderValue("é".repeat(200));

    expect(encoded.split("\r\n ").length).toBeGreaterThan(1);
    for (const word of encoded.split("\r\n ")) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  // Splitting a multi-byte character across two words decodes to a
  // replacement glyph rather than the character.
  test("folding never splits a character in half", () => {
    const subject = "🌍".repeat(60);
    const decoded = encodeHeaderValue(subject)
      .split("\r\n ")
      .map((word) => word.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, ""))
      .map((body) =>
        utf8.decode(Uint8Array.from(atob(body), (char) => char.charCodeAt(0))),
      )
      .join("");

    expect(decoded).toBe(subject);
  });
});

describe("the message", () => {
  test("carries both alternatives, richest last", () => {
    const raw = message();

    expect(raw).toContain(
      `Content-Type: multipart/alternative; boundary="${BOUNDARY}"`,
    );
    expect(partBodies(raw)).toEqual(["**hi**", "<p><strong>hi</strong></p>"]);
    expect(raw.trimEnd().endsWith(`--${BOUNDARY}--`)).toBe(true);
  });

  test("sends the markdown itself as the plain-text alternative", () => {
    const raw = message({ bodyMarkdown: "# Heading\n\n- one\n- two" });

    expect(partBodies(raw)[0]).toBe("# Heading\n\n- one\n- two");
  });

  test("addresses are comma-separated", () => {
    const raw = message({ to: ["grace@example.com", "alan@example.com"] });

    expect(raw).toContain("To: grace@example.com, alan@example.com");
  });

  test("a new message carries no threading headers", () => {
    const raw = message();

    expect(raw).not.toContain("In-Reply-To:");
    expect(raw).not.toContain("References:");
  });

  test("a reply carries the headers that thread it", () => {
    const raw = message({
      maybeInReplyTo: Option.some("<parent@mail.example.com>"),
      references: "<root@mail.example.com> <parent@mail.example.com>",
    });

    expect(raw).toContain("In-Reply-To: <parent@mail.example.com>");
    expect(raw).toContain(
      "References: <root@mail.example.com> <parent@mail.example.com>",
    );
  });

  // RFC 2045 caps an encoded line at 76 characters, and some servers enforce
  // it rather than merely preferring it.
  test("no encoded line exceeds the limit", () => {
    const raw = message({ bodyMarkdown: "x".repeat(5_000) });

    for (const line of raw.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  test("goes on the wire as base64url", () => {
    const raw = message();

    expect(utf8.decode(base64UrlToBytes(toRawMessage(raw)))).toBe(raw);
  });
});

describe("replies", () => {
  test("the subject gains one Re:, and only one", () => {
    expect(replySubject("Lunch")).toBe("Re: Lunch");
    expect(replySubject("Re: Lunch")).toBe("Re: Lunch");
    expect(replySubject("re: Lunch")).toBe("re: Lunch");
  });

  test("the chain grows by the message being replied to", () => {
    expect(replyReferences("<a@x>", "<b@x>")).toBe("<a@x> <b@x>");
  });

  // The first reply in a thread has no chain to extend.
  test("a first reply starts the chain", () => {
    expect(replyReferences("", "<b@x>")).toBe("<b@x>");
  });
});
