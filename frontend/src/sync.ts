// The SyncEngine: Gmail → local SQLite, serving every read from the store.
// syncMachine.ts drives the network passes.

import {
  Array as Arr,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schema as S,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ts } from "foldkit/schema";

import {
  Gmail,
  DRAFT_LABEL,
  HistoryId,
  INBOX_LABEL,
  LabelId,
  MessageId,
  SENT_LABEL,
  SPAM_LABEL,
  STARRED_LABEL,
  ThreadId,
  TRASH_LABEL,
  UNREAD_LABEL,
  type GmailError,
  type History as GmailHistory,
  type ListHistoryResponse,
  type Message as GmailMessage,
  type MessagePart,
  type PageToken,
  type Thread as GmailThread,
} from "./Gmail";
import {
  BodyCodec,
  Compression,
  CompressionError,
  type CompressedBody,
} from "./compression";
import { emailHtmlToMarkdown } from "./emailMarkdown";
import {
  IMAGE_CONCURRENCY,
  ImageFetcher,
  remoteImageUrls,
  type FetchedImage,
} from "./images";
import { renderEmailMarkdownToHtml } from "./markdown";
import { prepareBody } from "./sanitizeBody";
import {
  avatarUrl,
  domainKey,
  faviconUrl,
  logoDomains,
  personKey,
  registerAvatar,
} from "./avatars";
import { People } from "./People";
import {
  BOOT_ENGINE_READY,
  BOOT_ENGINE_START,
  BOOT_QUERY_END,
  BOOT_QUERY_START,
  logBootReport,
  mark,
} from "./bootMarks";
import { base64UrlToBytes } from "./mime";
import { OutboxEngine } from "./outboxEngine";
import { cleanSnippet } from "./snippet";
import { SqlLive } from "./sql";
import { HOT_THREAD_COUNT, OPENED_LRU_COUNT } from "./tiers";

// As they appear in system label ids (CATEGORY_PERSONAL etc.).
export const ThreadCategory = S.Literals([
  "personal",
  "promotions",
  "social",
  "updates",
  "forums",
  "none",
]);
export type ThreadCategory = typeof ThreadCategory.Type;

/** The mailboxes the folder menu can show. Each is a slice of the threads
 *  table, decided by the system-label flags extracted at sync time. */
export const Folder = S.Literals([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "all",
]);
export type Folder = typeof Folder.Type;

// Which slice of the threads table each folder is. Spam and trash are their
// own places and excluded everywhere else, mirroring Gmail's own semantics
// ("All Mail" hides both).
const FOLDER_WHERE: Record<Folder, string> = {
  inbox: "in_inbox = 1 AND is_spam = 0 AND is_trash = 0",
  starred: "is_starred = 1 AND is_spam = 0 AND is_trash = 0",
  sent: "is_sent = 1 AND is_spam = 0 AND is_trash = 0",
  drafts: "is_draft = 1 AND is_spam = 0 AND is_trash = 0",
  spam: "is_spam = 1",
  trash: "is_trash = 1",
  all: "is_spam = 0 AND is_trash = 0",
};

/**
 * What the tabs and the folder menu put next to their labels.
 *
 * NOTE: Counted in SQL over the whole store, never from the rows in the Model.
 * The list holds one folder's newest HOT_THREAD_COUNT, so counting those gives
 * a number that is capped at the window size, changes when you switch folder,
 * and agrees with Gmail only on a small mailbox — which reads exactly like a
 * made-up number, because it effectively is one.
 *
 * The category counts are unread, matching Gmail's own tabs. Drafts and spam
 * are totals: neither has a meaningful unread state, and what you want to know
 * about them is how many there are.
 */
export const MailboxCounts = S.Struct({
  primary: S.Number,
  social: S.Number,
  promotions: S.Number,
  updates: S.Number,
  forums: S.Number,
  inbox: S.Number,
  drafts: S.Number,
  spam: S.Number,
});
export type MailboxCounts = typeof MailboxCounts.Type;

export const EMPTY_COUNTS: MailboxCounts = {
  primary: 0,
  social: 0,
  promotions: 0,
  updates: 0,
  forums: 0,
  inbox: 0,
  drafts: 0,
  spam: 0,
};

/** One inbox list row. `date` is epoch milliseconds. */
export const ThreadRow = S.Struct({
  id: ThreadId,
  subject: S.String,
  sender: S.String,
  /** The sender's address, which `sender` (a display name) is not. What an
   *  avatar is keyed on — see avatars.ts.
   *
   *  NOTE: A plain string, empty when unknown, rather than an Option. This
   *  struct is what inboxSnapshot.ts persists to localStorage, and an Option
   *  does not survive that JSON round-trip. */
  senderEmail: S.String,
  snippet: S.String,
  date: S.Number,
  isUnread: S.Boolean,
  isStarred: S.Boolean,
  category: ThreadCategory,
});
export type ThreadRow = typeof ThreadRow.Type;

/**
 * What a rendered body actually is, which decides how the view frames it.
 *
 *   markdown  Converted at rest and rendered by us. The sender's stylesheet
 *             was discarded on the way through, so nothing in it assumes a
 *             colour — it can sit on the app's own surface and follow the
 *             theme, like any other content in the window.
 *   html      The sender's own markup, sanitized. Its colours are baked into
 *             the message and overwhelmingly assume white behind them, so it
 *             gets a white card in both themes. Darkening it would leave grey
 *             text on near-black, which is worse than a bright card.
 *   plain     Text, rendered in a `<pre>`. Themed, same as markdown.
 */
export const BodyKind = S.Literals(["markdown", "html", "plain"]);
export type BodyKind = typeof BodyKind.Type;

export const MessageDetail = S.Struct({
  id: MessageId,
  fromName: S.String,
  fromEmail: S.String,
  date: S.Number,
  bodyKind: BodyKind,
  body: S.String,
  /** This message's own Message-ID header, and the chain it belongs to —
   *  what a reply threads against in the recipient's client (mime.ts).
   *  Empty for messages synced before the headers were extracted. */
  rfc822MessageId: S.String,
  references: S.String,
});
export type MessageDetail = typeof MessageDetail.Type;

export const ThreadDetail = S.Struct({
  id: ThreadId,
  subject: S.String,
  messages: S.Array(MessageDetail),
});
export type ThreadDetail = typeof ThreadDetail.Type;

// NOTE: A mismatch between these and the DDL is a bug in our own schema pair,
// hence orDie at the call sites. Exported because search.ts selects the same
// shape and must not drift from it.
export const THREAD_ROW_COLUMNS =
  "id, subject, snippet, participants, sender_email, latest_date, is_unread, is_starred, category";

const DbThreadRow = S.Struct({
  id: ThreadId,
  subject: S.String,
  snippet: S.String,
  participants: S.String,
  sender_email: S.String,
  latest_date: S.Number,
  is_unread: S.Number,
  is_starred: S.Number,
  category: ThreadCategory,
});
const decodeDbRows = S.decodeUnknownEffect(S.Array(DbThreadRow));

const decodeParticipants = S.decodeUnknownOption(S.Array(S.String));

const senderOf = (participants: string): string =>
  Option.getOrElse(
    Option.flatMap(decodeParticipants(JSON.parse(participants)), Arr.head),
    () => "",
  );

export const decodeThreadRows = (
  raw: unknown,
): Effect.Effect<ReadonlyArray<ThreadRow>> =>
  decodeDbRows(raw).pipe(
    Effect.orDie,
    Effect.map((rows) =>
      rows.map(
        (row): ThreadRow => ({
          id: row.id,
          subject: row.subject,
          sender: senderOf(row.participants),
          senderEmail: row.sender_email,
          snippet: cleanSnippet(row.snippet),
          date: row.latest_date,
          isUnread: row.is_unread !== 0,
          isStarred: row.is_starred !== 0,
          category: row.category,
        }),
      ),
    ),
  );

// A missing row means an empty store, not a failure, so callers name a zero.
const firstRowOr = <Row, Value>(
  rows: ReadonlyArray<Row>,
  select: (row: Row) => Value,
  fallback: Value,
): Value =>
  Option.getOrElse(Option.map(Arr.head(rows), select), () => fallback);

const DbMessageRow = S.Struct({
  id: MessageId,
  internal_date: S.Number,
  from_name: S.String,
  from_email: S.String,
  rfc822_message_id: S.String,
  references_header: S.String,
});
const decodeDbMessages = S.decodeUnknownEffect(S.Array(DbMessageRow));

const DbBodyRow = S.Struct({
  message_id: MessageId,
  mime_type: S.String,
  data: S.instanceOf(Uint8Array),
  codec: BodyCodec,
});
const decodeDbBodies = S.decodeUnknownEffect(S.Array(DbBodyRow));

// The open path and the backfill, which are the only readers that want the
// markdown. Deliberately not folded into DbBodyRow: the image pass decodes
// every body in a thread to scrape urls out of the html and has no use for a
// second copy of the message.
//
// NOTE: `markdown` and `markdown_codec` are null together or not at all, but
// the pair is decoded independently because SQLite will not enforce that. A
// half-written row reads as "no markdown" and falls back, rather than
// throwing on open.
const DbMarkdownBodyRow = S.Struct({
  ...DbBodyRow.fields,
  markdown: S.NullOr(S.instanceOf(Uint8Array)),
  markdown_codec: S.NullOr(BodyCodec),
});
type DbMarkdownBodyRow = typeof DbMarkdownBodyRow.Type;
const decodeDbMarkdownBodies = S.decodeUnknownEffect(
  S.Array(DbMarkdownBodyRow),
);

/** Written when a body cannot be converted, so it leaves the backfill queue
 *  instead of being retried forever. Zero bytes is not a markdown a message
 *  could legitimately have — an empty conversion is stored as NULL at sync
 *  time — so it needs no column of its own. */
const EMPTY_MARKDOWN = new Uint8Array(0);

/** Whether conversion has been attempted for this row at all.
 *
 *  Deliberately distinct from having produced something. An attempt that comes
 *  back empty writes the marker above, and this is what tells a later open
 *  that the emptiness is an answer rather than a gap — without it, every open
 *  of such a message would convert it again to learn the same thing. */
