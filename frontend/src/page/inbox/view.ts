// The inbox page's view. Pure rendering over the Model in model.ts; every
// interaction is a Message from there. Nothing in here reaches for a
// Command or the update logic.

import { Array as Arr, Match as M, Option } from "effect";
import { AsyncData, Submodel } from "foldkit";
import { createKeyedLazy, createLazy, html, type Html } from "foldkit/html";

import * as Icon from "../../icons";
import { ThreadId } from "../../Gmail";
import { ThreadDetail, ThreadRow, type MessageDetail } from "../../sync";
import * as SyncMachine from "../../syncMachine";
import * as Ui from "../../ui";

import {
  AVATAR_BG,
  AVATAR_FG,
  Appearance,
  BODY_FRAME_HEIGHT,
  CATEGORIES,
  CATEGORY_FROM_THREAD,
  type Category,
  ClickedAppearance,
  ClickedBack,
  ClickedRow,
  ClickedAccountSignOut,
  EnteredList,
  ExitedList,
  FOLDERS,
  FOLDER_LABELS,
  FolderMenu,
  GotAccountPopoverMessage,
  GotFolderMenuMessage,
  GotListMessage,
  GotPaletteMessage,
  GotSyncMessage,
  GotTabsMessage,
  HoveredRow,
  InboxPalette,
  LIST_ID,
  LIST_OVERSCAN,
  DETAIL_PANE_ID,
  Message,
  Model,
  PAGE_SURFACE,
  ROW_HEIGHT,
  TAB_LABELS,
  ToggledPalette,
  formatBytes,
  formatProgress,
  progressPercent,
  recentReadyLine,
  formatTime,
  tabSpec,
  threadItemSpec,
} from "./model";

// VIEW

// Hoisted out of the folder menu's viewInputs. Written inline it was a fresh
// closure and a fresh string on every render, which would keep the cluster's
// memoization slot missing no matter what the Model did.
const FOLDER_BUTTON_CLASS = `flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5 font-medium text-foreground hover:bg-active ${Ui.hoverTransition}`;

const folderItemSpec = (item: (typeof FOLDER_LABELS)[number]) => ({
  icon: FOLDERS[item].icon,
  label: item,
  detail:
    FOLDERS[item].count === undefined ? undefined : String(FOLDERS[item].count),
  isChecked: item === "All Inbox",
});

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
const accountPanelView = (profile: Profile, appearance: Appearance): Html => {
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
        [h.Type("button"), h.OnClick(ClickedAppearance()), h.Class(itemClass)],
        [
          (isDark ? Icon.sun : Icon.moon)("h-4 w-4 shrink-0"),
          isDark ? "Light mode" : "Dark mode",
        ],
      ),
      h.button(
        [
          h.Type("button"),
          h.OnClick(ClickedAccountSignOut()),
          h.Class(itemClass),
        ],
        [Icon.logOut("h-4 w-4 shrink-0"), "Sign out"],
      ),
    ],
  );
};

// What the pill says, per machine state: a short label for the pill itself
// and a fuller sentence for the hover detail. Cold is deliberately not empty
// — the machine boots Cold, so rendering nothing there made the pill appear a
// beat after first paint and shove the toolbar sideways.
type SyncSummary = Readonly<{
  /** The pill itself. */
  label: string;
  /** The panel's headline — the stage, named. */
  stage: string;
  /** The line under the bar: counts and time when we have them, a plain
   *  explanation of the stage when we don't. */
  detail: string;
  /** Some only while backfilling, which is the one stage with a real
   *  denominator to draw a bar against. */
  maybeProgress: Option.Option<
    Readonly<{ syncedCount: number; totalEstimate: number }>
  >;
}>;

