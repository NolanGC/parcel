import { Cause, Effect, Match as M, Option, Schema as S } from "effect";
import { Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { evo } from "foldkit/struct";

import * as Icon from "../icons";
import { MessageId, ThreadId } from "../Gmail";
import {
  SyncEngine,
  ThreadDetail,
  ThreadRow,
  type MessageDetail,
  type ThreadCategory,
} from "../sync";
import * as Ui from "../ui";

// The inbox, built on FoldkitUI (the Fluid Functionalism port). Colors
// come from the surface ladder + overlay tokens in styles.css, motion
// from the spring tiers in ui/motion.ts — no view here names a raw color
// or duration. Rows are real threads pulled through the SyncEngine
// (Gmail → local SQLite → this list); the folder dropdown, tabs, and
// palette remain chrome.

// The whole page sits on surface 1; everything that opens from it derives
// its own level from this substrate.
const PAGE_SURFACE = Ui.SurfaceLevel.make(1);

// APPEARANCE
//
// System follows the OS via CSS color-scheme; Light/Dark pin a class on
// <html> so the light-dark() tokens re-resolve. The swap is a Command (DOM
// side effect), wrapped in a 180ms cross-fade (html.transitioning).

export const Appearance = S.Literals(["System", "Light", "Dark"]);
export type Appearance = typeof Appearance.Type;

// DATA

/** Avatar tiles are "content colors" — deliberately outside the surface
 *  token system, like a favicon. The brand marks them as validated raw
 *  colors rather than free strings that bypass the design tokens. */
const HexColor = S.String.check(
  S.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
).pipe(S.brand("HexColor"));
type HexColor = typeof HexColor.Type;

type Category =
  | "todo"
  | "newsletter"
  | "reminder"
  | "promotions"
  | "primary"
  | "vacation"
  | "other";

type Avatar =
  | { kind: "image"; src: string }
  | {
      kind: "tile";
      bg: HexColor;
      fg: HexColor;
      label: string;
      serif?: boolean;
      rounded?: boolean;
    };

type Email = {
  id: string;
  sender: string;
  groupCount?: number;
  avatar: Avatar;
  unread?: boolean;
  /** Read rows drop the unread dot and recede: sender and subject render in
   *  the muted text color instead of full-contrast foreground. */
  isRead?: boolean;
  subjectIcon?: "cloud";
  subject: string;
  preview: string;
  category: Category;
  time: string;
  attachment?: boolean;
};

// Gmail's real category labels mapped onto the chip set the design
// defines. Categories without an honest counterpart land on "other"
// rather than pretending.
const CATEGORY_FROM_THREAD: Record<ThreadCategory, Category> = {
  personal: "primary",
  promotions: "promotions",
  social: "other",
  updates: "other",
  forums: "other",
  none: "other",
};

// Real senders have no avatar images yet, so every row wears an initial
// tile in the app accent — same shape the profile chip uses.
const AVATAR_BG = HexColor.make("#4f46e5");
const AVATAR_FG = HexColor.make("#ffffff");

// Same-day threads show the clock, older ones the date — matching the
// format the design used.
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
  id: row.id,
  sender: row.sender,
  avatar: {
    kind: "tile",
    bg: AVATAR_BG,
    fg: AVATAR_FG,
    label: (row.sender.slice(0, 1) || "?").toUpperCase(),
    rounded: true,
  },
  unread: row.unread,
  isRead: !row.unread,
  subject: row.subject,
  preview: row.snippet,
  category: CATEGORY_FROM_THREAD[row.category],
  time: formatTime(row.date),
});

type CategoryConfig = {
  label: string;
  icon: Ui.IconView;
  iconClass: string;
};