const isConverted = (row: DbMarkdownBodyRow): boolean =>
  row.markdown !== null && row.markdown_codec !== null;

/** The stored markdown, if this row has a usable one. Anything else — no
 *  markdown yet, a half-written pair, the marker above — reads as absent. */
const storedMarkdown = (
  row: DbMarkdownBodyRow,
): Option.Option<CompressedBody> =>
  row.markdown === null ||
  row.markdown_codec === null ||
  row.markdown.byteLength === 0
    ? Option.none()
    : Option.some({ codec: row.markdown_codec, data: row.markdown });

const DbImageRow = S.Struct({
  message_id: MessageId,
  content_id: S.String,
  mime_type: S.String,
  bytes: S.instanceOf(Uint8Array),
});
const decodeDbImages = S.decodeUnknownEffect(S.Array(DbImageRow));

const DbRemoteImageRow = S.Struct({
  url: S.String,
  mime_type: S.String,
  bytes: S.instanceOf(Uint8Array),
});
const decodeDbRemoteImages = S.decodeUnknownEffect(S.Array(DbRemoteImageRow));

const DbUrlRow = S.Struct({ url: S.String });
const decodeDbUrls = S.decodeUnknownEffect(S.Array(DbUrlRow));

const DbThreadIdRow = S.Struct({ id: ThreadId });
const decodeDbThreadIds = S.decodeUnknownEffect(S.Array(DbThreadIdRow));

const DbCutoffRow = S.Struct({ latest_date: S.Number });
const decodeDbCutoffs = S.decodeUnknownEffect(S.Array(DbCutoffRow));

const DbSubjectRow = S.Struct({ subject: S.String });
const decodeDbSubjects = S.decodeUnknownEffect(S.Array(DbSubjectRow));

const DbSyncStateRow = S.Struct({
  history_id: S.NullOr(HistoryId),
  email: S.NullOr(S.String),
  synced_count: S.Number,
  total_estimate: S.Number,
  backfill_done: S.Number,
});
const decodeDbSyncState = S.decodeUnknownEffect(S.Array(DbSyncStateRow));

const DbCountRow = S.Struct({ n: S.Number });
const decodeDbCounts = S.decodeUnknownEffect(S.Array(DbCountRow));

const DbMailboxCountsRow = S.Struct({
  primary_count: S.Number,
  social_count: S.Number,
  promotions_count: S.Number,
  updates_count: S.Number,
  forums_count: S.Number,
  inbox_count: S.Number,
  drafts_count: S.Number,
  spam_count: S.Number,
});
const decodeDbMailboxCounts = S.decodeUnknownEffect(
  S.Array(DbMailboxCountsRow),
);

const DbSenderEmailRow = S.Struct({ sender_email: S.String });
const decodeDbSenderEmails = S.decodeUnknownEffect(S.Array(DbSenderEmailRow));

const DbAvatarKeyRow = S.Struct({ key: S.String });
const decodeDbAvatarKeys = S.decodeUnknownEffect(S.Array(DbAvatarKeyRow));

const DbAvatarRow = S.Struct({
  key: S.String,
  mime_type: S.String,
  bytes: S.NullOr(S.instanceOf(Uint8Array)),
});
const decodeDbAvatars = S.decodeUnknownEffect(S.Array(DbAvatarRow));

const DbPeopleSyncedRow = S.Struct({ people_synced_at: S.Number });
const decodeDbPeopleSynced = S.decodeUnknownEffect(S.Array(DbPeopleSyncedRow));

const DbWindowCountRow = S.Struct({ total: S.Number, pending: S.Number });
const decodeDbWindowCounts = S.decodeUnknownEffect(S.Array(DbWindowCountRow));

// PRAGMA results come back named after the pragma itself.
const decodeDbPragmaCounts = S.decodeUnknownEffect(
  S.Array(S.Struct({ page_count: S.Number })),
);
const decodeDbPragmaSizes = S.decodeUnknownEffect(
  S.Array(S.Struct({ page_size: S.Number })),
);

const DbThreadHistoryRow = S.Struct({
  id: ThreadId,
  history_id: S.NullOr(HistoryId),
});
const decodeDbThreadHistories = S.decodeUnknownEffect(
  S.Array(DbThreadHistoryRow),
);

const DbMessageIdRow = S.Struct({ id: MessageId });
const decodeDbMessageIds = S.decodeUnknownEffect(S.Array(DbMessageIdRow));

// NOTE: Knowledge only. Runtime state (page tokens, retry attempts) is never
// persisted; it dies with the tab by design.
export const SyncCheckpoint = S.Struct({
  maybeHistoryId: S.Option(HistoryId),
  isBackfillDone: S.Boolean,
  syncedCount: S.Number,
  totalEstimate: S.Number,
});
export type SyncCheckpoint = typeof SyncCheckpoint.Type;

/** What primeInbox reports back to the machine. */
export type PrimeResult = Readonly<{
  historyId: HistoryId;
  syncedCount: number;
  totalEstimate: number;
}>;

/**
 * Which slice of the mailbox the backfill is walking, in the order it walks
 * them.
 *
 * Phased because the mailbox is not equally interesting. Newest-first across
 * everything means a promotions blizzard arrives ahead of the mail you
 * actually read, and on a large mailbox the Primary tab is still filling in
 * twenty minutes later.
 *
 *   primary  `in:inbox category:primary` — the tab you live in, usable
 *            within the first minute
 *   inbox    the rest of the inbox: updates, social, promotions, forums. Mail
 *            addressed to you, just not the tab you read first.
 *   rest     everything else — archived, sent, drafts, spam, trash. Reachable
 *            by search and by folder, and not what anyone is waiting on.
 *
 * NOTE: Each phase re-lists what the one before it stored rather than negating
 * the query. A negated query would have to stay in step with Gmail's own
 * classification, and the skip-scan makes the overlap nearly free: an
 * already-stored page costs one local SELECT and no fetches.
 *
 * The phase is runtime state and deliberately not checkpointed: a resumed walk
 * restarts at `primary` and skip-scans back to where it was.
 */
export const BackfillPhase = S.Literals(["primary", "inbox", "rest"]);
export type BackfillPhase = typeof BackfillPhase.Type;

/** The phase after this one, or `None` when the walk is over. The single
 *  definition of the order — the machine advances through it rather than
 *  naming phases itself. */
export const nextBackfillPhase = (
  phase: BackfillPhase,
): Option.Option<BackfillPhase> =>
  phase === "primary"
    ? Option.some("inbox")
    : phase === "inbox"
      ? Option.some("rest")
      : Option.none();

/** The tabs that are not Primary, which is the only way to ask for Primary. */
const TABBED_CATEGORIES = ["social", "promotions", "updates", "forums"];

/**
 * The Gmail `threads.list` filter for a phase.
 *
 * NOTE: Primary is spelled as a subtraction, NOT as `category:primary`. The
 * two are not the same set, and the difference is most of the inbox.
 * `category:primary` matches only what Gmail actively labelled
 * `CATEGORY_PERSONAL`; mail it never categorised at all carries no
 * `CATEGORY_*` label and matches nothing. That mail is not rare — it is where
 * plain person-to-person email lands — and it is Primary by every definition
 * the app itself uses: `threadCategory` calls it "none" and TAB_FROM_CATEGORY
 * maps "none" to the Primary tab, exactly as it maps "personal".
 *
 * Asking for `category:primary` therefore declared Primary exhausted while
 * most of it was still unfetched, and the walk moved on to the categories the
 * phases exist to defer. Subtracting the four tabbed categories asks for the
 * same set the Primary tab renders, and does it whether or not the account has
 * Gmail's tabs turned on.
 */
const PHASE_QUERY: Record<BackfillPhase, Record<string, unknown>> = {
  primary: {
    q: `in:inbox ${TABBED_CATEGORIES.map((c) => `-category:${c}`).join(" ")}`,
  },
  inbox: { q: "in:inbox" },
  rest: { includeSpamTrash: true },
};

/** The query a phase walks. Exported for the tests that pin the Primary
 *  definition to the tab's own. */
export const backfillQuery = (phase: BackfillPhase): Record<string, unknown> =>
  PHASE_QUERY[phase];

/** What one backfill page reports back to the machine. */
export type BatchResult = Readonly<{
  syncedCount: number;
  maybeNextPageToken: Option.Option<PageToken>;
}>;

/** What one image batch reports back to the page's prefetch loop.
 *
 *  `isIdle` means the queue came up empty, which is the loop's cue to slow
 *  down rather than to stop: the backfill is usually still producing threads.
 *
 *  `isRecentReady` is the milestone: the hot window is full and every thread in
 *  it has its images stored. A real crossing point rather than a gauge, because
 *  the backfill walks newest-first and only ever adds older threads, so once
 *  the store passes HOT_THREAD_COUNT the window's membership stops changing. */
export type ImageBatchResult = Readonly<{
  isIdle: boolean;
  isRecentReady: boolean;
}>;

/** What one avatar batch reports back to the page's loop.
 *
 *  `addedCount` is how many new blob urls were published — the page bumps a
 *  counter by it, which is the whole reason the view re-renders and the new
 *  faces appear. `isIdle` means nothing was resolved this turn, the loop's cue
 *  to slow down rather than stop: the backfill is usually still producing
 *  senders. */
export type AvatarBatchResult = Readonly<{
  addedCount: number;
  isIdle: boolean;
}>;

/** What one markdown backfill batch reports back to the page's loop.
 *
 *  `isIdle` means every html body in the store already has its markdown, so
 *  the loop can idle — it is the loop's cue to slow down rather than to stop,
 *  since the backfill keeps producing bodies for as long as it runs. Nothing
 *  visible changes when a batch converts, so unlike the avatar loop there is
 *  no count for the page to act on. */
export type MarkdownBatchResult = Readonly<{
  isIdle: boolean;
}>;

/** What a history pass reports back to the machine. Expired = Gmail forgot the
 *  cursor (~a week); Overflowed = more changes than per-thread re-syncs are
 *  worth, so the machine full-resyncs instead (see HISTORY_RESYNC_CAP). */
