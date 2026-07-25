// The inbox page's view. Pure rendering over the Model in model.ts; every
// interaction is a Message from there. Nothing in here reaches for a
// Command or the update logic.

import { Match as M, Option } from "effect";
import { AsyncData, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";

import * as Icon from "../../icons";
import { ThreadDetail, ThreadRow, type MessageDetail } from "../../sync";
import * as SyncMachine from "../../syncMachine";
import * as Ui from "../../ui";

import {
  GotSyncMessage,
  AVATAR_BG,
  AVATAR_FG,
  Appearance,
  BODY_FRAME_HEIGHT,
  CATEGORIES,
  CATEGORY_FROM_THREAD,
  type Category,
  ClickedAppearance,
  ClickedBack,
  ClickedSignOut,
  EnteredList,
  FOLDERS,
  FOLDER_LABELS,
  FolderMenu,
  GotAccountPopoverMessage,
  GotFolderMenuMessage,
  GotListMessage,
  GotPaletteMessage,
  GotTabsMessage,
  HoveredRow,
  InboxPalette,
  LIST_ID,
  LIST_OVERSCAN,
  LeftList,
  Message,
  Model,
  OpenedPalette,
  OpenedRow,
  PAGE_SURFACE,
  ROW_HEIGHT,
  TAB_LABELS,
  formatTime,
  tabSpec,
  threadItemSpec,
} from "./model";

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
      // The one pill that is a control: the machine parks here and cannot
      // leave on its own, so without a click there is no way back short of
      // reloading the page.
      NeedsAuth: () =>
        h.button(
          [
            h.Type("button"),
            h.OnClick(
              GotSyncMessage({ message: SyncMachine.RetriedAuth() }),
            ),
            h.Class(
              `flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-lg bg-hover px-2.5 text-[12px] text-muted-foreground outline-none hover:bg-active hover:text-foreground focus-visible:ring-1 focus-visible:ring-focus-ring ${Ui.hoverTransition}`,
            ),
          ],
          [Ui.badgeDot({ color: "red" }), "Reconnect Gmail"],
        ),
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
const threadRowView = (row: ThreadRow, index: number): Html => {
  const h = html<Message>();
  const tone = row.unread ? "text-foreground" : "text-muted-foreground";

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
          senderTile((row.sender.slice(0, 1) || "?").toUpperCase()),
          h.span([h.Class(`truncate font-semibold ${tone}`)], [row.sender]),
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
            threadRowView(row, index),
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

// Renders whatever the Search service last ranked, in that order — the
// palette does no matching of its own.
const paletteView = (model: Model): Html => {
  const h = html<Message>();
  const specs = new Map(
    model.searchResults.map((row) => [row.id as string, threadItemSpec(row)]),
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
          items: model.searchResults.map((row) => row.id as string),
        },
      ],
      itemSpec: (item: string) => specs.get(item) ?? { label: item },
      placeholder: "Search your mail…",
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
