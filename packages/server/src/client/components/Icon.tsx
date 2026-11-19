import "./Icon.css";
import {
  AlertIcon,
  ArrowUpIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  ClockIcon,
  CloudIcon,
  CommentIcon,
  CopyIcon,
  DeviceDesktopIcon,
  DotFillIcon,
  FileCodeIcon,
  GearIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  HistoryIcon,
  InfoIcon,
  LinkExternalIcon,
  PlugIcon,
  PlusIcon,
  RepoIcon,
  ShieldCheckIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  SyncIcon,
  ToolsIcon,
  TrashIcon,
  XCircleIcon,
  XIcon,
} from "@primer/octicons-react";

// The icons of the inventory (design/components.md, Foundations): GitHub's Octicons, 16px, in the current color.
const GLYPHS = {
  "git-pull-request": GitPullRequestIcon,
  "git-merge": GitMergeIcon,
  "git-pull-request-closed": GitPullRequestClosedIcon,
  clock: ClockIcon,
  "x-circle": XCircleIcon,
  "check-circle": CheckCircleIcon,
  alert: AlertIcon,
  "circle-slash": CircleSlashIcon,
  "device-desktop": DeviceDesktopIcon,
  cloud: CloudIcon,
  plug: PlugIcon,
  sync: SyncIcon,
  "link-external": LinkExternalIcon,
  copy: CopyIcon,
  check: CheckIcon,
  x: XIcon,
  "chevron-down": ChevronDownIcon,
  "chevron-left": ChevronLeftIcon,
  "chevron-right": ChevronRightIcon,
  info: InfoIcon,
  history: HistoryIcon,
  comment: CommentIcon,
  plus: PlusIcon,
  trash: TrashIcon,
  "arrow-up": ArrowUpIcon,
  tools: ToolsIcon,
  repo: RepoIcon,
  "dot-fill": DotFillIcon,
  "shield-check": ShieldCheckIcon,
  "file-code": FileCodeIcon,
  gear: GearIcon,
  "sidebar-collapse": SidebarCollapseIcon,
  "sidebar-expand": SidebarExpandIcon,
} as const;

export type IconName = keyof typeof GLYPHS;

export const ICON_NAMES = Object.keys(GLYPHS).filter((name): name is IconName => name in GLYPHS);

// Decorative unless it has a label: the text next to an icon says what it means.
export function Icon({ name, label }: { name: IconName; label?: string }) {
  const Glyph = GLYPHS[name];
  return <Glyph data-component="Icon" data-name={name} {...(label === undefined ? {} : { "aria-label": label })} />;
}
