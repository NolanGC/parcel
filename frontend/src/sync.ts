// The SyncEngine: pulls one page of inbox threads from Gmail into a local
// SQLite store and serves all reads (inbox list, open thread) from it.
// Provided to the Foldkit runtime via `resources` in entry.ts.

import { Context, Effect, Layer, Schema as S } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  Gmail,
  LabelId,
  MessageId,
  ThreadId,
  type GmailError,
  type Message as GmailMessage,
  type MessagePart,
  type Thread as GmailThread,
} from "./Gmail";
import { SqlLive } from "./sql";

// Gmail's inbox tab categories, as they appear in system label ids
// (CATEGORY_PERSONAL etc.). "none" = no category label on the thread.
export const ThreadCategory = S.Literals([
  "personal",
  "promotions",
  "social",
  "updates",
  "forums",
  "none",
]);
export type ThreadCategory = typeof ThreadCategory.Type;

// One inbox list row. `date` is epoch milliseconds.
export const ThreadRow = S.Struct({
  id: ThreadId,
  subject: S.String,
  sender: S.String,
  snippet: S.String,
  date: S.Number,
  unread: S.Boolean,
  category: ThreadCategory,
});
export type ThreadRow = typeof ThreadRow.Type;

export const BodyKind = S.Literals(["html", "plain"]);
export type BodyKind = typeof BodyKind.Type;

export const MessageDetail = S.Struct({
  id: MessageId,
  fromName: S.String,
  fromEmail: S.String,
  date: S.Number,
  bodyKind: BodyKind,
  body: S.String,
});
export type MessageDetail = typeof MessageDetail.Type;

export const ThreadDetail = S.Struct({
  id: ThreadId,
  subject: S.String,
  messages: S.Array(MessageDetail),
});
export type ThreadDetail = typeof ThreadDetail.Type;

// What the SELECTs below return. A mismatch is a bug in our own
// schema/DDL pair, hence orDie at the call sites.
const DbThreadRow = S.Struct({
  id: ThreadId,
  subject: S.String,
  snippet: S.String,
  participants: S.String,
  latest_date: S.Number,
  is_unread: S.Number,
  category: ThreadCategory,
});
const decodeDbRows = S.decodeUnknownEffect(S.Array(DbThreadRow));

const DbMessageRow = S.Struct({
  id: MessageId,
  internal_date: S.Number,
  from_name: S.String,
  from_email: S.String,
});
const decodeDbMessages = S.decodeUnknownEffect(S.Array(DbMessageRow));

const DbBodyRow = S.Struct({
  message_id: MessageId,
  mime_type: S.String,
  body: S.String,
});
const decodeDbBodies = S.decodeUnknownEffect(S.Array(DbBodyRow));

const DbImageRow = S.Struct({
  message_id: MessageId,
  content_id: S.String,
  mime_type: S.String,
  bytes: S.instanceOf(Uint8Array),
});
const decodeDbImages = S.decodeUnknownEffect(S.Array(DbImageRow));

const DbSubjectRow = S.Struct({ subject: S.String });
const decodeDbSubjects = S.decodeUnknownEffect(S.Array(DbSubjectRow));

