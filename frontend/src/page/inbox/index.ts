// The inbox page: its Commands and its update. Re-exports model.ts and
// view.ts so `Inbox.Model` / `Inbox.view` stay one import for main.ts.

import {
  Array as Arr,
  Cause,
  Effect,
  Match as M,
  Number,
  Option,
  Result,
  Schema as S,
} from "effect";
import { AsyncData, Command } from "foldkit";
import { evo } from "foldkit/struct";

import { mark } from "../../bootMarks";
import { ThreadId } from "../../Gmail";
import { renderMarkdownToEmailHtml } from "../../markdown";
import { replyReferences, replySubject } from "../../mime";
import { OutboxEngine } from "../../outboxEngine";
import * as OutboxMachine from "../../outboxMachine";
import {
  OutboxOp,
  SEND_MESSAGE,
  SendMessage,
  archiveOp,
  readOp,
  starOp,
  type ThreadPatch,
} from "../../outboxOps";
import { Search } from "../../search";
import { Folder, SyncEngine, ThreadRow } from "../../sync";
import * as SyncMachine from "../../syncMachine";
import * as Ui from "../../ui";

import {
  Appearance,
  CATEGORIES_FOR_TAB,
  ComposeClosed,
  ComposeEditing,
  ComposeField,
  CompletedFocusComposeField,
  composeFieldId,
  CompletedApplyAppearance,
  CompletedScrollListToRow,
  FailedEnqueueOp,
  FailedLoadFolder,
  FailedLoadThread,
  CompletedCacheImageBatch,
  FailedCacheImageBatch,
  CompletedCacheAvatarBatch,
  FailedCacheAvatarBatch,
  CompletedConvertMarkdownBatch,
  FailedConvertMarkdownBatch,
  FailedReadLocalSize,
  FailedSearch,
  FolderMenu,
  GotAccountPopoverMessage,
  GotFolderMenuMessage,
  GotListMessage,
  GotOutboxMessage,
  GotPaletteMessage,
  GotSyncMessage,
  GotTabsMessage,
  InboxPalette,
  LIST_ID,
  ListKey,
  Message,
  Model,
  OpeningThread,
  PALETTE_RESULT_LIMIT,
  ROW_HEIGHT,
  isSendable,
  parseRecipients,
  patchRow,
  reconcileRows,
  ShowingList,
  ShowingThread,
  SucceededEnqueueOp,
  SucceededLoadFolder,
  SucceededLoadInboxTop,
  FailedLoadInboxTop,
  SucceededLoadThread,
  SucceededReadLocalSize,
  SucceededReadCounts,
  FailedReadCounts,
  SucceededSearch,
  TabLabel,
  tabLabelOf,
  visibleRows,
} from "./model";

export * from "./model";
export { view } from "./view";

/** Everything this page's Commands can require. main.ts folds it into the
 *  application's own resource union, and entry.ts provides the layers. */
export type InboxResources = SyncEngine | Search | OutboxEngine;

// COMMAND

const APPEARANCE_CROSSFADE = "220 millis";

// System follows the OS; Light/Dark pin a class on <html> so the light-dark()
// tokens re-resolve, wrapped in a cross-fade.
const ApplyAppearance = Command.define(
  "ApplyAppearance",
  { appearance: Appearance },
  CompletedApplyAppearance,
)(({ appearance }) =>
  Effect.gen(function* () {
    const root = document.documentElement;
    yield* Effect.sync(() => {
      root.classList.add("transitioning");
      root.classList.remove("light", "dark");
      if (appearance === "Light") {
        root.classList.add("light");
      }
      if (appearance === "Dark") {
        root.classList.add("dark");
      }
    });
    yield* Effect.sleep(APPEARANCE_CROSSFADE);
    yield* Effect.sync(() => root.classList.remove("transitioning"));
    return CompletedApplyAppearance();
  }),
);

/** Selects one folder from the local store, newest first. No network: filling
 *  the store is the sync machine's job. */
export const LoadFolder = Command.define(
  "LoadFolder",
  { folder: Folder, tab: TabLabel },
  SucceededLoadFolder,
  FailedLoadFolder,
)(({ folder, tab }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    // Outside the inbox there are no tabs, so nothing narrows: the categories
    // are still on the rows, but every folder shows all of them.
    const categories = folder === "inbox" ? CATEGORIES_FOR_TAB[tab] : [];
    return yield* engine.loadFolder(folder, categories).pipe(
      Effect.map((rows) => SucceededLoadFolder({ folder, tab, rows })),
      Effect.catchCause((cause) =>
        Effect.succeed(
          FailedLoadFolder({ folder, error: Cause.pretty(cause) }),
        ),
      ),
    );
  }),
);

/** How many rows the boot-only first read selects: comfortably past the
 *  viewport, still O(1) against mailbox size. */
export const TOP_READ_LIMIT = 200;

/** The boot-only LIMITed first read; the full LoadInbox is issued from its
 *  result, and so are ReadLocalSize and the image loop — everything shares
 *  one serialized DB worker, so nothing may queue ahead of the paint. */
const LoadInboxTop = Command.define(
  "LoadInboxTop",
  SucceededLoadInboxTop,
  FailedLoadInboxTop,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.loadInboxTop(TOP_READ_LIMIT).pipe(
      Effect.map((rows) => SucceededLoadInboxTop({ rows })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedLoadInboxTop({ error: Cause.pretty(cause) })),
      ),
    );
  }),
);

/** Everything main.ts issues on entering the inbox: the LIMITed first local
 *  read plus the sync machine's checkpoint-derived boot. The full read, the
 *  size read, and the image loop chain off the top read's result rather than
 *  queueing here in front of the first paint. `accountEmail` scopes the
 *  local store — a different mailbox wipes it rather than blending. */