const syncSummary = (sync: SyncMachine.State): SyncSummary =>
  M.value(sync).pipe(
    M.withReturnType<SyncSummary>(),
    M.tagsExhaustive({
      Cold: () => ({
        label: "Starting…",
        stage: "Starting",
        detail: "Reading your local mailbox.",
        maybeProgress: Option.none(),
      }),
      Priming: () => ({
        label: "Syncing…",
        stage: "Priming",
        detail: "Fetching your most recent mail.",
        maybeProgress: Option.none(),
      }),
      Backfilling: ({ syncedCount, totalEstimate }) => ({
        label: `Syncing ${syncedCount.toLocaleString()} of ~${totalEstimate.toLocaleString()}`,
        stage: "Backfilling",
        detail: formatProgress(syncedCount, totalEstimate),
        maybeProgress: Option.some({ syncedCount, totalEstimate }),
      }),
      CatchingUp: () => ({
        label: "Checking…",
        stage: "Checking",
        detail: "Looking for anything that changed since the last sync.",
        maybeProgress: Option.none(),
      }),
      Settled: () => ({
        label: "Synced",
        stage: "Synced",
        detail: "Your mailbox is up to date on this device.",
        maybeProgress: Option.none(),
      }),
      Backoff: () => ({
        label: "Retrying…",
        stage: "Retrying",
        detail: "Gmail asked us to slow down. Retrying shortly.",
        maybeProgress: Option.none(),
      }),
      NeedsAuth: () => ({
        label: "Reconnect Gmail",
        stage: "Disconnected",
        detail: "Your Gmail session expired. Click to sign in again.",
        maybeProgress: Option.none(),
      }),
    }),
  );

