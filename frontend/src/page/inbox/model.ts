// The inbox page's vocabulary: its constants, its Model, and its Message
// set. Imported by both view.ts and index.ts, and imports neither — the
// split exists so the update logic and the ~700 lines of view can be read
// independently, and a shared file with no sibling imports is what keeps
// that from becoming an import cycle.

import { Option, Schema as S } from "effect";
import { AsyncData } from "foldkit";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";

import * as Icon from "../../icons";
import { ThreadId } from "../../Gmail";
import { ThreadDetail, ThreadRow, type ThreadCategory } from "../../sync";
import * as SyncMachine from "../../syncMachine";
import * as Ui from "../../ui";

// The inbox, built on FoldkitUI (the Fluid Functionalism port). Colors come
// from the surface ladder + overlay tokens in styles.css, motion from the
// spring tiers in ui/motion.ts. Rows are real threads pulled through the
// SyncEngine (Gmail → local SQLite → this list); the folder dropdown, tabs,
// and palette are chrome.

export const PAGE_SURFACE = Ui.SurfaceLevel.make(1);

// The virtualized list: rows are a fixed height so the visible window and the
// traveling hover overlay are both pure arithmetic (index * ROW_HEIGHT).
export const LIST_ID = "inbox-list";
export const ROW_HEIGHT = 53;
export const LIST_OVERSCAN = 6;

// Html email bodies render in a sandboxed iframe at a fixed height and scroll
// internally — no content measurement, no pane pre-mounting.
export const BODY_FRAME_HEIGHT = 600;

// APPEARANCE — System follows the OS; Light/Dark pin a class on <html> so the
// light-dark() tokens re-resolve, wrapped in a 180ms cross-fade.

export const Appearance = S.Literals(["System", "Light", "Dark"]);
export type Appearance = typeof Appearance.Type;

// DATA

export type Category = "promotions" | "primary" | "other";

// Gmail's category labels mapped onto the chip set the design defines.
export const CATEGORY_FROM_THREAD: Record<ThreadCategory, Category> = {
  personal: "primary",
  promotions: "promotions",
  social: "other",
  updates: "other",
  forums: "other",
  none: "other",
};

// Sender tiles are "content colors" — deliberately outside the surface token
// system, like a favicon.
export const AVATAR_BG = "#4f46e5";
export const AVATAR_FG = "#ffffff";

// Same-day threads show the clock, older ones the date.
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

export type CategoryConfig = { label: string; icon: Ui.IconView; iconClass: string };

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

export type TabConfig = {
  label: string;
  icon: Ui.IconView;
  count: number;
  iconClass: string;
};

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

export const tabSpec = (label: string): Ui.Tabs.TabSpec => {
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

export const FOLDER_LABELS = [
  "All Inbox",
  "Sent",
  "Send later",
  "Drafts",
  "Spams",
  "Archives",
] as const;
export type FolderLabel = (typeof FOLDER_LABELS)[number];

export const FOLDERS: Record<FolderLabel, { icon: Ui.IconView; count?: number }> = {
  "All Inbox": { icon: Icon.inbox, count: 199 },
  Sent: { icon: Icon.send },
  "Send later": { icon: Icon.clock },
  Drafts: { icon: Icon.feather, count: 2 },
  Spams: { icon: Icon.shieldAlert, count: 8 },
  Archives: { icon: Icon.archive, count: 7 },
};

export const FolderMenu = Ui.Menu.create<FolderLabel>();

// COMMAND PALETTE — search over the local store (⌘K, or the toolbar search
// button). Items are thread ids; the corpus is the mailbox itself.
//
// The whole store already rides in the model (SyncEngine.loadInbox selects
// every row — see the VirtualList note in sync.ts), so matching is pure and
// instant: no command round-trip, no debounce, nothing async to keep honest.
// The rank/cap happens here rather than in the palette because only an
// unbounded corpus needs one, and the palette re-applies the same scorer.

export const PALETTE_RESULT_LIMIT = 50;

export const threadItemSpec = (row: ThreadRow): Ui.Palette.PaletteItemSpec => ({
  icon: row.unread ? Icon.mail : Icon.mailOpen,
  label: row.subject === "" ? "(no subject)" : row.subject,
  detail: row.sender,
});

export const InboxPalette = Ui.Palette.create<string>();

// MODEL

// The inbox rows as an async-loaded value: Loading renders the placeholder,
// Success/Refreshing the rows, Failure the error, and Stale keeps the last
// good rows on screen with the refresh error above them.
export const ThreadsData = AsyncData.Schema(S.Array(ThreadRow), S.String);

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
  // The palette's results, in the order the Search service ranked them.
  searchResults: S.Array(ThreadRow),
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
  searchResults: [],
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
export const GotSearchResults = m("GotSearchResults", {
  seq: S.Number,
  rows: S.Array(ThreadRow),
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
  GotSearchResults,
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
