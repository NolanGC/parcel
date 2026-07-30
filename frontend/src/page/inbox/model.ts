// Imported by both view.ts and index.ts, and imports neither, which is what
// keeps the split from becoming an import cycle.

import { Array as Arr, Option, Schema as S } from "effect";
import { AsyncData } from "foldkit";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

import * as Icon from "../../icons";
import { HOT_THREAD_COUNT } from "../../tiers";
import { THREADS_PER_SECOND, ThreadId } from "../../Gmail";
import * as OutboxMachine from "../../outboxMachine";
import { ThreadPatch } from "../../outboxOps";
import { ThreadDetail, ThreadRow, type ThreadCategory } from "../../sync";
import * as SyncMachine from "../../syncMachine";
import * as Ui from "../../ui";

export const PAGE_SURFACE = Ui.SurfaceLevel.make(1);

// NOTE: Rows are a fixed height so the visible window and the traveling hover
// overlay are both pure arithmetic (index * ROW_HEIGHT).
export const LIST_ID = "inbox-list";
export const ROW_HEIGHT = 53;
export const LIST_OVERSCAN = 6;

// NOTE: Only the perf bench reads this, but it lives here so a view change
// can't leave the harness silently addressing nothing.
export const DETAIL_PANE_ID = "inbox-detail-pane";

export const BODY_FRAME_HEIGHT = 600;

// APPEARANCE

export const Appearance = S.Literals(["System", "Light", "Dark"]);
export type Appearance = typeof Appearance.Type;

// DATA

export type Category = "promotions" | "primary" | "other";

export const CATEGORY_FROM_THREAD: Record<ThreadCategory, Category> = {
  personal: "primary",
  promotions: "promotions",
  social: "other",
  updates: "other",
  forums: "other",
  none: "other",
};

// NOTE: Content colors, deliberately outside the surface token system.
export const AVATAR_BG = "#4f46e5";
export const AVATAR_FG = "#ffffff";

// NOTE: LoadInbox re-decodes the entire list, so a refresh hands back fresh
// objects even for rows whose bytes did not change. View memoization compares
// with `===`, so that churn would miss the cache for every row. Reusing the
// previous object whenever the fields are equal keeps a strided refresh
// mid-backfill down to the handful of rows that actually moved.
const isSameRow = (left: ThreadRow, right: ThreadRow): boolean =>
  left.id === right.id &&
  left.subject === right.subject &&
  left.sender === right.sender &&
  left.snippet === right.snippet &&
  left.date === right.date &&
  left.isUnread === right.isUnread &&
  left.isStarred === right.isStarred &&
  left.category === right.category;

// NOTE: The common case by a wide margin is that a refresh changed nothing,
// so that case is answered by a positional scan that allocates nothing. The id
// index below is only paid for once a row actually differs; running it
// unconditionally put this on the wrong side of the update budget at ~30k rows.
const isAlignedWith = (
  previous: ReadonlyArray<ThreadRow>,
  next: ReadonlyArray<ThreadRow>,
): boolean => {
  if (previous.length !== next.length) {
    return false;
  }
  return previous.every((row, index) => {
    const incoming = next[index];
    return incoming !== undefined && isSameRow(row, incoming);
  });
};

/**
 * One thread's row, changed in place.
 *
 * The optimistic path for a flag action: the local write has already
 * happened (outboxEngine.enqueue), and this is the list catching up to it.
 * Re-reading the store instead would re-decode every row to change one of
 * them, and hand every memoized row subtree a new object on the way past.
 *
 * NOTE: A thread the list doesn't hold returns the same array — patching a
 * row that isn't on screen must not cost the list its identity.
 */
export const patchRow = (
  rows: ReadonlyArray<ThreadRow>,
  patch: ThreadPatch,
): ReadonlyArray<ThreadRow> => {
  const isPatched = (row: ThreadRow): boolean => row.id === patch.threadId;
  if (!rows.some(isPatched)) {
    return rows;
  }
  if (patch.isRemoved) {
    return rows.filter((row) => !isPatched(row));
  }
  // Every other row keeps its object, so every other memo slot keeps its hit.
  return rows.map((row) =>
    isPatched(row)
      ? evo(row, {
          isUnread: (was) => Option.getOrElse(patch.maybeIsUnread, () => was),
          isStarred: (was) => Option.getOrElse(patch.maybeIsStarred, () => was),
        })
      : row,
  );
};