// Category accents are content colors, not theme tokens — they stay fixed
// across themes (like avatar tiles).
const CATEGORIES: Record<Category, CategoryConfig> = {
  todo: { label: "To-do", icon: Icon.circleCheck, iconClass: "" },
  newsletter: {
    label: "Newsletter",
    icon: Icon.leaf,
    iconClass: "text-green-500",
  },
  reminder: { label: "Reminder", icon: Icon.bell, iconClass: "text-amber-400" },
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
  vacation: {
    label: "Vacation",
    icon: Icon.palmtree,
    iconClass: "text-orange-400",
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

// COMMAND PALETTE
//
// The palette is the app's primary control surface (⌘K, or the toolbar
// search button). Its corpus is everything the chrome used to hold:
// actions, folder navigation, and the emails themselves. Items are plain
// strings; specs resolve through lookup maps so the viewInputs carry only
// one top-level function.

const PALETTE_ACTIONS = ["Compose", "Toggle dark mode"] as const;

const ACTION_SPECS: Record<string, Ui.Palette.PaletteItemSpec> = {
  Compose: { icon: Icon.squarePen, label: "Compose" },
  "Toggle dark mode": {
    icon: Icon.moon,
    label: "Toggle dark mode",
    keywords: "theme appearance light",
  },
};

// The palette's corpus is actions and folders. Emails will join once the
// palette can open a real thread — items would come from the model's rows,
// not a static module-level list.
const PALETTE_GROUPS: ReadonlyArray<Ui.Palette.Group<string>> = [
  { label: "Actions", items: PALETTE_ACTIONS },
  { label: "Folders", items: FOLDER_LABELS },
];

const paletteItemSpec = (item: string): Ui.Palette.PaletteItemSpec =>
  ACTION_SPECS[item] ??
  (item in FOLDERS
    ? { icon: FOLDERS[item as FolderLabel].icon, label: item }
    : { label: item });

const InboxPalette = Ui.Palette.create<string>();

// MODEL

export const Model = S.Struct({
  appearance: Appearance,
  folderMenu: Ui.Menu.Model,
  tabs: Ui.Tabs.Model,
  list: Ui.Table.Model,
  palette: Ui.Palette.Model,
  accountPopover: Ui.Popover.Model,
  // None = the first load hasn't completed; Some([]) = a genuinely empty
  // inbox. loadError keeps the last failure for the list to surface.
  threads: S.Option(S.Array(ThreadRow)),
  loadError: S.Option(S.String),
  // The mounted thread detail — visible once committed and measured, or
  // an invisible hover-prefetch pre-mount until then. Bodies live in the
  // model only while mounted — closing (or mounting another thread)
  // evicts them; the local database remains the working set.
  open: S.Option(ThreadDetail),
  // Measured srcdoc-iframe content heights by message id, set once per
  // body after its load event so the frame fits its content exactly.
  bodyHeights: S.Record(S.String, S.Number),
  // True only after a real click: the pane swap requires it, so a hover
  // prefetch can mount and measure without ever changing the screen.
  openCommitted: S.Boolean,
  // The thread a LoadThread is in flight for. A GotThread that doesn't
  // match is stale (the cursor moved on) and gets dropped — the load is
  // read-only, so discarding the result is the whole cancellation story.
  pendingLoad: S.Option(ThreadId),
  // The row currently under the cursor; the dwell timer checks it hasn't
  // changed before prefetching, so sweeping the list starts nothing.
  hovered: S.Option(ThreadId),
});
export type Model = typeof Model.Type;

export const init = (): Model => ({
  appearance: "System",
  folderMenu: Ui.Menu.init({ id: "inbox-folders", isAnimated: true }),
  tabs: Ui.Tabs.init({ id: "inbox-tabs" }),
  list: Ui.Table.init({ id: "inbox-list" }),
  palette: Ui.Palette.init({ id: "inbox-palette" }),
  accountPopover: Ui.Popover.init({ id: "inbox-account", isAnimated: true }),
  threads: Option.none(),
  loadError: Option.none(),
  open: Option.none(),
  bodyHeights: {},
  openCommitted: false,
  pendingLoad: Option.none(),
  hovered: Option.none(),
});

// MESSAGE

export const GotFolderMenuMessage = m("GotFolderMenuMessage", {
  message: Ui.Menu.Message,
});
export const CompletedApplyAppearance = m("CompletedApplyAppearance");
export const GotTabsMessage = m("GotTabsMessage", {
  message: Ui.Tabs.Message,
});
export const GotListMessage = m("GotListMessage", {
  message: Ui.Table.Message,
});
/** Toggles the command palette — from the toolbar button or the global ⌘K
 *  subscription in main.ts. A second ⌘K while open closes it. */
export const OpenedPalette = m("OpenedPalette");
export const GotPaletteMessage = m("GotPaletteMessage", {
  message: Ui.Palette.Message,
});
export const GotAccountPopoverMessage = m("GotAccountPopoverMessage", {
  message: Ui.Popover.Message,
});
/** The popover's sign-out action. The session lives on the top-level model,
 *  so main.ts watches for this tag inside GotInboxMessage and runs the
 *  actual SignOut command; here it only closes the popover. */
export const ClickedSignOut = m("InboxClickedSignOut");
/** The SyncEngine finished a pull: real thread rows, read back from the
 *  local database. */
export const GotThreads = m("GotThreads", { rows: S.Array(ThreadRow) });
export const FailedLoadInbox = m("FailedLoadInbox", { error: S.String });
/** Background hydration finished: rows re-read after threads missing
 *  local content were fully synced. Terminal — issues no further
 *  commands, so GotThreads → hydrate can't loop. */
export const GotHydratedThreads = m("GotHydratedThreads", {
  rows: S.Array(ThreadRow),
});
export const GotThread = m("GotThread", { detail: ThreadDetail });
/** The hover dwell elapsed for a row: if the cursor is still there, its
 *  thread gets prefetched and pre-mounted invisibly. */
export const DwellElapsed = m("DwellElapsed", { id: ThreadId });
export const FailedLoadThread = m("FailedLoadThread", { error: S.String });
export const ClickedBack = m("ClickedBack");
/** An html body's iframe finished loading — time to measure it. */
export const LoadedBodyFrame = m("LoadedBodyFrame", { messageId: MessageId });
export const CompletedScrollReset = m("CompletedScrollReset");
export const MeasuredBodyFrame = m("MeasuredBodyFrame", {
  messageId: MessageId,
  height: S.Number,
});

export const Message = S.Union([
  GotFolderMenuMessage,
  CompletedApplyAppearance,
  GotTabsMessage,
  GotListMessage,
  OpenedPalette,
  GotPaletteMessage,
  GotAccountPopoverMessage,
  ClickedSignOut,
  GotThreads,
  FailedLoadInbox,
  GotHydratedThreads,
  GotThread,
  DwellElapsed,
  FailedLoadThread,
  ClickedBack,
  LoadedBodyFrame,
  MeasuredBodyFrame,
  CompletedScrollReset,
]);
export type Message = typeof Message.Type;

// COMMAND

// Pins (or releases) the theme on <html> so every light-dark() token
// re-resolves, wrapped in the 180ms cross-fade class from styles.css. The
// cross-fade cleanup stays inside the effect (no detached setTimeout), so
// the runtime owns the timer's lifetime.
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

// Pulls one page of real inbox threads through the SyncEngine
// (Gmail → SQLite → rows). Triggered by main.ts on entering the
// logged-in inbox; the runtime's resources provide the SyncEngine.
export const LoadInbox = Command.define(
  "LoadInbox",
  GotThreads,
  FailedLoadInbox,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.loadInbox.pipe(
      Effect.map((rows) => GotThreads({ rows })),
      // catchCause, not catch: a defect (e.g. an orDie'd own-schema decode)
      // must surface as a visible failure, not kill the fiber silently.
      Effect.catchCause((cause) =>
        Effect.succeed(FailedLoadInbox({ error: Cause.pretty(cause) })),
      ),
    );
  }),
);

