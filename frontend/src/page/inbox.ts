import { Cause, Effect, Match as M, Option, Result, Schema as S } from "effect";
import { AsyncData, Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

import * as Icon from "../icons";
import { ThreadId } from "../Gmail";
import { Search, SearchHit } from "../search";
import {
  SyncEngine,
  ThreadDetail,
  ThreadRow,
  type MessageDetail,
  type ThreadCategory,
} from "../sync";
import * as SyncMachine from "../syncMachine";
import * as Ui from "../ui";

// The inbox, built on FoldkitUI (the Fluid Functionalism port). Colors come
// from the surface ladder + overlay tokens in styles.css, motion from the
// spring tiers in ui/motion.ts. Rows are real threads pulled through the
// SyncEngine (Gmail → local SQLite → this list); the folder dropdown, tabs,
// and palette are chrome.

const PAGE_SURFACE = Ui.SurfaceLevel.make(1);

// The virtualized list: rows are a fixed height so the visible window and the
// traveling hover overlay are both pure arithmetic (index * ROW_HEIGHT).
const LIST_ID = "inbox-list";
const ROW_HEIGHT = 53;
const LIST_OVERSCAN = 6;

// Html email bodies render in a sandboxed iframe at a fixed height and scroll
// internally — no content measurement, no pane pre-mounting.
const BODY_FRAME_HEIGHT = 600;

// APPEARANCE — System follows the OS; Light/Dark pin a class on <html> so the
// light-dark() tokens re-resolve, wrapped in a 180ms cross-fade.

export const Appearance = S.Literals(["System", "Light", "Dark"]);
export type Appearance = typeof Appearance.Type;

// DATA

const HexColor = S.String.check(
  S.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
).pipe(S.brand("HexColor"));
type HexColor = typeof HexColor.Type;

type Category = "promotions" | "primary" | "other";

type Email = {
  sender: string;
  unread: boolean;
  subject: string;
  preview: string;
  category: Category;
  time: string;
};

// Gmail's category labels mapped onto the chip set the design defines.
const CATEGORY_FROM_THREAD: Record<ThreadCategory, Category> = {
  personal: "primary",
  promotions: "promotions",
  social: "other",
  updates: "other",
  forums: "other",
  none: "other",
};

// Sender tiles are "content colors" — deliberately outside the surface token
// system, like a favicon.
const AVATAR_BG = HexColor.make("#4f46e5");
const AVATAR_FG = HexColor.make("#ffffff");

// Same-day threads show the clock, older ones the date.
const formatTime = (epochMs: number): string => {
  const date = new Date(epochMs);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}/${String(
    date.getFullYear(),
  ).slice(2)}`;
};

const emailFromThreadRow = (row: ThreadRow): Email => ({
  sender: row.sender,
  unread: row.unread,
  subject: row.subject,
  preview: row.snippet,
  category: CATEGORY_FROM_THREAD[row.category],
  time: formatTime(row.date),
});

type CategoryConfig = { label: string; icon: Ui.IconView; iconClass: string };

const CATEGORIES: Record<Category, CategoryConfig> = {
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

type TabConfig = {
  label: string;
  icon: Ui.IconView;
  count: number;
  iconClass: string;
};

const TABS: ReadonlyArray<TabConfig> = [
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

const TAB_LABELS: ReadonlyArray<string> = TABS.map((tab) => tab.label);

const tabSpec = (label: string): Ui.Tabs.TabSpec => {
  const tab = TABS.find((tab) => tab.label === label);
  return tab === undefined
    ? { icon: Icon.ellipsis, label }
    : {
        icon: tab.icon,
        label: tab.label,
        detail: String(tab.count),
        iconClass: tab.iconClass,
      };
};

// FOLDER MENU

const FOLDER_LABELS = [
  "All Inbox",
  "Sent",
  "Send later",
  "Drafts",
  "Spams",
  "Archives",
] as const;
type FolderLabel = (typeof FOLDER_LABELS)[number];

const FOLDERS: Record<FolderLabel, { icon: Ui.IconView; count?: number }> = {
  "All Inbox": { icon: Icon.inbox, count: 199 },
  Sent: { icon: Icon.send },
  "Send later": { icon: Icon.clock },
  Drafts: { icon: Icon.feather, count: 2 },
  Spams: { icon: Icon.shieldAlert, count: 8 },
  Archives: { icon: Icon.archive, count: 7 },
};

const FolderMenu = Ui.Menu.create<FolderLabel>();

// COMMAND PALETTE — search over the local store (⌘K, or the toolbar search
// button). Items are thread ids; the corpus is the mailbox itself.
//
// The whole store already rides in the model (SyncEngine.loadInbox selects
// every row — see the VirtualList note in sync.ts), so matching is pure and
// instant: no command round-trip, no debounce, nothing async to keep honest.
// The rank/cap happens here rather than in the palette because only an
// unbounded corpus needs one, and the palette re-applies the same scorer.

const PALETTE_RESULT_LIMIT = 50;

const threadItemSpec = (row: ThreadRow): Ui.Palette.PaletteItemSpec => ({
  icon: row.unread ? Icon.mail : Icon.mailOpen,
  label: row.subject === "" ? "(no subject)" : row.subject,
  detail: row.sender,
  keywords: `${row.sender} ${row.snippet}`,
});

const InboxPalette = Ui.Palette.create<string>();

// MODEL

// The inbox rows as an async-loaded value: Loading renders the placeholder,
// Success/Refreshing the rows, Failure the error, and Stale keeps the last
// good rows on screen with the refresh error above them.
const ThreadsData = AsyncData.Schema(S.Array(ThreadRow), S.String);

// Which screen the page shows, as a tagged state — the list, the list with a
// thread load in flight, or an open thread. One state at a time, so "detail
// open while a different load is pending" can't be expressed.
export const ShowingList = ts("ShowingList", { error: S.Option(S.String) });
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
  // The sync machine: fills and freshens the SQLite store behind the UI.
  // Its state renders as the toolbar pill; its progress triggers the
  // strided row refreshes (see GotSyncMessage).
  sync: SyncMachine.State,
  screen: Screen,
  // The single list cursor: mouse hover and j/k both move it. Drives the
  // traveling hover overlay; Enter (or a click) opens it.
  selected: S.Option(S.Number),
  // Hover-session state for the traveling overlay (the FF treatment).
  // Bumped on each pointer entry; keys the overlay so a new session remounts
  // it (snap + @starting-style fade-in) instead of sliding from a stale row.
  hoverSession: S.Number,
  isPointerInside: S.Boolean,
  // True once j/k has claimed the overlay: it then stays visible regardless
  // of the pointer, until real mouse motion over a row reclaims it.
  keyboardControlled: S.Boolean,
  // The palette's results, as the Search service ranked them — not derived
  // from `threads`, because the semantic stages coming next will surface
  // threads no substring pass would find.
  searchHits: S.Array(SearchHit),
  // Bumped per issued search; a reply carrying an older seq lost the race to
  // a later keystroke and is dropped. The correctness half of a debounce,
  // without the latency half.
  searchSeq: S.Number,
  searchError: S.Option(S.String),
});
export type Model = typeof Model.Type;

export const init = (): Model => ({
  appearance: "System",
  folderMenu: Ui.Menu.init({ id: "inbox-folders", isAnimated: true }),
  tabs: Ui.Tabs.init({ id: "inbox-tabs" }),
  list: Ui.VirtualList.init({ id: LIST_ID, rowHeightPx: ROW_HEIGHT }),
  palette: Ui.Palette.init({ id: "inbox-palette" }),
  accountPopover: Ui.Popover.init({ id: "inbox-account", isAnimated: true }),
  // main.ts issues LoadInbox on entering the inbox, so the page is born
  // loading rather than idle.
  threads: AsyncData.Loading(),
  sync: SyncMachine.init(),
  screen: ShowingList({ error: Option.none() }),
  selected: Option.none(),
  hoverSession: 0,
  isPointerInside: false,
  keyboardControlled: false,
  searchHits: [],
  searchSeq: 0,
  searchError: Option.none(),
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
export const LeftList = m("LeftList");
/** A row was clicked: open its thread. */
export const OpenedRow = m("OpenedRow", { index: S.Number });
/** Toggles the command palette — toolbar button or the global ⌘K sub. */
export const OpenedPalette = m("OpenedPalette");
export const GotPaletteMessage = m("GotPaletteMessage", {
  message: Ui.Palette.Message,
});
export const GotAccountPopoverMessage = m("GotAccountPopoverMessage", {
  message: Ui.Popover.Message,
});
/** The popover's sign-out action. main.ts owns the session, so it watches for
 *  this tag and runs SignOut; here it only closes the popover. */
export const ClickedSignOut = m("InboxClickedSignOut");
/** The popover's light/dark switch. */
export const ClickedAppearance = m("InboxClickedAppearance");
/** Ranked results for the search identified by `seq`. */
export const GotSearchHits = m("GotSearchHits", {
  seq: S.Number,
  hits: S.Array(SearchHit),
});
export const FailedSearch = m("FailedSearch", {
  seq: S.Number,
  error: S.String,
});
/** The SyncEngine finished a pull: real thread rows from the local store. */
export const GotThreads = m("GotThreads", { rows: S.Array(ThreadRow) });
/** A sync-machine fact (checkpoint read, batch landed, failure, …). */
export const GotSyncMessage = m("GotSyncMessage", {
  message: SyncMachine.Message,
});
export const FailedLoadInbox = m("FailedLoadInbox", { error: S.String });
export const GotThread = m("GotThread", { detail: ThreadDetail });
/** List keyboard nav from the global subscription in main.ts. */
export const PressedListKey = m("PressedListKey", {
  key: S.Literals(["j", "k", "Enter", "Escape"]),
});
export const FailedLoadThread = m("FailedLoadThread", { error: S.String });
export const ClickedBack = m("ClickedBack");
export const CompletedListScroll = m("CompletedListScroll");

export const Message = S.Union([
  GotFolderMenuMessage,
  CompletedApplyAppearance,
  GotTabsMessage,
  GotListMessage,
  HoveredRow,
  EnteredList,
  LeftList,
  OpenedRow,
  OpenedPalette,
  GotPaletteMessage,
  GotAccountPopoverMessage,
  ClickedSignOut,
  ClickedAppearance,
  GotSearchHits,
  FailedSearch,
  GotThreads,
  GotSyncMessage,
  FailedLoadInbox,
  GotThread,
  PressedListKey,
  FailedLoadThread,
  ClickedBack,
  CompletedListScroll,
]);
export type Message = typeof Message.Type;

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
 *  plus the sync machine's checkpoint-derived boot. */
export const bootCommands = (): ReadonlyArray<
  Command.Command<Message, never, SyncEngine | Search>
> => [
  LoadInbox(),
  ...Command.mapMessages(SyncMachine.bootCommands(), (message) =>
    GotSyncMessage({ message }),
  ),
];

// One palette search. `seq` rides through the service untouched so the
// update can tell a fresh reply from a superseded one.
const RunSearch = Command.define(
  "RunSearch",
  { seq: S.Number, text: S.String },
  GotSearchHits,
  FailedSearch,
)(({ seq, text }) =>
  Effect.gen(function* () {
    const search = yield* Search;
    return yield* search
      .search({ text, limit: PALETTE_RESULT_LIMIT })
      .pipe(
        Effect.map((hits) => GotSearchHits({ seq, hits })),
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
      GotSearchHits: ({ seq, hits }) =>
        seq !== model.searchSeq
          ? [model, []]
          : [
              evo(model, {
                searchHits: () => hits,
                searchError: () => Option.none(),
              }),
              [],
            ],

      FailedSearch: ({ seq, error }) =>
        seq !== model.searchSeq
          ? [model, []]
          : [
              evo(model, {
                searchHits: () => [],
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

// VIEW

const folderButtonContent = (): Html => {
  const h = html();
  return h.span(
    [h.Class("flex items-center gap-2")],
    [
      Icon.inbox("h-[18px] w-[18px]"),
      h.span([], ["All"]),
      h.span([h.Class("text-muted-foreground")], ["199"]),
      Icon.chevronsUpDown("h-4 w-4 text-muted-foreground"),
    ],
  );
};

// The signed-in Google account, passed down from main.ts.
export type Profile = { readonly name: string; readonly email: string };

export type ViewInputs = { readonly profile: Profile };

const profileInitial = (profile: Profile, sizeClassName: string): Html => {
  const h = html();
  return h.span(
    [
      h.Class(
        `flex shrink-0 items-center justify-center rounded-full bg-active font-semibold uppercase text-foreground ${sizeClassName}`,
      ),
    ],
    [profile.name.slice(0, 1)],
  );
};

const profileChipContent = (profile: Profile): Html => {
  const h = html();
  return h.span(
    [h.Class("flex items-center gap-2")],
    [
      profileInitial(profile, "h-6 w-6 text-[11px]"),
      h.span(
        [h.Class("text-[13px] font-medium text-foreground")],
        [profile.name],
      ),
    ],
  );
};

// The account popover: identity up top, sign-out below.
const accountPanelView = (
  profile: Profile,
  appearance: Appearance,
): Html => {
  const h = html<Message>();
  const itemClass = `flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`;
  const isDark = appearance === "Dark";

  return h.div(
    [],
    [
      h.div(
        [h.Class("flex items-center gap-3 px-2 py-2")],
        [
          profileInitial(profile, "h-8 w-8 text-[13px]"),
          h.div(
            [h.Class("min-w-0")],
            [
              h.div(
                [h.Class("truncate text-[13px] font-medium text-foreground")],
                [profile.name],
              ),
              h.div(
                [h.Class("break-all text-[12px] text-muted-foreground")],
                [profile.email],
              ),
            ],
          ),
        ],
      ),
      h.div([h.Class("mx-2 my-1 border-t border-border")], []),
      h.button(
        [
          h.Type("button"),
          h.OnClick(ClickedAppearance()),
          h.Class(itemClass),
        ],
        [
          (isDark ? Icon.sun : Icon.moon)("h-4 w-4 shrink-0"),
          isDark ? "Light mode" : "Dark mode",
        ],
      ),
      h.button(
        [h.Type("button"), h.OnClick(ClickedSignOut()), h.Class(itemClass)],
        [Icon.logOut("h-4 w-4 shrink-0"), "Sign out"],
      ),
    ],
  );
};

// The sync pill: the machine's state rendered directly — no parallel
// status struct to keep honest. Because the machine's entry state is
// derived from the persisted checkpoint, a refresh mid-backfill shows real
// progress from first paint.
const syncPillView = (sync: SyncMachine.State): Html => {
  const h = html<Message>();

  const pill = (children: ReadonlyArray<Html | string>): Html =>
    h.div(
      [
        h.Class(
          "flex h-7 shrink-0 items-center gap-2 rounded-lg bg-hover px-2.5 text-[12px] tabular-nums text-muted-foreground",
        ),
        h.Role("status"),
      ],
      children,
    );

  const workingDot = h.span(
    [h.Class("animate-pulse")],
    [Ui.badgeDot({ color: "indigo" })],
  );

  return M.value(sync).pipe(
    M.tagsExhaustive({
      Cold: () => h.empty,
      Priming: () => pill([workingDot, "Syncing…"]),
      Backfilling: ({ syncedCount, totalEstimate }) =>
        pill([
          workingDot,
          `Syncing ${syncedCount.toLocaleString()} of ~${totalEstimate.toLocaleString()}`,
        ]),
      CatchingUp: () => pill([workingDot, "Checking…"]),
      Settled: () => pill([Icon.check("h-3.5 w-3.5"), "Synced"]),
      Backoff: () => pill([Ui.badgeDot({ color: "amber" }), "Retrying…"]),
      NeedsAuth: () =>
        pill([Ui.badgeDot({ color: "red" }), "Reconnect Gmail"]),
    }),
  );
};

const toolbarView = (model: Model, profile: Profile): Html => {
  const h = html<Message>();
  return h.header(
    [h.Class("flex items-center justify-between gap-4 px-5 py-3")],
    [
      // Left cluster: folder dropdown and category tabs.
      h.div(
        [h.Class("flex min-w-0 items-center gap-5")],
        [
          h.submodel({
            slotId: "inbox-folder-menu",
            model: model.folderMenu,
            view: FolderMenu.view,
            viewInputs: {
              items: FOLDER_LABELS,
              itemSpec: (item) => ({
                icon: FOLDERS[item].icon,
                label: item,
                detail:
                  FOLDERS[item].count === undefined
                    ? undefined
                    : String(FOLDERS[item].count),
                isChecked: item === "All Inbox",
              }),
              buttonContent: folderButtonContent(),
              buttonClassName: `flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5 font-medium text-foreground hover:bg-active ${Ui.hoverTransition}`,
              ariaLabel: "Mail folders",
              substrate: PAGE_SURFACE,
            },
            toParentMessage: (message) => GotFolderMenuMessage({ message }),
          }),
          h.nav(
            [h.Class("flex items-center gap-2")],
            [
              h.submodel({
                slotId: "inbox-tabs",
                model: model.tabs,
                view: Ui.Tabs.view,
                viewInputs: { tabs: TAB_LABELS, tabSpec },
                toParentMessage: (message) => GotTabsMessage({ message }),
              }),
              Ui.button(
                { variant: "ghost", size: "icon-sm", ariaLabel: "Add filter" },
                [Icon.plus("h-[18px] w-[18px]")],
              ),
            ],
          ),
        ],
      ),

      // Right cluster: sync pill, search (⌘K), profile, notifications,
      // compose.
      h.div(
        [h.Class("flex shrink-0 items-center gap-3")],
        [
          syncPillView(model.sync),
          h.button(
            [
              h.Type("button"),
              h.AriaLabel("Search"),
              h.OnClick(OpenedPalette()),
              h.Class(
                `flex h-7 cursor-pointer items-center gap-2 rounded-lg bg-hover px-2.5 text-muted-foreground outline-none hover:bg-active hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
              ),
            ],
            [
              Icon.search("h-4 w-4"),
              h.kbd(
                [h.Class("flex items-center text-[11px]")],
                [Icon.command("h-3 w-3"), h.span([h.Class("ml-0.5")], ["K"])],
              ),
            ],
          ),
          h.submodel({
            slotId: "inbox-account-popover",
            model: model.accountPopover,
            view: Ui.Popover.view,
            viewInputs: {
              buttonContent: profileChipContent(profile),
              buttonClassName: `flex cursor-pointer items-center rounded-lg bg-hover py-1 pl-1.5 pr-2.5 outline-none hover:bg-active focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
              ariaLabel: "Account",
              substrate: PAGE_SURFACE,
              toPanelContent: () => accountPanelView(profile, model.appearance),
            },
            toParentMessage: (message) => GotAccountPopoverMessage({ message }),
          }),
          Ui.button(
            { variant: "ghost", size: "icon-sm", ariaLabel: "Notifications" },
            [Icon.bell("h-[18px] w-[18px]")],
          ),
          Ui.button(
            { variant: "tertiary", size: "icon", ariaLabel: "Compose" },
            [Icon.squarePen("h-[18px] w-[18px]")],
          ),
        ],
      ),
    ],
  );
};

const senderTile = (label: string): Html => {
  const h = html();
  return h.span(
    [
      h.Class(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold leading-none",
      ),
      h.Style({ backgroundColor: AVATAR_BG, color: AVATAR_FG }),
    ],
    [label],
  );
};

const categoryTagView = (category: Category): Html => {
  const h = html();
  const { label, icon, iconClass } = CATEGORIES[category];
  return h.span(
    [
      h.Class(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md bg-hover px-2 py-1 text-xs font-medium text-muted-foreground",
      ),
    ],
    [icon(`h-3.5 w-3.5 ${iconClass}`, "2.25"), label],
  );
};

// One list row. Carries no hover background of its own — the traveling
// overlay (listOverlayView) is the single highlight for mouse and keyboard.
// The row height is fixed by the VirtualList; content just fills and centers.
const emailRowView = (email: Email, index: number): Html => {
  const h = html<Message>();
  const tone = email.unread ? "text-foreground" : "text-muted-foreground";

  return h.div(
    [
      h.OnClick(OpenedRow({ index })),
      h.OnMouseEnter(HoveredRow({ index })),
      h.Class(
        "flex h-full cursor-pointer items-center gap-4 border-b border-border px-4",
      ),
    ],
    [
      // Sender
      h.div(
        [h.Class("flex w-56 shrink-0 items-center gap-3 md:w-64")],
        [
          senderTile((email.sender.slice(0, 1) || "?").toUpperCase()),
          h.span([h.Class(`truncate font-semibold ${tone}`)], [email.sender]),
        ],
      ),

      // Subject + preview
      h.div(
        [h.Class("flex min-w-0 flex-1 items-center gap-2")],
        [
          // The dot's slot is always reserved so the subject column lines up
          // across read and unread rows; only the dot itself hides.
          email.unread
            ? Ui.badgeDot({ color: "indigo", ariaLabel: "Unread" })
            : h.span([h.Class("invisible h-[7px] w-[7px] shrink-0")], []),
          // The truncation ellipsis draws in the truncating element's color;
          // muted here matches the preview text it's eliding.
          h.span(
            [h.Class("min-w-0 truncate text-muted-foreground")],
            [
              h.span([h.Class(`font-semibold ${tone}`)], [email.subject]),
              h.span([h.Class("mx-2 text-muted-foreground/50")], ["—"]),
              h.span([], [email.preview]),
            ],
          ),
        ],
      ),

      // Meta
      h.div(
        [h.Class("flex shrink-0 items-center gap-3")],
        [
          categoryTagView(email.category),
          h.span(
            [
              h.Class(
                "w-14 text-right text-[13px] tabular-nums text-muted-foreground",
              ),
            ],
            [email.time],
          ),
        ],
      ),
    ],
  );
};

const sectionHeaderView = (label: string): Html => {
  const h = html();
  return h.div(
    [
      h.Class(
        "border-b border-border py-2.5 text-center text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70",
      ),
    ],
    [label],
  );
};

const statusRowView = (text: string): Html => {
  const h = html();
  return h.div(
    [
      h.Class(
        "border-b border-border px-4 py-8 text-center text-muted-foreground",
      ),
    ],
    [text],
  );
};

// The traveling hover highlight. One absolutely-positioned overlay glides
// between rows: `top` (transitioned) gives the travel, `translateY(-scrollTop)`
// (not transitioned — see .fk-hover-overlay) tracks scrolling instantly.
// Keyed by the hover session so re-entering the list remounts it (snap +
// @starting-style fade-in) instead of sliding from a stale row; leaving keeps
// it mounted and fades it out in place (data-hidden), unless the keyboard
// holds it.
const listOverlayView = (model: Model): Html => {
  const h = html<Message>();
  return Option.match(model.selected, {
    onNone: () => h.empty,
    onSome: (index) => {
      const visible = model.isPointerInside || model.keyboardControlled;
      return h.keyed("div")(
        `inbox-hover-overlay-${model.hoverSession}`,
        [
          h.Class("fk-hover-overlay"),
          ...(visible ? [] : [h.DataAttribute("hidden", "")]),
          h.Style({
            top: `${index * ROW_HEIGHT}px`,
            left: "0",
            right: "0",
            height: `${ROW_HEIGHT}px`,
            transform: `translateY(${-model.list.scrollTop}px)`,
          }),
        ],
        [],
      );
    },
  });
};

// The virtualized thread list plus its overlay. The wrapper is the overlay's
// positioning context and clips it to the viewport; the list owns its scroll.
const virtualListView = (
  model: Model,
  rows: ReadonlyArray<ThreadRow>,
): Html => {
  const h = html<Message>();
  return h.div(
    [
      h.Class("relative min-h-0 flex-1 overflow-clip"),
      h.OnMouseEnter(EnteredList()),
      h.OnMouseLeave(LeftList()),
    ],
    [
      listOverlayView(model),
      h.submodel({
        slotId: LIST_ID,
        model: model.list,
        view: Ui.VirtualList.view<ThreadRow>(),
        viewInputs: {
          items: rows,
          itemToKey: (row: ThreadRow) => row.id,
          itemToView: (row: ThreadRow, index: number) =>
            emailRowView(emailFromThreadRow(row), index),
          overscan: LIST_OVERSCAN,
          containerClassName: "h-full",
        },
        toParentMessage: (message) => GotListMessage({ message }),
      }),
    ],
  );
};

// The loaded rows, preceded by an error row when one is present (a stale
// refresh, or a thread open that failed).
const listBodyView = (
  model: Model,
  rows: ReadonlyArray<ThreadRow>,
  error: Option.Option<string>,
): ReadonlyArray<Html> => [
  ...Option.match(error, {
    onNone: (): ReadonlyArray<Html> => [],
    onSome: (message) => [statusRowView(message)],
  }),
  rows.length === 0
    ? statusRowView(
        // A cold store while the machine is still filling it isn't empty,
        // it's early — the first primed rows land within a second or two.
        isSyncFilling(model.sync)
          ? "Syncing your inbox…"
          : "Your inbox is empty.",
      )
    : virtualListView(model, rows),
];

const isSyncFilling = (sync: SyncMachine.State): boolean =>
  sync._tag === "Cold" ||
  sync._tag === "Priming" ||
  sync._tag === "Backfilling";

// The list section: header, then whichever body the load state calls for.
const listSectionView = (model: Model): Html => {
  const h = html<Message>();

  const openError =
    model.screen._tag === "ShowingList"
      ? model.screen.error
      : Option.none<string>();

  const body = AsyncData.match(model.threads, {
    onIdle: (): ReadonlyArray<Html> => [statusRowView("Loading your inbox…")],
    onLoading: () => [statusRowView("Loading your inbox…")],
    onFailure: (error) => [statusRowView(error)],
    onSuccess: (rows) => listBodyView(model, rows, openError),
    onRefreshing: (rows) => listBodyView(model, rows, openError),
    onStale: ({ error, data }) => listBodyView(model, data, Option.some(error)),
  });

  return h.div(
    [h.Class("flex min-h-0 flex-1 flex-col")],
    [sectionHeaderView("Inbox"), ...body],
  );
};

// THREAD DETAIL
//
// Html bodies render in a sandboxed srcdoc iframe (email css can't leak out,
// ours can't leak in; no scripts run). Plain bodies skip the iframe.

// default-src 'none' blocks everything except images (inline cid: images
// arrive as blob: urls over locally stored bytes; remote images load live)
// and inline styles.
const FRAME_CSP =
  "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'";

const srcdocFor = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
  `<base target="_blank">` +
  `<style>body{margin:16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;background:#fff;overflow-wrap:break-word}img{max-width:100%;height:auto}</style>` +
  `</head><body>${body}</body></html>`;

const formatDetailTime = (epochMs: number): string =>
  new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const messageBodyView = (message: MessageDetail): Html => {
  const h = html<Message>();

  if (message.bodyKind === "plain") {
    return h.pre(
      [
        h.Class(
          "mt-3 whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-foreground",
        ),
      ],
      [message.body],
    );
  }

  return h.iframe(
    [
      h.Sandbox(
        "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
      ),
      h.Srcdoc(srcdocFor(message.body)),
      h.Class("mt-3 w-full rounded-lg bg-white"),
      h.Style({ height: `${BODY_FRAME_HEIGHT}px`, border: "0" }),
    ],
    [],
  );
};

const messageCardView = (message: MessageDetail): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("border-b border-border px-4 py-4")],
    [
      h.div(
        [h.Class("flex items-center gap-3")],
        [
          senderTile((message.fromName.slice(0, 1) || "?").toUpperCase()),
          h.div(
            [h.Class("min-w-0 flex-1")],
            [
              h.div(
                [h.Class("truncate text-[13px] font-semibold text-foreground")],
                [message.fromName],
              ),
              h.div(
                [h.Class("truncate text-[12px] text-muted-foreground")],
                [message.fromEmail],
              ),
            ],
          ),
          h.span(
            [
              h.Class(
                "shrink-0 text-[12px] tabular-nums text-muted-foreground",
              ),
            ],
            [formatDetailTime(message.date)],
          ),
        ],
      ),
      messageBodyView(message),
    ],
  );
};

const threadDetailView = (detail: ThreadDetail): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("flex min-h-0 flex-1 flex-col")],
    [
      h.div(
        [h.Class("flex items-center gap-3 border-b border-border px-2 py-2.5")],
        [
          h.button(
            [
              h.Type("button"),
              h.OnClick(ClickedBack()),
              h.AriaLabel("Back to inbox"),
              h.Class(
                `flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
              ),
            ],
            [Icon.arrowLeft("h-4 w-4"), "Inbox"],
          ),
          h.h1(
            [
              h.Class(
                "min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground",
              ),
            ],
            [detail.subject === "" ? "(no subject)" : detail.subject],
          ),
        ],
      ),
      h.div(
        [h.Class("min-h-0 flex-1 overflow-y-auto")],
        detail.messages.map((message) => messageCardView(message)),
      ),
    ],
  );
};

// Renders whatever the Search service last ranked. `prefiltered` keeps the
// palette from re-scoring: the service's order is the answer, and a lexical
// re-filter would discard exactly the semantic hits the later stages exist
// to produce.
const paletteView = (model: Model): Html => {
  const h = html<Message>();
  const specs = new Map(
    model.searchHits.map(({ thread }) => [
      thread.id as string,
      threadItemSpec(thread),
    ]),
  );

  return h.submodel({
    slotId: "inbox-palette",
    model: model.palette,
    view: InboxPalette.view,
    viewInputs: {
      // One unlabeled group: results are the only thing in the palette.
      groups: [
        {
          label: "",
          items: model.searchHits.map(({ thread }) => thread.id as string),
        },
      ],
      itemSpec: (item: string) => specs.get(item) ?? { label: item },
      placeholder: "Search your mail…",
      prefiltered: true,
      emptyLabel: Option.getOrElse(model.searchError, () => "No results"),
      substrate: PAGE_SURFACE,
    },
    toParentMessage: (message) => GotPaletteMessage({ message }),
  });
};

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { profile }): Html => {
    const h = html<Message>();

    return h.div(
      [h.Class("flex h-screen flex-col bg-background text-foreground")],
      [
        toolbarView(model, profile),
        // The list and the open thread share this centered column, so opening
        // a thread never moves the column.
        h.div(
          [
            h.Class(
              "mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-6",
            ),
          ],
          [
            M.value(model.screen).pipe(
              M.withReturnType<Html>(),
              M.tagsExhaustive({
                ShowingList: () => listSectionView(model),
                OpeningThread: () => listSectionView(model),
                ShowingThread: ({ detail }) => threadDetailView(detail),
              }),
            ),
          ],
        ),
        paletteView(model),
      ],
    );
  },
);