export const reconcileRows = (
  previous: ReadonlyArray<ThreadRow>,
  next: ReadonlyArray<ThreadRow>,
): ReadonlyArray<ThreadRow> => {
  // NOTE: Holding the array reference, not just the row references, is what
  // lets a memoized list subtree skip entirely rather than re-walking every
  // row to discover each one is unchanged.
  if (isAlignedWith(previous, next)) {
    return previous;
  }

  const previousById = new Map(previous.map((row) => [row.id, row] as const));
  return next.map((row) => {
    const existing = previousById.get(row.id);
    return existing !== undefined && isSameRow(existing, row) ? existing : row;
  });
};

export const formatTime = (epochMs: number): string => {
  const date = new Date(epochMs);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}/${String(
    date.getFullYear(),
  ).slice(2)}`;
};

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;

// NOTE: Rounded coarsely on purpose. A number that ticks every second reads as
// precision the estimate lacks; the rate comes from THREADS_PER_SECOND.
export const formatEta = (remainingThreads: number): string => {
  const seconds = Math.ceil(remainingThreads / THREADS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) {
    return "under a minute";
  }
  const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `about ${minutes} min`;
  }
  return `about ${Math.round(seconds / SECONDS_PER_HOUR)} hr`;
};

export const formatProgress = (
  syncedCount: number,
  totalEstimate: number,
): string =>
  `${syncedCount.toLocaleString()} of ${totalEstimate.toLocaleString()} threads · ` +
  `${formatEta(Math.max(0, totalEstimate - syncedCount))} left`;

const FULL_PERCENT = 100;

// NOTE: Clamped both ends. total_estimate is Gmail's own label count and
// drifts, so syncedCount can pass it, and a bar reading 104% is worse than one
// that sits at full for the last few seconds.
export const progressPercent = (
  syncedCount: number,
  totalEstimate: number,
): number =>
  totalEstimate <= 0
    ? 0
    : Math.min(
        FULL_PERCENT,
        Math.max(0, Math.round((syncedCount / totalEstimate) * FULL_PERCENT)),
      );

// NOTE: Names HOT_THREAD_COUNT rather than spelling the number, so the
// sentence can't become a lie the day the tier size changes.
export const RECENT_READY_LINE = `Latest ${HOT_THREAD_COUNT.toLocaleString()} ready to read offline, images included.`;

const BYTES_PER_GB = 1_073_741_824;
const BYTES_PER_MB = 1_048_576;

export const formatBytes = (bytes: number): string =>
  bytes >= BYTES_PER_GB
    ? `${(bytes / BYTES_PER_GB).toFixed(1)} GB`
    : `${Math.round(bytes / BYTES_PER_MB)} MB`;

export type CategoryConfig = Readonly<{
  label: string;
  icon: Ui.IconView;
  iconClass: string;
}>;

export const CATEGORIES: Record<Category, CategoryConfig> = {
  promotions: {
    label: "Promotions",
    icon: Icon.hand,
    iconClass: "text-orange-400",
  },
  primary: {
    label: "Primary",
    icon: Icon.circleUser,
    iconClass: "text-blue-400",
  },
  other: { label: "Other", icon: Icon.ellipsis, iconClass: "" },
};

export type TabConfig = Readonly<{
  label: string;
  icon: Ui.IconView;
  count: number;
  iconClass: string;
}>;

export const TABS: ReadonlyArray<TabConfig> = [
  { label: "To-do", icon: Icon.circleCheck, count: 2, iconClass: "" },
  {
    label: "Reminders",
    icon: Icon.bell,
    count: 8,
    iconClass: "text-amber-400",
  },
  { label: "Priority", icon: Icon.tag, count: 3, iconClass: "text-indigo-400" },
  {
    label: "Newsletters",
    icon: Icon.leaf,
    count: 23,
    iconClass: "text-green-500",
  },
  { label: "Other", icon: Icon.ellipsis, count: 18, iconClass: "" },
];

export const TAB_LABELS: ReadonlyArray<string> = TABS.map((tab) => tab.label);

export const tabSpec = (label: string): Ui.Tabs.TabSpec =>
  Option.match(
    Arr.findFirst(TABS, (tab) => tab.label === label),
    {
      onNone: () => ({ icon: Icon.ellipsis, label }),
      onSome: (tab) => ({
        icon: tab.icon,
        label: tab.label,
        detail: String(tab.count),
        iconClass: tab.iconClass,
      }),
    },
  );

// FOLDER MENU

export const FOLDER_LABELS = [
  "All Inbox",
  "Sent",
  "Send later",
  "Drafts",
  "Spams",
  "Archives",
] as const;
export type FolderLabel = (typeof FOLDER_LABELS)[number];

export const FOLDERS: Record<
  FolderLabel,
  Readonly<{ icon: Ui.IconView; count?: number }>
> = {
  "All Inbox": { icon: Icon.inbox, count: 199 },
  Sent: { icon: Icon.send },
  "Send later": { icon: Icon.clock },
  Drafts: { icon: Icon.feather, count: 2 },
  Spams: { icon: Icon.shieldAlert, count: 8 },
  Archives: { icon: Icon.archive, count: 7 },
};

export const FolderMenu = Ui.Menu.create<FolderLabel>();

// COMMAND PALETTE

export const PALETTE_RESULT_LIMIT = 50;

export const threadItemSpec = (row: ThreadRow): Ui.Palette.PaletteItemSpec => ({
  icon: row.isUnread ? Icon.mail : Icon.mailOpen,
  label: row.subject === "" ? "(no subject)" : row.subject,
  detail: row.sender,
});

export const InboxPalette = Ui.Palette.create<ThreadId>();

// MODEL

export const ThreadsData = AsyncData.Schema(S.Array(ThreadRow), S.String);

// COMPOSE

/** What makes a compose a reply rather than a new message: the thread it
 *  joins in our mailbox, and the headers that join it in the recipient's. */
export const ReplyContext = S.Struct({
  threadId: ThreadId,
  inReplyTo: S.String,
  references: S.String,
});
export type ReplyContext = typeof ReplyContext.Type;

export const ComposeField = S.Literals(["to", "subject", "body"]);
export type ComposeField = typeof ComposeField.Type;

export const composeFieldId = (field: ComposeField): string =>
  `inbox-compose-${field}`;

/** Where focus goes when the panel opens. */
export const COMPOSE_FIRST_FIELD_ID = composeFieldId("to");

export const ComposeClosed = ts("ComposeClosed");
/** NOTE: The body is markdown, and `isPreviewing` swaps the textarea for the
 *  rendered result — the same render that is sent (markdown.ts), so the
 *  preview cannot drift from the message. */
export const ComposeEditing = ts("ComposeEditing", {
  to: S.String,
  subject: S.String,
  body: S.String,
  isPreviewing: S.Boolean,
  maybeReply: S.Option(ReplyContext),
});
export const Compose = S.Union([ComposeClosed, ComposeEditing]);
export type Compose = typeof Compose.Type;

/** Addresses as typed, one per comma. Empty entries are dropped rather than
 *  sent as blanks, so a trailing comma is not an error. */
export const parseRecipients = (text: string): ReadonlyArray<string> =>
  text
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");

/** A compose worth sending: somewhere to send it, and something to say. */
export const isSendable = (compose: typeof ComposeEditing.Type): boolean =>
  Arr.isReadonlyArrayNonEmpty(parseRecipients(compose.to)) &&
  compose.body.trim() !== "";

export const ShowingList = ts("ShowingList", {
  maybeError: S.Option(S.String),
});
export const OpeningThread = ts("OpeningThread", { id: ThreadId });
export const ShowingThread = ts("ShowingThread", { detail: ThreadDetail });
export const Screen = S.Union([ShowingList, OpeningThread, ShowingThread]);
export type Screen = typeof Screen.Type;

export const Model = S.Struct({
  appearance: Appearance,
  folderMenu: Ui.Menu.Model,
  tabs: Ui.Tabs.Model,
  list: Ui.VirtualList.Model,
  palette: Ui.Palette.Model,
  accountPopover: Ui.Popover.Model,
  threads: ThreadsData.schema,
  sync: SyncMachine.State,
  /** The drain's state, which is also the queue badge: every state carries
   *  the pending and failed counts. */
  outbox: OutboxMachine.State,
  compose: Compose,
  /** Threads with a reply still in the queue, for the "Sending…" chip. The
   *  sent copy itself arrives through the sync like any other message. */
  sendingThreads: S.Array(ThreadId),
  /** The last permanent outbox failure, shown once rather than latched into
   *  the row it concerned. */
  maybeOutboxError: S.Option(S.String),
  screen: Screen,
  /** The single list cursor: mouse hover and j/k both move it. */
  maybeSelected: S.Option(S.Number),
  // NOTE: Bumped on each pointer entry; keys the overlay so a new session
  // remounts it rather than sliding from a stale row.
  hoverSession: S.Number,
  isPointerInside: S.Boolean,
  /** Once j/k claims the overlay it stays visible regardless of the pointer,
   *  until real mouse motion over a row reclaims it. */
  isKeyboardControlled: S.Boolean,
  searchResults: S.Array(ThreadRow),
  // NOTE: Bumped per issued search; a reply carrying an older seq lost the
  // race to a later keystroke and is dropped.
  searchSeq: S.Number,
  maybeSearchError: S.Option(S.String),
  maybeLocalBytes: S.Option(S.Number),
  /** The newest HOT_THREAD_COUNT threads are fully local, bodies and images.
   *  Latched; see the CompletedCacheImageBatch handler. */
  isRecentReady: S.Boolean,
});
export type Model = typeof Model.Type;

/** `maybeSeedRows` is the localStorage snapshot of the top of the list
 *  (inboxSnapshot.ts): seeded boots paint rows immediately as `Refreshing`,
 *  and the boot LoadInbox settles over them. */
export const init = (
  maybeSeedRows: Option.Option<ReadonlyArray<ThreadRow>> = Option.none(),
): Model => ({
  appearance: "System",
  folderMenu: Ui.Menu.init({ id: "inbox-folders", isAnimated: true }),
  tabs: Ui.Tabs.init({
    id: "inbox-tabs",
    selectedValue: Option.getOrElse(Arr.head(TAB_LABELS), () => ""),
  }),
  list: Ui.VirtualList.init({ id: LIST_ID, rowHeightPx: ROW_HEIGHT }),
  palette: Ui.Palette.init({ id: "inbox-palette" }),
  accountPopover: Ui.Popover.init({ id: "inbox-account", isAnimated: true }),
  threads: Option.match(maybeSeedRows, {
    onNone: (): typeof ThreadsData.schema.Type => AsyncData.Loading(),
    onSome: (rows) => AsyncData.Refreshing({ data: rows }),
  }),
  sync: SyncMachine.init(),
  outbox: OutboxMachine.init(),
  compose: ComposeClosed(),
  sendingThreads: [],
  maybeOutboxError: Option.none(),
  screen: ShowingList({ maybeError: Option.none() }),
  maybeSelected: Option.none(),
  hoverSession: 0,
  isPointerInside: false,
  isKeyboardControlled: false,
  searchResults: [],
  searchSeq: 0,
  maybeSearchError: Option.none(),
  maybeLocalBytes: Option.none(),
  isRecentReady: false,
});

// MESSAGE

export const GotFolderMenuMessage = m("GotFolderMenuMessage", {
  message: Ui.Menu.Message,
});
export const CompletedApplyAppearance = m("CompletedApplyAppearance");
export const GotTabsMessage = m("GotTabsMessage", { message: Ui.Tabs.Message });
/** Scroll/resize events from the VirtualList's container subscription. */
export const GotListMessage = m("GotListMessage", {
  message: Ui.VirtualList.Message,
});
/** Mouse entered a row: move the cursor (and the hover overlay) there. */
export const HoveredRow = m("HoveredRow", { index: S.Number });
/** Pointer entered the list area: a fresh hover session. */
export const EnteredList = m("EnteredList");
/** Pointer left the list area: the overlay fades out in place. */
export const ExitedList = m("ExitedList");
/** A row was clicked: open its thread. `id` — not `index` — is what names
 *  the thread. A strided backfill refresh or an incremental history pass can
 *  replace the row list between paint and click, which shifts every index;
 *  the id survives that. `index` rides along only to park the cursor. */
export const ClickedRow = m("ClickedRow", { id: ThreadId, index: S.Number });
/** Toggles the command palette — toolbar button or the global ⌘K sub. */
export const ToggledPalette = m("ToggledPalette");
export const GotPaletteMessage = m("GotPaletteMessage", {
  message: Ui.Palette.Message,
});
export const GotAccountPopoverMessage = m("GotAccountPopoverMessage", {
  message: Ui.Popover.Message,
});
/** The popover's sign-out action. main.ts owns the session, so it watches for
 *  this tag and runs SignOut; here it only closes the popover. */
export const ClickedAccountSignOut = m("ClickedAccountSignOut");
/** The popover's light/dark switch. */
export const ClickedAppearance = m("ClickedAppearance");
/** Ranked results for the search identified by `seq`. */
export const SucceededSearch = m("SucceededSearch", {
  seq: S.Number,
  rows: S.Array(ThreadRow),
});
export const FailedSearch = m("FailedSearch", {
  seq: S.Number,
  error: S.String,
});
/** The SyncEngine finished a pull: real thread rows from the local store. */
export const SucceededLoadInbox = m("SucceededLoadInbox", {
  rows: S.Array(ThreadRow),
});
/** The boot-only LIMITed first read: enough rows to paint the viewport,
 *  decoded in O(limit) instead of O(mailbox). The full read follows. */
export const SucceededLoadInboxTop = m("SucceededLoadInboxTop", {
  rows: S.Array(ThreadRow),
});
/** A failed top read stays silent: the full read that follows either
 *  succeeds or owns the error report. */
export const FailedLoadInboxTop = m("FailedLoadInboxTop", {
  error: S.String,
});
/** A sync-machine fact (checkpoint read, batch landed, failure, …). */
export const GotSyncMessage = m("GotSyncMessage", {
  message: SyncMachine.Message,
});
export const FailedLoadInbox = m("FailedLoadInbox", { error: S.String });
/** On-disk size of the local store, for the sync pill's detail. */
export const SucceededReadLocalSize = m("SucceededReadLocalSize", {
  bytes: S.Number,
});
export const FailedReadLocalSize = m("FailedReadLocalSize", {
  error: S.String,
});
/** One image batch landed — the prefetch loop's cue to ask for the next.
 *  Carries the milestone rather than a count: the pill reports *that* the
 *  recent window is fully local, not how far along it is. */
export const CompletedCacheImageBatch = m("CompletedCacheImageBatch", {
  isRecentReady: S.Boolean,
});
export const FailedCacheImageBatch = m("FailedCacheImageBatch", {
  error: S.String,
});
export const SucceededLoadThread = m("SucceededLoadThread", {
  detail: ThreadDetail,
});
export const ListKey = S.Literals(["j", "k", "Enter", "Escape"]);
export type ListKey = typeof ListKey.Type;

/** List keyboard nav from the global subscription in main.ts. */
export const PressedListKey = m("PressedListKey", { key: ListKey });
export const FailedLoadThread = m("FailedLoadThread", { error: S.String });
export const ClickedBack = m("ClickedBack");
export const CompletedScrollListToRow = m("CompletedScrollListToRow");

// OUTGOING
//
// The three flag actions name the thread by id, never by position, for the
// same reason ClickedRow does: a refresh between paint and click shifts
// every index, and starring the wrong thread is worse than doing nothing.

export const ClickedStarRow = m("ClickedStarRow", { id: ThreadId });
export const ClickedArchiveRow = m("ClickedArchiveRow", { id: ThreadId });
export const ClickedToggleReadRow = m("ClickedToggleReadRow", {
  id: ThreadId,
});
export const ClickedCompose = m("ClickedCompose");
/** Reply to the open thread, prefilled from its newest message. */
export const ClickedReply = m("ClickedReply");
export const EditedCompose = m("EditedCompose", {
  field: ComposeField,
  value: S.String,
});
export const ToggledComposePreview = m("ToggledComposePreview");
export const CompletedFocusComposeField = m("CompletedFocusComposeField");
export const ClickedSend = m("ClickedSend");
export const ClosedCompose = m("ClosedCompose");
/** The op is durably queued and the local store already reflects it.
 *  `maybePatch` is the one row the list has to catch up on. */
export const SucceededEnqueueOp = m("SucceededEnqueueOp", {
  maybePatch: S.Option(ThreadPatch),
  maybeSendingThreadId: S.Option(ThreadId),
});
/** The queue write itself failed, so *nothing* happened — no local change to
 *  roll back, and the action can simply be repeated. */
export const FailedEnqueueOp = m("FailedEnqueueOp", { error: S.String });
export const GotOutboxMessage = m("GotOutboxMessage", {
  message: OutboxMachine.Message,
});
/** Dismisses the outbox error line. */
export const ClosedOutboxError = m("ClosedOutboxError");

export const Message = S.Union([
  GotFolderMenuMessage,
  CompletedApplyAppearance,
  GotTabsMessage,
  GotListMessage,
  HoveredRow,
  EnteredList,
  ExitedList,
  ClickedRow,
  ToggledPalette,
  GotPaletteMessage,
  GotAccountPopoverMessage,
  ClickedAccountSignOut,
  ClickedAppearance,
  SucceededSearch,
  FailedSearch,
  SucceededLoadInbox,
  SucceededLoadInboxTop,
  FailedLoadInboxTop,
  GotSyncMessage,
  FailedLoadInbox,
  SucceededReadLocalSize,
  FailedReadLocalSize,
  CompletedCacheImageBatch,
  FailedCacheImageBatch,
  SucceededLoadThread,
  PressedListKey,
  FailedLoadThread,
  ClickedBack,
  CompletedScrollListToRow,
  ClickedStarRow,
  ClickedArchiveRow,
  ClickedToggleReadRow,
  ClickedCompose,
  ClickedReply,
  EditedCompose,
  ToggledComposePreview,
  CompletedFocusComposeField,
  ClickedSend,
  ClosedCompose,
  SucceededEnqueueOp,
  FailedEnqueueOp,
  GotOutboxMessage,
  ClosedOutboxError,
]);
export type Message = typeof Message.Type;