// Pulls full content for any listed thread that has none locally, then
// re-reads the rows. Issued right after GotThreads so the list is already
// painted; once this lands, every listed thread opens without a fetch.
const HydrateInbox = Command.define(
  "HydrateInbox",
  GotHydratedThreads,
  FailedLoadInbox,
)(
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    return yield* engine.hydrateMissing.pipe(
      Effect.map((rows) => GotHydratedThreads({ rows })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedLoadInbox({ error: Cause.pretty(cause) })),
      ),
    );
  }),
);

// Opens a thread from the local store only: SQLite rows, bodies gunzipped
// on the fly, cid: images rewritten from locally cached bytes — no
// network on this path, which is what makes opening instant post-sync.
export const LoadThread = Command.define(
  "LoadThread",
  { id: ThreadId },
  GotThread,
  FailedLoadThread,
)(({ id }) =>
  Effect.gen(function* () {
    const engine = yield* SyncEngine;
    // Timeline marks bracket the data phase (SQLite + decompress + cid
    // rewrite; on a cold thread, the self-heal fetch too). The perf
    // harness (perf/) reads them to split click→paint into phases; they
    // also show up in the DevTools Performance panel.
    yield* Effect.sync(() => performance.mark("parcel:data:start"));
    return yield* engine.loadThread(id).pipe(
      Effect.tap(() => Effect.sync(() => performance.mark("parcel:data:end"))),
      Effect.map((detail) => GotThread({ detail })),
      Effect.catchCause((cause) =>
        Effect.succeed(FailedLoadThread({ error: Cause.pretty(cause) })),
      ),
    );
  }),
);

