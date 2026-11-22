/**
 * Two sidebar rows PearKit's `SidebarItem` cannot draw yet (it has one line and an icon):
 *  - `SidebarGroupRow`: a collapsible group head with an avatar, a title, a subtitle and a trailing badge
 *    (a project with its folder name);
 *  - `SidebarThreadItem`: a two-line row: title + time on the first line, a snippet and a badge on the second
 *    (a conversation), with a pulsing dot when something is happening in it.
 * Candidates for PearKit; written with PearKit primitives only.
 */
import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Avatar, CountBadge, Icon, StatusDot, Text, Tooltip, cn, useSidebar, type StatusTone } from 'pearkit';

/** Touch-first device: rows grow to 44px targets. */
const touch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

export interface SidebarGroupRowProps {
  seed: string;
  title: string;
  subtitle?: string;
  unread?: number;
  selected?: boolean;
  /** Expanded? Without `onToggle` the row has nothing to expand: no chevron (a project still being made). */
  open?: boolean;
  onToggle?: () => void;
  onPress?: () => void;
  /** A long press (or a right click) on the row: the project's actions. */
  onLongPress?: () => void;
  /** A live dot on the avatar (a seat is thinking somewhere in the group). */
  live?: boolean;
  trailing?: React.ReactNode;
}

export function SidebarGroupRow({ seed, title, subtitle, unread = 0, selected, open = false, onToggle, onPress, onLongPress, live, trailing }: SidebarGroupRowProps) {
  const { collapsed } = useSidebar();
  const avatar = (
    <View className="relative">
      <Avatar seed={seed} size={collapsed ? 28 : 24} label={title} />
      {live ? (
        <View className="absolute -bottom-px -right-px rounded-full bg-sidebar p-px">
          <StatusDot tone="primary" size={7} pulse />
        </View>
      ) : null}
    </View>
  );
  if (collapsed) {
    return (
      <Tooltip label={title} shortcut={unread ? String(unread) : undefined} placement="right" offset={10}>
        <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress ?? onToggle} className={cn('h-[34px] w-[34px] items-center justify-center rounded-md', selected ? 'bg-selected' : 'hover:bg-overlay/5')}>
          {avatar}
          {unread ? (
            <View className="absolute right-0.5 top-0.5">
              <StatusDot tone="warning" size={6} />
            </View>
          ) : null}
        </Pressable>
      </Tooltip>
    );
  }
  // Two buttons side by side (never nested): the row selects or expands, the chevron only toggles.
  return (
    <View {...({ dataSet: { project: title } } as object)} className={cn('app-region-no-drag w-full flex-row items-center rounded-md pr-1.5', selected ? 'bg-selected' : 'hover:bg-overlay/5')}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open, selected: !!selected }}
        onPress={onPress ?? onToggle}
        onLongPress={onLongPress}
        delayLongPress={350}
        className={cn('min-w-0 flex-1 flex-row items-center gap-2.5 pl-2 pr-1', touch ? 'py-2.5' : 'py-1.5', Platform.OS === 'web' && 'cursor-pointer select-none')}
        {...(onLongPress && Platform.OS === 'web' ? ({ onContextMenu: (e: { preventDefault: () => void }) => { e.preventDefault(); onLongPress(); } } as object) : {})}
      >
        {avatar}
        <View className="min-w-0 flex-1">
          <Text variant="body-lg" numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" tone="subtle" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {unread ? <CountBadge value={unread} tone="warning" /> : null}
      </Pressable>
      {trailing}
      {onToggle ? (
        <Pressable accessibilityRole="button" accessibilityLabel={open ? 'Collapse' : 'Expand'} accessibilityState={{ expanded: open }} onPress={onToggle} hitSlop={touch ? 12 : 6} className={cn('items-center justify-center rounded-xs hover:bg-overlay/[0.08]', touch ? 'h-8 w-8' : 'h-5 w-5', Platform.OS === 'web' && 'cursor-pointer')}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} tone="subtle" />
        </Pressable>
      ) : null}
    </View>
  );
}

export interface SidebarThreadItemProps {
  title: string;
  snippet?: string;
  time?: string;
  unread?: number;
  selected?: boolean;
  /** Something is happening in this thread right now (a seat is thinking): pulsing dot. */
  live?: boolean;
  liveTone?: StatusTone;
  onPress?: () => void;
  /** Indent under a group head. Default true. */
  nested?: boolean;
}

export function SidebarThreadItem({ title, snippet, time, unread = 0, selected, live, liveTone = 'primary', onPress, nested = true }: SidebarThreadItemProps) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return (
    <Pressable
      accessibilityRole={Platform.OS === 'web' ? 'link' : 'button'}
      accessibilityLabel={title}
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      {...({ dataSet: { conversation: title } } as object)}
      className={cn('app-region-no-drag w-full flex-row items-center gap-2 rounded-md pr-2', touch ? 'py-2' : 'py-[6px]', nested ? 'pl-[42px]' : 'pl-2.5', Platform.OS === 'web' && 'cursor-pointer select-none', selected ? 'bg-selected' : 'hover:bg-overlay/5 active:bg-overlay/[0.08]')}
    >
      <View className="min-w-0 flex-1 gap-px">
        <View className="flex-row items-center gap-1.5">
          {live ? <StatusDot tone={liveTone} size={6} pulse /> : null}
          <Text variant="body" weight={unread || selected ? 'semibold' : 'medium'} numberOfLines={1} className="min-w-0 flex-1">
            {title}
          </Text>
          {time ? (
            <Text variant="micro" tone="subtle">
              {time}
            </Text>
          ) : null}
        </View>
        {snippet ? (
          <View className="flex-row items-center gap-1.5">
            <Text variant="caption" tone="subtle" numberOfLines={1} className="min-w-0 flex-1">
              {snippet}
            </Text>
            {unread ? <CountBadge value={unread} tone="warning" /> : null}
          </View>
        ) : unread ? (
          <View className="flex-row justify-end">
            <CountBadge value={unread} tone="warning" />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
