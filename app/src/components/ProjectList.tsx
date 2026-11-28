/**
 * The projects, grouped by organization, each with its conversations. A + on a project makes a conversation;
 * ⋯ (or a long press) offers Rename, Move to organization, Remove. Used by the phone's Projects page and the
 * desktop sidebar.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { isTouch } from '../hooks';
import { CountBadge, IconButton, Menu, SidebarGroupRow, SidebarSection, SidebarThreadItem, Text, useToast, type MenuItem } from '../kit';
import { useStore } from '../store/context';
import { convTitle, folderName, groupByOrg, homeOf, roomIsThinking, thinkingIn, unreadIn, unreadInRoom, visibleConvs } from '../store/selectors';
import { shortTime } from '../time';
import type { RoomSummary } from '../types';

const OPEN_KEY = 'rkc.app.groups';

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export type ProjectAction = 'rename' | 'org' | 'remove';

export interface ProjectListProps {
  rooms: RoomSummary[];
  query?: string;
  /** Group under organization headings (off when the list is already filtered to one). */
  grouped?: boolean;
  phone?: boolean;
  onNavigate?: () => void;
  onProjectAction: (action: ProjectAction, topic: string) => void;
  emptyText?: string;
}

/**
 * Where a press happened, for the menu to hang from it: under the pressed button when the page can say where that
 * is, else the finger's point. Undefined lets the menu open in the middle (it once opened in the top corner, under
 * the phone's status bar: Guy, 2026-11-28).
 */
function pressPoint(e: unknown): { x: number; y: number } | undefined {
  const ev = e as { currentTarget?: { getBoundingClientRect?: () => DOMRect }; nativeEvent?: { pageX?: number; pageY?: number } } | undefined;
  const r = ev?.currentTarget?.getBoundingClientRect?.();
  if (r && r.width) return { x: r.right, y: r.bottom + 4 };
  const n = ev?.nativeEvent;
  if (typeof n?.pageX === 'number' && typeof n?.pageY === 'number') return { x: n.pageX, y: n.pageY + 8 };
  return undefined;
}

