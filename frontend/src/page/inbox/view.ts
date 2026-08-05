// Pure rendering over the Model in model.ts. Every interaction is a Message.

import { Array as Arr, Match as M, Option } from "effect";
import { AsyncData, Submodel } from "foldkit";
import { createLazy, html, type Html } from "foldkit/html";

import * as Icon from "../../icons";
import { ThreadId } from "../../Gmail";
import { renderMarkdownToEmailHtml } from "../../markdown";
import * as OutboxMachine from "../../outboxMachine";
import { prepareBody } from "../../sanitizeBody";
import {
  ThreadDetail,
  ThreadRow,
  type BackfillPhase,
  type Folder,
  type MailboxCounts,
  type MessageDetail,
  type ThreadCategory,
} from "../../sync";
import * as SyncMachine from "../../syncMachine";
import * as Ui from "../../ui";
import { createCappedKeyedLazy } from "../../ui/lazy";
import { mailBodySpec } from "../../ui/mailBody";
import { senderAvatarUrl } from "../../avatars";

import {
  AVATAR_BG,
  AVATAR_FG,
  Appearance,
  CATEGORY_PILLS,
  ClickedAppearance,
  ClickedArchiveRow,
  ClickedBack,
  ClickedCompose,
  ClickedReply,
  ClickedRow,
  ClickedSend,
  ClickedStarRow,
  ClickedToggleReadRow,
  ClickedAccountSignOut,
  ClosedCompose,
  ClosedOutboxError,
  ComposeEditing,
  type ComposeField,
  composeFieldId,
  EditedCompose,
  EnteredList,
  ExitedList,
  FOLDER_CONFIG,
  FOLDER_ITEMS,
  FolderMenu,
  GotAccountPopoverMessage,
  GotFolderMenuMessage,
  GotListMessage,
  GotOutboxMessage,
  GotPaletteMessage,
  GotSyncMessage,
  GotTabsMessage,
  HoveredRow,
  InboxPalette,
  isSendable,
  LIST_ID,
  LIST_OVERSCAN,
  DETAIL_PANE_ID,
  Message,
  Model,
  PAGE_SURFACE,
  ROW_HEIGHT,
  TAB_LABELS,
  ToggledComposePreview,
  ToggledPalette,
  formatBytes,
  formatProgress,
  progressPercent,
  RECENT_READY_LINE,
  formatTime,
  tabSpec,
  folderCount,
  threadItemSpec,
  visibleRows,
} from "./model";

// VIEW

const mailBody = mailBodySpec.withMessage<Message>();

// A draft has no cached images to swap in — it is composed here, and every
// url in it is already whatever the author typed.
const EMPTY_URLS: ReadonlyMap<string, string> = new Map();

// NOTE: Hoisted out of viewInputs. Inline it was a fresh string per render,
// which missed the cluster's memoization slot no matter what the Model did.
const FOLDER_BUTTON_CLASS = `flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5 font-medium text-foreground hover:bg-active ${Ui.hoverTransition}`;

// Curried so the returned function sits at the top level of viewInputs (the
// submodel boundary auto-scopes functions there, and only there).
const folderItemSpec =
  (folder: Folder, counts: MailboxCounts) => (item: Folder) => {
    const count = folderCount(counts, item);
    return {
      icon: FOLDER_CONFIG[item].icon,
      label: FOLDER_CONFIG[item].label,
      // Only the folders where a number means something carry one, and only
      // when it is not zero (see folderCount).
      detail: count === 0 ? undefined : String(count),
      isChecked: item === folder,
    };
  };