// The hover→prefetch debounce: entering a row starts this timer, and the
// DwellElapsed handler checks the cursor is still on the same row before
// loading anything — so sweeping the cursor across the whole list starts
// timers, not loads.
const StartDwell = Command.define(
  "StartDwell",
  { id: ThreadId },
  DwellElapsed,
)(({ id }) =>
  Effect.gen(function* () {
    yield* Effect.sleep("150 millis");
    return DwellElapsed({ id });
  }),
);

const frameId = (messageId: string): string => `body-frame-${messageId}`;
const SCROLL_ID = "inbox-scroll";

// The list ↔ detail pane swap happens on this flag: the detail pane stays
// invisible (loading and measuring its iframes at final geometry behind
// the list) until every html body has a real height — so when the screen
// changes, the whole email is already painted.
const detailIsReady = (model: Model): boolean =>
  Option.match(model.open, {
    onNone: () => false,
    onSome: (detail) =>
      detail.messages.every(
        (message) =>
          message.bodyKind !== "html" ||
          (model.bodyHeights[message.id] ?? 0) > 0,
      ),
  });

// Ready alone isn't enough to change the screen: a hover prefetch mounts
// and measures without a click, so the swap also requires the commit.
const detailIsShown = (model: Model): boolean =>
  model.openCommitted && detailIsReady(model);

// The scroll container survives the pane swap (both panes live inside
// it), so entering and leaving a thread resets it explicitly — otherwise
// the detail opens at the list's scroll offset.
const ResetScroll = Command.define(
  "ResetScroll",
  CompletedScrollReset,
)(
  Effect.sync(() => {
    const container = document.getElementById(SCROLL_ID);
    if (container !== null) container.scrollTop = 0;
    return CompletedScrollReset();
  }),
);

// Reads the loaded iframe's content height (a DOM read is a side effect,
// so it lives in a command). The height lands in the model and the frame
// is sized once — content never scrolls inside the frame, the column
// scrolls as one surface.
const MeasureBodyFrame = Command.define(
  "MeasureBodyFrame",
  { messageId: MessageId },
  MeasuredBodyFrame,
)(({ messageId }) =>
  Effect.sync(() => {
    const frame = document.getElementById(frameId(messageId));
    const height =
      frame instanceof HTMLIFrameElement
        ? (frame.contentDocument?.documentElement.scrollHeight ?? 0)
        : 0;
    performance.mark(`parcel:measure:${messageId}`);
    return MeasuredBodyFrame({ messageId, height });
  }),
);

// UPDATE

