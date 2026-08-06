// Pure Gmail message decoding: MIME tree walking, header lookup, FROM
// parsing, inline-image discovery and base64url decoding.
//
// These were private closures inside the 1350-line SyncEngine monolith.
// They have no dependencies beyond the Gmail wire types and Effect — pure
// projections, so they are module functions (not services), but in their
// own file with unit tests rather than buried in the engine.

import { Array as Arr, Option } from "effect";

import type { Message as GmailMessage, MessagePart } from "./Gmail";

// NOTE: Gmail body payloads are BASE64URL (-/_ alphabet), not btoa's +/.
export const base64UrlToBytes = (data: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );

export const utf8 = new TextDecoder();

// MIME TREE WALKING

export const headerValue = (
  message: GmailMessage,
  name: string,
): string | undefined =>
  message.payload?.headers?.find((header) => header.name.toLowerCase() === name)
    ?.value;

export const partHeader = (
  part: MessagePart,
  name: string,
): string | undefined =>
  part.headers?.find((header) => header.name.toLowerCase() === name)?.value;

export const flattenParts = (part: MessagePart): ReadonlyArray<MessagePart> => [
  part,
  ...(part.parts ?? []).flatMap(flattenParts),
];

export const hasBodyOfType =
  (mimeType: string) =>
  (part: MessagePart): boolean =>
    part.mimeType === mimeType && (part.body?.data ?? "") !== "";

// The displayable body: prefer text/html, fall back to text/plain.
export const displayPart = (message: GmailMessage): Option.Option<MessagePart> => {
  if (message.payload === undefined) {
    return Option.none();
  }
  const parts = flattenParts(message.payload);
  return Option.orElse(Arr.findFirst(parts, hasBodyOfType("text/html")), () =>
    Arr.findFirst(parts, hasBodyOfType("text/plain")),
  );
};

// Inline images: image parts carrying a Content-ID, referenced from the
// html as `cid:<id>`. The stored content_id drops the RFC angle brackets.
export type InlineImage = {
  readonly contentId: string;
  readonly mimeType: string;
  readonly part: MessagePart;
};

export const toInlineImage = (part: MessagePart): Option.Option<InlineImage> => {
  const contentId = partHeader(part, "content-id");
  const mimeType = part.mimeType;
  if (
    contentId === undefined ||
    mimeType === undefined ||
    !mimeType.startsWith("image/")
  ) {
    return Option.none();
  }
  return Option.some({
    contentId: contentId.replace(/^</, "").replace(/>$/, ""),
    mimeType,
    part,
  });
};

export const inlineImages = (message: GmailMessage): ReadonlyArray<InlineImage> =>
  message.payload === undefined
    ? []
    : Arr.getSomes(Arr.map(flattenParts(message.payload), toInlineImage));

// `"Ada Lovelace" <ada@example.com>` → { name, email }; bare addresses use the
// address as both.
export const parseFrom = (from: string): Readonly<{ name: string; email: string }> => {
  const email = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const name = (from.split("<")[0] ?? "").trim().replace(/^"(.*)"$/, "$1");
  return { name: name === "" ? email : name, email };
};

export const latestDate = (messages: ReadonlyArray<GmailMessage>): number =>
  Arr.reduce(messages, 0, (max, message) => {
    const date = Number(message.internalDate ?? "0");
    return Number.isFinite(date) && date > max ? date : max;
  });
