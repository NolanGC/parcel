// The inbox page: its Commands and its update. Re-exports model.ts and
// view.ts so `Inbox.Model` / `Inbox.view` stay one import for main.ts.

import { Cause, Effect, Match as M, Option, Result, Schema as S } from "effect";
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
  CompletedListScroll,
  FailedLoadInbox,
  FailedLoadThread,
  FailedSearch,
  FolderMenu,
  GotAccountPopoverMessage,
  GotFolderMenuMessage,
  GotListMessage,
  GotPaletteMessage,
  GotSearchResults,
  GotSyncMessage,
  GotTabsMessage,
  GotThread,
  GotThreads,
  InboxPalette,
  LIST_ID,
  Message,
  Model,
  OpeningThread,
  PALETTE_RESULT_LIMIT,
  ROW_HEIGHT,
  ShowingList,
  ShowingThread,
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
  GotThreads,
  FailedLoadInbox,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.loadInbox.pipe(
      Effect.map((rows) => GotThreads({ rows })),
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
  ...Command.mapMessages(SyncMachine.bootCommands(accountEmail), (message) =>
    GotSyncMessage({ message }),
  ),
];

// One palette search. `seq` rides through the service untouched so the
// update can tell a fresh reply from a superseded one.
const RunSearch = Command.define(
  "RunSearch",
  { seq: S.Number, text: S.String },
  GotSearchResults,
  FailedSearch,
)(({ seq, text }) =>
  Effect.gen(function* () {
    const search = yield* Search;
    return yield* search
      .search({ text, limit: PALETTE_RESULT_LIMIT })
      .pipe(
        Effect.map((rows) => GotSearchResults({ seq, rows })),
        Effect.catchCause((cause) =>
          Effect.succeed(FailedSearch({ seq, error: Cause.pretty(cause) })),
        ),
      );
  }),
);

// Opens a thread from the local store only: SQLite rows, cid: images
// rewritten from locally cached bytes — no network.
export const LoadThread = Command.define(
  "LoadThread",
  { id: ThreadId },
  GotThread,
  FailedLoadThread,
)(({ id }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.loadThread(id).pipe(
      Effect.map((detail) => GotThread({ detail })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedLoadThread({ error: Cause.pretty(cause) })),
      ),
    );
  }),
);

// Keeps the keyboard cursor on screen. Row positions are known from the fixed
// row height, so this scrolls the container directly — the target row need
// not be mounted (it usually isn't, which is why scrollIntoView won't do).
const ScrollListToRow = Command.define(
  "ScrollListToRow",
  { index: S.Number },
  CompletedListScroll,
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
    return CompletedListScroll();
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

// Whether a sync-machine fact means the store has enough new rows to be
// worth re-reading: the prime (first screen), a strided slice of the
// backfill, the backfill's end, or an incremental pass that changed rows.
const shouldRefreshRows = (
  before: SyncMachine.State,
  message: SyncMachine.Message,
): boolean =>
  M.value(message).pipe(
    M.tags({
      CompletedPrime: () => true,
      CompletedBatch: ({ syncedCount, maybeNextPageToken }) => {
        if (Option.isNone(maybeNextPageToken)) return true;
        const previousCount =
          before._tag === "Backfilling" ? before.syncedCount : 0;
        return (
          Math.floor(previousCount / REFRESH_STRIDE) !==
          Math.floor(syncedCount / REFRESH_STRIDE)
        );
      },
      AppliedHistory: ({ changedCount }) => changedCount > 0,
    }),
    M.orElse(() => false),
  );

// Row clicks and the Enter key both funnel here: move the cursor to the row
// and, unless its thread is already open, load it.
const openThread = (model: Model, index: number): UpdateReturn => {
  const id = listedRows(model)[index]?.id;
  const base = evo(model, { selected: () => Option.some(index) });
  if (
    id === undefined ||
    (base.screen._tag === "ShowingThread" && base.screen.detail.id === id)
  ) {
    return [base, []];
  }
  return [
    evo(base, { screen: () => OpeningThread({ id }) }),
    [LoadThread({ id })],
  ];
};

// Picking a palette result: the item is a thread id, so resolve it back to
// its list index and reuse the ordinary open path — the cursor lands on the
// row, so closing the thread returns to it in place.
const openThreadId = (model: Model, id: string): UpdateReturn => {
  const index = listedRows(model).findIndex((row) => row.id === id);
  return index === -1 ? [model, []] : openThread(model, index);
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
      LeftList: () => [evo(model, { isPointerInside: () => false }), []],

      OpenedRow: ({ index }) => openThread(model, index),

      // Opening runs the empty search, so the palette paints its "recent"
      // list in the same frame the dialog appears rather than a beat later.
      OpenedPalette: () => {
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
      GotSearchResults: ({ seq, rows }) =>
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
      GotThreads: ({ rows }) => [
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
            ...(shouldRefreshRows(model.sync, message) ? [LoadInbox()] : []),
          ],
        ];
      },

      FailedLoadInbox: ({ error }) => [
        evo(model, {
          threads: AsyncData.settle<ReadonlyArray<ThreadRow>, string>(
            Result.fail(error),
          ),
        }),
        [],
      ],

      GotThread: ({ detail }) => {
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
            onSome: (index) => openThread(model, index),
          });
        }

        const rowCount = listedRows(model).length;
        if (rowCount === 0) return [model, []];
        const current = Option.getOrElse(model.selected, () => -1);
        const index =
          key === "j"
            ? Math.min(current + 1, rowCount - 1)
            : Math.max(current - 1, 0);
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

      CompletedListScroll: () => [model, []],

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