export const bootCommands = (
  accountEmail: string,
): ReadonlyArray<Command.Command<Message, never, InboxResources>> => [
  LoadInboxTop(),
  ...Command.mapMessages(SyncMachine.bootCommands(accountEmail), (message) =>
    GotSyncMessage({ message }),
  ),
  // Whatever the last session queued and never got out. Costs one local
  // SELECT when the queue is empty, which is the usual case.
  ...Command.mapMessages(OutboxMachine.bootCommands(), (message) =>
    GotOutboxMessage({ message }),
  ),
];

/** One palette search. `seq` rides through the service untouched so the update
 *  can tell a fresh reply from a superseded one. */
export const RunSearch = Command.define(
  "RunSearch",
  { seq: S.Number, text: S.String },
  SucceededSearch,
  FailedSearch,
)(({ seq, text }) =>
  Effect.gen(function* () {
    const search = yield* Search;
    return yield* search.search({ text, limit: PALETTE_RESULT_LIMIT }).pipe(
      Effect.map((rows) => SucceededSearch({ seq, rows })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedSearch({ seq, error: Cause.pretty(cause) })),
      ),
    );
  }),
);

/** The store's on-disk size, for the sync pill's detail. Re-read on the same
 *  cadence as the row refresh so it tracks a running backfill. */
export const ReadLocalSize = Command.define(
  "ReadLocalSize",
  SucceededReadLocalSize,
  FailedReadLocalSize,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.localSizeBytes.pipe(
      Effect.map((bytes) => SucceededReadLocalSize({ bytes })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedReadLocalSize({ error: Cause.pretty(cause) })),
      ),
    );
  }),
);

const IMAGE_IDLE_WAIT = "4 seconds";
const IMAGE_RETRY_WAIT = "15 seconds";

/**
 * One turn of the image prefetch loop, re-issued from its own result. Runs
 * alongside the sync machine rather than after it: the backfill is bound by
 * Gmail's quota bucket and this by the image proxy, so sequencing them would
 * leave one resource idle for the whole sync.
 */
// NOTE: The idle wait lives in the Command rather than a Subscription because
// idleness is a fact the engine discovers, not a schedule.
export const CacheImageBatch = Command.define(
  "CacheImageBatch",
  CompletedCacheImageBatch,
  FailedCacheImageBatch,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.cacheImageBatch.pipe(
      Effect.tap(({ isIdle }) =>
        isIdle ? Effect.sleep(IMAGE_IDLE_WAIT) : Effect.void,
      ),
      Effect.map(({ isRecentReady }) =>
        CompletedCacheImageBatch({ isRecentReady }),
      ),
      Effect.catchCause((cause) =>
        Effect.sleep(IMAGE_RETRY_WAIT).pipe(
          Effect.as(FailedCacheImageBatch({ error: Cause.pretty(cause) })),
        ),
      ),
    );
  }),
);

/** The tab and folder badges. Issued with every folder read, so the numbers
 *  move with the list rather than lagging a backfill behind it. */
export const ReadCounts = Command.define(
  "ReadCounts",
  SucceededReadCounts,
  FailedReadCounts,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.readCounts.pipe(
      Effect.map((counts) => SucceededReadCounts({ counts })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedReadCounts({ error: Cause.pretty(cause) })),
      ),
    );
  }),
);

const AVATAR_IDLE_WAIT = "10 seconds";
const AVATAR_RETRY_WAIT = "60 seconds";

/**
 * One turn of the avatar loop, re-issued from its own result — the same shape
 * as CacheImageBatch, and running alongside it for the same reason: mail
 * images are bound by the proxy, avatars by one request each to a hundred
 * different origins, so sequencing them would leave one idle throughout.
 *
 * Idles far longer than the image loop. Senders repeat, so the set of distinct
 * domains stops growing long before the mailbox does.
 */
export const CacheAvatarBatch = Command.define(
  "CacheAvatarBatch",
  CompletedCacheAvatarBatch,
  FailedCacheAvatarBatch,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.cacheAvatarBatch.pipe(
      Effect.tap(({ isIdle }) =>
        isIdle ? Effect.sleep(AVATAR_IDLE_WAIT) : Effect.void,
      ),
      Effect.map(({ addedCount }) => CompletedCacheAvatarBatch({ addedCount })),
      Effect.catchCause((cause) =>
        Effect.sleep(AVATAR_RETRY_WAIT).pipe(
          Effect.as(FailedCacheAvatarBatch({ error: Cause.pretty(cause) })),
        ),
      ),
    );
  }),
);

// Longer waits than the other two loops on purpose. This one is bound by the
// main thread rather than by a remote service, so its cost is measured in
// frames the list did not get to draw — and unlike images, nothing on screen
// is waiting for it. The queue is finite and never refills once a mailbox has
// finished backfilling.
const MARKDOWN_TURN_WAIT = "2 seconds";
const MARKDOWN_IDLE_WAIT = "60 seconds";
const MARKDOWN_RETRY_WAIT = "60 seconds";

/** True while the sync still has work in flight. What decides whether the
 *  markdown loop may touch the whole store or only the threads you opened —
 *  both want the same main thread, and the sync is the one you can see. */
const isSyncBusy = (state: SyncMachine.State): boolean =>
  state._tag !== "Settled" && state._tag !== "NeedsAuth";

/**
 * One turn of the markdown backfill, re-issued from its own result. Converts
 * bodies stored without markdown — which is all of them, since the sync path
 * deliberately does not convert — so that opening them stops costing a
 * DOMPurify pass over the raw html. Purely an optimization: an unconverted
 * body opens exactly as it did before.
 *
 * `openedOnly` keeps it out of the sync's way. During a walk it converts only
 * threads you have opened, which is a handful of bodies and buys the thing you
 * would notice; the unbounded pass waits for the sync to settle.
 */
