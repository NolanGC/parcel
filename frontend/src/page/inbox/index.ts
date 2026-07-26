// The inbox page: its Commands and its update. Re-exports model.ts and
// view.ts so `Inbox.Model` / `Inbox.view` stay one import for main.ts.

import {
  Array as Arr,
  Cause,
  Effect,
  Match as M,
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
  Message,
  Model,
  OpeningThread,
  PALETTE_RESULT_LIMIT,
  ROW_HEIGHT,
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
      if (appearance === "Light") root.classList.add("light");
      if (appearance === "Dark") root.classList.add("dark");
    });
    yield* Effect.sleep("220 millis");
    yield* Effect.sync(() => root.classList.remove("transitioning"));
    return CompletedApplyAppearance();
  }),
);

// Selects the whole local store (newest first) — no network; filling the
// store is the sync machine's job. Runs at boot and again whenever the
// machine reports enough new rows (see GotSyncMessage).
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

// One palette search. `seq` rides through the service untouched so the
// update can tell a fresh reply from a superseded one.
export const RunSearch = Command.define(
  "RunSearch",
  { seq: S.Number, text: S.String },
  SucceededSearch,
  FailedSearch,
)(({ seq, text }) =>
  Effect.gen(function* () {
    const search = yield* Search;
    return yield* search
      .search({ text, limit: PALETTE_RESULT_LIMIT })
      .pipe(
        Effect.map((rows) => SucceededSearch({ seq, rows })),
        Effect.catchCause((cause) =>
          Effect.succeed(FailedSearch({ seq, error: Cause.pretty(cause) })),
        ),
      );
  }),
);

// The store's on-disk size, for the sync pill's detail. Read at boot and
// again whenever the machine reports progress worth repainting for, so the
// number tracks a running backfill instead of going stale at whatever it was
// when the app opened.
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

// One turn of the image prefetch loop, re-issued from its own result (see
// the CompletedCacheImageBatch handler). Deliberately separate from the sync
// machine and running alongside it: the backfill is bound by Gmail's quota
// bucket and this by the image proxy, so sequencing them would leave one of
// the two resources idle for the whole sync.
//
// The idle wait lives inside the Command rather than in a Subscription
// because idleness is a fact the engine discovers, not a schedule: an empty
// queue mid-backfill means "ask again shortly", and once everything is
// cached it means "ask again much less often". Both are the same loop.
const IMAGE_IDLE_WAIT = "4 seconds";
const IMAGE_RETRY_WAIT = "15 seconds";

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

// Opens a thread from the local store only: SQLite rows, cid: images
// rewritten from locally cached bytes — no network.
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

// Keeps the keyboard cursor on screen. Row positions are known from the fixed
// row height, so this scrolls the container directly — the target row need
// not be mounted (it usually isn't, which is why scrollIntoView won't do).
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

// Issues a search and claims the next sequence number. Every palette query
// goes through here so the seq can never be bumped without a search in
// flight to match it.
const runSearch = (model: Model, text: string): UpdateReturn => {
  const seq = model.searchSeq + 1;
  return [evo(model, { searchSeq: () => seq }), [RunSearch({ seq, text })]];
};

const listedRows = (model: Model): ReadonlyArray<ThreadRow> =>
  Option.getOrElse(AsyncData.getData(model.threads), () => []);

// Re-selecting and decoding the whole store costs tens of ms at 10k rows,
// so backfill progress refreshes the list on a stride, not per batch.
const REFRESH_STRIDE = 200;

// The newest threads the user is owed promptly. The backfill already walks
// newest-first, so these are the first ones fetched — but at a 200 stride a
// fresh mailbox sits on the prime's handful of rows for the first two pages.
// Under this many synced, every page repaints, so the list fills visibly
// (100 rows at a time) instead of jumping once. Above it the stride takes
// over and the cost of re-decoding the store is amortised again.
export const PRIORITY_WINDOW = 500;

// Whether a sync-machine fact means the store has enough new rows to be
// worth re-reading: the prime (first screen), the priority window, a strided
// slice of the backfill, the backfill's end, or an incremental pass that
// changed rows.
const shouldRefreshRows = (
  before: SyncMachine.State,
  message: SyncMachine.Message,
): boolean =>
  M.value(message).pipe(
    M.tags({
      CompletedPrimeInbox: () => true,
      CompletedSyncBatch: ({ syncedCount, maybeNextPageToken }) => {
        if (Option.isNone(maybeNextPageToken)) return true;
        if (syncedCount <= PRIORITY_WINDOW) return true;
        const previousCount =
          before._tag === "Backfilling" ? before.syncedCount : 0;
        return (
          Math.floor(previousCount / REFRESH_STRIDE) !==
          Math.floor(syncedCount / REFRESH_STRIDE)
        );
      },
      AppliedHistory: ({ changedCount }) => changedCount > 0,
      // The whole point of interleaving history into the backfill: mail that
      // arrives mid-sync reaches the list now, not when the walk finishes.
      RefreshedDuringBackfill: ({ changedCount }) => changedCount > 0,
    }),
    M.orElse(() => false),
  );