type UpdateReturn = readonly [
  Model,
  ReadonlyArray<Command.Command<Message, never, SyncEngine>>,
];

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      GotFolderMenuMessage: ({ message }) => {
        // Pure UI sketch: folder selection has no domain effect yet, so
        // only the menu state advances.
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
        const [list, commands] = Ui.Table.update(model.list, message);
        const listCommands = Command.mapMessages(commands, (message) =>
          GotListMessage({ message }),
        );

        // Row keys are thread ids, so a Table click is an open request —
        // the click lives on the Table (submodel viewInputs can't carry
        // event handlers), and this page gives it meaning.
        if (message._tag === "TableClickedRow") {
          const decoded = S.decodeUnknownOption(ThreadId)(message.key);
          if (Option.isNone(decoded)) {
            return [evo(model, { list: () => list }), listCommands];
          }
          const id = decoded.value;

          // Already pre-mounted by a hover prefetch: committing is the
          // whole open — if every body is measured, the swap is this
          // frame's class flip.
          if (Option.exists(model.open, (detail) => detail.id === id)) {
            const next = evo(model, {
              list: () => list,
              openCommitted: () => true,
            });
            return [
              next,
              [
                ...listCommands,
                ...(detailIsShown(next) && !detailIsShown(model)
                  ? [ResetScroll()]
                  : []),
              ],
            ];
          }

          // A prefetch for this thread is in flight: commit and let its
          // GotThread continue the normal mount → measure → swap flow.
          if (Option.exists(model.pendingLoad, (pending) => pending === id)) {
            return [
              evo(model, { list: () => list, openCommitted: () => true }),
              listCommands,
            ];
          }

          return [
            evo(model, {
              list: () => list,
              open: () => Option.none<ThreadDetail>(),
              bodyHeights: () => ({}),
              openCommitted: () => true,
              pendingLoad: () => Option.some(id),
            }),
            [...listCommands, LoadThread({ id })],
          ];
        }

        // Entering a row tracks it as hovered and starts the prefetch
        // dwell timer for its thread.
        if (message._tag === "EnteredRow") {
          const id = Option.flatMap(
            model.threads,
            (rows): Option.Option<ThreadId> =>
              Option.fromUndefinedOr(rows[message.index]?.id),
          );
          return [
            evo(model, { list: () => list, hovered: () => id }),
            [
              ...listCommands,
              ...Option.match(id, {
                onNone: () => [],
                onSome: (id) => [StartDwell({ id })],
              }),
            ],
          ];
        }

        return [evo(model, { list: () => list }), listCommands];
      },

      OpenedPalette: () => {
        const [palette, commands] = InboxPalette.toggle(model.palette);
        return [
          evo(model, { palette: () => palette }),
          Command.mapMessages(commands, (message) =>
            GotPaletteMessage({ message }),
          ),
        ];
      },

      GotPaletteMessage: ({ message }) => {
        const [palette, commands, maybeSelected] = InboxPalette.update(
          model.palette,
          message,
        );
        const paletteCommands = Command.mapMessages(commands, (message) =>
          GotPaletteMessage({ message }),
        );
        // Only the theme action has a domain effect in the sketch; every
        // other selection just closes the palette.
        return Option.match(maybeSelected, {
          onNone: (): UpdateReturn => [
            evo(model, { palette: () => palette }),
            paletteCommands,
          ],
          onSome: (item): UpdateReturn => {
            if (item !== "Toggle dark mode") {
              return [evo(model, { palette: () => palette }), paletteCommands];
            }
            const appearance: Appearance =
              model.appearance === "Dark" ? "Light" : "Dark";
            return [
              evo(model, {
                palette: () => palette,
                appearance: () => appearance,
              }),
              [...paletteCommands, ApplyAppearance({ appearance })],
            ];
          },
        });
      },

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

      GotThreads: ({ rows }) => [
        evo(model, {
          threads: () => Option.some(rows),
          loadError: () => Option.none<string>(),
        }),
        [HydrateInbox()],
      ],

      GotHydratedThreads: ({ rows }) => [
        evo(model, { threads: () => Option.some(rows) }),
        [],
      ],

      FailedLoadInbox: ({ error }) => [
        evo(model, { loadError: () => Option.some(error) }),
        [],
      ],

      GotThread: ({ detail }) => {
        // Only the load we're still waiting for counts — anything else is
        // a superseded prefetch whose row the cursor left.
        if (!Option.exists(model.pendingLoad, (id) => id === detail.id)) {
          return [model, []];
        }
        const next = evo(model, {
          open: () => Option.some(detail),
          bodyHeights: () => ({}),
          pendingLoad: () => Option.none<ThreadId>(),
          loadError: () => Option.none<string>(),
        });
        // All-plain committed threads have nothing to measure: they're
        // shown now, so the pane swap (and its scroll reset) is immediate.
        return [
          next,
          detailIsShown(next) && !detailIsShown(model) ? [ResetScroll()] : [],
        ];
      },

      DwellElapsed: ({ id }) => {
        const stillHovered = Option.exists(
          model.hovered,
          (hovered) => hovered === id,
        );
        const alreadyMounted = Option.exists(
          model.open,
          (detail) => detail.id === id,
        );
        const alreadyLoading = Option.exists(
          model.pendingLoad,
          (pending) => pending === id,
        );
        // Prefetch only an idle, still-hovered, uncommitted row; a newer
        // dwell supersedes an older in-flight load (its result is dropped
        // by the pendingLoad check in GotThread).
        if (
          !stillHovered ||
          alreadyMounted ||
          alreadyLoading ||
          model.openCommitted
        ) {
          return [model, []];
        }
        return [
          evo(model, { pendingLoad: () => Option.some(id) }),
          [LoadThread({ id })],
        ];
      },

      FailedLoadThread: ({ error }) => [
        evo(model, {
          pendingLoad: () => Option.none<ThreadId>(),
          // A failed prefetch stays silent (nobody asked for that thread);
          // a failed committed open surfaces and un-commits, so the list
          // stays interactive and a re-click retries.
          openCommitted: () => false,
          loadError: () =>
            model.openCommitted ? Option.some(error) : model.loadError,
        }),
        [],
      ],

      ClickedBack: () => [
        evo(model, {
          open: () => Option.none<ThreadDetail>(),
          bodyHeights: () => ({}),
          openCommitted: () => false,
          pendingLoad: () => Option.none<ThreadId>(),
        }),
        [ResetScroll()],
      ],

      LoadedBodyFrame: ({ messageId }) => [
        model,
        [MeasureBodyFrame({ messageId })],
      ],

      MeasuredBodyFrame: ({ messageId, height }) => {
        const next = evo(model, {
          bodyHeights: () => ({ ...model.bodyHeights, [messageId]: height }),
        });
        // The measurement that completes a committed set flips the pane
        // swap; reset the shared scroll container in the same frame. A
        // prefetch's measurements change nothing on screen.
        return [
          next,
          !detailIsShown(model) && detailIsShown(next) ? [ResetScroll()] : [],
        ];
      },

      CompletedScrollReset: () => [model, []],

      // The actual sign-out is main.ts's job (it owns the session); this
      // page just folds the popover shut behind it.
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