// The sync pill: the machine's state rendered directly — no parallel status
// struct to keep honest. Because the machine's entry state is derived from
// the persisted checkpoint, a refresh mid-backfill shows real progress from
// first paint.
//
// Hovering reveals the detail and the store's on-disk size: a local-first
// client that quietly grows to a gigabyte should say so somewhere visible.
const syncPillView = (
  sync: SyncMachine.State,
  maybeLocalBytes: Option.Option<number>,
  isRecentReady: boolean,
): Html => {
  const h = html<Message>();
  const { label, stage, detail, maybeProgress } = syncSummary(sync);
  const isWorking =
    sync._tag === "Cold" ||
    sync._tag === "Priming" ||
    sync._tag === "Backfilling" ||
    sync._tag === "CatchingUp";

  // A function, not a value: the glyph appears in both the pill and the
  // panel header, and a vnode is not reusable across two positions in the
  // tree — snabbdom patches through the same object twice.
  const leading = (): Html =>
    sync._tag === "Settled"
      ? Icon.check("h-3.5 w-3.5")
      : sync._tag === "Backoff"
        ? Ui.badgeDot({ color: "amber" })
        : sync._tag === "NeedsAuth"
          ? Ui.badgeDot({ color: "red" })
          : Ui.brailleLoader("text-[13px] text-muted-foreground");

  const progressRows: ReadonlyArray<Html> = Option.match(maybeProgress, {
    onNone: () => [],
    onSome: ({ syncedCount, totalEstimate }) => {
      const percent = progressPercent(syncedCount, totalEstimate);
      return [
        // The bar is decorative — the exact fraction is in the detail line
        // right below it, and that is what a screen reader reads.
        h.div(
          [
            h.Class("mt-2 h-1 w-full overflow-hidden rounded-full bg-active"),
            h.AriaHidden(true),
          ],
          [
            h.div(
              [
                h.Class("h-full rounded-full bg-foreground/70"),
                h.Style({ width: `${percent}%` }),
              ],
              [],
            ),
          ],
        ),
      ];
    },
  });

  // The header's right edge carries both numbers that are true of every
  // state: how far along we are, and how much is on disk. Neither earns its
  // own row — the size in particular is a standing fact, not a step, and a
  // labelled "On disk" row gave it more weight than the progress it sits next
  // to.
  const trailing = [
    ...Option.match(maybeLocalBytes, {
      onNone: () => [],
      onSome: (bytes) => [formatBytes(bytes)],
    }),
    ...Option.match(maybeProgress, {
      onNone: () => [],
      onSome: ({ syncedCount, totalEstimate }) => [
        `${progressPercent(syncedCount, totalEstimate)}%`,
      ],
    }),
  ].join(" · ");

  // The one genuinely interesting thing the app has to say mid-sync: your
  // recent mail is entirely local — bodies, images, offline — while the rest
  // of the mailbox is still coming down. Shown only while backfilling; once
  // the walk is done the whole mailbox is local and the claim is redundant.
  const milestoneRows: ReadonlyArray<Html> =
    isRecentReady && Option.isSome(maybeProgress)
      ? [
          h.div(
            [h.Class("mt-2 flex items-start gap-1.5 text-foreground")],
            [
              Icon.check("mt-0.5 h-3.5 w-3.5 shrink-0"),
              h.span([], [recentReadyLine()]),
            ],
          ),
        ]
      : [];

  // Hover-only, no state: the panel is always in the DOM for screen readers
  // and is revealed by the group. Cheaper than a Popover for something with
  // no interaction inside it.
  const detailPanel = h.div(
    [
      h.Class(
        `pointer-events-none absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-border p-3 text-left text-[12px] leading-relaxed opacity-0 transition-opacity group-hover:opacity-100 ${Ui.surface(
          Ui.elevate(PAGE_SURFACE, 3),
          3,
        )}`,
      ),
    ],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-3")],
        [
          h.span(
            [h.Class("flex items-center gap-2 text-foreground")],
            [leading(), stage],
          ),
          h.span([h.Class("shrink-0 text-muted-foreground")], [trailing]),
        ],
      ),
      ...progressRows,
      h.div([h.Class("mt-2 text-muted-foreground")], [detail]),
      ...milestoneRows,
    ],
  );

  const body: ReadonlyArray<Html> = [leading(), h.span([], [label])];
  const pillClass =
    "flex h-7 shrink-0 items-center gap-2 rounded-lg bg-hover px-2.5 text-[12px] tabular-nums text-muted-foreground";

  // NeedsAuth is the one pill that is a control: the machine parks there and
  // cannot leave on its own, so without a click there is no way back short
  // of reloading the page.
  return h.div(
    [h.Class("group relative")],
    [
      sync._tag === "NeedsAuth"
        ? h.button(
            [
              h.Type("button"),
              h.OnClick(
                GotSyncMessage({ message: SyncMachine.ClickedReconnect() }),
              ),
              h.Class(
                `${pillClass} cursor-pointer outline-none hover:bg-active hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
              ),
            ],
            body,
          )
        : h.div(
            [
              h.Class(pillClass),
              h.Role("status"),
              // The pill text alone is terse; the detail is what actually
              // explains the state, so it rides along for screen readers
              // rather than living only in a hover affordance.
              h.AriaLabel(`${label}. ${detail}`),
              ...(isWorking ? [h.AriaLive("polite")] : []),
            ],
            body,
          ),
      detailPanel,
    ],
  );
};

// The toolbar is split into three memoized pieces along the lines its inputs
// actually change on. The pill's counter ticks several times a second during
// a backfill; the folder menu and the account cluster do not move for minutes
// at a time. Rendering them as one subtree meant every tick rebuilt four
// submodels to change two digits.
const lazyFolderCluster = createLazy();
const lazySyncPill = createLazy();
const lazyAccountCluster = createLazy();

const folderClusterView = (
  folderMenu: Model["folderMenu"],
  tabs: Model["tabs"],
): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("flex min-w-0 items-center gap-5")],
    [
      h.submodel({
        slotId: "inbox-folder-menu",
        model: folderMenu,
        view: FolderMenu.view,
        viewInputs: {
          items: FOLDER_LABELS,
          itemSpec: folderItemSpec,
          buttonContent: folderButtonContent(),
          buttonClassName: FOLDER_BUTTON_CLASS,
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
            model: tabs,
            view: Ui.Tabs.view,
            viewInputs: {
              tabs: TAB_LABELS,
              tabSpec,
              ariaLabel: "Mail categories",
            },
            toParentMessage: (message) => GotTabsMessage({ message }),
          }),
          Ui.button(
            { variant: "ghost", size: "icon-sm", ariaLabel: "Add filter" },
            [Icon.plus("h-[18px] w-[18px]")],
          ),
        ],
      ),
    ],
  );
};

// Everything to the right of the pill. `profile` arrives as a fresh object on
// every render (main.ts builds it inline from the session), so this takes the
// two strings instead: they compare equal by value and the slot keeps its hit.
const accountClusterView = (
  accountPopover: Model["accountPopover"],
  appearance: Appearance,
  name: string,
  email: string,
): Html => {
  const h = html<Message>();
  const profile: Profile = { name, email };

  return h.div(
    [h.Class("flex shrink-0 items-center gap-3")],
    [
      h.button(
        [
          h.Type("button"),
          h.AriaLabel("Search"),
          h.OnClick(ToggledPalette()),
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
        model: accountPopover,
        view: Ui.Popover.view,
        viewInputs: {
          buttonContent: profileChipContent(profile),
          buttonClassName: `flex cursor-pointer items-center rounded-lg bg-hover py-1 pl-1.5 pr-2.5 outline-none hover:bg-active focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
          ariaLabel: "Account",
          substrate: PAGE_SURFACE,
          toPanelContent: () => accountPanelView(profile, appearance),
        },
        toParentMessage: (message) => GotAccountPopoverMessage({ message }),
      }),
      Ui.button(
        { variant: "ghost", size: "icon-sm", ariaLabel: "Notifications" },
        [Icon.bell("h-[18px] w-[18px]")],
      ),
      Ui.button({ variant: "tertiary", size: "icon", ariaLabel: "Compose" }, [
        Icon.squarePen("h-[18px] w-[18px]"),
      ]),
    ],
  );
};