export const Applied = ts("Applied", {
  historyId: HistoryId,
  changedCount: S.Number,
  syncedAt: S.Number,
});
export const Expired = ts("Expired");
export const Overflowed = ts("Overflowed");

export const HistoryResult = S.Union([Applied, Expired, Overflowed]);
export type HistoryResult = typeof HistoryResult.Type;

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

const hasBodyOfType =
  (mimeType: string) =>
  (part: MessagePart): boolean =>
    part.mimeType === mimeType && (part.body?.data ?? "") !== "";

// The displayable body: prefer text/html, fall back to text/plain.
const displayPart = (message: GmailMessage): Option.Option<MessagePart> => {
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
type InlineImage = {
  readonly contentId: string;
  readonly mimeType: string;
  readonly part: MessagePart;
};

const toInlineImage = (part: MessagePart): Option.Option<InlineImage> => {
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

const inlineImages = (message: GmailMessage): ReadonlyArray<InlineImage> =>
  message.payload === undefined
    ? []
    : Arr.getSomes(Arr.map(flattenParts(message.payload), toInlineImage));

// `"Ada Lovelace" <ada@example.com>` → { name, email }; bare addresses use the
// address as both.
const parseFrom = (from: string): Readonly<{ name: string; email: string }> => {
  const email = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const name = (from.split("<")[0] ?? "").replace(/^"(.*)"$/, "$1").trim();
  return { name: name === "" ? email : name, email };
};

const CATEGORY_PREFIX = "CATEGORY_";

// A thread carries a flag if any of its messages does — which is how Gmail
// itself presents an unread or starred conversation in a list.
const hasLabel = (
  messages: ReadonlyArray<GmailMessage>,
  label: LabelId,
): boolean =>
  messages.some((message) => message.labelIds?.some((id) => id === label));

const decodeThreadCategory = S.decodeUnknownOption(ThreadCategory);

const messageCategory = (
  message: GmailMessage,
): Option.Option<ThreadCategory> =>
  Option.flatMap(
    Arr.findFirst(message.labelIds ?? [], (id) =>
      id.startsWith(CATEGORY_PREFIX),
    ),
    (label) =>
      decodeThreadCategory(label.slice(CATEGORY_PREFIX.length).toLowerCase()),
  );

/**
 * Which tab a thread belongs to, taken from its NEWEST categorized message.
 *
 * NOTE: Newest, not first. Gmail places a conversation by where its latest
 * message landed, and `thread.messages` arrives oldest-first — so scanning
 * forward answers with the category the thread had when it *started*. A thread
 * that began as a newsletter and turned into a real exchange reads as
 * "updates" that way, for as long as it lives.
 *
 * That is not a cosmetic mislabel. The backfill asks Gmail for the Primary
 * slice first, Gmail hands over those conversations because it agrees they are
 * Primary, and then this function files them under Updates locally. The result
 * is a Primary tab that looks empty next to a huge Updates one, and a walk
 * that appears to be fetching the wrong things while doing exactly the right
 * ones.
 *
 * Sorted explicitly rather than trusting the order the API happened to use.
 */
export const threadCategory = (
  messages: ReadonlyArray<GmailMessage>,
): ThreadCategory => {
  const newestFirst = [...messages].sort(
    (left, right) =>
      Number(right.internalDate ?? "0") - Number(left.internalDate ?? "0"),
  );
  return Option.getOrElse(
    Arr.findFirst(newestFirst, messageCategory),
    (): ThreadCategory => "none",
  );
};

const latestDate = (messages: ReadonlyArray<GmailMessage>): number =>
  Arr.reduce(messages, 0, (max, message) => {
    const date = Number(message.internalDate ?? "0");
    return Number.isFinite(date) && date > max ? date : max;
  });

// HISTORY SCAN

// NOTE: `touched` is a Set because the same thread routinely appears in
// several records of one page, and re-syncing it once is the point.
type HistoryScan = Readonly<{
  touched: ReadonlySet<ThreadId>;
  deletedMessages: ReadonlyArray<MessageId>;
  latest: HistoryId;
}>;

const emptyHistoryScan = (startHistoryId: HistoryId): HistoryScan => ({
  touched: new Set(),
  deletedMessages: [],
  latest: startHistoryId,
});

const recordThreadIds = (record: GmailHistory): ReadonlyArray<ThreadId> =>
  Arr.map(
    [
      ...(record.messagesAdded ?? []),
      ...(record.messagesDeleted ?? []),
      ...(record.labelsAdded ?? []),
      ...(record.labelsRemoved ?? []),
    ],
    ({ message }) => message.threadId,
  );

const recordDeletedMessageIds = (
  record: GmailHistory,
): ReadonlyArray<MessageId> =>
  Arr.map(record.messagesDeleted ?? [], ({ message }) => message.id);

const foldHistoryPage = (
  scan: HistoryScan,
  page: ListHistoryResponse,
): HistoryScan => {
  const records = page.history ?? [];
  return {
    touched: new Set([
      ...scan.touched,
      ...Arr.flatMap(records, recordThreadIds),
    ]),
    deletedMessages: [
      ...scan.deletedMessages,
      ...Arr.flatMap(records, recordDeletedMessageIds),
    ],
    latest: page.historyId ?? scan.latest,
  };
};

// SERVICE

// The prime page: enough to fill the first screen.
const PULL_LIMIT = 15;
// NOTE: threads.list costs 10 quota units whatever the page size, so small
// pages are pure overhead. Held at 100 rather than the 500 maximum only
// because one CompletedSyncBatch per page is also the progress tick, which at
// the ~19 threads/sec ceiling reports in every ~5s. Going higher wants
// progress decoupled from paging first.
const LIST_PAGE_SIZE = 100;
// Threads fetched and committed together. Bounds how many payloads sit in
// memory at once, and is the transaction size that stops every INSERT paying
// its own OPFS fsync.
const SYNC_CHUNK_SIZE = 25;
// NOTE: Gmail allows 250 quota units/user/sec and the token bucket in Gmail.ts
// paces to 200, so the ceiling is ~19 threads/sec (threads.get = 10 units). 20
// in flight is what it takes to reach it; the bucket, not this number, is what
// keeps us under the quota.
const SYNC_CONCURRENCY = 20;
const HISTORY_PAGE_SIZE = 500;
// Above this many changed threads, per-thread re-syncs are slower than a fresh
// skip-scan walk, so the machine resets to Priming instead.
const HISTORY_RESYNC_CAP = 100;
// Threads per image batch. Real mail carries ~13 remote images per message, so
// this is ~100 proxy fetches per pass: small enough that the pill's counter
// moves visibly, large enough that per-batch SQL overhead disappears.
const IMAGE_BATCH_THREADS = 8;
// NOTE: The eviction query is unbounded by nature, so without a cap one turn
// of a four-second loop walks the entire cold tail. Draining a slice per cycle
// keeps each turn's cost flat no matter how large the store grows.
const IMAGE_EVICT_BATCH = 64;
// Sender domains resolved per avatar pass. Smaller than the image batch
// because each is a request to a different origin — no connection reuse, so
// the tail latency is the batch's latency.
const AVATAR_BATCH_DOMAINS = 12;
// Stored avatars turned into blob urls per pass. Comfortably above the blob
// registry's own ceiling (avatars.ts), so publishing is never the thing that
// leaves a visible row without its picture.
const AVATAR_PUBLISH_LIMIT = 400;
// How stale the contacts photo map may get. Profile pictures change on the
// order of years, and the walk is a handful of requests, so once a day is
// already generous.
const PEOPLE_REFRESH_MS = 24 * 60 * 60 * 1000;
// Bodies converted to markdown per backfill turn. Unlike the image and avatar
// passes this one is bound by nothing but the CPU it runs on — the main
// thread, the one drawing the list — so the batch is sized to stay well inside
// a frame's worth of work and hand control back.
const MARKDOWN_BATCH_BODIES = 12;

export class SyncEngine extends Context.Service<SyncEngine>()(
  "parcel/SyncEngine",
  {
    make: Effect.gen(function* () {
      yield* mark(BOOT_ENGINE_START);
      const gmail = yield* Gmail;
      const sql = yield* SqlClient.SqlClient;
      const compression = yield* Compression;
      const imageFetcher = yield* ImageFetcher;
      const people = yield* People;
      const outbox = yield* OutboxEngine;
      yield* mark(BOOT_ENGINE_READY);

      // The list columns all come off the newest message in the thread, so
      // they are resolved together rather than each re-deriving it.
      const upsertThread = (thread: GmailThread) => {
        const latest = Option.match(Arr.last(thread.messages ?? []), {
          onNone: () => ({
            subject: "",
            snippet: "",
            participants: [] as ReadonlyArray<string>,
            senderEmail: "",
          }),
          onSome: (message) => {
            const from = parseFrom(headerValue(message, "from") ?? "");
            return {
              subject: headerValue(message, "subject") ?? "",
              snippet: message.snippet ?? "",
              participants: [from.name],
              // Stored beside the name because the name is not enough to key
              // an avatar on: two senders share a display name routinely, and
              // a logo belongs to a domain.
              senderEmail: from.email.toLowerCase(),
            };
          },
        });
        const messages = thread.messages ?? [];
        return sql`INSERT OR REPLACE INTO threads ${sql.insert([
          {
            id: thread.id,
            history_id: thread.historyId ?? null,
            subject: latest.subject,
            snippet: thread.snippet ?? latest.snippet,
            participants: JSON.stringify(latest.participants),
            sender_email: latest.senderEmail,
            latest_date: latestDate(messages),
            message_count: messages.length,
            is_unread: hasLabel(messages, UNREAD_LABEL) ? 1 : 0,
            is_starred: hasLabel(messages, STARRED_LABEL) ? 1 : 0,
            // Archiving is just the removal of this label, so re-reading it
            // on every sync is what lets a thread leave the local inbox.
            in_inbox: hasLabel(messages, INBOX_LABEL) ? 1 : 0,
            is_sent: hasLabel(messages, SENT_LABEL) ? 1 : 0,
            is_draft: hasLabel(messages, DRAFT_LABEL) ? 1 : 0,
            is_spam: hasLabel(messages, SPAM_LABEL) ? 1 : 0,
            is_trash: hasLabel(messages, TRASH_LABEL) ? 1 : 0,
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
            // Kept verbatim, angle brackets included: a reply puts these
            // straight back on the wire.
            rfc822_message_id: headerValue(message, "message-id") ?? "",
            references_header: headerValue(message, "references") ?? "",
            has_attachments: (message.payload?.parts ?? []).some(
              (part) => (part.filename ?? "") !== "",
            )
              ? 1
              : 0,
          },
        ])}`;
      };

      // Html → the markdown the message is displayed from, ready to store.
      //
      // `None` means there is nothing worth keeping, and the reader falls back
      // to the html. The converter is total and answers "" for input it can
      // make nothing of; storing that would render every such message blank.
      //
      // NOTE: Deliberately NOT called while a thread is being synced, even
      // though that is where the html arrives and where it would be free of a
      // second decompression. Conversion is pure CPU on the main thread — the
      // one drawing the list — and a backfill is already saturating it, so
      // paying per message during the walk is felt as lag on a mailbox large
      // enough for any of this to matter. The backfill loop below does the
      // work instead, when the sync has gone quiet.
      //
      // DOMParser is what makes it main-thread-only: it does not exist in a
      // worker, so this cannot be moved off the UI thread as it stands.
      const compressMarkdown = (
        html: string,
      ): Effect.Effect<Option.Option<CompressedBody>> =>
        Effect.suspend(() => {
          const markdown = emailHtmlToMarkdown(html);
          return markdown === ""
            ? Effect.succeed(Option.none<CompressedBody>())
            : compression.compress(markdown).pipe(Effect.orDie, Effect.asSome);
        });

      // NOTE: orDie on compress. This gzips a string we just decoded
      // ourselves, so a failure is the platform misbehaving rather than
      // anything a sync retry could fix, and keeping it out of the error
      // channel stops CompressionError leaking into every sync signature.
      const upsertBody = (message: GmailMessage) =>
        Option.match(displayPart(message), {
          onNone: () => Effect.void,
          onSome: (part) =>
            Effect.gen(function* () {
              const data = part.body?.data;
              if (data === undefined) {
                return;
              }
              const body = yield* compression
                .compress(utf8.decode(base64UrlToBytes(data)))
                .pipe(Effect.orDie);
              // Markdown is left NULL for the backfill loop to fill in. The
              // walk stays as cheap as it was before markdown existed.
              yield* sql`INSERT OR REPLACE INTO message_bodies ${sql.insert([
                {
                  message_id: message.id,
                  mime_type: part.mimeType ?? "text/plain",
                  data: body.data,
                  codec: body.codec,
                  markdown: null,
                  markdown_codec: null,
                },
              ])}`;
            }),
        });

      // NOTE: Resolved during the fetch phase so the write phase is pure SQL.
      // A transaction must never be held open across a network round-trip.
      const resolveInlineImages = (message: GmailMessage) =>
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
              return data === undefined
                ? []
                : [
                    {
                      message_id: message.id,
                      content_id: image.contentId,
                      mime_type: image.mimeType,
                      bytes: base64UrlToBytes(data),
                    },
                  ];
            }),
          { concurrency: 2 },
        ).pipe(Effect.map((groups) => groups.flat()));

      type FetchedThread = Readonly<{
        thread: GmailThread;
        images: ReadonlyArray<{
          message_id: MessageId;
          content_id: string;
          mime_type: string;
          bytes: Uint8Array;
        }>;
      }>;

      // `None` means Gmail 404'd it: the thread is gone, so the caller drops
      // the local copy.
      const fetchThread = (
        id: ThreadId,
      ): Effect.Effect<Option.Option<FetchedThread>, GmailError> =>
        Effect.gen(function* () {
          const thread = yield* gmail.getThread(id, "full");
          const images = yield* Effect.forEach(
            thread.messages ?? [],
            resolveInlineImages,
          ).pipe(Effect.map((groups) => groups.flat()));
          return Option.some<FetchedThread>({ thread, images });
        }).pipe(
          Effect.catchTag("GmailNotFound", () =>
            Effect.succeed(Option.none<FetchedThread>()),
          ),
        );

      const persistThread = ({ thread, images }: FetchedThread) =>
        Effect.gen(function* () {
          yield* upsertThread(thread);
          yield* Effect.forEach(thread.messages ?? [], (message) =>
            Effect.gen(function* () {
              yield* upsertMessage(thread.id, message);
              yield* upsertBody(message);
            }),
          );
          yield* Effect.forEach(
            images,
            (image) =>
              sql`INSERT OR REPLACE INTO message_attachments ${sql.insert([image])}`,
          );
        });

      // NOTE: Fetch concurrently, then commit one transaction per chunk.
      // Splitting the phases is what keeps the network out of the transaction,
      // and what makes the transaction worth having: an fsync per chunk rather
      // than per INSERT.
      const syncThreads = (ids: ReadonlyArray<ThreadId>) =>
        Effect.forEach(
          Arr.chunksOf(ids, SYNC_CHUNK_SIZE),
          (group) =>
            Effect.forEach(
              group,
              (id) =>
                fetchThread(id).pipe(
                  Effect.map((maybeFetched) => ({ id, maybeFetched })),
                ),
              { concurrency: SYNC_CONCURRENCY },
            ).pipe(
              Effect.flatMap((fetched) =>
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* Effect.forEach(
                      fetched,
                      ({ id, maybeFetched }) =>
                        Option.match(maybeFetched, {
                          onNone: () => deleteThreadLocal(id),
                          onSome: persistThread,
                        }),
                      { discard: true },
                    );
                    // NOTE: What was just written is the mailbox as Gmail
                    // currently sees it — a mailbox where the queued ops have
                    // not happened. Without re-applying them in the same
                    // transaction, archiving a thread and then catching up
                    // puts it back in the list until the op drains, and the
                    // optimistic update reads as a bug.
                    yield* outbox.reapplyPendingLabelOps;
                  }),
                ),
              ),
            ),
          { discard: true },
        );

      const countLocalThreads = Effect.gen(function* () {
        const raw = yield* sql`SELECT COUNT(*) AS n FROM threads`;
        const rows = yield* decodeDbCounts(raw).pipe(Effect.orDie);
        return firstRowOr(rows, (row) => row.n, 0);
      });

      // On-disk size of the local store, from SQLite's own page accounting.
      // Surfaced in the sync pill's detail because a local-first client that
      // quietly grows to a gigabyte should say so where you can see it.
      const localSizeBytes = Effect.gen(function* () {
        const pageCount = yield* sql`PRAGMA page_count`;
        const pageSize = yield* sql`PRAGMA page_size`;
        const counts = yield* decodeDbPragmaCounts(pageCount).pipe(
          Effect.orDie,
        );
        const sizes = yield* decodeDbPragmaSizes(pageSize).pipe(Effect.orDie);
        return (
          firstRowOr(counts, (row) => row.page_count, 0) *
          firstRowOr(sizes, (row) => row.page_size, 0)
        );
      });

      // The stubs from a threads.list page the store has never seen. A page of
      // already-stored threads costs one local SELECT and no fetches, which is
      // what makes restarting the walk from the top cheap on resume.
      //
      // NOTE: Membership, deliberately, not a historyId comparison. Keeping
      // threads current is applyHistory's job and is correct by construction,
      // since primeInbox captures the cursor before the walk starts. Comparing
      // historyIds added no correctness and, whenever the two disagreed,
      // silently re-downloaded the whole mailbox on every resume. Safe because
      // persistThread writes a thread and its messages in one transaction, so
      // "we have this id" means the thread is complete.
      const unseenThreadIds = (stubs: ReadonlyArray<GmailThread>) =>
        Effect.gen(function* () {
          if (Arr.isReadonlyArrayEmpty(stubs)) {
            return [];
          }
          const raw = yield* sql`
            SELECT id, history_id FROM threads
            WHERE ${sql.in(
              "id",
              stubs.map((stub) => stub.id),
            )}
          `;
          const rows = yield* decodeDbThreadHistories(raw).pipe(Effect.orDie);
          const local = new Set(rows.map((row) => row.id));
          return stubs
            .filter((stub) => !local.has(stub.id))
            .map((stub) => stub.id);
        });

      // MACHINE PASSES

      // Every local table, in foreign-key order. Used when the signed-in
      // account changes: the store is one mailbox's worth of data keyed by
      // nothing, so the only safe response to a different owner is to drop
      // all of it.
      const deleteAllLocal = sql.withTransaction(
        Effect.forEach(
          [
            "message_attachments",
            "message_images",
            "message_bodies",
            "message_labels",
            "messages",
            "threads",
            "labels",
            "outbox",
            "sync_state",
          ],
          (table) => sql`DELETE FROM ${sql.literal(table)}`,
          { discard: true },
        ),
      );

      // NOTE: `accountEmail` is the signed-in address from the session, not
      // from Gmail. A network call here could fail, and failing open would
      // render the previous account's mail to whoever just signed in. The OPFS
      // database is per-origin and holds exactly one mailbox with no owner
      // column, so a mismatch is not a merge problem. Wipe and re-prime.
      const readCheckpoint = (accountEmail: string) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT history_id, email, synced_count, total_estimate, backfill_done
            FROM sync_state WHERE id = 1
          `;
          const rows = yield* decodeDbSyncState(raw).pipe(Effect.orDie);
          const maybeRow = Arr.head(rows);
          if (Option.isNone(maybeRow)) {
            return Option.none<SyncCheckpoint>();
          }
          const row = maybeRow.value;

          if (row.email !== null && row.email !== accountEmail) {
            yield* Effect.logInfo(
              "mailbox owner changed; clearing local store",
            );
            yield* deleteAllLocal;
            return Option.none<SyncCheckpoint>();
          }

          // NOTE: total_estimate is otherwise only ever written by primeInbox,
          // and a mailbox resuming mid-backfill never re-primes, so it would
          // keep whatever number the last prime wrote. Refreshed once per boot,
          // best-effort: a progress denominator is not worth failing a boot over.
          const totalEstimate = yield* gmail.getProfile.pipe(
            Effect.map((profile) => profile.threadsTotal),
            Effect.catchCause(() => Effect.succeed(row.total_estimate)),
          );
          if (totalEstimate !== row.total_estimate) {
            yield* sql`
              UPDATE sync_state SET total_estimate = ${totalEstimate} WHERE id = 1
            `;
          }

          return Option.some<SyncCheckpoint>({
            maybeHistoryId: Option.fromNullishOr(row.history_id),
            isBackfillDone: row.backfill_done !== 0,
            syncedCount: row.synced_count,
            totalEstimate,
          });
        });

      // The first-screen pass: capture the history cursor before pulling
      // anything, sync the newest page, stamp the checkpoint.
      // NOTE: The cursor is captured first so the first applyHistory replays
      // every change that lands during the long backfill.
      const primeInbox: Effect.Effect<PrimeResult, GmailError | SqlError> =
        Effect.gen(function* () {
          const profile = yield* gmail.getProfile;
          // The backfill walks the entire mailbox (see syncBatch), so the
          // profile's own thread count is the denominator. The prime page
          // narrows harder than that: the boot view is the Primary tab, and
          // these 15 threads exist to fill its first screen. Listing the whole
          // inbox instead can spend all fifteen on a promotions blizzard and
          // leave the first screen you ever see empty.
          const totalEstimate = profile.threadsTotal;
          const page = yield* gmail.listThreads({
            ...PHASE_QUERY.primary,
            maxResults: PULL_LIMIT,
          });
          yield* syncThreads(yield* unseenThreadIds(page.threads ?? []));
          const syncedCount = yield* countLocalThreads;
          const syncedAt = yield* Clock.currentTimeMillis;
          yield* sql`
          INSERT INTO sync_state (id, history_id, email, last_synced_at, synced_count, total_estimate, backfill_done)
          VALUES (1, ${profile.historyId}, ${profile.emailAddress}, ${syncedAt}, ${syncedCount}, ${totalEstimate}, 0)
          ON CONFLICT (id) DO UPDATE SET
            history_id = excluded.history_id,
            email = excluded.email,
            last_synced_at = excluded.last_synced_at,
            synced_count = excluded.synced_count,
            total_estimate = excluded.total_estimate,
            backfill_done = 0
        `;
          return {
            historyId: profile.historyId,
            syncedCount,
            totalEstimate,
          };
        });

      // One backfill page: list LIST_PAGE_SIZE stubs, fetch only the stale
      // ones, stamp progress. The checkpoint stores counts (knowledge),
      // never the page token (runtime state) — a resumed walk re-lists
      // from the top and skip-scans, see staleThreadIds.
      //
      // `previousCount` comes from the machine's own Backfilling state, so
      // progress advances by addition. The last page reconciles against a
      // real COUNT(*): additions can drift from the truth if applyHistory
      // deleted a thread mid-walk, and "done" is the one moment the number
      // is worth being exact about.
      const syncBatch = (
        phase: BackfillPhase,
        maybePageToken: Option.Option<PageToken>,
        previousCount: number,
      ): Effect.Effect<BatchResult, GmailError | SqlError> =>
        Effect.gen(function* () {
          // See BackfillPhase for the order and why each phase re-lists what
          // the one before it stored.
          const page = yield* gmail.listThreads({
            maxResults: LIST_PAGE_SIZE,
            ...PHASE_QUERY[phase],
            ...Option.match(maybePageToken, {
              onNone: () => ({}),
              onSome: (pageToken) => ({ pageToken }),
            }),
          });
          const unseen = yield* unseenThreadIds(page.threads ?? []);
          yield* syncThreads(unseen);
          const maybeNextPageToken = Option.fromNullishOr(page.nextPageToken);

          // One line per page, so which slice the walk is actually in is a
          // fact you can read rather than infer from the tab counts. `listed`
          // vs `fetched` separates "this phase is out of mail" from "this
          // phase is re-listing what an earlier one already stored", which
          // look identical from outside and mean opposite things.
          yield* Effect.logInfo("backfill page", {
            phase,
            query: PHASE_QUERY[phase],
            listed: (page.threads ?? []).length,
            fetched: unseen.length,
            hasNextPage: Option.isSome(maybeNextPageToken),
          });
          // Only the last page of the LAST phase finishes the backfill —
          // running out of primary mail means the walk moves on, not that it
          // is over.
          const isDone =
            Option.isNone(maybeNextPageToken) &&
            Option.isNone(nextBackfillPhase(phase));
          const syncedCount = isDone
            ? yield* countLocalThreads
            : previousCount + unseen.length;
          const syncedAt = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE sync_state SET
              synced_count = ${syncedCount},
              backfill_done = ${isDone ? 1 : 0},
              last_synced_at = ${syncedAt}
            WHERE id = 1
          `;
          return { syncedCount, maybeNextPageToken };
        });

      const deleteMessagesLocal = (ids: ReadonlyArray<MessageId>) =>
        Effect.forEach(ids, (id) =>
          Effect.all([
            sql`DELETE FROM message_attachments WHERE message_id = ${id}`,
            sql`DELETE FROM message_images WHERE message_id = ${id}`,
            sql`DELETE FROM message_bodies WHERE message_id = ${id}`,
            sql`DELETE FROM message_labels WHERE message_id = ${id}`,
            sql`DELETE FROM messages WHERE id = ${id}`,
          ]),
        );

      const deleteThreadLocal = (id: ThreadId) =>
        Effect.gen(function* () {
          const raw =
            yield* sql`SELECT id FROM messages WHERE thread_id = ${id}`;
          const rows = yield* decodeDbMessageIds(raw).pipe(Effect.orDie);
          yield* deleteMessagesLocal(rows.map((row) => row.id));
          yield* sql`DELETE FROM threads WHERE id = ${id}`;
        });

      // The incremental pass: everything that changed since the cursor,
      // applied locally. Cheap when nothing changed (one request), targeted
      // when something did (full re-sync of just the touched threads).
      const scanPages = (
        startHistoryId: HistoryId,
        maybePageToken: Option.Option<PageToken>,
        scan: HistoryScan,
      ): Effect.Effect<HistoryScan, GmailError> =>
        Effect.gen(function* () {
          const page: ListHistoryResponse = yield* gmail.listHistory({
            startHistoryId,
            maxResults: HISTORY_PAGE_SIZE,
            ...Option.match(maybePageToken, {
              onNone: () => ({}),
              onSome: (pageToken) => ({ pageToken }),
            }),
          });
          const scanned = foldHistoryPage(scan, page);
          return yield* Option.match(Option.fromNullishOr(page.nextPageToken), {
            onNone: () => Effect.succeed(scanned),
            onSome: (pageToken) =>
              scanPages(startHistoryId, Option.some(pageToken), scanned),
          });
        });

      const applyHistory = (
        startHistoryId: HistoryId,
      ): Effect.Effect<HistoryResult, GmailError | SqlError> =>
        Effect.gen(function* () {
          const { touched, deletedMessages, latest } = yield* scanPages(
            startHistoryId,
            Option.none(),
            emptyHistoryScan(startHistoryId),
          );

          if (touched.size > HISTORY_RESYNC_CAP) {
            return Overflowed();
          }

          yield* deleteMessagesLocal(deletedMessages);
          // syncThreads already treats a 404 as "the thread is gone" and drops
          // the local copy, which is exactly the history case too.
          yield* syncThreads([...touched]);

          const syncedAt = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE sync_state SET history_id = ${latest}, last_synced_at = ${syncedAt}
            WHERE id = 1
          `;
          return Applied({
            historyId: latest,
            changedCount: touched.size,
            syncedAt,
          });
        }).pipe(
          // NOTE: On listHistory a 404 means the cursor expired, not a missing
          // resource. The machine full-resyncs from Priming.
          Effect.catchTag("GmailNotFound", () => Effect.succeed(Expired())),
        );

      // IMAGE PASS
      //
      // NOTE: Runs concurrently with the backfill because the two are bound by
      // different resources (quota bucket vs image proxy). Work is queued in
      // the threads table itself: images_cached_at = 0 means pending.

      // The latest_date of the HOT_THREAD_COUNT-th newest thread. Below that
      // count there is no row at the offset and everything is hot, which is
      // right for a mailbox mid-backfill.
      const hotCutoffDate = Effect.gen(function* () {
        const raw = yield* sql`
          SELECT latest_date FROM threads
          WHERE in_inbox = 1
          ORDER BY latest_date DESC
          LIMIT 1 OFFSET ${HOT_THREAD_COUNT - 1}
        `;
        const rows = yield* decodeDbCutoffs(raw).pipe(Effect.orDie);
        return firstRowOr(rows, (row) => row.latest_date, 0);
      });

      // Priority order: opened threads first, then the hot window newest-first.
      // Threads outside the window you never opened are never prefetched.
      const pendingImageThreadIds = (cutoffDate: number) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT id FROM threads
            WHERE images_cached_at = 0
              AND (images_used_at > 0 OR latest_date >= ${cutoffDate})
            ORDER BY images_used_at DESC, latest_date DESC
            LIMIT ${IMAGE_BATCH_THREADS}
          `;
          const rows = yield* decodeDbThreadIds(raw).pipe(Effect.orDie);
          return rows.map((row) => row.id);
        });

      // Bodies are the source and already local, so building the work list
      // costs no network.
      const uncachedImageUrls = (id: ThreadId) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT b.message_id, b.mime_type, b.data, b.codec
            FROM message_bodies b
            JOIN messages m ON m.id = b.message_id
            WHERE m.thread_id = ${id}
          `;
          const bodies = yield* decodeDbBodies(raw).pipe(Effect.orDie);

          // NOTE: A body that won't decompress costs its own images and
          // nothing more. This pass is an optimization and must never be the
          // thing that fails a sync.
          const referenced = yield* Effect.forEach(
            Arr.filter(bodies, (stored) => stored.mime_type === "text/html"),
            (stored) =>
              compression.decompress(stored).pipe(
                Effect.catchCause(() => Effect.succeed("")),
                Effect.map((body) =>
                  Arr.map(remoteImageUrls(body), (url): [string, MessageId] => [
                    url,
                    stored.message_id,
                  ]),
                ),
              ),
          ).pipe(Effect.map(Arr.flatten));

          // The first body to reference a url owns it, which is what `new Map`
          // would undo, so duplicates are dropped before it is built.
          const wanted = new Map(
            Arr.dedupeWith(referenced, ([left], [right]) => left === right),
          );

          // NOTE: `sql.in` with an empty list is a syntax error, and a thread
          // with no remote images at all is the common case.
          if (wanted.size === 0) {
            return [];
          }
          const knownRaw = yield* sql`
            SELECT url FROM message_images
            WHERE ${sql.in("message_id", [...new Set(wanted.values())])}
          `;
          const known = new Set(
            (yield* decodeDbUrls(knownRaw).pipe(Effect.orDie)).map(
              (row) => row.url,
            ),
          );

          return [...wanted]
            .filter(([url]) => !known.has(url))
            .map(([url, messageId]) => ({ url, messageId }));
        });

      const cacheThreadImages = (id: ThreadId) =>
        Effect.gen(function* () {
          const wanted = yield* uncachedImageUrls(id);
          const fetched = yield* Effect.forEach(
            wanted,
            ({ url, messageId }) =>
              imageFetcher.fetchImage(url).pipe(
                Effect.map(
                  Option.map((image) => ({
                    message_id: messageId,
                    url,
                    mime_type: image.mimeType,
                    bytes: image.bytes,
                  })),
                ),
              ),
            { concurrency: IMAGE_CONCURRENCY },
          ).pipe(Effect.map(Arr.getSomes));

          const cachedAt = yield* Clock.currentTimeMillis;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* Effect.forEach(
                fetched,
                (row) =>
                  sql`INSERT OR REPLACE INTO message_images ${sql.insert([row])}`,
                { discard: true },
              );
              // Stamped even when nothing was fetched: a thread whose images
              // are all dead links is *done*, and leaving it at 0 would put
              // it back at the head of the queue forever.
              yield* sql`
                UPDATE threads SET images_cached_at = ${cachedAt} WHERE id = ${id}
              `;
            }),
          );
        });

      // Outside the hot window only the OPENED_LRU_COUNT most recently opened
      // threads keep their images. Evicted threads reset to images_used_at = 0
      // so they leave the queue rather than churning back into it.
      // NOTE: Capped per cycle and one transaction. Selecting the whole cold
      // tail and opening a transaction per thread cost a worker round trip
      // each, which showed up as dropped frames every four seconds.
      const evictColdImages = (cutoffDate: number) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT id FROM threads
            WHERE images_cached_at > 0 AND latest_date < ${cutoffDate}
            ORDER BY images_used_at DESC, latest_date DESC
            LIMIT ${IMAGE_EVICT_BATCH} OFFSET ${OPENED_LRU_COUNT}
          `;
          const rows = yield* decodeDbThreadIds(raw).pipe(Effect.orDie);
          // NOTE: `sql.in` with an empty list is a syntax error.
          if (Arr.isReadonlyArrayEmpty(rows)) {
            return;
          }
          const ids = rows.map((row) => row.id);
          yield* sql.withTransaction(
            Effect.all([
              sql`
                DELETE FROM message_images WHERE message_id IN
                  (SELECT id FROM messages WHERE ${sql.in("thread_id", ids)})
              `,
              sql`
                UPDATE threads
                SET images_cached_at = 0, images_used_at = 0
                WHERE ${sql.in("id", ids)}
              `,
            ]),
          );
        });

      // NOTE: Requires a full window, not just an empty queue. Mid-backfill
      // the queue also runs dry, and claiming the recent window is ready there
      // would be a claim about threads not yet downloaded.
      const isHotWindowReady = (cutoffDate: number) =>
        Effect.gen(function* () {
          const raw = yield* sql`
            SELECT
              (SELECT COUNT(*) FROM threads WHERE in_inbox = 1) AS total,
              (SELECT COUNT(*) FROM threads
                WHERE in_inbox = 1
                  AND latest_date >= ${cutoffDate}
                  AND images_cached_at = 0) AS pending
          `;
          const rows = yield* decodeDbWindowCounts(raw).pipe(Effect.orDie);
          return firstRowOr(
            rows,
            (row) => row.total >= HOT_THREAD_COUNT && row.pending === 0,
            false,
          );
        });

      const cacheImageBatch: Effect.Effect<ImageBatchResult, SqlError> =
        Effect.gen(function* () {
          const cutoffDate = yield* hotCutoffDate;
          const ids = yield* pendingImageThreadIds(cutoffDate);
          yield* Effect.forEach(ids, cacheThreadImages, { discard: true });
          yield* evictColdImages(cutoffDate);
          return {
            isIdle: Arr.isReadonlyArrayEmpty(ids),
            isRecentReady: yield* isHotWindowReady(cutoffDate),
          };
        });

      // AVATAR PASS
      //
      // NOTE: A separate loop from the image pass, not a step inside it. The
      // two are bound by different things — mail images by the proxy, avatars
      // by one request each to a hundred different origins — and a slow
      // favicon must never hold up the images that make a mail readable.

      // Bytes for a key that has none yet. `None` records the absence, which
      // matters as much as the presence: most domains have no reachable
      // favicon, and without a row saying so every pass retries all of them.
      const storeAvatar = (
        key: string,
        maybeImage: Option.Option<FetchedImage>,
      ) =>
        Effect.gen(function* () {
          const fetchedAt = yield* Clock.currentTimeMillis;
          yield* Option.match(maybeImage, {
            onNone: () => sql`
              INSERT OR REPLACE INTO avatars (key, bytes, mime_type, is_missing, fetched_at)
              VALUES (${key}, NULL, '', 1, ${fetchedAt})
            `,
            onSome: (image) => sql`
              INSERT OR REPLACE INTO avatars (key, bytes, mime_type, is_missing, fetched_at)
              VALUES (${key}, ${image.bytes}, ${image.mimeType}, 0, ${fetchedAt})
            `,
          });
        });

      // The contacts half: every profile photo this account can see, keyed by
      // address. Runs at most once a day (PEOPLE_REFRESH_MS).
      //
      // NOTE: Failure is swallowed to a zero. A session predating the contacts
      // scopes cannot call People at all, and the honest response to that is
      // letter tiles, not a broken sync — the user re-consents by signing in
      // again, exactly as with the outbox's write scopes.
      const syncPeopleAvatars = Effect.gen(function* () {
        const photos = yield* people.listPhotos.pipe(
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<never>)),
        );
        // NOTE: One query for the whole address book, not one per contact.
        // Every SQL call is a round trip to the database worker, and asking
        // "do we have this one?" a few thousand times over serializes the
        // whole boot behind a question that fits in a single IN.
        const candidates = Arr.dedupeWith(
          photos.map((photo) => ({ key: personKey(photo.email), photo })),
          (left, right) => left.key === right.key,
        );
        if (Arr.isReadonlyArrayEmpty(candidates)) {
          const syncedAt = yield* Clock.currentTimeMillis;
          yield* sql`UPDATE sync_state SET people_synced_at = ${syncedAt} WHERE id = 1`;
          return 0;
        }
        const knownRaw = yield* sql`
          SELECT key FROM avatars
          WHERE ${sql.in(
            "key",
            candidates.map(({ key }) => key),
          )}
        `;
        const known = new Set(
          (yield* decodeDbAvatarKeys(knownRaw).pipe(Effect.orDie)).map(
            (row) => row.key,
          ),
        );
        const wanted = candidates.filter(({ key }) => !known.has(key));

        yield* Effect.forEach(
          wanted,
          ({ key, photo }) =>
            // Through the proxy like every other remote image:
            // lh3.googleusercontent.com sends no CORS headers the tab can use.
            imageFetcher
              .fetchImage(photo.photoUrl)
              .pipe(Effect.flatMap((image) => storeAvatar(key, image))),
          { concurrency: IMAGE_CONCURRENCY },
        );

        const syncedAt = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE sync_state SET people_synced_at = ${syncedAt} WHERE id = 1`;
        return wanted.length;
      });

      const isPeopleStale = Effect.gen(function* () {
        const raw =
          yield* sql`SELECT people_synced_at FROM sync_state WHERE id = 1`;
        const rows = yield* decodeDbPeopleSynced(raw).pipe(Effect.orDie);
        const syncedAt = firstRowOr(rows, (row) => row.people_synced_at, 0);
        const now = yield* Clock.currentTimeMillis;
        return now - syncedAt > PEOPLE_REFRESH_MS;
      });

      // The company half: sender domains in the hot window with nothing stored
      // for them yet. Deliberately driven off the threads table rather than a
      // queue of its own — the mailbox already is the queue.
      const pendingAvatarEmails = Effect.gen(function* () {
        const raw = yield* sql`
          SELECT DISTINCT sender_email FROM threads
          WHERE sender_email != ''
          ORDER BY latest_date DESC
          LIMIT ${HOT_THREAD_COUNT}
        `;
        const rows = yield* decodeDbSenderEmails(raw).pipe(Effect.orDie);
        return rows.map((row) => row.sender_email);
      });

      const resolveDomainAvatars = Effect.gen(function* () {
        const emails = yield* pendingAvatarEmails;
        // A domain is worth one lookup however many senders share it, and the
        // person key is checked first because a face beats a logo.
        const candidates = Arr.dedupe(
          emails.flatMap((email) =>
            Option.isSome(avatarUrl(personKey(email)))
              ? []
              : logoDomains(email),
          ),
        );
        if (Arr.isReadonlyArrayEmpty(candidates)) {
          return 0;
        }

        const knownRaw = yield* sql`
          SELECT key FROM avatars
          WHERE ${sql.in("key", candidates.map(domainKey))}
        `;
        const known = new Set(
          (yield* decodeDbAvatarKeys(knownRaw).pipe(Effect.orDie)).map(
            (row) => row.key,
          ),
        );
        const wanted = Arr.take(
          candidates.filter((domain) => !known.has(domainKey(domain))),
          AVATAR_BATCH_DOMAINS,
        );

        yield* Effect.forEach(
          wanted,
          (domain) =>
            imageFetcher
              .fetchImage(faviconUrl(domain))
              .pipe(
                Effect.flatMap((image) =>
                  storeAvatar(domainKey(domain), image),
                ),
              ),
          { concurrency: IMAGE_CONCURRENCY },
        );
        return wanted.length;
      });

      // Stored bytes into blob urls the view can read.
      //
      // NOTE: Two queries, and the split is the point. This runs every turn of
      // a loop that keeps going long after the last avatar is resolved, so
      // reading the BLOBs first and discarding the ones already registered
      // would drag several megabytes out of SQLite every ten seconds, forever.
      // The keys are tiny; only the ones the registry is actually missing cost
      // their bytes, and a settled mailbox pays for none of them.
      const publishAvatars = Effect.gen(function* () {
        const keyRaw = yield* sql`
          SELECT key FROM avatars
          WHERE is_missing = 0
          ORDER BY fetched_at DESC
          LIMIT ${AVATAR_PUBLISH_LIMIT}
        `;
        const keys = (yield* decodeDbAvatarKeys(keyRaw).pipe(Effect.orDie))
          .map((row) => row.key)
          .filter((key) => Option.isNone(avatarUrl(key)));
        // NOTE: `sql.in` with an empty list is a syntax error, and an empty
        // list is the steady state here.
        if (Arr.isReadonlyArrayEmpty(keys)) {
          return 0;
        }

        const raw = yield* sql`
          SELECT key, mime_type, bytes FROM avatars
          WHERE ${sql.in("key", keys)}
        `;
        const rows = yield* decodeDbAvatars(raw).pipe(Effect.orDie);
        return Arr.reduce(rows, 0, (added, row) =>
          row.bytes !== null &&
          registerAvatar(row.key, row.mime_type, row.bytes)
            ? added + 1
            : added,
        );
      });

      const cacheAvatarBatch: Effect.Effect<AvatarBatchResult, SqlError> =
        Effect.gen(function* () {
          const peopleAdded = (yield* isPeopleStale)
            ? yield* syncPeopleAvatars
            : 0;
          const domainsAdded = yield* resolveDomainAvatars;
          const addedCount = yield* publishAvatars;
          return {
            addedCount,
            isIdle: peopleAdded === 0 && domainsAdded === 0,
          };
        });

      // MARKDOWN BACKFILL
      //
      // Bodies stored before the markdown column existed, and any the
      // converter has since been taught to handle better. Queued in
      // message_bodies itself: markdown IS NULL means pending, which the
      // partial index from migration 0010 makes cheap to ask about.

      // Priority order matches the image pass: threads you have opened first,
      // then the newest. What you are most likely to open next is what gets
      // the fast path first.
      //
      // `openedOnly` is the whole concurrency story with the sync. While the
      // mailbox is still walking, the only bodies worth spending main-thread
      // time on are the ones you have actually opened — a handful, and their
      // next open is instant. The unbounded pass waits until the sync has
      // gone quiet, so the two never compete for the thread drawing the list.
      const pendingMarkdownBodies = (openedOnly: boolean) =>
        Effect.gen(function* () {
          const scope = openedOnly ? "AND t.images_used_at > 0" : "";
          const raw = yield* sql`
            SELECT b.message_id, b.mime_type, b.data, b.codec,
                   b.markdown, b.markdown_codec
            FROM message_bodies b
            JOIN messages m ON m.id = b.message_id
            JOIN threads t ON t.id = m.thread_id
            WHERE b.markdown IS NULL AND b.mime_type = 'text/html'
              ${sql.literal(scope)}
            ORDER BY t.images_used_at DESC, t.latest_date DESC
            LIMIT ${MARKDOWN_BATCH_BODIES}
          `;
          return yield* decodeDbMarkdownBodies(raw).pipe(Effect.orDie);
        });

      // One turn of the backfill. Converts what it took and writes the results
      // in a single transaction, the same shape as the image pass.
      //
      // NOTE: A body that cannot be decompressed still gets written — as the
      // empty marker, which reads back as "no markdown" (storedMarkdown) and
      // opens through the html path. Leaving it NULL would put it back at the
      // head of the queue on the next turn and every turn after that, and one
      // corrupt row would stall the backfill for the whole mailbox.
      const convertMarkdownBatch = (
        openedOnly: boolean,
      ): Effect.Effect<MarkdownBatchResult, SqlError> =>
        Effect.gen(function* () {
          const pending = yield* pendingMarkdownBodies(openedOnly);
          if (pending.length === 0) {
            return { isIdle: true };
          }

          const converted = yield* Effect.forEach(pending, (stored) =>
            compression.decompress(stored).pipe(
              Effect.flatMap(compressMarkdown),
              Effect.catchCause(() =>
                Effect.succeed(Option.none<CompressedBody>()),
              ),
              Effect.map((markdown) => ({
                message_id: stored.message_id,
                markdown: Option.match(markdown, {
                  onNone: () => EMPTY_MARKDOWN,
                  onSome: (body) => body.data,
                }),
                codec: Option.match(markdown, {
                  onNone: (): BodyCodec => "none",
                  onSome: (body) => body.codec,
                }),
              })),
            ),
          );

          yield* sql.withTransaction(
            Effect.forEach(
              converted,
              (row) => sql`
                UPDATE message_bodies
                SET markdown = ${row.markdown}, markdown_codec = ${row.codec}
                WHERE message_id = ${row.message_id}
              `,
              { discard: true },
            ),
          );

          return { isIdle: false };
        });

      // READS

      // One folder's rows, newest first. Never touches the network: filling
      // the store is the sync machine's job.
      //
      // NOTE: Capped at HOT_THREAD_COUNT, deliberately NOT the whole store.
      // "VirtualList renders a fixed window so the full mailbox can ride in
      // the model" was this query's original justification, and it held right
      // up until a mailbox finished backfilling: at 30k rows every
      // O(modelSize) walk outside the view got the bill — foldkit's HMR model
      // preservation most fatally, which encodes the entire Model and sends
      // it over the vite websocket on every quiet window. At ~15MB per
      // preserve the socket died, and the vite client answers a dead socket
      // with location.reload() — the dev tab reloaded in a metronomic loop.
      // The cap is the same tier the image cache calls hot, and everything
      // past it is a search away; SQL remains the authority for the mailbox.
      //
      // NOTE: `categories` narrows the query, and it has to be the query
      // rather than a filter over the result. The cap is applied by this
      // LIMIT, so taking the newest 1,000 of the whole inbox and narrowing
      // afterwards gives the tab whatever of it happened to fall inside that
      // window — which, for a mailbox whose inbox is mostly promotions, is
      // almost nothing. Measured on a real one: 34 rows reached the Primary
      // tab out of 1,211 primary threads in the store, against a badge
      // reading 643, and the list simply stopped scrolling. Narrowing first
      // gives each tab its own newest 1,000.
      const loadFolder = (
        folder: Folder,
        categories: ReadonlyArray<ThreadCategory>,
      ) =>
        Effect.gen(function* () {
          // NOTE: Built from ThreadCategory's own literals, not from the
          // argument's strings — the fragment is interpolated into SQL, so
          // nothing that reaches it should come from outside this module.
          // Empty means every category: the folders outside the inbox have no
          // tabs, and the query must never become `IN ()`.
          const wanted = ThreadCategory.literals.filter((category) =>
            categories.includes(category),
          );
          const narrowing =
            wanted.length === 0
              ? ""
              : ` AND category IN (${wanted.map((c) => `'${c}'`).join(",")})`;
          const raw = yield* sql`
            SELECT ${sql.literal(THREAD_ROW_COLUMNS)}
            FROM threads
            WHERE ${sql.literal(FOLDER_WHERE[folder] + narrowing)}
            ORDER BY latest_date DESC
            LIMIT ${HOT_THREAD_COUNT}
          `;
          return yield* decodeThreadRows(raw);
        });

      // Every number the toolbar shows, in one pass over the table.
      //
      // NOTE: One query with conditional sums rather than eight COUNT(*)s.
      // Each of those is its own round trip to the database worker, and this
      // is re-read on the same cadence as the list during a backfill.
      //
      // `is_unread` mirrors Gmail's own tab counters. The category arithmetic
      // matches TAB_FROM_CATEGORY in the page's model: primary is where
      // uncategorized mail lands, because "primary" is Gmail's name for the
      // absence of a category rather than a label of its own.
      const readCounts = Effect.gen(function* () {
        const inInbox = "in_inbox = 1 AND is_spam = 0 AND is_trash = 0";
        // NOTE: COUNT(CASE …) with no ELSE, not SUM. Over an empty table SUM
        // is NULL and every one of these would have to be coalesced; COUNT
        // ignores the NULLs the CASE produces and returns a real 0, which is
        // the honest answer for a store that has not synced yet.
        const raw = yield* sql`
          SELECT
            COUNT(CASE WHEN ${sql.literal(inInbox)} AND is_unread = 1
              AND category IN ('personal', 'none') THEN 1 END) AS primary_count,
            COUNT(CASE WHEN ${sql.literal(inInbox)} AND is_unread = 1
              AND category = 'social' THEN 1 END) AS social_count,
            COUNT(CASE WHEN ${sql.literal(inInbox)} AND is_unread = 1
              AND category = 'promotions' THEN 1 END) AS promotions_count,
            COUNT(CASE WHEN ${sql.literal(inInbox)} AND is_unread = 1
              AND category = 'updates' THEN 1 END) AS updates_count,
            COUNT(CASE WHEN ${sql.literal(inInbox)} AND is_unread = 1
              AND category = 'forums' THEN 1 END) AS forums_count,
            COUNT(CASE WHEN ${sql.literal(inInbox)} AND is_unread = 1
              THEN 1 END) AS inbox_count,
            COUNT(CASE WHEN is_draft = 1 AND is_spam = 0 AND is_trash = 0
              THEN 1 END) AS drafts_count,
            COUNT(CASE WHEN is_spam = 1 THEN 1 END) AS spam_count
          FROM threads
        `;
        const rows = yield* decodeDbMailboxCounts(raw).pipe(Effect.orDie);
        return firstRowOr(
          rows,
          (row): MailboxCounts => ({
            primary: row.primary_count,
            social: row.social_count,
            promotions: row.promotions_count,
            updates: row.updates_count,
            forums: row.forums_count,
            inbox: row.inbox_count,
            drafts: row.drafts_count,
            spam: row.spam_count,
          }),
          EMPTY_COUNTS,
        );
      });

      // The boot-only first read: the viewport's worth of inbox rows in
      // O(limit), served by the (in_inbox, latest_date DESC) index. The full
      // loadFolder follows it and settles the list. Runs once per boot, which
      // is what makes it the right home for the boot-query bracket.
      const loadInboxTop = (limit: number) =>
        Effect.gen(function* () {
          yield* mark(BOOT_QUERY_START);
          const raw = yield* sql`
            SELECT ${sql.literal(THREAD_ROW_COLUMNS)}
            FROM threads
            WHERE ${sql.literal(FOLDER_WHERE.inbox)}
            ORDER BY latest_date DESC
            LIMIT ${limit}
          `;
          const rows = yield* decodeThreadRows(raw);
          yield* mark(BOOT_QUERY_END);
          yield* logBootReport(rows.length);
          return rows;
        });

      // Image bytes reach the html as blob: urls rather than data: URIs, since
      // inlining megabytes of base64 into the body string is slow and can OOM
      // the tab.
      //
      // NOTE: One registry for the whole engine, not one per thread. A blob:
      // url pins its bytes until revoked and only one thread is ever on
      // screen, so everything from the previous open is garbage the moment the
      // next one starts. Keying this by thread leaked every other thread's
      // images for the life of the tab, about a megabyte per thread opened.
      const liveObjectUrls = yield* Ref.make<ReadonlyArray<string>>([]);

      const revokeObjectUrls = Ref.getAndSet(liveObjectUrls, []).pipe(
        Effect.flatMap((urls) =>
          Effect.sync(() => {
            urls.forEach(URL.revokeObjectURL);
          }),
        ),
      );

      const registerObjectUrl = (
        mimeType: string,
        bytes: Uint8Array,
      ): Effect.Effect<string> =>
        Effect.gen(function* () {
          const url = URL.createObjectURL(
            new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
          );
          yield* Ref.update(liveObjectUrls, Arr.append(url));
          return url;
        });

      /** What a message opens as, plus the markdown to write back if this
       *  open is what produced it. */
      type OpenedBody = Readonly<{
        kind: BodyKind;
        /** Markdown, html or plain text, according to `kind`. */
        text: string;
        writeBack: Option.Option<CompressedBody>;
      }>;

      /**
       * The rendition a message opens from.
       *
       * Converts on the spot when the backfill has not reached this body yet,
       * rather than falling back to the sender's html. Two renderings of the
       * same mailbox is not a thing a reader should ever see, and which one
       * you got would depend on nothing more legible than how far a background
       * loop had run — so the loop is a pre-warm, not the thing that decides.
       *
       * The conversion is paid once: `writeBack` carries the result to the
       * caller, which stores it, and every later open of the message is the
       * cheap path again.
       *
       * NOTE: The html fallback survives for exactly one case — a body the
       * converter can make nothing of, which would otherwise render as a blank
       * message. It writes the marker back too, so the queue does not retry it
       * on every pass.
       */
      const openBody = (
        maybeStored: Option.Option<DbMarkdownBodyRow>,
      ): Effect.Effect<OpenedBody, CompressionError> =>
        Effect.gen(function* () {
          if (Option.isNone(maybeStored)) {
            return { kind: "plain", text: "", writeBack: Option.none() };
          }
          const stored = maybeStored.value;

          const ready = storedMarkdown(stored);
          if (Option.isSome(ready)) {
            return {
              kind: "markdown",
              text: yield* compression.decompress(ready.value),
              writeBack: Option.none(),
            };
          }

          const text = yield* compression.decompress(stored);
          if (stored.mime_type !== "text/html") {
            return { kind: "plain", text, writeBack: Option.none() };
          }

          // Already tried, and the answer was nothing. Re-running the
          // converter would only produce the same empty string.
          if (isConverted(stored)) {
            return { kind: "html", text, writeBack: Option.none() };
          }

          const markdown = emailHtmlToMarkdown(text);
          if (markdown === "") {
            return {
              kind: "html",
              text,
              writeBack: Option.some({
                codec: "none",
                data: EMPTY_MARKDOWN,
              } satisfies CompressedBody),
            };
          }
          return {
            kind: "markdown",
            text: markdown,
            writeBack: Option.some(
              yield* compression.compress(markdown).pipe(Effect.orDie),
            ),
          };
        });

      // Opening a thread: SQLite only.
      const loadThread = (id: ThreadId) =>
        Effect.gen(function* () {
          const subjectRaw = yield* sql`
            SELECT subject FROM threads WHERE id = ${id}
          `;
          const subjects = yield* decodeDbSubjects(subjectRaw).pipe(
            Effect.orDie,
          );
          const subject = firstRowOr(subjects, (row) => row.subject, "");

          const rowsRaw = yield* sql`
            SELECT id, internal_date, from_name, from_email,
                   rfc822_message_id, references_header
            FROM messages
            WHERE thread_id = ${id}
            ORDER BY internal_date ASC
          `;
          const rows = yield* decodeDbMessages(rowsRaw).pipe(Effect.orDie);

          yield* revokeObjectUrls;

          const messages = yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const bodyRaw = yield* sql`
                SELECT message_id, mime_type, data, codec,
                       markdown, markdown_codec
                FROM message_bodies
                WHERE message_id = ${row.id}
              `;
              const maybeStored = Arr.head(
                yield* decodeDbMarkdownBodies(bodyRaw).pipe(Effect.orDie),
              );
              const imagesRaw = yield* sql`
                SELECT message_id, content_id, mime_type, bytes
                FROM message_attachments
                WHERE message_id = ${row.id}
              `;
              const images = yield* decodeDbImages(imagesRaw).pipe(
                Effect.orDie,
              );
              const remoteRaw = yield* sql`
                SELECT url, mime_type, bytes
                FROM message_images
                WHERE message_id = ${row.id}
              `;
              const remote = yield* decodeDbRemoteImages(remoteRaw).pipe(
                Effect.orDie,
              );

              const opened = yield* openBody(maybeStored);

              // Inline attachments, addressed by the `cid:` token the body
              // refers to them by, and cached remote images addressed by
              // their original url. Both become blobs so the render is local
              // and the sender's tracking pixels never fire on open. Anything
              // missing from this map is left alone and loads live, which is
              // what keeps a cold thread readable rather than half-broken.
              const inlineBlobs = yield* Effect.forEach(images, (image) =>
                registerObjectUrl(image.mime_type, image.bytes).pipe(
                  Effect.map((url): [string, string] => [
                    `cid:${image.content_id}`,
                    url,
                  ]),
                ),
              );
              const remoteBlobs = yield* Effect.forEach(remote, (image) =>
                registerObjectUrl(image.mime_type, image.bytes).pipe(
                  Effect.map((url): [string, string] => [image.url, url]),
                ),
              );
              const localUrls = new Map([...inlineBlobs, ...remoteBlobs]);

              return {
                detail: {
                  id: row.id,
                  fromName: row.from_name,
                  fromEmail: row.from_email,
                  date: row.internal_date,
                  bodyKind: opened.kind,
                  // NOTE: Once, here, and not in the view. The body is
                  // rendered into a shadow root in this document rather than a
                  // sandboxed iframe, so `prepareBody` is what makes it safe
                  // to insert at all (sanitizeBody.ts) — and the view runs on
                  // every render, while this runs on open.
                  //
                  // Markdown is rendered to html before it is prepared, never
                  // inserted as-is. `prepareBody` still runs over the result:
                  // it is what swaps cached image bytes in for their urls, and
                  // it is the sanitizer this document's safety rests on either
                  // way. It is cheap here — the rendered markdown is a
                  // fraction of the html it came from.
                  //
                  // A plain body is not html and must not be parsed as it: it
                  // goes into a `<pre>` as text, where the renderer escapes
                  // it.
                  body:
                    opened.kind === "markdown"
                      ? prepareBody(
                          renderEmailMarkdownToHtml(opened.text),
                          localUrls,
                        )
                      : opened.kind === "html"
                        ? prepareBody(opened.text, localUrls)
                        : opened.text,
                  rfc822MessageId: row.rfc822_message_id,
                  references: row.references_header,
                } satisfies MessageDetail,
                writeBack: Option.map(opened.writeBack, (markdown) => ({
                  message_id: row.id,
                  markdown,
                })),
              };
            }),
          );

          // Anything this open had to convert itself, so the next one does
          // not. One transaction with the stamp below, which is one round trip
          // to the database worker rather than one per message.
          const writeBacks = Arr.getSomes(
            messages.map((message) => message.writeBack),
          );

          // The LRU stamp, and the only way a thread outside the hot window
          // ever enters the image queue: opening it is the signal that its
          // images are worth keeping. The next batch picks it up, so this
          // open renders remote images live and every later one is local.
          const usedAt = yield* Clock.currentTimeMillis;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE threads SET images_used_at = ${usedAt} WHERE id = ${id}
              `;
              yield* Effect.forEach(
                writeBacks,
                ({ message_id, markdown }) => sql`
                  UPDATE message_bodies
                  SET markdown = ${markdown.data},
                      markdown_codec = ${markdown.codec}
                  WHERE message_id = ${message_id}
                `,
                { discard: true },
              );
            }),
          );

          return {
            id,
            subject,
            messages: messages.map((message) => message.detail),
          } satisfies ThreadDetail;
        });

      return {
        cacheAvatarBatch,
        cacheImageBatch,
        convertMarkdownBatch,
        loadFolder,
        loadInboxTop,
        readCounts,
        loadThread,
        localSizeBytes,
        readCheckpoint,
        primeInbox,
        syncBatch,
        applyHistory,
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Gmail.layer,
        SqlLive,
        Compression.layer,
        ImageFetcher.layer,
        People.layer,
        OutboxEngine.layer,
      ),
    ),
  );
}

export type LoadInboxError = SqlError;
// Decompression is in this path and can fail on bytes that don't match their
// stored codec. That surfaces as FailedLoadThread rather than dying: a single
// corrupt body should cost you that thread, not the app.
export type LoadThreadError = SqlError | CompressionError;