export const ConvertMarkdownBatch = Command.define(
  "ConvertMarkdownBatch",
  { openedOnly: S.Boolean },
  CompletedConvertMarkdownBatch,
  FailedConvertMarkdownBatch,
)(({ openedOnly }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.convertMarkdownBatch(openedOnly).pipe(
      Effect.tap(({ isIdle }) =>
        Effect.sleep(isIdle ? MARKDOWN_IDLE_WAIT : MARKDOWN_TURN_WAIT),
      ),
      Effect.as(CompletedConvertMarkdownBatch()),
      Effect.catchCause((cause) =>
        Effect.sleep(MARKDOWN_RETRY_WAIT).pipe(
          Effect.as(FailedConvertMarkdownBatch({ error: Cause.pretty(cause) })),
        ),
      ),
    );
  }),
);

/** Opens a thread from the local store only: SQLite rows, cid: images
 *  rewritten from locally cached bytes. No network. */
export const LoadThread = Command.define(
  "LoadThread",
  { id: ThreadId },
  SucceededLoadThread,
  FailedLoadThread,
)(({ id }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    // parcel:data:* is the perf bench's data-phase bracket (perf/src/bench.ts).
    yield* mark("parcel:data:start");
    return yield* engine.loadThread(id).pipe(
      Effect.map((detail) => SucceededLoadThread({ detail })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedLoadThread({ error: Cause.pretty(cause) })),
      ),
      Effect.tap(mark("parcel:data:end")),
    );
  }),
);

/** Queues one outgoing action and applies it to the local store, in one
 *  transaction. The action is done from here on; getting it to Gmail is the
 *  outbox machine's problem. */