// The one open path. The thread is named by id, never by position: the row
// list is replaced wholesale on strided backfill refreshes and on history
// passes, so an index captured at paint time can address a different thread
// by the time the click or keypress lands. `index` only parks the cursor, so
// closing the thread returns the overlay to the row in place.
const openThread = (
  model: Model,
  id: ThreadId,
  index: number,
): UpdateReturn => {
  const base = evo(model, { selected: () => Option.some(index) });
  if (base.screen._tag === "ShowingThread" && base.screen.detail.id === id) {
    return [base, []];
  }
  return [
    evo(base, { screen: () => OpeningThread({ id }) }),
    [LoadThread({ id })],
  ];
};

// Opening from a position — the j/k cursor and Enter. Resolves the row first
// so the id, not the index, is what reaches openThread.
const openRowAt = (model: Model, index: number): UpdateReturn => {
  const row = listedRows(model)[index];
  return row === undefined ? [model, []] : openThread(model, row.id, index);
};

// Picking a palette result: the item is a thread id. The cursor follows it
// into the list when the thread is on screen, and simply stays put when the
// search surfaced something the current list doesn't contain.
const openThreadId = (model: Model, id: string): UpdateReturn => {
  const index = listedRows(model).findIndex((row) => row.id === id);
  return index === -1 ? [model, []] : openRowAt(model, index);
};

