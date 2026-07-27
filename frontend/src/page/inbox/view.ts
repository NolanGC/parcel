// Pure rendering over the Model in model.ts. Every interaction is a Message.

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
  RECENT_READY_LINE,
  formatTime,
  tabSpec,
  threadItemSpec,
} from "./model";

// VIEW

// NOTE: Hoisted out of viewInputs. Inline it was a fresh string per render,
// which missed the cluster's memoization slot no matter what the Model did.
const FOLDER_BUTTON_CLASS = `flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5 font-medium text-foreground hover:bg-active ${Ui.hoverTransition}`;

const DEFAULT_FOLDER = "All Inbox";

const folderItemSpec = (item: (typeof FOLDER_LABELS)[number]) => {
  const { icon, count } = FOLDERS[item];
  return {
    icon,
    label: item,
    detail: count === undefined ? undefined : String(count),
    isChecked: item === DEFAULT_FOLDER,
  };
};

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

export type Profile = Readonly<{ name: string; email: string }>;

export type ViewInputs = Readonly<{ profile: Profile }>;

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

const accountPanelView = (profile: Profile, appearance: Appearance): Html => {
  const h = html<Message>();
  const itemClass = `flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`;
  const appearanceToggle =
    appearance === "Dark"
      ? { icon: Icon.sun, label: "Light mode" }
      : { icon: Icon.moon, label: "Dark mode" };

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
        [appearanceToggle.icon("h-4 w-4 shrink-0"), appearanceToggle.label],
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

const spinner = (): Html =>
  Ui.brailleLoader("text-[13px] text-muted-foreground");

const PILL_CLASS =
  "flex h-7 shrink-0 items-center gap-2 rounded-lg bg-hover px-2.5 text-[12px] tabular-nums text-muted-foreground";

// NeedsAuth is the one pill that is a control: the machine parks there and
// cannot leave on its own, so without a click there is no way back short of
// reloading the page.
const reconnectPillView = (body: ReadonlyArray<Html>): Html => {
  const h = html<Message>();
  return h.button(
    [
      h.Type("button"),
      h.OnClick(GotSyncMessage({ message: SyncMachine.ClickedReconnect() })),
      h.Class(
        `${PILL_CLASS} cursor-pointer outline-none hover:bg-active hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
      ),
    ],
    body,
  );
};

const statusPillView = (
  body: ReadonlyArray<Html>,
  label: string,
  detail: string,
  isWorking: boolean,
): Html => {
  const h = html<Message>();
  return h.div(
    [
      h.Class(PILL_CLASS),
      h.Role("status"),
      // The pill text alone is terse, so the detail rides along for screen
      // readers rather than living only in a hover affordance.
      h.AriaLabel(`${label}. ${detail}`),
      ...(isWorking ? [h.AriaLive("polite")] : []),
    ],
    body,
  );
};

// Everything the pill needs to know about a machine state, decided in one
// exhaustive match so a new state can't be half-handled.
// NOTE: Cold is deliberately not empty. The machine boots Cold, so rendering
// nothing there made the pill appear a beat after first paint and shove the
// toolbar sideways.
type SyncSummary = Readonly<{
  /** The pill itself. */
  label: string;
  /** The panel's headline: the stage, named. */
  stage: string;
  /** The line under the bar: counts and time when we have them, a plain
   *  explanation of the stage when we don't. */
  detail: string;
  /** Some only while backfilling, the one stage with a real denominator to
   *  draw a bar against. */
  maybeProgress: Option.Option<
    Readonly<{ syncedCount: number; totalEstimate: number }>
  >;
  /** Whether the machine is mid-pass, which is what makes the pill a polite
   *  live region rather than a static status. */
  isWorking: boolean;
  // NOTE: A function, not a value. The glyph appears in both the pill and the
  // panel header, and a vnode is not reusable across two positions in the
  // tree: snabbdom patches through the same object twice.
  toLeadingGlyph: () => Html;
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
        isWorking: true,
        toLeadingGlyph: spinner,
      }),
      Priming: () => ({
        label: "Syncing…",
        stage: "Priming",
        detail: "Fetching your most recent mail.",
        maybeProgress: Option.none(),
        isWorking: true,
        toLeadingGlyph: spinner,
      }),
      Backfilling: ({ syncedCount, totalEstimate }) => ({
        label: `Syncing ${syncedCount.toLocaleString()} of ~${totalEstimate.toLocaleString()}`,
        stage: "Backfilling",
        detail: formatProgress(syncedCount, totalEstimate),
        maybeProgress: Option.some({ syncedCount, totalEstimate }),
        isWorking: true,
        toLeadingGlyph: spinner,
      }),
      CatchingUp: () => ({
        label: "Checking…",
        stage: "Checking",
        detail: "Looking for anything that changed since the last sync.",
        maybeProgress: Option.none(),
        isWorking: true,
        toLeadingGlyph: spinner,
      }),
      Settled: () => ({
        label: "Synced",
        stage: "Synced",
        detail: "Your mailbox is up to date on this device.",
        maybeProgress: Option.none(),
        isWorking: false,
        toLeadingGlyph: () => Icon.check("h-3.5 w-3.5"),
      }),
      Backoff: () => ({
        label: "Retrying…",
        stage: "Retrying",
        detail: "Gmail asked us to slow down. Retrying shortly.",
        maybeProgress: Option.none(),
        isWorking: false,
        toLeadingGlyph: () => Ui.badgeDot({ color: "amber" }),
      }),
      NeedsAuth: () => ({
        label: "Reconnect Gmail",
        stage: "Disconnected",
        detail: "Your Gmail session expired. Click to sign in again.",
        maybeProgress: Option.none(),
        isWorking: false,
        toLeadingGlyph: () => Ui.badgeDot({ color: "red" }),
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
  const { label, stage, detail, maybeProgress, isWorking, toLeadingGlyph } =
    syncSummary(sync);

  // NOTE: The bar is decorative. The exact fraction is in the detail line
  // right below it, and that is what a screen reader reads.
  const progressRows = Arr.fromOption(
    Option.map(maybeProgress, ({ syncedCount, totalEstimate }) =>
      h.div(
        [
          h.Class("mt-2 h-1 w-full overflow-hidden rounded-full bg-active"),
          h.AriaHidden(true),
        ],
        [
          h.div(
            [
              h.Class("h-full rounded-full bg-foreground/70"),
              h.Style({
                width: `${progressPercent(syncedCount, totalEstimate)}%`,
              }),
            ],
            [],
          ),
        ],
      ),
    ),
  );

  // The header's right edge carries the two numbers true of every state: how
  // far along we are, and how much is on disk. Neither earns its own row.
  const trailing = [
    ...Arr.fromOption(Option.map(maybeLocalBytes, formatBytes)),
    ...Arr.fromOption(
      Option.map(
        maybeProgress,
        ({ syncedCount, totalEstimate }) =>
          `${progressPercent(syncedCount, totalEstimate)}%`,
      ),
    ),
  ].join(" · ");

  // The one genuinely interesting thing the app has to say mid-sync: your
  // recent mail is entirely local while the rest is still coming down. Shown
  // only while backfilling, since once the walk is done the whole mailbox is
  // local and the claim is redundant.
  const milestoneRows = Arr.fromOption(
    Option.map(
      Option.filter(maybeProgress, () => isRecentReady),
      () =>
        h.div(
          [h.Class("mt-2 flex items-start gap-1.5 text-foreground")],
          [
            Icon.check("mt-0.5 h-3.5 w-3.5 shrink-0"),
            h.span([], [RECENT_READY_LINE]),
          ],
        ),
    ),
  );

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
            [toLeadingGlyph(), stage],
          ),
          h.span([h.Class("shrink-0 text-muted-foreground")], [trailing]),
        ],
      ),
      ...progressRows,
      h.div([h.Class("mt-2 text-muted-foreground")], [detail]),
      ...milestoneRows,
    ],
  );

  const body: ReadonlyArray<Html> = [toLeadingGlyph(), h.span([], [label])];

  return h.div(
    [h.Class("group relative")],
    [
      sync._tag === "NeedsAuth"
        ? reconnectPillView(body)
        : statusPillView(body, label, detail, isWorking),
      detailPanel,
    ],
  );
};

// NOTE: Split into three memoized pieces along the lines its inputs change
// on. The pill ticks several times a second during a backfill; as one subtree
// every tick rebuilt four submodels to change two digits.
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

// NOTE: `profile` arrives as a fresh object per render, so this takes the two
// strings instead; they compare equal by value and the slot keeps its hit.
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
  const tone = row.isUnread ? "text-foreground" : "text-muted-foreground";

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
          row.isUnread
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
  maybeSelected: Option.Option<number>,
  hoverSession: number,
  isPointerInside: boolean,
  isKeyboardControlled: boolean,
): Html => {
  const h = html<Message>();
  return Option.match(maybeSelected, {
    onNone: () => h.empty,
    onSome: (index) => {
      const isVisible = isPointerInside || isKeyboardControlled;
      return h.keyed("div")(
        `inbox-hover-overlay-${hoverSession}`,
        [
          h.Class("fk-hover-overlay"),
          ...(isVisible ? [] : [h.DataAttribute("hidden", "")]),
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

// NOTE: The overlay gets its own memo slot rather than being rebuilt inline.
// A freshly built vnode is a new reference every render, so passing one
// straight into the list's args would miss the cache unconditionally and
// leave the memo doing nothing.
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
      // NOTE: One memo slot per thread id. Rows keep identity across a
      // refresh (see reconcileRows), so a sync tick that changed nothing in
      // the visible window rebuilds no rows.
      itemToView: (row: ThreadRow, index: number) =>
        lazyThreadRow(row.id, threadRowView, [row, index]),
      overscan: LIST_OVERSCAN,
      containerClassName: "h-full",
      contentOverlay: overlay,
    },
    toParentMessage: (message) => GotListMessage({ message }),
  });
};

// The wrapper carries the pointer boundary for the hover session.
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
          model.maybeSelected,
          model.hoverSession,
          model.isPointerInside,
          model.isKeyboardControlled,
        ]),
      ]),
    ],
  );
};

// Whether the store is still being filled, which is what separates "empty
// inbox" from "not downloaded yet".
const isSyncFilling = (sync: SyncMachine.State): boolean =>
  M.value(sync).pipe(
    M.withReturnType<boolean>(),
    M.tagsExhaustive({
      Cold: () => true,
      Priming: () => true,
      Backfilling: () => true,
      CatchingUp: () => false,
      Settled: () => false,
      Backoff: () => false,
      NeedsAuth: () => false,
    }),
  );

// The loaded rows, preceded by an error row when one is present (a stale
// refresh, or a thread open that failed).
const listBodyView = (
  model: Model,
  rows: ReadonlyArray<ThreadRow>,
  maybeError: Option.Option<string>,
): ReadonlyArray<Html> => [
  ...Arr.fromOption(Option.map(maybeError, statusRowView)),
  Arr.match(rows, {
    onEmpty: () =>
      statusRowView(
        // NOTE: A cold store while the machine is still filling it isn't
        // empty, it's early. The first primed rows land within a second or two.
        isSyncFilling(model.sync)
          ? "Syncing your inbox…"
          : "Your inbox is empty.",
      ),
    onNonEmpty: () => virtualListView(model, rows),
  }),
];

const LOADING_LINE = "Loading your inbox…";

const listSectionView = (model: Model): Html => {
  const h = html<Message>();

  const maybeOpenError = M.value(model.screen).pipe(
    M.withReturnType<Option.Option<string>>(),
    M.tagsExhaustive({
      ShowingList: ({ maybeError }) => maybeError,
      OpeningThread: () => Option.none(),
      ShowingThread: () => Option.none(),
    }),
  );

  const body = AsyncData.match(model.threads, {
    onIdle: (): ReadonlyArray<Html> => [statusRowView(LOADING_LINE)],
    onLoading: () => [statusRowView(LOADING_LINE)],
    onFailure: (error) => [statusRowView(error)],
    onSuccess: (rows) => listBodyView(model, rows, maybeOpenError),
    onRefreshing: (rows) => listBodyView(model, rows, maybeOpenError),
    onStale: ({ error, data }) => listBodyView(model, data, Option.some(error)),
  });

  return h.div(
    [h.Class("flex min-h-0 flex-1 flex-col")],
    [sectionHeaderView("Inbox"), ...body],
  );
};

// THREAD DETAIL
//
// NOTE: Html bodies render in a sandboxed srcdoc iframe so email css can't
// leak out, ours can't leak in, and no scripts run. Plain bodies skip it.

// default-src 'none' blocks everything except images and inline styles.
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

const lazyPalette = createLazy();

const paletteView = (
  palette: Model["palette"],
  searchResults: ReadonlyArray<ThreadRow>,
  maybeSearchError: Option.Option<string>,
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
      emptyLabel: Option.getOrElse(maybeSearchError, () => "No results"),
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
          model.maybeSearchError,
        ]),
      ],
    );
  },
);