export const EnqueueOp = Command.define(
  "EnqueueOp",
  { op: OutboxOp },
  SucceededEnqueueOp,
  FailedEnqueueOp,
)(({ op }) =>
  Effect.gen(function* () {
    const engine = yield* OutboxEngine;
    return yield* engine.enqueue(op).pipe(
      Effect.map((maybePatch) =>
        SucceededEnqueueOp({
          maybePatch,
          maybeSendingThreadId:
            op._tag === SEND_MESSAGE ? op.maybeThreadId : Option.none(),
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedEnqueueOp({ error: Cause.pretty(cause) })),
      ),
    );
  }),
);

/** Moves focus into the compose panel when it opens, so the panel is where
 *  the keyboard already is rather than somewhere to be found. */
// NOTE: A Command, not a Mount: the cause is the message that opened the
// panel, not the input existing. Missing the element is not a failure worth
// reporting — the panel closing before the focus lands is the only way it
// happens, and the user has already moved on.
export const FocusComposeField = Command.define(
  "FocusComposeField",
  { field: ComposeField },
  CompletedFocusComposeField,
)(({ field }) =>
  Effect.sync(() => {
    document.getElementById(composeFieldId(field))?.focus();
    return CompletedFocusComposeField();
  }),
);

/** Keeps the keyboard cursor on screen. */
// NOTE: Scrolls the container directly rather than using scrollIntoView: the
// target row usually isn't mounted, and the fixed row height makes its
// position known anyway.
export const ScrollListToRow = Command.define(
  "ScrollListToRow",
  { index: S.Number },
  CompletedScrollListToRow,
)(({ index }) =>
  Effect.sync(() => {
    const element = document.getElementById(LIST_ID);
    if (element !== null) {
      const top = index * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      if (top < element.scrollTop) {
        element.scrollTop = top;
      } else if (bottom > element.scrollTop + element.clientHeight) {
        element.scrollTop = bottom - element.clientHeight;
      }
    }
    return CompletedScrollListToRow();
  }),
);

// UPDATE

type UpdateReturn = readonly [
  Model,
  ReadonlyArray<Command.Command<Message, never, InboxResources>>,
];

/** Issued exactly once, from the top read's settle (either branch): the full
 *  read that settles the list, then the size read and the image loop queued
 *  behind it on the shared worker. */
const afterTopReadCommands = (
  folder: Folder,
  tab: TabLabel,
): ReadonlyArray<Command.Command<Message, never, InboxResources>> => [
  LoadFolder({ folder, tab }),
  ReadCounts(),
  ReadLocalSize(),
  CacheImageBatch(),
  CacheAvatarBatch(),
  // Starts in the narrow mode. The first read happens while the sync is at its
  // busiest, and every later turn re-reads the machine's state for itself.
  ConvertMarkdownBatch({ openedOnly: true }),
];

// Every palette query goes through here, so the seq can never be bumped
// without a search in flight to match it.
const runSearch = (model: Model, text: string): UpdateReturn => {
  const seq = Number.increment(model.searchSeq);
  return [evo(model, { searchSeq: () => seq }), [RunSearch({ seq, text })]];
};

/** The current folder's rows as loaded, before any tab narrowing. What the
 *  reconcilers and by-id lookups run against. */
const storedRows = (model: Model): ReadonlyArray<ThreadRow> =>
  Option.getOrElse(AsyncData.getData(model.threads), () => []);

/** The rows actually on screen (see visibleRows). Everything positional —
 *  the cursor, j/k, Enter — indexes into this. */
const listedRows = (model: Model): ReadonlyArray<ThreadRow> =>
  visibleRows(model, storedRows(model));

// NOTE: Re-selecting and decoding the whole store costs tens of ms at 10k
// rows, so backfill progress refreshes the list on a stride, not per batch.
const REFRESH_STRIDE = 200;

// NOTE: Below this many synced rows every page repaints, so a fresh mailbox
// fills visibly instead of sitting on the prime's handful of rows for the
// first two strides. Above it the stride amortises the re-decode again.
export const PRIORITY_WINDOW = 500;

const hasCrossedStride = (
  previousCount: number,
  syncedCount: number,
): boolean =>
  Math.floor(previousCount / REFRESH_STRIDE) !==
  Math.floor(syncedCount / REFRESH_STRIDE);

// Whether a sync-machine fact leaves enough new rows in the store to be worth
// re-reading: the prime, the priority window, a strided slice of the backfill,
// the backfill's end, or an incremental pass that changed rows.
const shouldRefreshRows = (
  before: SyncMachine.State,
  message: SyncMachine.Message,
): boolean =>
  M.value(message).pipe(
    M.tags({
      CompletedPrimeInbox: () => true,
      CompletedSyncBatch: ({ syncedCount, maybeNextPageToken }) =>
        Option.isNone(maybeNextPageToken) ||
        syncedCount <= PRIORITY_WINDOW ||
        hasCrossedStride(
          before._tag === "Backfilling" ? before.syncedCount : 0,
          syncedCount,
        ),
      AppliedHistory: ({ changedCount }) => changedCount > 0,
      // The point of interleaving history into the backfill: mail arriving
      // mid-sync reaches the list now, not when the walk finishes.
      RefreshedDuringBackfill: ({ changedCount }) => changedCount > 0,
    }),
    M.orElse(() => false),
  );

// NOTE: The thread is named by id, never by position. Strided backfill
// refreshes and history passes replace the row list wholesale, so an index
// captured at paint time can address a different thread by the time the click
// lands. `index` only parks the cursor.
const openThread = (
  model: Model,
  id: ThreadId,
  index: number,
): UpdateReturn => {
  const base = evo(model, { maybeSelected: () => Option.some(index) });
  if (base.screen._tag === "ShowingThread" && base.screen.detail.id === id) {
    return [base, []];
  }
  // Opening is reading. The mark-read rides the same outbox op as the
  // explicit toggle, so the dot clears optimistically and Gmail hears about
  // it when the queue drains — an already-read thread enqueues nothing.
  const markRead = Option.map(
    Option.filter(
      Arr.findFirst(listedRows(base), (row) => row.id === id),
      (row) => row.isUnread,
    ),
    (row) => EnqueueOp({ op: readOp(row.id, true) }),
  );
  return [
    evo(base, { screen: () => OpeningThread({ id }) }),
    [...Arr.fromOption(markRead), LoadThread({ id })],
  ];
};

// Opening from a position (the j/k cursor and Enter). Resolves the row first
// so the id, not the index, is what reaches openThread.
const openRowAt = (model: Model, index: number): UpdateReturn =>
  Option.match(Arr.get(listedRows(model), index), {
    onNone: (): UpdateReturn => [model, []],
    onSome: ({ id }) => openThread(model, id, index),
  });

// Picking a palette result. The cursor follows the thread into the list when
// it is on screen, and stays put when the search surfaced something the
// current list doesn't contain.
const openThreadId = (model: Model, id: string): UpdateReturn =>
  Option.match(
    Arr.findFirstIndex(listedRows(model), (row) => row.id === id),
    {
      onNone: (): UpdateReturn => [model, []],
      onSome: (index) => openRowAt(model, index),
    },
  );

const closeThread = (model: Model): UpdateReturn => [
  evo(model, { screen: () => ShowingList({ maybeError: Option.none() }) }),
  [],
];

// Switching mailboxes. The old folder's rows never paint under the new
// folder's name: the list drops to Loading, and the read that comes back is
// checked against the folder it was issued for.
const switchFolder = (model: Model, folder: Folder): UpdateReturn => {
  if (folder === model.folder) {
    return [model, []];
  }
  return [
    evo(model, {
      folder: () => folder,
      threads: (): Model["threads"] => AsyncData.Loading(),
      screen: () => ShowingList({ maybeError: Option.none() }),
      maybeSelected: () => Option.none(),
    }),
    [
      LoadFolder({ folder, tab: tabLabelOf(model.tabs.selectedValue) }),
      ReadCounts(),
      ScrollListToRow({ index: 0 }),
    ],
  ];
};

const isStaleSearch = (model: Model, seq: number): boolean =>
  seq !== model.searchSeq;

// OUTGOING

// The list catching up to a local write that has already happened. Only the
// one row changes, and the cursor is clamped because an archive shortens the
// list under it.
const applyPatch = (model: Model, patch: ThreadPatch): Model => {
  const rows = storedRows(model);
  // Leaving the inbox is only a removal in the inbox. An archived thread is
  // still a member of All Mail, Starred, Sent — every other folder keeps the
  // row and takes just the flag changes.
  const effective =
    patch.isRemoved && model.folder !== "inbox"
      ? evo(patch, { isRemoved: () => false })
      : patch;
  const next = patchRow(rows, effective);
  if (next === rows) {
    return model;
  }
  const patched = evo(model, {
    threads: (threads) => AsyncData.map(threads, () => next),
  });
  // Clamped against what is on screen: the tab filter can shorten the list
  // well past where the stored rows end.
  const lastIndex = listedRows(patched).length - 1;
  return evo(patched, {
    maybeSelected: (maybeSelected) =>
      Option.filter(
        Option.map(maybeSelected, (index) => Math.min(index, lastIndex)),
        (index) => index >= 0,
      ),
  });
};

// Every flag action is the same two steps: name the op from the row's current
// state, and queue it. The row is found by id because an index captured at
// paint time may address a different thread by the time the click lands.
const enqueueForRow = (
  model: Model,
  id: ThreadId,
  toOp: (row: ThreadRow) => OutboxOp,
): UpdateReturn =>
  Option.match(
    Arr.findFirst(storedRows(model), (row) => row.id === id),
    {
      onNone: (): UpdateReturn => [model, []],
      onSome: (row) => [model, [EnqueueOp({ op: toOp(row) })]],
    },
  );

const editingCompose = (
  model: Model,
): Option.Option<typeof ComposeEditing.Type> =>
  Option.liftPredicate(
    model.compose,
    (compose): compose is typeof ComposeEditing.Type =>
      compose._tag === "ComposeEditing",
  );

// Every compose edit is the same shape: if a draft is open, replace it with an
// edited one; if not, the message was for a panel that has since closed.
const withEditingCompose = (
  model: Model,
  edit: (compose: typeof ComposeEditing.Type) => typeof ComposeEditing.Type,
): Model =>
  Option.match(editingCompose(model), {
    onNone: () => model,
    onSome: (compose) => evo(model, { compose: () => edit(compose) }),
  });

// NOTE: Matched rather than written as `evo(compose, { [field]: … })`. `evo`
// takes literal keys only — a computed one widens to an index signature and is
// rejected — and reaching for a spread instead would step outside the one
// update path every Model change goes through.
const editComposeField = (
  compose: typeof ComposeEditing.Type,
  field: ComposeField,
  value: string,
): typeof ComposeEditing.Type =>
  M.value(field).pipe(
    M.withReturnType<typeof ComposeEditing.Type>(),
    M.when("to", () => evo(compose, { to: () => value })),
    M.when("subject", () => evo(compose, { subject: () => value })),
    M.when("body", () => evo(compose, { body: () => value })),
    M.exhaustive,
  );

// A reply is prefilled from the newest message in the open thread: its sender
// is the recipient, and its Message-ID is what threads the reply in that
// person's client.
const openReply = (model: Model): UpdateReturn => {
  if (model.screen._tag !== "ShowingThread") {
    return [model, []];
  }
  const { detail } = model.screen;
  return Option.match(Arr.last(detail.messages), {
    onNone: (): UpdateReturn => [model, []],
    onSome: (latest) => [
      evo(model, {
        compose: () =>
          ComposeEditing({
            to: latest.fromEmail,
            subject: replySubject(detail.subject),
            body: "",
            isPreviewing: false,
            maybeReply: Option.some({
              threadId: detail.id,
              inReplyTo: latest.rfc822MessageId,
              references: replyReferences(
                latest.references,
                latest.rfc822MessageId,
              ),
            }),
          }),
      }),
      // The recipient and subject are already filled in, so the body is where
      // there is actually something to type.
      [FocusComposeField({ field: "body" })],
    ],
  });
};

const sendCompose = (model: Model): UpdateReturn =>
  Option.match(Option.filter(editingCompose(model), isSendable), {
    // The Send button is disabled in this case; reaching it anyway (a stray
    // Enter, say) should do nothing rather than queue an empty message.
    onNone: (): UpdateReturn => [model, []],
    onSome: (compose) => {
      const op = SendMessage({
        to: parseRecipients(compose.to),
        subject: compose.subject,
        bodyMarkdown: compose.body,
        // Rendered here, once, so the queued op carries exactly what the
        // preview showed rather than re-rendering at send time.
        bodyHtml: renderMarkdownToEmailHtml(compose.body),
        maybeThreadId: Option.map(
          compose.maybeReply,
          (reply) => reply.threadId,
        ),
        maybeInReplyTo: Option.flatMap(compose.maybeReply, (reply) =>
          Option.liftPredicate(reply.inReplyTo, (id) => id !== ""),
        ),
        references: Option.match(compose.maybeReply, {
          onNone: () => "",
          onSome: (reply) => reply.references,
        }),
      });
      // The panel closes immediately: the message is the outbox's from the
      // moment it is queued, and holding a spinner over a durable queue would
      // be pretending otherwise.
      return [
        evo(model, { compose: () => ComposeClosed() }),
        [EnqueueOp({ op })],
      ];
    },
  });

// A settled send, however it settled, is no longer sending.
const settleSending = (
  model: Model,
  maybeThreadId: Option.Option<ThreadId>,
): Model =>
  Option.match(maybeThreadId, {
    onNone: () => model,
    onSome: (threadId) =>
      evo(model, {
        sendingThreads: (threads) =>
          threads.filter((sending) => sending !== threadId),
      }),
  });

// What one drain outcome means to the page, on top of what it means to the
// machine: a rolled-back label edit has to reach the row, and a settled send
// has to clear its chip.
const applyDrainOutcome = (
  model: Model,
  message: OutboxMachine.Message,
): Model => {
  if (message._tag !== "SteppedDrain") {
    return model;
  }
  return M.value(message.result).pipe(
    M.withReturnType<Model>(),
    M.tagsExhaustive({
      Applied: ({ maybeSentThreadId }) =>
        settleSending(model, maybeSentThreadId),
      Rejected: ({ maybeRollback, maybeSentThreadId, message: error }) =>
        evo(
          Option.match(maybeRollback, {
            onNone: () => settleSending(model, maybeSentThreadId),
            onSome: (rollback) =>
              applyPatch(settleSending(model, maybeSentThreadId), rollback),
          }),
          { maybeOutboxError: () => Option.some(error) },
        ),
      Drained: () => model,
      Deferred: () => model,
    }),
  );
};

// One step of the outbox machine, plus the page-level consequences of what
// the step just learned. Every path into the machine goes through here.
const stepOutbox = (
  model: Model,
  message: OutboxMachine.Message,
): UpdateReturn => {
  const [nextOutbox, commands] = OutboxMachine.step(model.outbox, message);
  return [
    applyDrainOutcome(evo(model, { outbox: () => nextOutbox }), message),
    Command.mapMessages(commands, (message) => GotOutboxMessage({ message })),
  ];
};

// The same for the sync machine, plus the row refresh its progress earns and
// the one message both machines answer to.
const stepSync = (model: Model, message: SyncMachine.Message): UpdateReturn => {
  const [nextSync, commands] = SyncMachine.step(model.sync, message);
  const syncCommands = [
    ...Command.mapMessages(commands, (message) => GotSyncMessage({ message })),
    ...(shouldRefreshRows(model.sync, message)
      ? [
          LoadFolder({
            folder: model.folder,
            tab: tabLabelOf(model.tabs.selectedValue),
          }),
          ReadCounts(),
          ReadLocalSize(),
        ]
      : []),
  ];
  const stepped = evo(model, { sync: () => nextSync });
  // One pill, two machines. Both park on the same lost grant, so the click
  // that revives the sync has to revive the drain as well — otherwise
  // reconnecting brings mail in and still will not send any.
  if (message._tag !== "ClickedReconnect") {
    return [stepped, syncCommands];
  }
  const [revived, outboxCommands] = stepOutbox(
    stepped,
    OutboxMachine.ClickedReconnect(),
  );
  return [revived, [...syncCommands, ...outboxCommands]];
};

// NOTE: With no cursor yet, either direction lands on the first row, stated
// outright rather than falling out of arithmetic on a sentinel.
const moveCursor = (model: Model, step: number): UpdateReturn => {
  const rows = listedRows(model);
  if (Arr.isReadonlyArrayEmpty(rows)) {
    return [model, []];
  }
  const lastIndex = rows.length - 1;
  const nextIndex = Option.match(model.maybeSelected, {
    onNone: () => 0,
    onSome: (current) => Math.min(Math.max(current + step, 0), lastIndex),
  });
  return [
    evo(model, {
      maybeSelected: () => Option.some(nextIndex),
      isKeyboardControlled: () => true,
    }),
    [ScrollListToRow({ index: nextIndex })],
  ];
};

// The palette owns the keyboard while it's open, and inside an open thread
// only Escape is bound: j/k/Enter are reserved for in-thread navigation.
const handlePressedListKey =
  (model: Model) =>
  (key: ListKey): UpdateReturn => {
    if (model.palette.dialog.isOpen) {
      return [model, []];
    }
    // NOTE: Before the thread branch, not after. An open compose panel is on
    // top of whatever it was opened from, so Escape has to dismiss the panel;
    // falling through would close the *thread underneath* a reply and leave
    // the panel floating over the list, with the half-written reply the only
    // thing still on screen.
    if (model.compose._tag === "ComposeEditing") {
      return key === "Escape"
        ? [evo(model, { compose: () => ComposeClosed() }), []]
        : [model, []];
    }
    if (model.screen._tag === "ShowingThread") {
      return key === "Escape" ? closeThread(model) : [model, []];
    }
    return M.value(key).pipe(
      M.withReturnType<UpdateReturn>(),
      M.when("Escape", () => [model, []]),
      M.when("Enter", () =>
        Option.match(model.maybeSelected, {
          onNone: (): UpdateReturn => [model, []],
          onSome: (index) => openRowAt(model, index),
        }),
      ),
      M.when("j", () => moveCursor(model, 1)),
      M.when("k", () => moveCursor(model, -1)),
      M.exhaustive,
    );
  };

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      GotFolderMenuMessage: ({ message }) => {
        const [nextFolderMenu, commands, maybeSelected] = FolderMenu.update(
          model.folderMenu,
          message,
        );
        const stepped = evo(model, { folderMenu: () => nextFolderMenu });
        const mapped = Command.mapMessages(commands, (message) =>
          GotFolderMenuMessage({ message }),
        );
        // Picking an item is picking a mailbox.
        return Option.match(maybeSelected, {
          onNone: (): UpdateReturn => [stepped, mapped],
          onSome: ({ value }) => {
            const [next, switchCommands] = switchFolder(stepped, value);
            return [next, [...mapped, ...switchCommands]];
          },
        });
      },

      CompletedApplyAppearance: () => [model, []],

      GotTabsMessage: ({ message }) => {
        const [nextTabs, commands] = Ui.Tabs.update(model.tabs, message);
        // A tab commit re-slices the already-loaded rows (visibleRows); the
        // cursor and scroll reset because their positions belonged to the
        // previous slice.
        const isTabChanged =
          nextTabs.selectedValue !== model.tabs.selectedValue;
        return [
          evo(model, {
            tabs: () => nextTabs,
            maybeSelected: (maybeSelected) =>
              isTabChanged ? Option.none() : maybeSelected,
            // The rows on screen belong to the tab being left. Loading is
            // honest about the gap until the new read lands, and it is what
            // stops the old slice being shown under the new tab's label.
            threads: (threads): Model["threads"] =>
              isTabChanged ? AsyncData.Loading() : threads,
          }),
          [
            ...Command.mapMessages(commands, (message) =>
              GotTabsMessage({ message }),
            ),
            ...(isTabChanged
              ? [
                  LoadFolder({
                    folder: model.folder,
                    tab: tabLabelOf(nextTabs.selectedValue),
                  }),
                  ScrollListToRow({ index: 0 }),
                ]
              : []),
          ],
        ];
      },

      GotListMessage: ({ message }) => {
        const [nextList, commands] = Ui.VirtualList.update(model.list, message);
        return [
          evo(model, { list: () => nextList }),
          Command.mapMessages(commands, (message) =>
            GotListMessage({ message }),
          ),
        ];
      },

      // Real pointer motion always reclaims the overlay from the keyboard.
      HoveredRow: ({ index }) => [
        evo(model, {
          maybeSelected: () => Option.some(index),
          isKeyboardControlled: () => false,
        }),
        [],
      ],

      // The cursor is cleared so the overlay stays unmounted until the first
      // row is hovered, mounting there instead of sliding from wherever the
      // last session ended. Skipped while the keyboard holds the overlay: the
      // pointer merely entering the list shouldn't blank a cursor it hasn't
      // reclaimed.
      EnteredList: () => [
        evo(model, {
          hoverSession: Number.increment,
          isPointerInside: () => true,
          maybeSelected: (maybeSelected) =>
            model.isKeyboardControlled ? maybeSelected : Option.none(),
        }),
        [],
      ],

      // The cursor is kept so the overlay fades out in place (data-hidden)
      // and Enter still opens the last-hovered row.
      ExitedList: () => [evo(model, { isPointerInside: () => false }), []],

      ClickedRow: ({ id, index }) => openThread(model, id, index),

      // The palette opens blank: results follow typing, never precede it.
      // The seq bump orphans any search still in flight from the previous
      // session, so a late reply can't repopulate an empty palette.
      ToggledPalette: () => {
        const [nextPalette, commands] = InboxPalette.toggle(model.palette);
        const opened = evo(model, {
          palette: () => nextPalette,
          searchResults: (): ReadonlyArray<ThreadRow> => [],
          searchSeq: Number.increment,
          maybeSearchError: () => Option.none(),
        });
        return [
          opened,
          Command.mapMessages(commands, (message) =>
            GotPaletteMessage({ message }),
          ),
        ];
      },

      GotPaletteMessage: ({ message }) => {
        const [nextPalette, commands, maybeSelectedId] = InboxPalette.update(
          model.palette,
          message,
        );
        const paletteCommands = Command.mapMessages(commands, (message) =>
          GotPaletteMessage({ message }),
        );
        const stepped = evo(model, { palette: () => nextPalette });
        // Every item is a thread id: picking one opens that thread.
        return Option.match(maybeSelectedId, {
          onSome: (id): UpdateReturn => {
            const [next, openCommands] = openThreadId(stepped, id);
            return [next, [...paletteCommands, ...openCommands]];
          },
          // A keystroke is the only palette message that changes the corpus;
          // the rest (cursor moves, rect measurements) reuse the last hits.
          onNone: (): UpdateReturn => {
            if (message._tag !== "ChangedQuery") {
              return [stepped, paletteCommands];
            }
            // Deleting back to nothing returns to the blank palette rather
            // than to "every thread matches the empty string". The seq bump
            // orphans the in-flight search for the last real keystroke.
            if (message.query.trim() === "") {
              return [
                evo(stepped, {
                  searchResults: (): ReadonlyArray<ThreadRow> => [],
                  searchSeq: Number.increment,
                  maybeSearchError: () => Option.none(),
                }),
                paletteCommands,
              ];
            }
            const [next, searchCommands] = runSearch(stepped, message.query);
            return [next, [...paletteCommands, ...searchCommands]];
          },
        });
      },

      // Stale replies lost a race to a later keystroke; showing them would
      // flash results for a query the user has already moved past.
      SucceededSearch: ({ seq, rows }) =>
        isStaleSearch(model, seq)
          ? [model, []]
          : [
              evo(model, {
                searchResults: () => rows,
                maybeSearchError: () => Option.none(),
              }),
              [],
            ],

      FailedSearch: ({ seq, error }) =>
        isStaleSearch(model, seq)
          ? [model, []]
          : [
              evo(model, {
                searchResults: () => [],
                maybeSearchError: () => Option.some(error),
              }),
              [],
            ],

      GotAccountPopoverMessage: ({ message }) => {
        const [nextAccountPopover, commands] = Ui.Popover.update(
          model.accountPopover,
          message,
        );
        return [
          evo(model, { accountPopover: () => nextAccountPopover }),
          Command.mapMessages(commands, (message) =>
            GotAccountPopoverMessage({ message }),
          ),
        ];
      },

      // The boot top read: paints as `Refreshing` (the full read is still in
      // flight) unless a sync-triggered full read already settled the list,
      // in which case the newer, complete rows win and the top slice is
      // dropped. The rows are inbox rows, so a folder switched away from
      // before they landed also drops them. Either way the follow-up
      // commands fire, exactly once, for whatever folder is current.
      SucceededLoadInboxTop: ({ rows }) => [
        model.threads._tag === "Success" || model.folder !== "inbox"
          ? model
          : evo(model, {
              threads: () =>
                AsyncData.Refreshing({
                  data: reconcileRows(storedRows(model), rows),
                }),
            }),
        afterTopReadCommands(
          model.folder,
          tabLabelOf(model.tabs.selectedValue),
        ),
      ],

      // The full read that follows either succeeds or owns the error report;
      // a failed top read stays silent so the user never sees an error for a
      // query whose only job was an early paint.
      FailedLoadInboxTop: () => [
        model,
        afterTopReadCommands(
          model.folder,
          tabLabelOf(model.tabs.selectedValue),
        ),
      ],

      // Reconciled against the rows already loaded so unchanged threads keep
      // their object identity and the view can memoize past them. A read for
      // a folder no longer current lost a race to a switch and is dropped.
      // Stale on either axis now: the tab is part of the query, so a read
      // that was in flight across a tab switch describes a slice nobody is
      // looking at.
      SucceededLoadFolder: ({ folder, tab, rows }) =>
        folder !== model.folder || tab !== tabLabelOf(model.tabs.selectedValue)
          ? [model, []]
          : [
              evo(model, {
                threads: AsyncData.settle<ReadonlyArray<ThreadRow>, string>(
                  Result.succeed(reconcileRows(storedRows(model), rows)),
                ),
              }),
              [],
            ],

      GotSyncMessage: ({ message }) => stepSync(model, message),

      // NOTE: Re-wrapping an unchanged number in a fresh Option would hand the
      // pill a new argument and cost it its memoization slot for nothing.
      SucceededReadLocalSize: ({ bytes }) =>
        Option.contains(model.maybeLocalBytes, bytes)
          ? [model, []]
          : [evo(model, { maybeLocalBytes: () => Option.some(bytes) }), []],

      // A size read is decoration; failing it leaves the previous number (or
      // nothing) rather than disturbing anything the user is looking at.
      FailedReadLocalSize: () => [model, []],

      SucceededReadCounts: ({ counts }) => [
        evo(model, { counts: () => counts }),
        [],
      ],

      // Same as the size read: a badge is not worth disturbing the view over.
      FailedReadCounts: () => [model, []],

      // The loop re-arms itself on both outcomes; the Command has already
      // waited out its own backoff, which is what stops this from spinning.
      // NOTE: isRecentReady latches and is never cleared. New mail lands in
      // the hot window with its images seconds behind, and flickering the
      // milestone off for those seconds would be noise, not information.
      CompletedCacheImageBatch: ({ isRecentReady }) => [
        evo(model, {
          isRecentReady: (was) => was || isRecentReady,
        }),
        [CacheImageBatch()],
      ],
      FailedCacheImageBatch: () => [model, [CacheImageBatch()]],

      // The counter is the repaint. Bumping it only when something arrived
      // keeps an idle loop from re-rendering the list every ten seconds
      // forever.
      CompletedCacheAvatarBatch: ({ addedCount }) => [
        addedCount === 0
          ? model
          : evo(model, { avatarVersion: Number.increment }),
        [CacheAvatarBatch()],
      ],
      FailedCacheAvatarBatch: () => [model, [CacheAvatarBatch()]],

      // Nothing to fold in: the backfill changes what the next open of an old
      // message costs, and no part of the model describes that. Both arms exist
      // only to re-issue the loop, which has already waited out its own delay.
      // Each turn re-reads the sync state, so the loop widens by itself the
      // first turn after the mailbox settles — nothing has to notice and
      // restart it.
      CompletedConvertMarkdownBatch: () => [
        model,
        [ConvertMarkdownBatch({ openedOnly: isSyncBusy(model.sync) })],
      ],
      FailedConvertMarkdownBatch: () => [
        model,
        [ConvertMarkdownBatch({ openedOnly: isSyncBusy(model.sync) })],
      ],

      FailedLoadFolder: ({ folder, error }) =>
        folder !== model.folder
          ? [model, []]
          : [
              evo(model, {
                threads: AsyncData.settle<ReadonlyArray<ThreadRow>, string>(
                  Result.fail(error),
                ),
              }),
              [],
            ],

      SucceededLoadThread: ({ detail }) => {
        // Only the load we're still waiting for counts — anything else is a
        // superseded open whose row the cursor left.
        if (
          model.screen._tag !== "OpeningThread" ||
          model.screen.id !== detail.id
        ) {
          return [model, []];
        }
        return [evo(model, { screen: () => ShowingThread({ detail }) }), []];
      },

      PressedListKey: ({ key }) => handlePressedListKey(model)(key),

      FailedLoadThread: ({ error }) => [
        evo(model, {
          screen: () => ShowingList({ maybeError: Option.some(error) }),
        }),
        [],
      ],

      ClickedBack: () => closeThread(model),

      CompletedScrollListToRow: () => [model, []],

      // The actual sign-out is main.ts's job; this page just folds the
      // popover shut behind it.
      ClickedAccountSignOut: () => {
        const [nextAccountPopover, commands] = Ui.Popover.close(
          model.accountPopover,
        );
        return [
          evo(model, { accountPopover: () => nextAccountPopover }),
          Command.mapMessages(commands, (message) =>
            GotAccountPopoverMessage({ message }),
          ),
        ];
      },

      // The three flag actions. Each reads the row's current state so the
      // toggle direction is never guessed, and each is done locally the
      // moment the enqueue lands.
      ClickedStarRow: ({ id }) =>
        enqueueForRow(model, id, (row) => starOp(row.id, row.isStarred)),

      ClickedArchiveRow: ({ id }) =>
        enqueueForRow(model, id, (row) => archiveOp(row.id)),

      ClickedToggleReadRow: ({ id }) =>
        enqueueForRow(model, id, (row) => readOp(row.id, row.isUnread)),

      ClickedCompose: () => [
        evo(model, {
          compose: () =>
            ComposeEditing({
              to: "",
              subject: "",
              body: "",
              isPreviewing: false,
              maybeReply: Option.none(),
            }),
        }),
        [FocusComposeField({ field: "to" })],
      ],

      ClickedReply: () => openReply(model),

      CompletedFocusComposeField: () => [model, []],

      EditedCompose: ({ field, value }) => [
        withEditingCompose(model, (compose) =>
          editComposeField(compose, field, value),
        ),
        [],
      ],

      ToggledComposePreview: () => [
        withEditingCompose(model, (compose) =>
          evo(compose, { isPreviewing: (was) => !was }),
        ),
        [],
      ],

      ClickedSend: () => sendCompose(model),

      ClosedCompose: () => [evo(model, { compose: () => ComposeClosed() }), []],

      // The store already reflects this; the list is only catching up. The
      // drain is nudged rather than started — the machine ignores the nudge
      // if one is already in flight.
      SucceededEnqueueOp: ({ maybePatch, maybeSendingThreadId }) => {
        const patched = Option.match(maybePatch, {
          onNone: () => model,
          onSome: (patch) => applyPatch(model, patch),
        });
        // NOTE: Deduped. `settleSending` clears every entry for a thread, so
        // a second queued reply to the same thread would otherwise have its
        // chip cleared by the first one landing, while it is still in flight.
        const sending = Option.match(maybeSendingThreadId, {
          onNone: () => patched,
          onSome: (threadId) =>
            evo(patched, {
              sendingThreads: (threads) =>
                threads.includes(threadId)
                  ? threads
                  : Arr.append(threads, threadId),
            }),
        });
        return stepOutbox(sending, OutboxMachine.QueuedOp());
      },

      // Nothing happened — not locally either, since the local write and the
      // queue row share a transaction. The action can just be repeated.
      FailedEnqueueOp: ({ error }) => [
        evo(model, { maybeOutboxError: () => Option.some(error) }),
        [],
      ],

      GotOutboxMessage: ({ message }) => stepOutbox(model, message),

      ClosedOutboxError: () => [
        evo(model, { maybeOutboxError: () => Option.none() }),
        [],
      ],

      // The popover stays open so the switch reads as a live preview.
      ClickedAppearance: () => {
        const appearance: Appearance =
          model.appearance === "Dark" ? "Light" : "Dark";
        return [
          evo(model, { appearance: () => appearance }),
          [ApplyAppearance({ appearance })],
        ];
      },
    }),
  );
