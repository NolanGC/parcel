import { Effect, Match as M, Option, Schema as S } from "effect";
import { Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { evo } from "foldkit/struct";

import * as Icon from "../icons";
import * as Ui from "../ui";

// The inbox UI sketch, built on FoldkitUI (the Fluid Functionalism port).
// Colors come from the surface ladder + overlay tokens in styles.css, motion
// from the spring tiers in ui/motion.ts — no view here names a raw color or
// duration. The emails are static data; the folder dropdown and the settings
// menu (appearance switcher) carry real interaction.

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

/** Scalar ID for an email row; also serves as the row's list key. */
const EmailId = S.String.pipe(S.brand("EmailId"));
type EmailId = typeof EmailId.Type;

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
  id: EmailId;
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

type Section = {
  label: string;
  emails: ReadonlyArray<Email>;
};

const SECTIONS: ReadonlyArray<Section> = [
  {
    label: "Today",
    emails: [
      {
        id: EmailId.make("1"),
        sender: "Solomon, Tony & Sade",
        groupCount: 13,
        avatar: { kind: "image", src: "/avatars/lego-green.png" },
        isRead: true,
        subject: "Re: Progress",
        preview:
          "I pushed the new update to git and we haven't finished the proposal for the funding we discussed ove...",
        category: "todo",
        time: "22:13",
      },
      {
        id: EmailId.make("2"),
        sender: "Apple",
        avatar: {
          kind: "tile",
          bg: HexColor.make("#000000"),
          fg: HexColor.make("#ffffff"),
          label: "apple",
        },
        isRead: true,
        subject: "Think different",
        preview:
          "Here's to the crazy ones. The misfits, the rebels, the troublemakers, the round pegs in the...",
        category: "newsletter",
        time: "21:27",
        attachment: true,
      },
      {
        id: EmailId.make("3"),
        sender: "Cal.com",
        avatar: {
          kind: "tile",
          bg: HexColor.make("#111111"),
          fg: HexColor.make("#ffffff"),
          label: "cal.com",
        },
        isRead: true,
        subject: "Reminder: quick chat - Tue, Jan 21, 2025 1:00pm",
        preview: "Hi Sanya Koyi, This is a reminder about your upcoming event.",
        category: "reminder",
        time: "18:19",
      },
      {
        id: EmailId.make("4"),
        sender: "mymind",
        avatar: { kind: "image", src: "/avatars/mymind.png" },
        unread: true,
        subjectIcon: "cloud",
        subject: "On art, Perspective & beautiful chairs",
        preview:
          "Hi Adesanya, this our weekly inspiration email, where we share a fe...",
        category: "promotions",
        time: "12:13",
      },
      {
        id: EmailId.make("5"),
        sender: "Tony Allen",
        avatar: { kind: "image", src: "/avatars/lego-red.png" },
        unread: true,
        subject: "Expenses Overview",
        preview:
          "You are to complete your contribution before we leave camp for the vacation and see if Helen i...",
        category: "todo",
        time: "22:13",
      },
      {
        id: EmailId.make("6"),
        sender: "Craft Docs",
        avatar: {
          kind: "tile",
          bg: HexColor.make("#f4f4f5"),
          fg: HexColor.make("#2563eb"),
          label: "C",
          rounded: true,
        },
        unread: true,
        subject: "Your tasks for today, Jan 21",
        preview:
          "Active tasks Create a roadmap for next version of web app Jan 8 Inbox See all Task...",
        category: "reminder",
        time: "12:13",
      },
    ],
  },
  {
    label: "Yesterday",
    emails: [
      {
        id: EmailId.make("7"),
        sender: "Steve Jobs",
        avatar: { kind: "image", src: "/avatars/steve-jobs.png" },
        unread: true,
        subject: "Don't be a Career",
        preview:
          "The enemy of most dreams and intuitions, and one of the most dangerous and stifling concepts...",
        category: "primary",
        time: "13:34",
      },
      {
        id: EmailId.make("8"),
        sender: "The New York Times",
        avatar: {
          kind: "tile",
          bg: HexColor.make("#ffffff"),
          fg: HexColor.make("#000000"),
          label: "T",
          serif: true,
        },
        subject: "Final hours: Best offer must end. $0.25 a week.",
        preview:
          "The New York Times. The Times sales ends in hours in hours b...",
        category: "newsletter",
        time: "13:34",
      },
      {
        id: EmailId.make("9"),
        sender: "Pinterest",
        avatar: {
          kind: "tile",
          bg: HexColor.make("#e60023"),
          fg: HexColor.make("#ffffff"),
          label: "P",
          rounded: true,
        },
        unread: true,
        subject: "Web and App Design for Adehsanya",
        preview:
          "Cloud storage desktop widget...| www... Design images images | www... l...",
        category: "promotions",
        time: "13:34",
      },
    ],
  },
  {
    label: "This week",
    emails: [
      {
        id: EmailId.make("10"),
        sender: "Tony, Jacob & Sade",
        groupCount: 23,
        avatar: { kind: "image", src: "/avatars/lego-red.png" },
        unread: true,
        subject: "Re: Status",
        preview:
          "Everything is in order now, we are set to go! Welldone guys, hopefully we get to meet at the office befor...",
        category: "todo",
        time: "1/13/25",
      },
      {
        id: EmailId.make("11"),
        sender: "The New York Times",
        avatar: {
          kind: "tile",
          bg: HexColor.make("#ffffff"),
          fg: HexColor.make("#000000"),
          label: "T",
          serif: true,
        },
        subject: "Final hours: Best offer must end. $0.25 a week.",
        preview:
          "The New York Times. The Times sales ends in hours in hours b...",
        category: "newsletter",
        time: "1/13/25",
      },
      {
        id: EmailId.make("12"),
        sender: "Product Hunt Weekly",
        avatar: { kind: "image", src: "/avatars/product-hunt.png" },
        subject: "Never context-switch again",
        preview:
          "Plus, see your Saas through the eyes of a VC Product Hunt Sunday, Jan 19 The Ro...",
        category: "newsletter",
        time: "1/11/25",
      },
      {
        id: EmailId.make("13"),
        sender: "Tony",
        avatar: { kind: "image", src: "/avatars/tony.png" },
        unread: true,
        subject: "Offer letter: Acme Design Team",
        preview:
          "We are pleased to offer you the position of [Job Title] at [Company Name]. Followi...",
        category: "todo",
        time: "1/9/25",
      },
      {
        id: EmailId.make("14"),
        sender: "Sade Helen",
        avatar: { kind: "image", src: "/avatars/sade.png" },
        unread: true,
        subject: "Re: Status",
        preview:
          "I hope this email finds you well. I'd like to schedule a team planning meeting for next Wednesday, Januar...",
        category: "todo",
        time: "1/8/25",
      },
      {
        id: EmailId.make("15"),
        sender: "Vlad, Ava, Lola and 5 Others",
        avatar: { kind: "image", src: "/avatars/vlad.png" },
        subject: "Red Cross Camp Preparation",
        preview:
          "I checked the website, I am afraid we are preparing for the wrong batch. I atta...",
        category: "vacation",
        time: "1/6/25",
        attachment: true,
      },
      {
        id: EmailId.make("16"),
        sender: "Lego Man",
        avatar: { kind: "image", src: "/avatars/lego-red.png" },
        unread: true,
        subject: "Status Confirmation",
        preview:
          "The collectible will be available on Opensea by 12 tommorow (WAT). Download any wallet fro...",
        category: "other",
        time: "1/6/25",
      },
    ],
  },
];

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

// Emails enter the palette as "sender — subject" strings; the map recovers
// the spec (and would recover the id, once opening an email is real).
// Image avatars carry over as the leading slot; tile avatars fall back to
// the mail icon. The category rides as the trailing tag chip.
const EMAIL_SPECS = new Map<string, Ui.Palette.PaletteItemSpec>(
  SECTIONS.flatMap((section) =>
    section.emails.map((email) => [
      `${email.sender} — ${email.subject}`,
      {
        ...(email.avatar.kind === "image"
          ? { avatarSrc: email.avatar.src }
          : { icon: Icon.inbox }),
        label: `${email.sender} — ${email.subject}`,
        tag: {
          icon: CATEGORIES[email.category].icon,
          label: CATEGORIES[email.category].label,
        },
        keywords: email.preview,
      } satisfies Ui.Palette.PaletteItemSpec,
    ]),
  ),
);

const PALETTE_GROUPS: ReadonlyArray<Ui.Palette.Group<string>> = [
  { label: "Actions", items: PALETTE_ACTIONS },
  { label: "Folders", items: FOLDER_LABELS },
  { label: "Emails", items: [...EMAIL_SPECS.keys()] },
];

const paletteItemSpec = (item: string): Ui.Palette.PaletteItemSpec =>
  ACTION_SPECS[item] ??
  (item in FOLDERS
    ? { icon: FOLDERS[item as FolderLabel].icon, label: item }
    : (EMAIL_SPECS.get(item) ?? { label: item }));

const InboxPalette = Ui.Palette.create<string>();

// MODEL

export const Model = S.Struct({
  appearance: Appearance,
  folderMenu: Ui.Menu.Model,
  tabs: Ui.Tabs.Model,
  list: Ui.Table.Model,
  palette: Ui.Palette.Model,
  accountPopover: Ui.Popover.Model,
});
export type Model = typeof Model.Type;

export const init = (): Model => ({
  appearance: "System",
  folderMenu: Ui.Menu.init({ id: "inbox-folders", isAnimated: true }),
  tabs: Ui.Tabs.init({ id: "inbox-tabs" }),
  list: Ui.Table.init({ id: "inbox-list" }),
  palette: Ui.Palette.init({ id: "inbox-palette" }),
  accountPopover: Ui.Popover.init({ id: "inbox-account", isAnimated: true }),
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

export const Message = S.Union([
  GotFolderMenuMessage,
  CompletedApplyAppearance,
  GotTabsMessage,
  GotListMessage,
  OpenedPalette,
  GotPaletteMessage,
  GotAccountPopoverMessage,
  ClickedSignOut,
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

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message>>];

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
        return [
          evo(model, { list: () => list }),
          Command.mapMessages(commands, (message) =>
            GotListMessage({ message }),
          ),
        ];
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
        "flex cursor-default items-center gap-4 border-b border-border px-4 py-3",
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

// The whole list — headers interleaved with rows — is one Table, so the
// hover overlay travels across section boundaries too.
const listChildren: ReadonlyArray<Ui.Table.TableChild> = SECTIONS.flatMap(
  (section) => [
    {
      kind: "static" as const,
      key: `header-${section.label}`,
      content: sectionHeaderView(section.label),
    },
    ...section.emails.map((email) => ({
      kind: "row" as const,
      key: email.id,
      content: emailRowView(email),
    })),
  ],
);

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
          [h.Class("flex-1 overflow-y-auto pb-24")],
          [
            h.div(
              [h.Class("mx-auto w-full max-w-7xl px-6")],
              [
                h.submodel({
                  slotId: "inbox-list",
                  model: model.list,
                  view: Ui.Table.view,
                  viewInputs: { children: listChildren },
                  toParentMessage: (message) => GotListMessage({ message }),
                }),
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