// The signed-in Google account, passed down from main.ts (the session
// lives on the top-level model, not in this submodel).
export type Profile = {
  readonly name: string;
  readonly email: string;
};

export type ViewInputs = {
  readonly profile: Profile;
};

// The session carries no picture (see auth.ts Session), so the chip wears
// an initial tile in the same shape as the sender avatars.
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

// Static trigger content — the popover renders the button around it.
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

// The account popover: full identity up top, sign-out below — the same
// panel anatomy as a menu (p-1 shell, item-shaped rows, hairline divider).
const accountPanelView = (profile: Profile): Html => {
  const h = html<Message>();

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
          h.OnClick(ClickedSignOut()),
          h.Class(
            `flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
          ),
        ],
        [Icon.logOut("h-4 w-4 shrink-0"), "Sign out"],
      ),
    ],
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

      // Right cluster: search (⌘K), the signed-in profile, notifications,
      // compose.
      h.div(
        [h.Class("flex shrink-0 items-center gap-3")],
        [
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
              toPanelContent: () => accountPanelView(profile),
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

const senderAvatarView = (avatar: Avatar, name: string): Html => {
  const h = html();

  if (avatar.kind === "image") {
    return h.img([
      h.Src(avatar.src),
      h.Alt(name),
      h.Class("h-7 w-7 shrink-0 rounded-full object-cover"),
    ]);
  }

  const radius = avatar.rounded ? "rounded-full" : "rounded-[7px]";

  return h.span(
    [
      h.Class(
        `flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden ${radius}`,
      ),
      h.Style({ backgroundColor: avatar.bg, color: avatar.fg }),
    ],
    [
      avatar.label === "apple"
        ? Icon.appleFilled("h-4 w-4 -translate-y-[0.5px]")
        : avatar.label === "cal.com"
          ? h.span(
              [h.Class("text-[8px] font-semibold leading-none tracking-tight")],
              ["cal.com"],
            )
          : h.span(
              [
                h.Class("text-sm font-bold leading-none"),
                ...(avatar.serif
                  ? [h.Style({ fontFamily: "Georgia, serif" })]
                  : []),
              ],
              [avatar.label],
            ),
    ],
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

// Sender and subject carry the read state: unread rows read at full
// contrast, read rows recede to the muted text color (Tailwind needs the
// literal strings, so both variants are spelled out).
const READ_STATE = {
  unread: {
    sender: "truncate font-semibold text-foreground",
    subject: "font-semibold text-foreground",
  },
  read: {
    sender: "truncate font-semibold text-muted-foreground",
    subject: "font-semibold text-muted-foreground",
  },
} as const;

// No hover style on the row itself: the Table's traveling overlay carries
// the hover state, so panning glides instead of blinking per row.
const emailRowView = (email: Email): Html => {
  const h = html();
  const readState = READ_STATE[email.isRead ? "read" : "unread"];

  return h.div(
    [
      h.Class(
        "flex cursor-pointer items-center gap-4 border-b border-border px-4 py-3",
      ),
    ],
    [
      // Sender
      h.div(
        [h.Class("flex w-56 shrink-0 items-center gap-3 md:w-64")],
        [
          senderAvatarView(email.avatar, email.sender),
          h.span(
            [h.Class("flex min-w-0 items-baseline gap-1.5 truncate")],
            [
              h.span([h.Class(readState.sender)], [email.sender]),
              email.groupCount === undefined
                ? h.empty
                : h.span(
                    [h.Class("shrink-0 text-muted-foreground")],
                    [`(${email.groupCount})`],
                  ),
            ],
          ),
        ],
      ),

      // Subject + preview
      h.div(
        [h.Class("flex min-w-0 flex-1 items-center gap-2")],
        [
          // The dot's slot is always reserved so the subject column lines up
          // across read and unread rows; only the dot itself hides.
          email.unread && !email.isRead
            ? Ui.badgeDot({ color: "indigo", ariaLabel: "Unread" })
            : h.span([h.Class("invisible h-[7px] w-[7px] shrink-0")], []),
          email.subjectIcon === "cloud"
            ? Icon.cloud("h-4 w-4 shrink-0 text-muted-foreground")
            : h.empty,
          h.span(
            [h.Class("min-w-0 truncate")],
            [
              h.span([h.Class(readState.subject)], [email.subject]),
              h.span([h.Class("mx-2 text-muted-foreground/50")], ["—"]),
              h.span([h.Class("text-muted-foreground")], [email.preview]),
            ],
          ),
        ],
      ),

      // Meta
      h.div(
        [h.Class("flex shrink-0 items-center gap-3")],
        [
          email.attachment
            ? Icon.paperclip("h-4 w-4 text-muted-foreground")
            : h.empty,
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

  // Symmetric: the previous row's border sits above, this header's own
  // border closes it below, and the label centers between the two lines.
  return h.div(
    [
      h.Class(
        "border-b border-border py-2.5 text-center text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70",
      ),
    ],
    [label],
  );
};

// A full-width quiet row for the states that aren't a thread: first load,
// a load failure, an actually-empty inbox.
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

// The whole list — header interleaved with rows — is one Table, so the
// hover overlay travels across boundaries. Rows are the model's real
// threads; until the first pull lands there are no rows to fake.
const listChildren = (model: Model): ReadonlyArray<Ui.Table.TableChild> => {
  const header = {
    kind: "static" as const,
    key: "header-inbox",
    content: sectionHeaderView("Inbox"),
  };

  return Option.match(model.threads, {
    onNone: () => [
      header,
      {
        kind: "static" as const,
        key: "inbox-status",
        content: statusRowView(
          Option.getOrElse(model.loadError, () => "Loading your inbox…"),
        ),
      },
    ],
    onSome: (rows) => [
      header,
      // A failure after the list is up (e.g. a thread open) still needs a
      // face — without this row it would die into invisible model state.
      ...Option.match(model.loadError, {
        onNone: () => [],
        onSome: (error) => [
          {
            kind: "static" as const,
            key: "inbox-error",
            content: statusRowView(error),
          },
        ],
      }),
      ...(rows.length === 0
        ? [
            {
              kind: "static" as const,
              key: "inbox-status",
              content: statusRowView("Your inbox is empty."),
            },
          ]
        : rows.map((row) => ({
            kind: "row" as const,
            key: row.id,
            content: emailRowView(emailFromThreadRow(row)),
          }))),
    ],
  });
};

// THREAD DETAIL
//
// Renders in the exact container the list uses, so switching between the
// two never moves the column. Html bodies render in a sandboxed srcdoc
// iframe (email css can't leak out, ours can't leak in; no scripts run —
// allow-same-origin exists solely so the measure command can read the
// content height). Plain bodies skip the iframe entirely.

// default-src 'none' keeps the frame network-silent except images:
// data: for the locally cached cid: images, https: for remote ones
// (blocking those behind a "show images" toggle is a follow-up).
const FRAME_CSP =
  "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'";

// Email html expects a white canvas regardless of app theme; the reset
// only fills gaps for fragment bodies that bring no styling of their own.
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

// Pre-measure the frame renders at a fixed placeholder height; the
// measured height replaces it in one style patch (srcdoc unchanged, so
// snabbdom never reloads the frame).
const PLACEHOLDER_HEIGHT = 160;

const messageBodyView = (
  message: MessageDetail,
  measuredHeight: number | undefined,
): Html => {
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

  // A 0 measurement (frame unreadable) keeps the placeholder rather than
  // collapsing the body to invisible.
  const isMeasured = measuredHeight !== undefined && measuredHeight > 0;

  return h.iframe(
    [
      h.Id(frameId(message.id)),
      h.Sandbox(
        "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
      ),
      h.Srcdoc(srcdocFor(message.body)),
      h.OnLoad(LoadedBodyFrame({ messageId: message.id })),
      h.Class("mt-3 w-full rounded-lg bg-white"),
      h.Style({
        height: `${isMeasured ? measuredHeight : PLACEHOLDER_HEIGHT}px`,
        border: "0",
        // Browsers paint srcdoc progressively as it parses; staying
        // hidden until the post-load measurement means the body appears
        // fully laid out at final height in a single frame. "inherit",
        // not "visible": visibility lets a child override a hidden
        // ancestor, and a measured frame must not paint through the
        // still-invisible prefetch pane.
        visibility: isMeasured ? "inherit" : "hidden",
      }),
    ],
    [],
  );
};

const messageCardView = (
  message: MessageDetail,
  measuredHeight: number | undefined,
): Html => {
  const h = html<Message>();

  return h.div(
    [h.Class("border-b border-border px-4 py-4")],
    [
      h.div(
        [h.Class("flex items-center gap-3")],
        [
          h.span(
            [
              h.Class(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold leading-none",
              ),
              h.Style({ backgroundColor: AVATAR_BG, color: AVATAR_FG }),
            ],
            [(message.fromName.slice(0, 1) || "?").toUpperCase()],
          ),
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
      messageBodyView(message, measuredHeight),
    ],
  );
};

const threadDetailView = (model: Model, detail: ThreadDetail): Html => {
  const h = html<Message>();

  return h.div(
    [],
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
      ...detail.messages.map((message) =>
        messageCardView(message, model.bodyHeights[message.id]),
      ),
    ],
  );
};

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { profile }): Html => {
    const h = html<Message>();

    return h.div(
      [h.Class("flex h-screen flex-col bg-background text-foreground")],
      [
        toolbarView(model, profile),
        // The list sits in a centered column narrower than the page, so the
        // rows breathe with clear space on both sides.
        h.div(
          [h.Id(SCROLL_ID), h.Class("flex-1 overflow-y-auto pb-24")],
          [
            h.div(
              [h.Class("mx-auto w-full max-w-7xl px-6")],
              [
                // List and detail share this exact container, so opening a
                // thread never changes the column's width or position. Both
                // panes stay mounted while a detail is loading: the detail
                // renders invisible-absolute underneath (same width, so
                // iframes load and measure at final geometry) and the swap
                // is a pure class flip once every body is ready — keyed
                // wrappers keep the loaded iframes' element identity, and
                // the screen never changes until the content is paintable.
                h.div(
                  [h.Class("relative")],
                  [
                    h.keyed("div")(
                      "inbox-list-pane",
                      [h.Class(detailIsShown(model) ? "hidden" : "")],
                      [
                        h.submodel({
                          slotId: "inbox-list",
                          model: model.list,
                          view: Ui.Table.view,
                          viewInputs: { children: listChildren(model) },
                          toParentMessage: (message) =>
                            GotListMessage({ message }),
                        }),
                      ],
                    ),
                    ...Option.match(model.open, {
                      onNone: () => [],
                      onSome: (detail) => [
                        h.keyed("div")(
                          "inbox-detail-pane",
                          [
                            h.Id("inbox-detail-pane"),
                            h.Class(
                              detailIsShown(model)
                                ? ""
                                : "pointer-events-none invisible absolute inset-x-0 top-0",
                            ),
                          ],
                          [threadDetailView(model, detail)],
                        ),
                      ],
                    }),
                  ],
                ),
              ],
            ),
          ],
        ),
        h.submodel({
          slotId: "inbox-palette",
          model: model.palette,
          view: InboxPalette.view,
          viewInputs: {
            groups: PALETTE_GROUPS,
            itemSpec: paletteItemSpec,
            placeholder: "Type to search or navigate…",
            substrate: PAGE_SURFACE,
          },
          toParentMessage: (message) => GotPaletteMessage({ message }),
        }),
      ],
    );
  },
);