const toolbarView = (model: Model, profile: Profile): Html => {
  const h = html<Message>();
  return h.header(
    [h.Class("flex items-center justify-between gap-4 px-5 py-3")],
    [
      lazyFolderCluster(folderClusterView, [model.folderMenu, model.tabs]),
      h.div(
        [h.Class("flex shrink-0 items-center gap-3")],
        [
          lazySyncPill(syncPillView, [
            model.sync,
            model.maybeLocalBytes,
            model.isRecentReady,
          ]),
          lazyAccountCluster(accountClusterView, [
            model.accountPopover,
            model.appearance,
            profile.name,
            profile.email,
          ]),
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

const lazyThreadRow = createKeyedLazy();

// One list row. Carries no hover background of its own — the traveling
// overlay (listOverlayView) is the single highlight for mouse and keyboard.
// The row height is fixed by the VirtualList; content just fills and centers.
const threadRowView = (row: ThreadRow, index: number): Html => {
  const h = html<Message>();
  const tone = row.unread ? "text-foreground" : "text-muted-foreground";

  return h.div(
    [
      h.OnClick(ClickedRow({ id: row.id, index })),
      h.OnMouseEnter(HoveredRow({ index })),
      h.Class(
        // overflow-hidden so a row can never widen the list: the sender and
        // meta clusters are shrink-0, so without it their combined
        // min-content width becomes the row's, and the container scrolls
        // sideways instead of the snippet truncating.
        "flex h-full cursor-pointer items-center gap-4 overflow-hidden border-b border-border px-4",
      ),
    ],
    [
      // Sender
      h.div(
        [h.Class("flex w-56 shrink-0 items-center gap-3 md:w-64")],
        [
          senderTile((row.sender.slice(0, 1) || "?").toUpperCase()),
          // min-w-0: a flex item defaults to min-width:auto, which refuses to
          // shrink below its text, so `truncate` alone never fires and a long
          // sender pushes past the fixed w-56.
          h.span(
            [h.Class(`min-w-0 truncate font-semibold ${tone}`)],
            [row.sender],
          ),
        ],
      ),

      // Subject + preview
      h.div(
        [h.Class("flex min-w-0 flex-1 items-center gap-2")],
        [
          // The dot's slot is always reserved so the subject column lines up
          // across read and unread rows; only the dot itself hides.
          row.unread
            ? Ui.badgeDot({ color: "indigo", ariaLabel: "Unread" })
            : h.span([h.Class("invisible h-[7px] w-[7px] shrink-0")], []),
          // The truncation ellipsis draws in the truncating element's color;
          // muted here matches the preview text it's eliding.
          h.span(
            [h.Class("min-w-0 truncate text-muted-foreground")],
            [
              h.span([h.Class(`font-semibold ${tone}`)], [row.subject]),
              h.span([h.Class("mx-2 text-muted-foreground/50")], ["—"]),
              h.span([], [row.snippet]),
            ],
          ),
        ],
      ),

      // Meta
      h.div(
        [h.Class("flex shrink-0 items-center gap-3")],
        [
          categoryTagView(CATEGORY_FROM_THREAD[row.category]),
          h.span(
            [
              h.Class(
                "w-14 text-right text-[13px] tabular-nums text-muted-foreground",
              ),
            ],
            [formatTime(row.date)],
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
// between rows; `top` is transitioned, which is the whole animation.
//
// It rides the VirtualList's `contentOverlay` slot, which puts it INSIDE the
// scroll container alongside the rows. That placement is the point: `top` is
// then a content-space coordinate and the browser scrolls the overlay with
// the rows for free. Rendered as a sibling of the list it had to chase
// scrollTop through a `translateY(-scrollTop)` recomputed from scroll
// Messages, and since native scrolling never waits for that round trip, the
// highlight visibly trailed the rows it was highlighting.
//
// Keyed by the hover session so re-entering the list remounts it (snap +
// @starting-style fade-in) instead of sliding from a stale row; leaving keeps
// it mounted and fades it out in place (data-hidden), unless the keyboard
// holds it.
const listOverlayView = (
  selected: Option.Option<number>,
  hoverSession: number,
  isPointerInside: boolean,
  keyboardControlled: boolean,
): Html => {
  const h = html<Message>();
  return Option.match(selected, {
    onNone: () => h.empty,
    onSome: (index) => {
      const visible = isPointerInside || keyboardControlled;
      return h.keyed("div")(
        `inbox-hover-overlay-${hoverSession}`,
        [
          h.Class("fk-hover-overlay"),
          ...(visible ? [] : [h.DataAttribute("hidden", "")]),
          h.Style({
            top: `${index * ROW_HEIGHT}px`,
            left: "0",
            right: "0",
            height: `${ROW_HEIGHT}px`,
          }),
        ],
        [],
      );
    },
  });
};

// The list, memoized on everything it actually draws from. Scrolling and
// hovering invalidate it by necessity now that the overlay rides inside the
// container. What it still buys is every render driven by something else: the
// sync pill ticks several times a second through a backfill, and rebuilding
// the list on each of those was pure waste.
//
// The overlay gets its own slot rather than being rebuilt inline, and that is
// load-bearing, not tidiness. A freshly built vnode is a new reference every
// render, so passing one straight into the list's args would miss the cache
// unconditionally and leave the memo above doing nothing at all.
const lazyVirtualList = createLazy();
const lazyListOverlay = createLazy();

const listSubmodelView = (
  list: Model["list"],
  rows: ReadonlyArray<ThreadRow>,
  overlay: Html,
): Html => {
  const h = html<Message>();
  return h.submodel({
    slotId: LIST_ID,
    model: list,
    view: Ui.VirtualList.view<ThreadRow>(),
    viewInputs: {
      items: rows,
      itemToKey: (row: ThreadRow) => row.id,
      // One memoization slot per thread id. Rows keep their identity
      // across a refresh (see reconcileRows), so a sync tick that changed
      // nothing in the visible window rebuilds no rows at all, and one
      // that marked a thread read rebuilds exactly that row.
      itemToView: (row: ThreadRow, index: number) =>
        lazyThreadRow(row.id, threadRowView, [row, index]),
      overscan: LIST_OVERSCAN,
      containerClassName: "h-full",
      contentOverlay: overlay,
    },
    toParentMessage: (message) => GotListMessage({ message }),
  });
};

// The virtualized thread list. The wrapper carries the pointer boundary for
// the hover session; the list owns its scroll and now its overlay too.
const virtualListView = (
  model: Model,
  rows: ReadonlyArray<ThreadRow>,
): Html => {
  const h = html<Message>();
  return h.div(
    [
      h.Class("min-h-0 flex-1 overflow-clip"),
      h.OnMouseEnter(EnteredList()),
      h.OnMouseLeave(ExitedList()),
    ],
    [
      lazyVirtualList(listSubmodelView, [
        model.list,
        rows,
        lazyListOverlay(listOverlayView, [
          model.selected,
          model.hoverSession,
          model.isPointerInside,
          model.keyboardControlled,
        ]),
      ]),
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
  Arr.match(rows, {
    onEmpty: () =>
      statusRowView(
        // A cold store while the machine is still filling it isn't empty,
        // it's early — the first primed rows land within a second or two.
        isSyncFilling(model.sync)
          ? "Syncing your inbox…"
          : "Your inbox is empty.",
      ),
    onNonEmpty: () => virtualListView(model, rows),
  }),
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

// Keyed by thread id rather than a single slot: reopening a thread you had
// open before should not have to rebuild its iframes, and srcdocFor rebuilds
// the whole body string every time it runs.
const lazyThreadDetail = createKeyedLazy();

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

// Renders whatever the Search service last ranked, in that order — the
// palette does no matching of its own.
const lazyPalette = createLazy();

const paletteView = (
  palette: Model["palette"],
  searchResults: ReadonlyArray<ThreadRow>,
  searchError: Option.Option<string>,
): Html => {
  const h = html<Message>();
  const specs = new Map(
    searchResults.map((row) => [row.id, threadItemSpec(row)]),
  );

  return h.submodel({
    slotId: "inbox-palette",
    model: palette,
    view: InboxPalette.view,
    viewInputs: {
      // One unlabeled group: results are the only thing in the palette.
      groups: [
        {
          label: "",
          items: searchResults.map((row) => row.id),
        },
      ],
      itemSpec: (item: ThreadId) => specs.get(item) ?? { label: item },
      placeholder: "Search your mail…",
      emptyLabel: Option.getOrElse(searchError, () => "No results"),
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
        //
        // The open thread is painted OVER the list rather than replacing it,
        // and the list stays mounted the whole time. Swapping the subtree
        // destroyed the VirtualList and rebuilt it on every close, which is
        // cheap near the top and brutal further down: the rebuilt container
        // starts at scrollTop 0 with a spacer as tall as everything above the
        // window (tens of thousands of rows worth), and the component only
        // re-applies scroll when it was Unmeasured — which a surviving model
        // is not. Keeping it mounted preserves its DOM, its measurement, and
        // its scroll position, so closing is free.
        h.div(
          [
            h.Class(
              "relative mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col",
            ),
          ],
          [
            h.div(
              [
                h.Class("flex min-h-0 flex-1 flex-col px-6"),
                // Still mounted under the open thread, so it has to be
                // hidden from screen readers or the list is announced
                // through the thread covering it.
                h.AriaHidden(model.screen._tag === "ShowingThread"),
              ],
              [listSectionView(model)],
            ),
            ...M.value(model.screen).pipe(
              M.withReturnType<ReadonlyArray<Html>>(),
              M.tagsExhaustive({
                ShowingList: () => [],
                OpeningThread: () => [],
                ShowingThread: ({ detail }) => [
                  h.div(
                    [
                      h.Class(
                        "absolute inset-0 z-10 flex min-h-0 flex-col bg-background px-6",
                      ),
                      // The click→paint benchmark's anchor for "the thread is
                      // on screen". It has no styling or behaviour attached.
                      h.Id(DETAIL_PANE_ID),
                    ],
                    [lazyThreadDetail(detail.id, threadDetailView, [detail])],
                  ),
                ],
              }),
            ),
          ],
        ),
        lazyPalette(paletteView, [
          model.palette,
          model.searchResults,
          model.searchError,
        ]),
      ],
    );
  },
);