export function ProjectList({ rooms, query = '', grouped = true, phone, onNavigate, onProjectAction, emptyText }: ProjectListProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const [rowMenu, setRowMenu] = useState<{ topic: string; at?: { x: number; y: number } } | null>(null);
  const touch = isTouch();
  const q = query.trim().toLowerCase();

  const toggle = (topic: string) =>
    setOpen((o) => {
      const next = { ...o, [topic]: o[topic] === false };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  const isOpen = (topic: string) => open[topic] !== false;

  const select = useCallback(
    (topic: string, conv: string) => {
      void actions.select(topic, conv);
      onNavigate?.();
    },
    [actions, onNavigate],
  );

  const newConversation = async (topic: string) => {
    try {
      await actions.createConversation(topic);
      onNavigate?.();
    } catch (e) {
      toast({ title: 'Could not create the conversation', description: (e as Error).message, tone: 'danger' });
    }
  };

  const matches = (r: RoomSummary) => {
    if (!q) return true;
    if (r.name.toLowerCase().includes(q) || folderName(r.folder).toLowerCase().includes(q) || (r.app?.org ?? '').toLowerCase().includes(q)) return true;
    return (state.convs[r.topic] ?? []).some((c) => convTitle(c).toLowerCase().includes(q));
  };

  const renderGroup = (r: RoomSummary) => {
    const convs = visibleConvs(state, r.topic).filter((c) => !q || convTitle(c).toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    const selectedHere = state.selected.topic === r.topic;
    const expanded = isOpen(r.topic) || !!q;
    const home = homeOf(r, state.me?.ref);
    const subtitle = r.folder ? (home.here || !home.name ? folderName(r.folder) : `${folderName(r.folder)} · on ${home.name}`) : home.name && !home.here ? `on ${home.name}` : undefined;
    return (
      <View key={r.topic} className="w-full">
        <SidebarGroupRow
          seed={r.topic}
          title={r.name}
          subtitle={subtitle}
          unread={expanded ? 0 : unreadInRoom(state, r.topic)}
          selected={selectedHere && !expanded}
          open={expanded}
          live={roomIsThinking(state, r.topic)}
          onToggle={() => toggle(r.topic)}
          onPress={() => {
            if (phone || !expanded || selectedHere) toggle(r.topic);
            else select(r.topic, 'main');
          }}
          onLongPress={(e?: unknown) => setRowMenu({ topic: r.topic, at: pressPoint(e) })}
          trailing={
            <View className="flex-row items-center">
              <IconButton icon="add" size="xs" hitSlop={6} tooltip={touch ? undefined : 'New conversation'} accessibilityLabel={`New conversation in ${r.name}`} onPress={() => void newConversation(r.topic)} />
              <IconButton icon="more" size="xs" hitSlop={6} tooltip={touch ? undefined : 'Project'} accessibilityLabel={`${r.name} actions`} onPress={(e?: unknown) => setRowMenu({ topic: r.topic, at: pressPoint(e) })} />
            </View>
          }
        />
        {expanded ? (
          <View className="w-full gap-px">
            {convs.map((c) => (
              <SidebarThreadItem
                key={c.conv}
                title={convTitle(c)}
                snippet={c.last ? `${c.last.name}: ${c.last.text}` : undefined}
                time={c.last ? shortTime(c.last.ts) : undefined}
                unread={unreadIn(state, r.topic, c.conv)}
                selected={selectedHere && state.selected.conv === c.conv}
                live={thinkingIn(state, r.topic, c.conv).length > 0}
                onPress={() => select(r.topic, c.conv)}
              />
            ))}
          </View>
        ) : null}
      </View>
    );
  };

  const shown = rooms.filter(matches);
  const { ungrouped, orgs } = useMemo(() => groupByOrg(shown), [shown]);
  // projects asked of another device that have not arrived: a row each, until the room answers or you stop waiting
  const waiting = state.pendingProjects.filter((p) => !p.topic && (!q || p.name.toLowerCase().includes(q)));
  const rowRoom = rowMenu ? state.rooms[rowMenu.topic] : null;
  const rowItems: MenuItem[] = rowRoom
    ? [
        { key: 'conv', label: 'New conversation', icon: 'add', shortcut: touch ? undefined : '⌘N', onSelect: () => void newConversation(rowRoom.topic) },
        { key: 'rename', label: 'Rename', icon: 'document', onSelect: () => onProjectAction('rename', rowRoom.topic) },
        { key: 'org', label: 'Move to organization…', icon: 'group', onSelect: () => onProjectAction('org', rowRoom.topic) },
        { key: 'sep', separator: true },
        { key: 'remove', label: 'Remove from this device', icon: 'close', danger: true, onSelect: () => onProjectAction('remove', rowRoom.topic) },
      ]
    : [];

  return (
    <View className="w-full">
      {waiting.length ? (
        <SidebarSection title="Waiting">
          {waiting.map((p) => (
            <SidebarGroupRow
              key={p.id}
              seed={p.id}
              title={p.name}
              subtitle={`Waiting on ${p.asked}${p.online === false ? ', offline' : ''}${p.ts ? ` · asked ${shortTime(p.ts)}` : ''}`}
              live={p.online !== false}
              trailing={<IconButton icon="close" size="xs" hitSlop={6} tooltip={touch ? undefined : 'Stop waiting'} accessibilityLabel={`Stop waiting for ${p.name}`} onPress={() => actions.dismissPending(p.id)} />}
            />
          ))}
        </SidebarSection>
      ) : null}
      {!shown.length ? (
        waiting.length ? null : (
          <Text variant="caption" tone="subtle" className="px-2.5 py-2">
            {q ? 'No project matches.' : emptyText ?? (touch ? 'Press + to start a project.' : 'Drop a folder here, or press +.')}
          </Text>
        )
      ) : !grouped ? (
        <View className="w-full gap-0.5">{shown.map(renderGroup)}</View>
      ) : (
        <>
          {ungrouped.length ? <SidebarSection title={orgs.length ? 'No organization' : 'Projects'}>{ungrouped.map(renderGroup)}</SidebarSection> : null}
          {orgs.map((o) => (
            <SidebarSection key={o.name} title={o.name} trailing={<CountBadge value={o.rooms.length} />}>
              {o.rooms.map(renderGroup)}
            </SidebarSection>
          ))}
        </>
      )}
      <Menu open={!!rowMenu} onClose={() => setRowMenu(null)} items={rowItems} align="right" anchor={rowMenu?.at} />
    </View>
  );
}
