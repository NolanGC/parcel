// Building the wire format of an outgoing message: RFC 2822 headers and a
// multipart/alternative body, base64url-encoded for Gmail's messages.send.
//
// Sending is the one place the app produces MIME rather than consuming it,
// and it is pure string work with no service around it, which is what makes
// it testable without a database or a network.

import { Array as Arr, Option } from "effect";

import { Base64Url } from "./Gmail";

// BASE64
//
// NOTE: Gmail's `raw` field is BASE64URL (RFC 4648 §5, the -/_ alphabet),
// while the transfer encoding *inside* the message is ordinary base64. Both
// live here, and the brand is what keeps the two apart at call sites.

const utf8Encoder = new TextEncoder();

// btoa takes a binary string, and spreading a large array into
// String.fromCharCode overflows the argument limit, so this walks in chunks.
const CHUNK_SIZE = 0x8000;

const bytesToBinaryString = (bytes: Uint8Array): string =>
  Arr.makeBy(Math.ceil(bytes.length / CHUNK_SIZE), (chunk) =>
    String.fromCharCode(
      ...bytes.subarray(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE),
    ),
  ).join("");

const bytesToBase64 = (bytes: Uint8Array): string =>
  btoa(bytesToBinaryString(bytes));

/** Gmail body payloads are base64url; atob() without the translation
 *  corrupts them. The inverse of {@link bytesToBase64Url}. */
export const base64UrlToBytes = (data: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );

export const bytesToBase64Url = (bytes: Uint8Array): Base64Url =>
  Base64Url.make(
    bytesToBase64(bytes)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
  );

// HEADERS

// RFC 2045 caps an encoded line at 76 characters.
const BASE64_LINE_LENGTH = 76;
const BASE64_LINE = new RegExp(`.{1,${BASE64_LINE_LENGTH}}`, "g");

const wrapBase64 = (encoded: string): string =>
  (encoded.match(BASE64_LINE) ?? []).join("\r\n");

const isAscii = (text: string): boolean =>
  // eslint-disable-next-line no-control-regex
  /^[\x00-\x7F]*$/.test(text);

// An RFC 2047 encoded-word may not exceed 75 characters including its
// `=?UTF-8?B?` … `?=` wrapper, so a long subject becomes several of them.
// Chunking is by code point rather than by byte: splitting a character in
// half produces a word that decodes to a replacement glyph.
const ENCODED_WORD_OVERHEAD = "=?UTF-8?B??=".length;
const ENCODED_WORD_LIMIT = 75;
const MAX_ENCODED_BYTES =
  Math.floor((ENCODED_WORD_LIMIT - ENCODED_WORD_OVERHEAD) / 4) * 3;

const chunkByEncodedSize = (text: string): ReadonlyArray<string> => {
  const folded = Arr.reduce(
    [...text],
    { chunks: [] as ReadonlyArray<string>, current: "" },
    ({ chunks, current }, character) => {
      const candidate = current + character;
      return utf8Encoder.encode(candidate).length > MAX_ENCODED_BYTES
        ? { chunks: Arr.append(chunks, current), current: character }
        : { chunks, current: candidate };
    },
  );
  return folded.current === ""
    ? folded.chunks
    : Arr.append(folded.chunks, folded.current);
};

/** A header value safe to put on the wire: plain when it is ASCII, RFC 2047
 *  encoded-words when it isn't. */
export const encodeHeaderValue = (value: string): string =>
  isAscii(value)
    ? value
    : chunkByEncodedSize(value)
        .map(
          (chunk) => `=?UTF-8?B?${bytesToBase64(utf8Encoder.encode(chunk))}?=`,
        )
        // A continuation is a folded line: CRLF then whitespace.
        .join("\r\n ");

// BODY

export type OutgoingMessage = Readonly<{
  from: string;
  to: ReadonlyArray<string>;
  subject: string;
  /** The composed source, sent verbatim as the text/plain alternative:
   *  markdown is meant to be readable as itself. */
  bodyMarkdown: string;
  /** The same body rendered (markdown.ts), as the text/html alternative. */
  bodyHtml: string;
  maybeInReplyTo: Option.Option<string>;
  /** The References header of the reply, already assembled. Empty for a new
   *  message. */
  references: string;
  /** The multipart separator. A parameter rather than generated here so the
   *  builder stays pure — the caller draws the randomness. */
  boundary: string;
}>;

const alternativePart = (
  boundary: string,
  contentType: string,
  content: string,
): string =>
  [
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(bytesToBase64(utf8Encoder.encode(content))),
    "",
  ].join("\r\n");

/**
 * The complete message. Both alternatives are base64, which sidesteps the
 * line-length limit and dot-stuffing rules that quoted-printable would
 * otherwise impose on every body we send.
 *
 * NOTE: No Date and no Message-ID. Gmail stamps both on the way out, and a
 * Message-ID we invented would not be the one the thread is later keyed by.
 */
export const buildRfc2822 = (message: OutgoingMessage): string => {
  const headers = [
    `From: ${encodeHeaderValue(message.from)}`,
    `To: ${message.to.map(encodeHeaderValue).join(", ")}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    ...Option.match(message.maybeInReplyTo, {
      onNone: () => [],
      onSome: (inReplyTo) => [`In-Reply-To: ${inReplyTo}`],
    }),
    ...(message.references === "" ? [] : [`References: ${message.references}`]),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${message.boundary}"`,
    "",
  ];

  return [
    ...headers,
    // Order is significant: a client picks the last alternative it can
    // render, so the richer part goes second.
    alternativePart(message.boundary, "text/plain", message.bodyMarkdown),
    alternativePart(message.boundary, "text/html", message.bodyHtml),
    `--${message.boundary}--`,
    "",
  ].join("\r\n");
};

export const toRawMessage = (rfc2822: string): Base64Url =>
  bytesToBase64Url(utf8Encoder.encode(rfc2822));

// REPLIES

/** The References header of a reply: the parent's own chain with the message
 *  being replied to appended, which is what threads it in the recipient's
 *  client (Gmail's `threadId` only threads it in ours). */
export const replyReferences = (
  parentReferences: string,
  parentMessageId: string,
): string =>
  parentReferences === ""
    ? parentMessageId
    : `${parentReferences} ${parentMessageId}`;

const REPLY_PREFIX = /^re:\s*/i;

export const replySubject = (subject: string): string =>
  REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`;
