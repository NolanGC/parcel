import * as Hugeicons from "@hugeicons/core-free-icons";
import { icon, type IconNode } from "./ui/icon";

// The app's icon set: HugeIcons stroke-rounded geometry (the free package
// ships every icon as pure data) rendered through Ui.icon. Each export takes
// sizing classes and an optional stroke width — FF's convention is 1.5
// resting, 2 active/checked, which is also the weight this set is drawn at.
//
// Local names stay descriptive rather than mirroring HugeIcons' numbered
// exports (`Mail01Icon`, `Notification01Icon`): call sites read `Icon.mail`
// and `Icon.bell`, and the numbering is a detail of that catalogue rather
// than something the inbox should carry.
//
// The package's own types describe the React component surface, not the raw
// data, so the cast is at this one boundary instead of at every export.
const from = (node: unknown) => icon(node as IconNode);

export const inbox = from(Hugeicons.InboxIcon);
export const mail = from(Hugeicons.Mail01Icon);
export const mailOpen = from(Hugeicons.MailOpen01Icon);
export const arrowLeft = from(Hugeicons.ArrowLeft01Icon);
export const chevronsUpDown = from(Hugeicons.UnfoldMoreIcon);
export const circleCheck = from(Hugeicons.CheckmarkCircle01Icon);
export const bell = from(Hugeicons.Notification01Icon);
export const tag = from(Hugeicons.Tag01Icon);
export const leaf = from(Hugeicons.Leaf01Icon);
export const ellipsis = from(Hugeicons.MoreHorizontalIcon);
export const plus = from(Hugeicons.PlusSignIcon);
export const listFilter = from(Hugeicons.FilterIcon);
export const squarePen = from(Hugeicons.PencilEdit01Icon);
export const send = from(Hugeicons.SentIcon);
export const clock = from(Hugeicons.Clock01Icon);
export const feather = from(Hugeicons.QuillWrite01Icon);
export const shieldAlert = from(Hugeicons.Shield01Icon);
export const archive = from(Hugeicons.Archive01Icon);
export const check = from(Hugeicons.Tick01Icon);
export const command = from(Hugeicons.CommandIcon);
export const search = from(Hugeicons.Search01Icon);
export const panelLeft = from(Hugeicons.SidebarLeft01Icon);
export const settings = from(Hugeicons.Settings01Icon);
export const cloud = from(Hugeicons.CloudIcon);
export const paperclip = from(Hugeicons.Attachment01Icon);
export const monitor = from(Hugeicons.ComputerIcon);
export const sun = from(Hugeicons.Sun01Icon);
export const moon = from(Hugeicons.Moon01Icon);
export const hand = from(Hugeicons.HandPointingRight01Icon);
export const circleUser = from(Hugeicons.UserCircleIcon);
export const logOut = from(Hugeicons.Logout01Icon);
export const palmtree = from(Hugeicons.TreeIcon);
export const star = from(Hugeicons.StarIcon);
export const reply = from(Hugeicons.ArrowTurnBackwardIcon);
export const x = from(Hugeicons.Cancel01Icon);
export const eye = from(Hugeicons.ViewIcon);
