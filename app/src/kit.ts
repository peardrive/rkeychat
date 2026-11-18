/**
 * The one place the app imports PearKit from. While a component is still being added to PearKit
 * (feat/chat-shell) its stand-in lives under ./pending-pearkit with the same props and is exported from here,
 * so swapping it for the real one is a one-line change in this file.
 *
 * 2026-11-18: Chat (MessageList, Composer), Menu, Toast, DropZone, Toggle, SegmentedControl and MarkdownText
 * landed in the worktree and are used from PearKit directly. Still stand-ins: the two-line sidebar rows.
 */
export {
  AppWindow,
  Avatar,
  Button,
  Card,
  Chip,
  Composer,
  CountBadge,
  Dialog,
  Divider,
  DropZone,
  EmptyState,
  Icon,
  IconButton,
  Kbd,
  MarkdownText,
  Menu,
  MenuButton,
  MessageList,
  Pane,
  PaneBody,
  PaneHeader,
  SearchField,
  SectionLabel,
  SegmentedControl,
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
  ToastProvider,
  Toggle,
  Tooltip,
  WindowControls,
  cn,
  copyToClipboard,
  messageTime,
  useSidebar,
  useTheme,
  useToast,
  withAlpha,
} from 'pearkit';
export type { ChatAttachment, ChatMessage, ColorToken, DroppedItem, IconName, IconSource, MenuItem, PaneHeaderAction, StatusTone, ToastOptions } from 'pearkit';

// Pending in PearKit: sidebar rows with two lines (a group head with avatar + subtitle; a thread with a snippet).
export { SidebarGroupRow, SidebarThreadItem } from './pending-pearkit/SidebarRows';