const closeThread = (model: Model): UpdateReturn => [
  evo(model, { screen: () => ShowingList({ error: Option.none() }) }),
  [],
];

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      GotFolderMenuMessage: ({ message }) => {
        const [folderMenu, commands] = FolderMenu.update(
          model.folderMenu,
          message,
        );
        return [
          evo(model, { folderMenu: () => folderMenu }),
          Command.mapMessages(commands, (message) =>
            GotFolderMenuMessage({ message }),
          ),
        ];
      },

      CompletedApplyAppearance: () => [model, []],

      GotTabsMessage: ({ message }) => {
        const [tabs, commands] = Ui.Tabs.update(model.tabs, message);
        return [
          evo(model, { tabs: () => tabs }),
          Command.mapMessages(commands, (message) =>
            GotTabsMessage({ message }),
          ),
        ];
      },

      GotListMessage: ({ message }) => {
        const [list, commands] = Ui.VirtualList.update(model.list, message);
        return [
          evo(model, { list: () => list }),
          Command.mapMessages(commands, (message) =>
            GotListMessage({ message }),
          ),
        ];
      },

      // Real pointer motion always reclaims the overlay from the keyboard.
      HoveredRow: ({ index }) => [
        evo(model, {
          selected: () => Option.some(index),
          keyboardControlled: () => false,
        }),
        [],
      ],

      EnteredList: () => [
        evo(model, {
          hoverSession: (session) => session + 1,
          isPointerInside: () => true,
          // Cleared so the overlay stays unmounted until the first row is
          // hovered — it then mounts there (snap + fade-in) instead of
          // sliding from wherever the last session ended. Skipped while the
          // keyboard holds the overlay: the pointer merely entering the
          // list shouldn't blank a cursor it hasn't reclaimed.
          selected: (selected) =>
            model.keyboardControlled ? selected : Option.none(),
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
        const [palette, commands] = InboxPalette.toggle(model.palette);
        const opened = evo(model, { palette: () => palette });
        const paletteCommands = Command.mapMessages(commands, (message) =>
          GotPaletteMessage({ message }),
        );
        if (!palette.dialog.isOpen) return [opened, paletteCommands];
        const [next, searchCommands] = runSearch(opened, "");
        return [next, [...paletteCommands, ...searchCommands]];
      },

      GotPaletteMessage: ({ message }) => {
        const [palette, commands, maybeSelected] = InboxPalette.update(
          model.palette,
          message,
        );
        const paletteCommands = Command.mapMessages(commands, (message) =>
          GotPaletteMessage({ message }),
        );
        const stepped = evo(model, { palette: () => palette });
        // Every item is a thread id — picking one opens that thread.
        return Option.match(maybeSelected, {
          onSome: (id): UpdateReturn => {
            const [next, openCommands] = openThreadId(stepped, id);
            return [next, [...paletteCommands, ...openCommands]];
          },
          // A keystroke is the only palette message that changes the corpus;
          // the rest (cursor moves, rect measurements) reuse the last hits.
          onNone: (): UpdateReturn => {
            if (message._tag !== "PaletteChangedQuery") {
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
        seq !== model.searchSeq
          ? [model, []]
          : [
              evo(model, {
                searchResults: () => rows,
                searchError: () => Option.none(),
              }),
              [],
            ],

      FailedSearch: ({ seq, error }) =>
        seq !== model.searchSeq
          ? [model, []]
          : [
              evo(model, {
                searchResults: () => [],
                searchError: () => Option.some(error),
              }),
              [],
            ],

      GotAccountPopoverMessage: ({ message }) => {
        const [accountPopover, commands] = Ui.Popover.update(
          model.accountPopover,
          message,
        );
        return [
          evo(model, { accountPopover: () => accountPopover }),
          Command.mapMessages(commands, (message) =>
            GotAccountPopoverMessage({ message }),
          ),
        ];
      },

      // settle folds the fetch outcome into whatever state threads is in:
      // success replaces the rows; failure keeps any previous rows (Stale)
      // or lands on Failure when there were none.
      SucceededLoadInbox: ({ rows }) => [
        evo(model, {
          threads: AsyncData.settle<ReadonlyArray<ThreadRow>, string>(
            Result.succeed(rows),
          ),
        }),
        [],
      ],

      GotSyncMessage: ({ message }) => {
        const [sync, commands] = SyncMachine.step(model.sync, message);
        return [
          evo(model, { sync: () => sync }),
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

      SucceededReadLocalSize: ({ bytes }) => [
        evo(model, { maybeLocalBytes: () => Option.some(bytes) }),
        [],
      ],

      // A size read is decoration; failing it leaves the previous number (or
      // nothing) rather than disturbing anything the user is looking at.
      FailedReadLocalSize: () => [model, []],

      // The loop's only turn: ask for the next batch. It never terminates by
      // design — new mail arriving in a settled mailbox needs its images too,
      // and the engine's own idle wait is what keeps a fully-cached store
      // down to one cheap query every few seconds.
      //
      // Prefetching is an optimization, so a failure re-arms the loop just
      // the same: the Command has already waited out its backoff before
      // either message arrives, which is what stops this from spinning.
      // Latched, never cleared: new mail lands in the hot window with its
      // images seconds behind, which would flicker the milestone off and on
      // every time a message arrives. "Your recent mail is ready offline"
      // does not stop being true because one email's images are three
      // seconds late.
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

      PressedListKey: ({ key }) => {
        // The palette owns the keyboard while it's open.
        if (model.palette.dialog.isOpen) return [model, []];

        if (key === "Escape") {
          return model.screen._tag === "ShowingThread"
            ? closeThread(model)
            : [model, []];
        }
        // Inside a thread, j/k/Enter are reserved for future in-thread nav.
        if (model.screen._tag === "ShowingThread") return [model, []];

        if (key === "Enter") {
          return Option.match(model.selected, {
            onNone: (): UpdateReturn => [model, []],
            onSome: (index) => openRowAt(model, index),
          });
        }

        const rows = listedRows(model);
        if (Arr.isReadonlyArrayEmpty(rows)) return [model, []];
        const lastIndex = rows.length - 1;
        // With no cursor yet, either key lands on the first row — stated
        // outright rather than falling out of arithmetic on a -1 sentinel.
        const index = Option.match(model.selected, {
          onNone: () => 0,
          onSome: (current) =>
            key === "j"
              ? Math.min(current + 1, lastIndex)
              : Math.max(current - 1, 0),
        });
        return [
          evo(model, {
            selected: () => Option.some(index),
            keyboardControlled: () => true,
          }),
          [ScrollListToRow({ index })],
        ];
      },

      FailedLoadThread: ({ error }) => [
        evo(model, {
          screen: () => ShowingList({ error: Option.some(error) }),
        }),
        [],
      ],

      ClickedBack: () => closeThread(model),

      CompletedScrollListToRow: () => [model, []],

      // The actual sign-out is main.ts's job; this page just folds the
      // popover shut behind it.
      InboxClickedSignOut: () => {
        const [accountPopover, commands] = Ui.Popover.close(
          model.accountPopover,
        );
        return [
          evo(model, { accountPopover: () => accountPopover }),
          Command.mapMessages(commands, (message) =>
            GotAccountPopoverMessage({ message }),
          ),
        ];
      },

      // The popover stays open so the switch reads as a live preview.
      InboxClickedAppearance: () => {
        const appearance: Appearance =
          model.appearance === "Dark" ? "Light" : "Dark";
        return [
          evo(model, { appearance: () => appearance }),
          [ApplyAppearance({ appearance })],
        ];
      },
    }),
  );