const folderButtonContent = (folder: Folder): Html => {
  const h = html();
  const { icon, label } = FOLDER_CONFIG[folder];
  return h.span(
    [h.Class("flex items-center gap-2")],
    [
      icon("h-[18px] w-[18px]"),
      h.span([], [label]),
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
// The backfill's tiers, named for the panel. See BackfillPhase in sync.ts for
// what each one actually asks Gmail for.
const BACKFILL_PHASE_LABEL: Record<BackfillPhase, string> = {
  primary: "Primary",
  inbox: "Rest of inbox",
  rest: "Everything else",
};

const BACKFILL_PHASE_DETAIL: Record<BackfillPhase, string> = {
  primary: "Filling the Primary tab first.",
  inbox: "Primary is complete. Now the other inbox tabs.",
  rest: "The inbox is complete. Now archived, sent and spam.",
};

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
      Backfilling: ({ syncedCount, totalEstimate, phase }) => ({
        label: `Syncing ${syncedCount.toLocaleString()} of ~${totalEstimate.toLocaleString()}`,
        stage: `Backfilling · ${BACKFILL_PHASE_LABEL[phase]}`,
        // Which slice the walk is in belongs next to the progress: the tiers
        // are the reason the Primary tab fills before the rest, and without
        // this the only way to tell them apart is to watch the tab counts and
        // guess.
        detail: `${BACKFILL_PHASE_DETAIL[phase]} ${formatProgress(
          syncedCount,
          totalEstimate,
        )}`,
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

// The outbound counterpart of the sync pill: what is still waiting to go out.
// Absent entirely when the queue is empty, which is almost always — a badge
// that reads "0 queued" is noise on every screen to spare one on a few.
//
// A failed send is the one state that is a control: its body was kept
// precisely so the click has something to retry.
const outboxPillView = (outbox: OutboxMachine.State): Html => {
  const h = html<Message>();
  const { pendingCount, failedCount } = outbox.summary;

  if (failedCount > 0) {
    const label =
      failedCount === 1
        ? "1 message failed to send"
        : `${failedCount} messages failed to send`;
    return h.button(
      [
        h.Type("button"),
        h.OnClick(
          GotOutboxMessage({ message: OutboxMachine.ClickedRetryFailed() }),
        ),
        h.AriaLabel(`${label}. Retry.`),
        h.Class(
          `${PILL_CLASS} cursor-pointer outline-none hover:bg-active hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
        ),
      ],
      [Ui.badgeDot({ color: "red" }), h.span([], [`${label} · Retry`])],
    );
  }

  if (pendingCount === 0) {
    return h.empty;
  }

  return h.div(
    [h.Class(PILL_CLASS), h.Role("status"), h.AriaLive("polite")],
    [
      Icon.send("h-3.5 w-3.5"),
      h.span([], [pendingCount === 1 ? "1 queued" : `${pendingCount} queued`]),
    ],
  );
};

// NOTE: Split into memoized pieces along the lines its inputs change on. The
// sync pill ticks several times a second during a backfill; as one subtree
// every tick rebuilt four submodels to change two digits.
const lazyFolderCluster = createLazy();
const lazySyncPill = createLazy();
const lazyOutboxPill = createLazy();
const lazyAccountCluster = createLazy();

const folderClusterView = (
  folderMenu: Model["folderMenu"],
  tabs: Model["tabs"],
  folder: Folder,
  counts: MailboxCounts,
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
          items: FOLDER_ITEMS,
          itemSpec: folderItemSpec(folder, counts),
          buttonContent: folderButtonContent(folder),
          buttonClassName: FOLDER_BUTTON_CLASS,
          ariaLabel: "Mail folders",
          substrate: PAGE_SURFACE,
        },
        toParentMessage: (message) => GotFolderMenuMessage({ message }),
      }),
      // Category tabs are an inbox concept — Gmail's own, and ours — so
      // every other folder shows the plain list without them.
      folder !== "inbox"
        ? h.empty
        : h.nav(
            [h.Class("flex items-center gap-2")],
            [
              h.submodel({
                slotId: "inbox-tabs",
                model: tabs,
                view: Ui.Tabs.view,
                viewInputs: {
                  tabs: TAB_LABELS,
                  tabSpec: tabSpec(counts),
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
      Ui.button(
        {
          variant: "tertiary",
          size: "icon",
          ariaLabel: "Compose",
          onClick: ClickedCompose(),
        },
        [Icon.squarePen("h-[18px] w-[18px]")],
      ),
    ],
  );
};

const toolbarView = (model: Model, profile: Profile): Html => {
  const h = html<Message>();
  return h.header(
    [h.Class("flex items-center justify-between gap-4 px-5 py-3")],
    [
      lazyFolderCluster(folderClusterView, [
        model.folderMenu,
        model.tabs,
        model.folder,
        model.counts,
      ]),
      h.div(
        [h.Class("flex shrink-0 items-center gap-3")],
        [
          lazyOutboxPill(outboxPillView, [model.outbox]),
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

// The sender's picture, or their initial.
//
// NOTE: The tile is the fallback BY CONSTRUCTION — the initial is always
// drawn, and the image is laid over it. An avatar that has not been fetched
// yet, or a url that fails to load, needs no handling at all: there is simply
// nothing on top, and the letter shows. That is the whole error path, and it
// costs no Message, no second state and nothing to keep in sync.
// NOTE: Takes the resolved url rather than the address, so this stays a pure
// function of its arguments. The lookup is a cache read (avatars.ts) and
// belongs at the memo boundary, where `avatarVersion` can force it — resolving
// in here would let a row keep a stale memo hit and never show its picture.
// An empty string is "no image", not a missing argument.
const senderTile = (label: string, avatarUrl: string): Html => {
  const h = html();
  return h.span(
    [
      h.Class(
        "relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold leading-none",
      ),
      h.Style({ backgroundColor: AVATAR_BG, color: AVATAR_FG }),
    ],
    [
      label,
      avatarUrl === ""
        ? h.empty
        : h.img([
            h.Src(avatarUrl),
            // Decorative: the sender's name is right beside it, so announcing
            // the picture too would only repeat it.
            h.Alt(""),
            h.Class("absolute inset-0 h-full w-full object-cover"),
          ]),
    ],
  );
};

/** The sender's image url for the view, or `""` for the letter tile. */
const avatarUrlFor = (email: string): string =>
  Option.getOrElse(senderAvatarUrl(email), () => "");

// The thread's real Gmail category. Primary rows wear nothing: primary is
// the absence of a category (see CATEGORY_PILLS).
const categoryTagView = (category: ThreadCategory): Html => {
  const h = html();
  return Option.match(CATEGORY_PILLS[category], {
    onNone: () => h.empty,
    onSome: ({ label, icon, iconClass }) =>
      h.span(
        [
          h.Class(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md bg-hover px-2 py-1 text-xs font-medium text-muted-foreground",
          ),
        ],
        [icon(`h-3.5 w-3.5 ${iconClass}`, "2.25"), label],
      ),
  });
};

// Several scroll windows' worth, so scrolling back over what you just passed
// still hits. The ceiling is what matters, not the exact number: without one,
// this cache retains a detached row subtree per thread ever scrolled past.
const ROW_MEMO_CAPACITY = 200;

const lazyThreadRow = createCappedKeyedLazy(ROW_MEMO_CAPACITY);

// One list row. Carries no hover background of its own — the traveling
// overlay (listOverlayView) is the single highlight for mouse and keyboard.
// The row height is fixed by the VirtualList; content just fills and centers.
//
// Nothing here depends on the cursor, so a row is a pure function of its own
// data and moving the selection rebuilds nothing.
const threadRowView = (
  row: ThreadRow,
  index: number,
  avatarUrl: string,
): Html => {
  const h = html<Message>();
  const tone = row.isUnread ? "text-foreground" : "text-muted-foreground";

  return h.div(
    [
      h.OnMouseEnter(HoveredRow({ index })),
      h.Class(
        // overflow-hidden so a row can never widen the list: the sender and
        // meta clusters are shrink-0, so without it their combined
        // min-content width becomes the row's, and the container scrolls
        // sideways instead of the snippet truncating.
        //
        // `group` is what lets the actions in the meta cluster reveal on
        // hover without any of it reaching the Model.
        "group flex h-full items-center gap-4 overflow-hidden border-b border-border px-4",
      ),
    ],
    [
      // The opening region. NOTE: The click handler is here rather than on
      // the row, so that the action buttons in the meta cluster are not also
      // "open this thread" — foldkit's OnClick has no stopPropagation, so a
      // button nested under a clickable row would do both.
      h.div(
        [
          h.OnClick(ClickedRow({ id: row.id, index })),
          h.Class("flex min-w-0 flex-1 cursor-pointer items-center gap-4"),
        ],
        [
          // Sender
          h.div(
            [h.Class("flex w-56 shrink-0 items-center gap-3 md:w-64")],
            [
              senderTile(
                (row.sender.slice(0, 1) || "?").toUpperCase(),
                avatarUrl,
              ),
              // min-w-0: a flex item defaults to min-width:auto, which refuses
              // to shrink below its text, so `truncate` alone never fires and
              // a long sender pushes past the fixed w-56.
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
              // The dot's slot is always reserved so the subject column lines
              // up across read and unread rows; only the dot itself hides.
              row.isUnread
                ? Ui.badgeDot({ color: "indigo", ariaLabel: "Unread" })
                : h.span([h.Class("invisible h-[7px] w-[7px] shrink-0")], []),
              // The truncation ellipsis draws in the truncating element's
              // color; muted here matches the preview text it's eliding.
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
        ],
      ),

      // Meta
      h.div(
        [h.Class("flex shrink-0 items-center gap-3")],
        [
          categoryTagView(row.category),
          // Always mounted, so a star can be set, unset, or hovered without
          // anything in the row moving a pixel.
          rowStarView(row),
          h.span(
            [
              h.Class(
                "w-14 text-right text-[13px] tabular-nums text-muted-foreground",
              ),
            ],
            [formatTime(row.date)],
          ),
          rowActionsView(row),
        ],
      ),
    ],
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
// One icon action. Shared by the list rows and the open thread's header, so
// starring from either place looks and reads the same.
const rowActionView = (
  label: string,
  icon: Ui.IconView,
  iconClass: string,
  message: Message,
  containerClass = "",
): Html => {
  const h = html<Message>();
  return h.button(
    [
      h.Type("button"),
      h.AriaLabel(label),
      h.Title(label),
      h.OnClick(message),
      h.Class(
        `flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-active hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition} ${containerClass}`,
      ),
    ],
    [icon(`h-4 w-4 ${iconClass}`)],
  );
};

// The star, which is both the indicator and the control — one element in one
// place, always mounted and always visible.
//
// NOTE: Not part of rowActionsView, and that is the whole point. As a
// read-only indicator on the left of the timestamp plus a star BUTTON inside
// the actions on the right of it, the star appeared to hop across the
// timestamp on hover. There is only one star now, and it never moves: only
// its color changes, amber when set and muted when not.
const rowStarView = (row: ThreadRow): Html =>
  rowActionView(
    row.isStarred ? "Unstar" : "Star",
    Icon.star,
    row.isStarred ? "fill-amber-400 text-amber-400" : "",
    ClickedStarRow({ id: row.id }),
  );

// The row's own actions.
//
// NOTE: In the row rather than in the traveling overlay, because the overlay
// reaches the VirtualList through `viewInputs` and foldkit rejects interactive
// Html there (it walks viewInputs and throws on nested functions).
//
// Always mounted and always visible — nothing here reacts to hover but the
// buttons' own background. Revealing them on hover meant the icons popped in
// under the cursor, and fading them in per row made a list that flickers as
// you move down it. They are muted enough to read as chrome until wanted.
//
// That they never change also means a row's view does not depend on which row
// is hovered, so moving the cursor down the list rebuilds no rows at all.
const rowActionsView = (row: ThreadRow): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("flex shrink-0 items-center gap-0.5")],
    [
      rowActionView(
        row.isUnread ? "Mark as read" : "Mark as unread",
        row.isUnread ? Icon.mailOpen : Icon.mail,
        "",
        ClickedToggleReadRow({ id: row.id }),
      ),
      rowActionView(
        "Archive",
        Icon.archive,
        "",
        ClickedArchiveRow({ id: row.id }),
      ),
    ],
  );
};

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

// NOTE: `_avatarVersion` is deliberately unread — it is a cache-busting
// argument, underscored to say so. The row urls come from the avatars
// registry, which the view cannot observe, so the counter is what tells this
// memo slot that resolving them again is worth doing. Rows whose url is
// unchanged still keep their own memo hit, because the resolved string is
// stable per sender.
const listSubmodelView = (
  list: Model["list"],
  rows: ReadonlyArray<ThreadRow>,
  overlay: Html,
  _avatarVersion: number,
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
      // the visible window rebuilds no rows — and neither does moving the
      // cursor, since a row renders the same whether or not it is hovered.
      itemToView: (row: ThreadRow, index: number) =>
        lazyThreadRow(row.id, threadRowView, [
          row,
          index,
          avatarUrlFor(row.senderEmail),
        ]),
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
        model.avatarVersion,
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
  // The tab narrowing happens here, at the last moment before the list, so
  // everything above (error rows, the AsyncData states) sees the folder's
  // full rows.
  Arr.match(visibleRows(model, rows), {
    onEmpty: () =>
      statusRowView(
        // NOTE: A cold store while the machine is still filling it isn't
        // empty, it's early. The first primed rows land within a second or two.
        isSyncFilling(model.sync) ? "Syncing your mail…" : "Nothing here.",
      ),
    onNonEmpty: (visible) => virtualListView(model, visible),
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

  return h.div([h.Class("flex min-h-0 flex-1 flex-col")], body);
};

// THREAD DETAIL
//
// NOTE: Html bodies render in a shadow root (ui/mailBody.ts), which scopes
// the mail's css both ways. The body reaching here has already been
// sanitized on load (sanitizeBody.ts) — it is not sanitized in the view,
// because a view runs on every render and this must happen exactly once.
// Plain bodies skip all of it.

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

  // A markdown body is our own rendering — the sender's stylesheet was
  // discarded on the way through — so it sits directly on the app's surface
  // and follows the theme, like the plain branch above. Only the sender's own
  // html gets the white card, because its colours were written for white and
  // there is no reading them back out.
  const isMarkdown = message.bodyKind === "markdown";

  // The shadow host lays out with the page and is therefore already the
  // height of its content, so the detail pane is the only thing that scrolls.
  return mailBody(
    [
      mailBody.Body(message.body),
      mailBody.Surface(isMarkdown ? "app" : "paper"),
      h.Class(
        isMarkdown
          ? "mt-3 block w-full"
          : "mt-3 block w-full overflow-hidden rounded-lg bg-white",
      ),
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
          senderTile(
            (message.fromName.slice(0, 1) || "?").toUpperCase(),
            avatarUrlFor(message.fromEmail),
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
      messageBodyView(message),
    ],
  );
};

// Keyed by thread id rather than a single slot: reopening a thread you had
// open before should not have to rebuild its iframes, and srcdocFor rebuilds
// the whole body string every time it runs.
// Far smaller than the row cap, because each entry is far larger: a thread's
// whole rendered body, iframes and all. A handful covers going back and forth
// between the threads you are actually reading.
const DETAIL_MEMO_CAPACITY = 10;

const lazyThreadDetail = createCappedKeyedLazy(DETAIL_MEMO_CAPACITY);

const SENDING_CHIP_CLASS =
  "flex shrink-0 items-center gap-1.5 rounded-lg bg-hover px-2 py-1 text-[12px] text-muted-foreground";

const threadDetailView = (
  detail: ThreadDetail,
  isStarred: boolean,
  isSending: boolean,
  _avatarVersion: number,
): Html => {
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
          // A reply is queued, not in flight — it will go out whether or not
          // this thread stays open, so the chip says "queued to send" rather
          // than pretending to be a progress indicator.
          ...(isSending
            ? [
                h.span(
                  [h.Class(SENDING_CHIP_CLASS), h.Role("status")],
                  [Icon.send("h-3.5 w-3.5"), "Sending…"],
                ),
              ]
            : []),
          h.div(
            [h.Class("flex shrink-0 items-center gap-1")],
            [
              rowActionView(
                isStarred ? "Unstar" : "Star",
                Icon.star,
                isStarred ? "fill-amber-400 text-amber-400" : "",
                ClickedStarRow({ id: detail.id }),
              ),
              rowActionView(
                "Archive",
                Icon.archive,
                "",
                ClickedArchiveRow({ id: detail.id }),
              ),
              Ui.button(
                { variant: "tertiary", size: "sm", onClick: ClickedReply() },
                [Icon.reply("h-4 w-4"), "Reply"],
              ),
            ],
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

// COMPOSE
//
// Bodies are markdown. The Write/Preview toggle renders through the exact
// function that produces the sent HTML (markdown.ts), so the preview cannot
// promise something the message does not deliver.

// NOTE: outline-none is replaced by an explicit focus ring rather than left
// bare. The palette's input can drop the outline because its dialog traps
// focus and it is the only focusable thing on screen; this panel has five
// focusable controls and no trap, so without this a keyboard user tabbing
// through it sees only the caret move.
const FIELD_CLASS =
  "w-full rounded-md bg-transparent px-1 py-0.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-focus-ring";

const composeFieldView = (
  label: string,
  field: ComposeField,
  value: string,
  placeholder: string,
): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("flex items-center gap-3 border-b border-border px-4 py-2.5")],
    [
      h.label(
        [
          h.For(composeFieldId(field)),
          h.Class("w-16 shrink-0 text-[12px] text-muted-foreground"),
        ],
        [label],
      ),
      // NOTE: A raw input rather than a Ui component: this app's local
      // FoldkitUI port (ui/index.ts) has no Input yet. The a11y surface an
      // Input would provide is written out here instead — a real label bound
      // by For/Id, and a focus ring in FIELD_CLASS.
      h.input([
        h.Id(composeFieldId(field)),
        h.Type("text"),
        h.Value(value),
        h.Placeholder(placeholder),
        h.Autocomplete("off"),
        h.Class(FIELD_CLASS),
        h.OnInput((value) => EditedCompose({ field, value })),
      ]),
    ],
  );
};

const composeBodyView = (compose: typeof ComposeEditing.Type): Html => {
  const h = html<Message>();

  if (compose.isPreviewing) {
    // The same treatment the thread view gives a received message: this is
    // email HTML and it is rendered under the same rules whether we wrote it
    // or someone sent it to us. `prepareBody` is a no-op on safety here —
    // markdown.ts escapes any tags the author typed — but it is what puts
    // `target="_blank"` on the links, and one path is easier to trust than
    // two.
    //
    // NOTE: The scroll container is the wrapper, not the body element. This
    // panel is `absolute inset-0` over the pane, so it has a fixed footprint
    // and a long preview has to scroll somewhere; letting the self-sizing
    // host grow instead would push the send controls off the bottom.
    return h.div(
      [h.Class("min-h-0 w-full flex-1 overflow-auto rounded-lg bg-white")],
      [
        mailBody(
          [
            mailBody.Body(
              prepareBody(renderMarkdownToEmailHtml(compose.body), EMPTY_URLS),
            ),
            // Light in both themes, on purpose: this previews what lands in
            // someone else's inbox, and that html carries the light colours
            // inlined because email clients strip stylesheets. Theming the
            // preview would show you something the recipient never sees.
            mailBody.Surface("paper"),
            h.Class("block w-full"),
          ],
          [],
        ),
      ],
    );
  }

  return h.textarea(
    [
      h.Id(composeFieldId("body")),
      h.Value(compose.body),
      h.Placeholder("Write your message… **markdown** works."),
      h.AriaLabel("Message body"),
      h.Class(`min-h-0 flex-1 resize-none leading-relaxed ${FIELD_CLASS}`),
      h.OnInput((value) => EditedCompose({ field: "body", value })),
    ],
    [],
  );
};

const composePanelView = (compose: typeof ComposeEditing.Type): Html => {
  const h = html<Message>();
  const isReply = Option.isSome(compose.maybeReply);

  return h.div(
    [
      h.Class(
        `absolute inset-0 z-20 flex min-h-0 flex-col rounded-xl border border-border ${Ui.surface(
          Ui.elevate(PAGE_SURFACE, 2),
          2,
        )}`,
      ),
      h.Role("dialog"),
      h.AriaModal(true),
      h.AriaLabel(isReply ? "Reply" : "New message"),
    ],
    [
      h.div(
        [
          h.Class(
            "flex items-center justify-between gap-3 border-b border-border px-4 py-2.5",
          ),
        ],
        [
          h.span(
            [h.Class("text-[13px] font-semibold text-foreground")],
            [isReply ? "Reply" : "New message"],
          ),
          h.div(
            [h.Class("flex items-center gap-1")],
            [
              rowActionView(
                compose.isPreviewing ? "Write" : "Preview",
                compose.isPreviewing ? Icon.squarePen : Icon.eye,
                "",
                ToggledComposePreview(),
              ),
              rowActionView("Discard", Icon.x, "", ClosedCompose()),
            ],
          ),
        ],
      ),
      composeFieldView("To", "to", compose.to, "name@example.com"),
      composeFieldView("Subject", "subject", compose.subject, "Subject"),
      h.div(
        [h.Class("flex min-h-0 flex-1 flex-col px-4 py-3")],
        [composeBodyView(compose)],
      ),
      h.div(
        [
          h.Class(
            "flex items-center justify-between gap-3 border-t border-border px-4 py-2.5",
          ),
        ],
        [
          h.span(
            [h.Class("text-[12px] text-muted-foreground")],
            ["Queued locally, sent when Gmail is reachable."],
          ),
          Ui.button(
            {
              variant: "primary",
              size: "md",
              onClick: ClickedSend(),
              isDisabled: !isSendable(compose),
            },
            [Icon.send("h-4 w-4"), "Send"],
          ),
        ],
      ),
    ],
  );
};

const lazyCompose = createLazy();
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
      // A blank query has no results by design (results follow typing), and
      // "No results" would read as a verdict on a search never made.
      emptyLabel: Option.getOrElse(maybeSearchError, () =>
        palette.query.trim() === "" ? "Type to search your mail" : "No results",
      ),
      substrate: PAGE_SURFACE,
    },
    toParentMessage: (message) => GotPaletteMessage({ message }),
  });
};

// Whether something is painted over the list: an open thread, or a compose
// panel. Either way the list is decorative until it comes back.
const isListCovered = (model: Model): boolean =>
  model.screen._tag === "ShowingThread" ||
  model.compose._tag === "ComposeEditing";

// The star lives on the list row, which is where it is stored; the open
// thread reads it from there rather than keeping a second copy that could
// disagree with the list behind it.
const isThreadStarred = (model: Model, id: ThreadId): boolean =>
  Option.match(
    Option.flatMap(AsyncData.getData(model.threads), (rows) =>
      Arr.findFirst(rows, (row) => row.id === id),
    ),
    { onNone: () => false, onSome: (row) => row.isStarred },
  );

// A permanently failed action, said once and dismissible. Not attached to the
// row it concerned: by the time this shows, that row has already been rolled
// back to the truth, and pinning an error to a row that now looks correct
// reads as a bug in the row rather than an explanation of it.
const outboxErrorView = (error: string): Html => {
  const h = html<Message>();
  return h.div(
    [
      h.Class(
        `pointer-events-auto absolute bottom-4 left-1/2 z-30 flex max-w-md -translate-x-1/2 items-start gap-3 rounded-xl border border-border px-4 py-3 text-[13px] ${Ui.surface(
          Ui.elevate(PAGE_SURFACE, 3),
          3,
        )}`,
      ),
      h.Role("alert"),
    ],
    [
      Ui.badgeDot({ color: "red" }),
      h.span([h.Class("min-w-0 flex-1 text-foreground")], [error]),
      h.button(
        [
          h.Type("button"),
          h.OnClick(ClosedOutboxError()),
          h.AriaLabel("Dismiss"),
          h.Class(
            `shrink-0 cursor-pointer text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
          ),
        ],
        [Icon.x("h-4 w-4")],
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
                //
                // NOTE: `inert` alongside, not aria-hidden alone. The rows
                // now contain real buttons (the star/read/archive actions),
                // and aria-hidden over focusable content is a spec violation
                // that leaves those buttons tabbable but unannounced.
                h.AriaHidden(isListCovered(model)),
                ...(isListCovered(model) ? [h.Inert(true)] : []),
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
                    [
                      lazyThreadDetail(detail.id, threadDetailView, [
                        detail,
                        // The star lives on the list row, which is the one
                        // place it is stored; the open thread reads it from
                        // there rather than keeping a second copy.
                        isThreadStarred(model, detail.id),
                        model.sendingThreads.includes(detail.id),
                        // Cache-busting only, as in the list: sender images
                        // resolve out of a registry this view cannot observe.
                        model.avatarVersion,
                      ]),
                    ],
                  ),
                ],
              }),
            ),
            // Above the open thread: replying to one and then discarding
            // should leave the thread exactly as it was.
            ...M.value(model.compose).pipe(
              M.withReturnType<ReadonlyArray<Html>>(),
              M.tagsExhaustive({
                ComposeClosed: () => [],
                ComposeEditing: (compose) => [
                  lazyCompose(composePanelView, [compose]),
                ],
              }),
            ),
          ],
        ),
        ...Arr.fromOption(Option.map(model.maybeOutboxError, outboxErrorView)),
        lazyPalette(paletteView, [
          model.palette,
          model.searchResults,
          model.maybeSearchError,
        ]),
      ],
    );
  },
);