// Gmail body payloads are BASE64URL (-/_ alphabet), not btoa's +/.
const base64UrlToBytes = (data: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const utf8 = new TextDecoder();

// MIME TREE WALKING

const headerValue = (message: GmailMessage, name: string): string | undefined =>
  message.payload?.headers?.find((header) => header.name.toLowerCase() === name)
    ?.value;

const partHeader = (part: MessagePart, name: string): string | undefined =>
  part.headers?.find((header) => header.name.toLowerCase() === name)?.value;

const flattenParts = (part: MessagePart): ReadonlyArray<MessagePart> => [
  part,
  ...(part.parts ?? []).flatMap(flattenParts),
];

// The displayable body: prefer text/html, fall back to text/plain.
const displayPart = (message: GmailMessage): MessagePart | undefined => {
  if (message.payload === undefined) return undefined;
  const parts = flattenParts(message.payload);
  return (
    parts.find((p) => p.mimeType === "text/html" && p.body?.data) ??
    parts.find((p) => p.mimeType === "text/plain" && p.body?.data)
  );
};

// Inline images: image parts carrying a Content-ID, referenced from the
// html as `cid:<id>`. The stored content_id drops the RFC angle brackets.
type InlineImage = {
  readonly contentId: string;
  readonly mimeType: string;
  readonly part: MessagePart;
};

const inlineImages = (message: GmailMessage): ReadonlyArray<InlineImage> => {
  if (message.payload === undefined) return [];
  return flattenParts(message.payload).flatMap((part) => {
    const contentId = partHeader(part, "content-id");
    if (
      contentId === undefined ||
      part.mimeType === undefined ||
      !part.mimeType.startsWith("image/")
    ) {
      return [];
    }
    return [
      {
        contentId: contentId.replace(/^</, "").replace(/>$/, ""),
        mimeType: part.mimeType,
        part,
      },
    ];
  });
};

// `"Ada Lovelace" <ada@example.com>` → { name, email }; bare addresses
// use the address as both.
const parseFrom = (from: string): { name: string; email: string } => {
  const email = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const beforeAngle = from.split("<")[0]?.trim() ?? "";
  const unquoted = beforeAngle.replace(/^"(.*)"$/, "$1").trim();
  return { name: unquoted === "" ? email : unquoted, email };
};

const UNREAD_LABEL = "UNREAD";
const CATEGORY_PREFIX = "CATEGORY_";

const threadCategory = (
  messages: ReadonlyArray<GmailMessage>,
): ThreadCategory => {
  for (const message of messages) {
    const label = message.labelIds?.find((id) =>
      id.startsWith(CATEGORY_PREFIX),
    );
    if (label !== undefined) {
      const category = label.slice(CATEGORY_PREFIX.length).toLowerCase();
      const decoded = S.decodeUnknownOption(ThreadCategory)(category);
      if (decoded._tag === "Some") return decoded.value;
    }
  }
  return "none";
};

const latestDate = (messages: ReadonlyArray<GmailMessage>): number =>
  messages.reduce((max, message) => {
    const date = Number(message.internalDate ?? "0");
    return Number.isFinite(date) && date > max ? date : max;
  }, 0);

// SERVICE

const INBOX = LabelId.make("INBOX");
const PULL_LIMIT = 15;

export class SyncEngine extends Context.Service<SyncEngine>()(
  "parcel/SyncEngine",
  {
    make: Effect.gen(function* () {
      const gmail = yield* Gmail;
      const sql = yield* SqlClient.SqlClient;

      const upsertThread = (thread: GmailThread) => {
        const messages = thread.messages ?? [];
        const latest = messages[messages.length - 1];
        return sql`INSERT OR REPLACE INTO threads ${sql.insert([
          {
            id: thread.id,
            history_id: thread.historyId ?? null,
            subject:
              latest === undefined
                ? ""
                : (headerValue(latest, "subject") ?? ""),
            snippet: thread.snippet ?? latest?.snippet ?? "",
            participants: JSON.stringify(
              latest === undefined
                ? []
                : [parseFrom(headerValue(latest, "from") ?? "").name],
            ),
            latest_date: latestDate(messages),
            message_count: messages.length,
            is_unread: messages.some((message) =>
              message.labelIds?.some((id) => id === UNREAD_LABEL),
            )
              ? 1
              : 0,
            category: threadCategory(messages),
          },
        ])}`;
      };

      const upsertMessage = (threadId: ThreadId, message: GmailMessage) => {
        const from = parseFrom(headerValue(message, "from") ?? "");
        return sql`INSERT OR REPLACE INTO messages ${sql.insert([
          {
            id: message.id,
            thread_id: threadId,
            internal_date: Number(message.internalDate ?? "0"),
            from_name: from.name,
            from_email: from.email,
            to_json: JSON.stringify(headerValue(message, "to") ?? ""),
            subject: headerValue(message, "subject") ?? "",
            snippet: message.snippet ?? "",
            has_attachments: (message.payload?.parts ?? []).some(
              (part) => (part.filename ?? "") !== "",
            )
              ? 1
              : 0,
          },
        ])}`;
      };

      const upsertBody = (message: GmailMessage) =>
        Effect.gen(function* () {
          const part = displayPart(message);
          const data = part?.body?.data;
          if (part === undefined || data === undefined) return;
          yield* sql`INSERT OR REPLACE INTO message_bodies ${sql.insert([
            {
              message_id: message.id,
              mime_type: part.mimeType ?? "text/plain",
              body: utf8.decode(base64UrlToBytes(data)),
            },
          ])}`;
        });

      // Inline image bytes: small ones ride along in the payload, larger
      // ones need the attachments endpoint.
      const upsertInlineImages = (message: GmailMessage) =>
        Effect.forEach(
          inlineImages(message),
          (image) =>
            Effect.gen(function* () {
              const inline = image.part.body?.data;
              const attachmentId = image.part.body?.attachmentId;
              const data =
                inline ??
                (attachmentId === undefined
                  ? undefined
                  : (yield* gmail.getAttachment(message.id, attachmentId))
                      .data);
              if (data === undefined) return;
              yield* sql`INSERT OR REPLACE INTO message_attachments ${sql.insert(
                [
                  {
                    message_id: message.id,
                    content_id: image.contentId,
                    mime_type: image.mimeType,
                    bytes: base64UrlToBytes(data),
                  },
                ],
              )}`;
            }),
          { concurrency: 2 },
        );

      const syncThread = (id: ThreadId) =>
        Effect.gen(function* () {
          const thread = yield* gmail.getThread(id, "full");
          yield* upsertThread(thread);
          yield* Effect.forEach(thread.messages ?? [], (message) =>
            Effect.all([
              upsertMessage(thread.id, message),
              upsertBody(message),
              upsertInlineImages(message),
            ]),
          );
        });

      // The network pass: one page of inbox threads, fetched in full
      // format and persisted with everything the UI needs to display them.
      const syncInbox = Effect.gen(function* () {
        const page = yield* gmail.listThreads({
          labelIds: [INBOX],
          maxResults: PULL_LIMIT,
        });
        yield* Effect.forEach(
          page.threads ?? [],
          (stub) => syncThread(stub.id),
          { concurrency: 4 },
        );
      });

      const selectInbox = Effect.gen(function* () {
        const raw = yield* sql`
          SELECT id, subject, snippet, participants, latest_date, is_unread, category
          FROM threads
          ORDER BY latest_date DESC
          LIMIT ${PULL_LIMIT}
        `;
        const rows = yield* decodeDbRows(raw).pipe(Effect.orDie);
        return rows.map(
          (row): ThreadRow => ({
            id: row.id,
            subject: row.subject,
            sender: (JSON.parse(row.participants) as string[])[0] ?? "",
            snippet: row.snippet,
            date: row.latest_date,
            unread: row.is_unread !== 0,
            category: row.category,
          }),
        );
      });

      // Local-first: a synced store answers straight from SQLite; only an
      // empty store triggers the sync pass first.
      const loadInbox = Effect.gen(function* () {
        const local = yield* selectInbox;
        if (local.length > 0) return local;
        yield* syncInbox;
        return yield* selectInbox;
      });

      // Inline image bytes reach the html as blob: urls (not data: URIs —
      // inlining megabytes of base64 into the body string is slow and can
      // OOM the tab). Each thread's urls are revoked on its next load.
      const threadObjectUrls = new Map<ThreadId, Array<string>>();
      const registerObjectUrl = (
        registry: Array<string>,
        mimeType: string,
        bytes: Uint8Array,
      ): string => {
        const url = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
        );
        registry.push(url);
        return url;
      };

      // Opening a thread: SQLite only.
      const loadThread = (id: ThreadId) =>
        Effect.gen(function* () {
          const subjectRaw = yield* sql`
            SELECT subject FROM threads WHERE id = ${id}
          `;
          const subject =
            (yield* decodeDbSubjects(subjectRaw).pipe(Effect.orDie))[0]
              ?.subject ?? "";

          const rowsRaw = yield* sql`
            SELECT id, internal_date, from_name, from_email
            FROM messages
            WHERE thread_id = ${id}
            ORDER BY internal_date ASC
          `;
          const rows = yield* decodeDbMessages(rowsRaw).pipe(Effect.orDie);

          for (const url of threadObjectUrls.get(id) ?? []) {
            URL.revokeObjectURL(url);
          }
          const objectUrls: Array<string> = [];
          threadObjectUrls.set(id, objectUrls);

          const messages = yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const bodyRaw = yield* sql`
                SELECT message_id, mime_type, body
                FROM message_bodies
                WHERE message_id = ${row.id}
              `;
              const stored = (yield* decodeDbBodies(bodyRaw).pipe(
                Effect.orDie,
              ))[0];
              const imagesRaw = yield* sql`
                SELECT message_id, content_id, mime_type, bytes
                FROM message_attachments
                WHERE message_id = ${row.id}
              `;
              const images = yield* decodeDbImages(imagesRaw).pipe(
                Effect.orDie,
              );

              let body = stored?.body ?? "";
              for (const image of images) {
                body = body.replaceAll(
                  `cid:${image.content_id}`,
                  registerObjectUrl(objectUrls, image.mime_type, image.bytes),
                );
              }

              return {
                id: row.id,
                fromName: row.from_name,
                fromEmail: row.from_email,
                date: row.internal_date,
                bodyKind: (stored?.mime_type === "text/html"
                  ? "html"
                  : "plain") satisfies BodyKind,
                body,
              } satisfies MessageDetail;
            }),
          );

          return { id, subject, messages } satisfies ThreadDetail;
        });

      return { loadInbox, loadThread, syncInbox } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(Gmail.layer, SqlLive)),
  );
}

export type LoadInboxError = GmailError | SqlError;
export type LoadThreadError = SqlError;
