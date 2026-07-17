// The SyncEngine: orchestrates the Gmail transport and the local SQLite
// store. Provided to the Foldkit runtime via `resources` in entry.ts, so
// commands returned from init/update (and subscriptions) can yield it.

import { Context, Effect, Layer, Schema as S } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  Gmail,
  LabelId,
  ThreadId,
  type GmailError,
  type Message as GmailMessage,
  type Thread as GmailThread,
} from "./Gmail";
import { SqlLive } from "./sql";

// Gmail's inbox tab categories, as they appear in system label ids
// (CATEGORY_PERSONAL etc.). "none" = the message carries no category
// label (common for mail that skipped the inbox).
export const ThreadCategory = S.Literals([
  "personal",
  "promotions",
  "social",
  "updates",
  "forums",
  "none",
]);
export type ThreadCategory = typeof ThreadCategory.Type;

// One inbox list row — everything the list view paints, nothing more.
// `date` is epoch milliseconds; `unread` is real (derived from the UNREAD
// system label on the thread's messages).
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

// What the SELECT below returns; decoded then mapped onto ThreadRow. A
// mismatch is a bug in our own schema/DDL pair, hence orDie at the call.
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

// HEADER EXTRACTION (runs once at sync time; the database stores results)

const headerValue = (message: GmailMessage, name: string): string | undefined =>
  message.payload?.headers?.find((header) => header.name.toLowerCase() === name)
    ?.value;

// `"Ada Lovelace" <ada@example.com>` → `Ada Lovelace`; bare addresses
// stay as-is.
const displayName = (from: string): string => {
  const beforeAngle = from.split("<")[0]?.trim() ?? "";
  const unquoted = beforeAngle.replace(/^"(.*)"$/, "$1").trim();
  return unquoted === "" ? from.trim() : unquoted;
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
                : [displayName(headerValue(latest, "from") ?? "")],
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

      // First slice of the sync loop: one page of inbox threads, headers
      // fetched in metadata format (no bodies), persisted locally — then
      // the UI rows are read back *from the database*, so the list always
      // renders the local store, never the network response directly.
      const loadInbox = Effect.gen(function* () {
        const page = yield* gmail.listThreads({
          labelIds: [INBOX],
          maxResults: PULL_LIMIT,
        });
        const stubs = page.threads ?? [];

        yield* Effect.forEach(
          stubs,
          (stub) =>
            gmail
              .getThread(stub.id, "metadata")
              .pipe(Effect.flatMap(upsertThread)),
          { concurrency: 4 },
        );

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

      return { loadInbox } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(Gmail.layer, SqlLive)),
  );
}

export type LoadInboxError = GmailError | SqlError;
