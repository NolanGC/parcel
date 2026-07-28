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

import { ThreadId } from "../../Gmail";
import { Search } from "../../search";
import { SyncEngine, ThreadRow } from "../../sync";
import * as SyncMachine from "../../syncMachine";
import * as Ui from "../../ui";

import {
  Appearance,
  CompletedApplyAppearance,
  CompletedScrollListToRow,
  FailedLoadInbox,
  FailedLoadThread,
  CompletedCacheImageBatch,
  FailedCacheImageBatch,
  FailedReadLocalSize,
  FailedSearch,
  FolderMenu,
  GotAccountPopoverMessage,
  GotFolderMenuMessage,
  GotListMessage,
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
  reconcileRows,
  ShowingList,
  ShowingThread,
  SucceededLoadInbox,
  SucceededLoadThread,
  SucceededReadLocalSize,
  SucceededSearch,
} from "./model";

export * from "./model";
export { view } from "./view";

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

/** Selects the whole local store, newest first. No network: filling the store
 *  is the sync machine's job. */
export const LoadInbox = Command.define(
  "LoadInbox",
  SucceededLoadInbox,
  FailedLoadInbox,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.loadInbox.pipe(
      Effect.map((rows) => SucceededLoadInbox({ rows })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedLoadInbox({ error: Cause.pretty(cause) })),
      ),
    );
  }),
);

/** Everything main.ts issues on entering the inbox: the first local read
 *  plus the sync machine's checkpoint-derived boot. `accountEmail` scopes
 *  the local store — a different mailbox wipes it rather than blending. */
export const bootCommands = (
  accountEmail: string,
): ReadonlyArray<Command.Command<Message, never, SyncEngine | Search>> => [
  LoadInbox(),
  ReadLocalSize(),
  CacheImageBatch(),
  ...Command.mapMessages(SyncMachine.bootCommands(accountEmail), (message) =>
    GotSyncMessage({ message }),
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
    return yield* engine.loadThread(id).pipe(
      Effect.map((detail) => SucceededLoadThread({ detail })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedLoadThread({ error: Cause.pretty(cause) })),
      ),
    );
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
  ReadonlyArray<Command.Command<Message, never, SyncEngine | Search>>,
];

// Every palette query goes through here, so the seq can never be bumped
// without a search in flight to match it.
const runSearch = (model: Model, text: string): UpdateReturn => {
  const seq = Number.increment(model.searchSeq);
  return [evo(model, { searchSeq: () => seq }), [RunSearch({ seq, text })]];
};

const listedRows = (model: Model): ReadonlyArray<ThreadRow> =>
  Option.getOrElse(AsyncData.getData(model.threads), () => []);

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
  return [
    evo(base, { screen: () => OpeningThread({ id }) }),
    [LoadThread({ id })],
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

const isStaleSearch = (model: Model, seq: number): boolean =>
  seq !== model.searchSeq;

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
        const [nextFolderMenu, commands] = FolderMenu.update(
          model.folderMenu,
          message,
        );
        return [
          evo(model, { folderMenu: () => nextFolderMenu }),
          Command.mapMessages(commands, (message) =>
            GotFolderMenuMessage({ message }),
          ),
        ];
      },

      CompletedApplyAppearance: () => [model, []],

      GotTabsMessage: ({ message }) => {
        const [nextTabs, commands] = Ui.Tabs.update(model.tabs, message);
        return [
          evo(model, { tabs: () => nextTabs }),
          Command.mapMessages(commands, (message) =>
            GotTabsMessage({ message }),
          ),
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

      // Opening runs the empty search, so the palette paints its "recent"
      // list in the same frame the dialog appears rather than a beat later.
      ToggledPalette: () => {
        const [nextPalette, commands] = InboxPalette.toggle(model.palette);
        const opened = evo(model, { palette: () => nextPalette });
        const paletteCommands = Command.mapMessages(commands, (message) =>
          GotPaletteMessage({ message }),
        );
        if (!nextPalette.dialog.isOpen) {
          return [opened, paletteCommands];
        }
        const [next, searchCommands] = runSearch(opened, "");
        return [next, [...paletteCommands, ...searchCommands]];
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

      // Reconciled against the rows already on screen so unchanged threads
      // keep their object identity and the view can memoize past them.
      SucceededLoadInbox: ({ rows }) => [
        evo(model, {
          threads: AsyncData.settle<ReadonlyArray<ThreadRow>, string>(
            Result.succeed(reconcileRows(listedRows(model), rows)),
          ),
        }),
        [],
      ],

      GotSyncMessage: ({ message }) => {
        const [nextSync, commands] = SyncMachine.step(model.sync, message);
        return [
          evo(model, { sync: () => nextSync }),
          [
            ...Command.mapMessages(commands, (message) =>
              GotSyncMessage({ message }),
            ),
            ...(shouldRefreshRows(model.sync, message)
              ? [LoadInbox(), ReadLocalSize()]
              : []),
          ],
        ];
      },

      // NOTE: Re-wrapping an unchanged number in a fresh Option would hand the
      // pill a new argument and cost it its memoization slot for nothing.
      SucceededReadLocalSize: ({ bytes }) =>
        Option.contains(model.maybeLocalBytes, bytes)
          ? [model, []]
          : [evo(model, { maybeLocalBytes: () => Option.some(bytes) }), []],

      // A size read is decoration; failing it leaves the previous number (or
      // nothing) rather than disturbing anything the user is looking at.
      FailedReadLocalSize: () => [model, []],

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

      FailedLoadInbox: ({ error }) => [
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
