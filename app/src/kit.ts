/**
 * The one place the app imports PearKit from. While a component is still being added to PearKit
 * (feat/chat-shell) its stand-in lives under ./pending-pearkit with the same props and is exported from here,
 * so swapping it for the real one is a one-line change in this file.
 *
 * 2026-11-19: everything from rounds 1 and 2 (Chat, Menu, Toast, DropZone, Toggle, SegmentedControl, MarkdownText,
 * ActivityFeed, GlassBar, EmojiPicker, ProfileCard, SettingsBlock) is used from PearKit directly.
 * Still stand-ins: the two-line sidebar rows and the file rows.
 */
export {
  ActivityFeed,
  AppWindow,
  Avatar,
  Button,
  Card,
  Chip,
  Composer,
  CountBadge,
  DangerZone,
  DebugNotesButton,
  Dialog,
  Divider,
  DropZone,
  EmojiBar,
  EmojiPicker,
  EmptyState,
  GlassBar,
  GlassBarButton,
  Icon,
  IconButton,
  Kbd,
  LinkField,
  MarkdownText,
  Menu,
  MenuButton,
  MessageList,
  MessageRow,
  Pane,
  PaneBody,
  PaneHeader,
  ProfileCard,
  SearchField,
  SectionLabel,
  SegmentedControl,
  SettingsBlock,
  SettingsRow,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarItem,
  SidebarSection,
  SidebarSpacer,
  SidebarToggle,
  StatusDot,
  Text,
  TextField,
  ThemeProvider,
  Thumbnail,
  ToastProvider,
  Toggle,
  Tooltip,
  WindowControls,
  cn,
  copyToClipboard,
  DEFAULT_QUICK_EMOJI,
  fileKindFromName,
  formatBytes,
  messageTime,
  placeOf,
  quotedMessages,
  useSidebar,
  useTheme,
  useToast,
  withAlpha,
} from 'pearkit';
export type { ActivityItem, ActivityKind, ChatAttachment, ChatMessage, ColorToken, DroppedItem, IconName, IconSource, MenuItem, PaneHeaderAction, ProfileSection, StatusTone, ToastOptions } from 'pearkit';

// Pending in PearKit (being written): the dock, organization tabs, home blocks.
export { Dock, DockButton } from './pending-pearkit/Dock';
export type { DockItem } from './pending-pearkit/Dock';
export { OrgTabs } from './pending-pearkit/OrgTabs';
export type { OrgTabItem } from './pending-pearkit/OrgTabs';
export { HomeBlock, HomeGrid, PresenceRow } from './pending-pearkit/HomeBlocks';
export type { PresencePerson } from './pending-pearkit/HomeBlocks';

// Pending in PearKit: the file rows of a project (projects-home-and-sync.md §3).
export { FileList, FileRow } from './pending-pearkit/FileList';
export type { FileState } from './pending-pearkit/FileList';

// Pending in PearKit: sidebar rows with two lines (a group head with avatar + subtitle; a thread with a snippet).
export { SidebarGroupRow, SidebarThreadItem } from './pending-pearkit/SidebarRows';
