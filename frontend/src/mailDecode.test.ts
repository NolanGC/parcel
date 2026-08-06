// Unit tests for the pure Gmail message decoders extracted from the
// SyncEngine monolith (mailDecode.ts).
import { Option } from "effect";
import { describe, expect, test } from "vitest";

import {
  base64UrlToBytes,
  displayPart,
  flattenParts,
  inlineImages,
  latestDate,
  parseFrom,
} from "./mailDecode";
import type { Message as GmailMessage, MessagePart } from "./Gmail";

const part = (p: Partial<MessagePart> = {}): MessagePart => ({
  partId: "1",
  mimeType: "text/plain",
  body: { size: 0, data: "aGVsbG8=" as never },
  headers: [],
  ...p,
});

const msg = (payload: MessagePart | undefined): GmailMessage => ({
  id: "m1" as any,
  threadId: "t1" as any,
  payload,
} as GmailMessage);

describe("base64UrlToBytes", () => {
  test("decodes base64url (RFC 4648 -/_ alphabet)", () => {
    const bytes = base64UrlToBytes("aGVsbG8=" );
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
  test("handles URL-safe -/_ characters", () => {
    const bytes = base64UrlToBytes("-_");
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("parseFrom", () => {
  test("parses \"Ada Lovelace\" <ada@example.com>", () => {
    expect(parseFrom("\"Ada Lovelace\" <ada@example.com>")).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
  });
  test("bare address uses the address as both name and email", () => {
    expect(parseFrom("ada@example.com")).toEqual({
      name: "ada@example.com",
      email: "ada@example.com",
    });
  });
});

describe("displayPart", () => {
  test("prefers text/html over text/plain", () => {
    const m = msg(part({ mimeType: "multipart/alternative", parts: [
      part({ mimeType: "text/plain" }),
      part({ mimeType: "text/html" }),
    ] }));
    const selected = displayPart(m);
    expect(Option.isSome(selected)).toBe(true);
    if (Option.isSome(selected)) expect(selected.value.mimeType).toBe("text/html");
  });
  test("returns none when there is no payload", () => {
    expect(displayPart(msg(undefined))).toEqual(Option.none());
  });
});

describe("flattenParts", () => {
  test("walks the whole tree in order", () => {
    const leaf = part({ partId: "1.1" });
    const root = part({ partId: "1", parts: [leaf] });
    const flat = flattenParts(root);
    expect(flat.map((p) => p.partId)).toEqual(["1", "1.1"]);
  });
});

describe("inlineImages", () => {
  test("finds image parts with a content-id", () => {
    const img = part({
      partId: "img",
      mimeType: "image/png",
      headers: [{ name: "Content-ID", value: "<cid-1>" }],
    });
    const m = msg(part({ parts: [img] }));
    const found = inlineImages(m);
    expect(found.length).toBe(1);
    expect(found[0]!.contentId).toBe("cid-1");
  });
  test("returns none when no payload", () => {
    expect(inlineImages(msg(undefined))).toEqual([]);
  });
});

describe("latestDate", () => {
  test("returns the max internal date", () => {
    const m1 = { id: "a", threadId: "t", internalDate: "100" } as GmailMessage;
    const m2 = { id: "b", threadId: "t", internalDate: "300" } as GmailMessage;
    expect(latestDate([m1, m2])).toBe(300);
  });
  test("empty list is 0", () => {
    expect(latestDate([])).toBe(0);
  });
});
