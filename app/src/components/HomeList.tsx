/**
 * Home: the activity feed and the projects, grouped by organization. The sidebar on a desktop, the first page on
 * a phone. One + at the top (New project / New organization); a + on each project makes a conversation; a
 * project's ⋯ (or a long press) offers Rename, Move to organization, Remove.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { getApi } from '../api';
import { SAFE_BOTTOM, SAFE_TOP, isTouch, rkc, type TextInputRef } from '../hooks';
import {
  ActivityFeed, Button, CountBadge, DropZone, Icon, IconButton, Menu, MenuButton, SearchField, Sidebar, SidebarContent, SidebarFooter, SidebarGroupRow,
  SidebarHeader, SidebarItem, SidebarSection, SidebarSpacer, SidebarThreadItem, SidebarToggle, Text, WindowControls, cn, useSidebar, useToast, type ActivityItem, type DroppedItem, type MenuItem,
} from '../kit';
import { ApprovalDialog, toActivityItems } from './feed';
import { DebugButton } from './DebugButton';
import { useStore } from '../store/context';
import { feedUnread, type FeedItem } from '../store/feed';
import { convTitle, folderName, groupByOrg, homeOf, orderedRooms, roomIsThinking, thinkingIn, unreadIn, unreadInRoom, visibleConvs } from '../store/selectors';
import { shortTime } from '../time';
import type { RoomSummary, SearchHit } from '../types';

const WIDTH_KEY = 'rkc.app.sidebar';
const OPEN_KEY = 'rkc.app.groups';

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export type ProjectAction = 'rename' | 'org' | 'remove';

export interface HomeListProps {
  onNewProject: (prefill?: { name?: string; org?: string }) => void;
  onNewOrg: () => void;
  onOpenSettings: () => void;
  onOpenHome: () => void;
  onProjectAction: (action: ProjectAction, topic: string) => void;
  searchRef: React.RefObject<TextInputRef | null>;
  /** Phone: fill the screen; this is the first page. */
  fullWidth?: number;
  /** A conversation was opened (phone: go to its page). */
  onNavigate?: () => void;
  homeActive?: boolean;
}

export function HomeList({ onNewProject, onNewOrg, onOpenSettings, onOpenHome, onProjectAction, searchRef, fullWidth, onNavigate, homeActive }: HomeListProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 272);
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [allNews, setAllNews] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ topic: string; anchor?: { x: number; y: number } } | null>(null);
  const [approval, setApproval] = useState<FeedItem | null>(null);
  const touch = isTouch();

  const toggle = (topic: string) =>
    setOpen((o) => {
      const next = { ...o, [topic]: o[topic] === false };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  const isOpen = (topic: string) => open[topic] !== false;

  const rooms = orderedRooms(state);
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const res = await getApi().search({ q, limit: 8 });
        if (alive) setHits(res.results ?? []);
      } catch {
        if (alive) setHits([]);
      }
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

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

  const onDrop = async (items: DroppedItem[]) => {
    const dir = items.find((i) => i.kind === 'directory') ?? items[0];
    if (!dir) return;
    const path = dir.file ? rkc()?.pathForFile?.(dir.file) : null;
    if (!path) {
      onNewProject({ name: dir.name.replace(/\.[^.]+$/, '') });
      return;
    }
    try {
      const res = await actions.createProject({ folder: path, name: folderName(path) });
      if (!('pending' in res)) toast({ title: 'Project ready.', description: `@${res.seat} is listening.`, tone: 'success' });
      onNavigate?.();
    } catch (e) {
      toast({ title: 'Could not create the project', description: (e as Error).message, tone: 'danger' });
    }
  };

  const matches = (r: RoomSummary) => {
    if (!q) return true;
    if (r.name.toLowerCase().includes(q) || folderName(r.folder).toLowerCase().includes(q) || (r.app?.org ?? '').toLowerCase().includes(q)) return true;
    return (state.convs[r.topic] ?? []).some((c) => convTitle(c).toLowerCase().includes(q));
  };

  const grant = useCallback((topic: string) => actions.loginGrant(topic).then(() => toast({ title: 'Let in', tone: 'success' })).catch((e) => toast({ title: 'Could not let them in', description: (e as Error).message, tone: 'danger' })), [actions, toast]);
  const deny = useCallback((topic: string) => actions.loginDeny(topic).catch((e) => toast({ title: 'Could not answer', description: (e as Error).message, tone: 'danger' })), [actions, toast]);
  const feed = useMemo(() => toActivityItems(state.feed, grant), [state.feed, grant]);
  const openItem = useCallback(
    (item: ActivityItem) => {
      const f = state.feed.find((x) => x.id === item.id);
      if (f?.kind === 'approval') {
        setApproval(f);
        return;
      }
      void actions.openFeedItem(item.id);
      onNavigate?.();
    },
    [state.feed, actions, onNavigate],
  );
  const unreadNews = feedUnread(state.feed);

  const renderGroup = (r: RoomSummary) => {
    const convs = visibleConvs(state, r.topic).filter((c) => !q || convTitle(c).toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    const selectedHere = state.selected.topic === r.topic && !homeActive;
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
            if (fullWidth || !expanded || selectedHere) toggle(r.topic);
            else select(r.topic, 'main');
          }}
          onLongPress={() => setRowMenu({ topic: r.topic })}
          trailing={
            <View className="flex-row items-center">
              <IconButton icon="add" size="xs" hitSlop={6} tooltip={touch ? undefined : 'New conversation'} accessibilityLabel={`New conversation in ${r.name}`} onPress={() => void newConversation(r.topic)} />
              <IconButton icon="more" size="xs" hitSlop={6} tooltip={touch ? undefined : 'Project'} accessibilityLabel={`${r.name} actions`} onPress={() => setRowMenu({ topic: r.topic })} />
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
  const plusItems: MenuItem[] = [
    { key: 'project', label: 'New project', icon: 'folder', onSelect: () => onNewProject() },
    { key: 'org', label: 'New organization', icon: 'grid-1', onSelect: onNewOrg },
  ];
  const rowRoom = rowMenu ? state.rooms[rowMenu.topic] : null;
  const rowItems: MenuItem[] = rowRoom
    ? [
        { key: 'conv', label: 'New conversation', icon: 'add', shortcut: touch ? undefined : '⌘N', onSelect: () => void newConversation(rowRoom.topic) },
        { key: 'rename', label: 'Rename', icon: 'document', onSelect: () => onProjectAction('rename', rowRoom.topic) },
        { key: 'org', label: 'Move to organization…', icon: 'grid-1', onSelect: () => onProjectAction('org', rowRoom.topic) },
        { key: 'sep', separator: true },
        { key: 'remove', label: 'Remove from this device', icon: 'close', danger: true, onSelect: () => onProjectAction('remove', rowRoom.topic) },
      ]
    : [];

  const newsLimit = fullWidth ? (allNews ? undefined : 6) : allNews ? undefined : 4;

  return (
    <Sidebar
      resizable={!fullWidth}
      width={fullWidth ?? width}
      maxWidth={fullWidth ?? 440}
      minWidth={fullWidth ?? 228}
      onWidthChange={setWidth}
      onResizeEnd={(w) => localStorage.setItem(WIDTH_KEY, String(w))}
      collapseOnDrag={fullWidth ? false : 60}
      contentClassName="px-2.5"
    >
      <DropZone onDrop={onDrop} overlay={touch ? null : 'Drop a folder to start a project'} disabled={touch} className="w-full min-h-0 flex-1">
        {fullWidth ? <View style={{ height: SAFE_TOP } as never} /> : null}
        {fullWidth && !rkc()?.desktop ? null : (
          <SidebarHeader className="px-1.5">
            <WindowControls />
            <SidebarSpacer />
            {fullWidth ? null : <SidebarToggle />}
          </SidebarHeader>
        )}
        <TopRow fullWidth={!!fullWidth} plusItems={plusItems} onOpenSettings={onOpenSettings} />
        <SearchBar ref={searchRef} value={query} onChangeText={setQuery} shortcut={touch ? undefined : '⌘K'} />
        <SidebarContent className="pb-2">
          {q && hits.length ? (
            <SidebarSection title="Messages">
              {hits.map((h) => (
                <SidebarThreadItem key={h.id} nested={false} title={`${h.room ?? ''}${h.name ? ` · ${h.name}` : ''}`} snippet={h.snippet.replace(/[\u0002\u0003]/g, '')} time={shortTime(h.ts)} onPress={() => h.topic && select(h.topic, h.conv ?? 'main')} />
              ))}
            </SidebarSection>
          ) : null}
          {!q ? (
            <NewsSection fullWidth={!!fullWidth} rows={feed} onOpen={openItem} limit={newsLimit} unread={unreadNews} homeActive={!!homeActive} onOpenHome={onOpenHome} onToggleAll={() => setAllNews((a) => !a)} allShown={allNews} />
          ) : null}
          {ungrouped.length || !orgs.length ? (
            <SidebarSection title="Projects">
              {ungrouped.map(renderGroup)}
              {!shown.length ? <Hint text={q ? 'No project matches.' : touch ? 'Press + to start a project.' : 'Drop a folder here, or press +.'} /> : null}
            </SidebarSection>
          ) : null}
          {orgs.map((o) => (
            <SidebarSection key={o.name} title={o.name} trailing={<CountBadge value={o.rooms.length} />}>
              {o.rooms.map(renderGroup)}
            </SidebarSection>
          ))}
        </SidebarContent>
        <SidebarFooter className="gap-0.5 pt-1">
          <SidebarItem icon="setting-2-bold" label="Settings" onPress={onOpenSettings} className={touch ? 'py-2.5' : undefined} />
          {fullWidth ? <View style={{ height: SAFE_BOTTOM } as never} /> : null}
        </SidebarFooter>
      </DropZone>
      <Menu open={!!rowMenu} onClose={() => setRowMenu(null)} items={rowItems} anchor={rowMenu?.anchor} align="right" />
      <ApprovalDialog item={approval} onClose={() => setApproval(null)} onGrant={grant} onDeny={deny} />
    </Sidebar>
  );
}

function TopRow({ fullWidth, plusItems, onOpenSettings }: { fullWidth: boolean; plusItems: MenuItem[]; onOpenSettings: () => void }) {
  const { collapsed } = useSidebar();
  if (collapsed) return <MenuButton icon="add" items={plusItems} size="sm" tooltip="New" />;
  return (
    <View className="w-full flex-row items-center gap-2 px-0.5 pb-2">
      <Text variant={fullWidth ? 'display' : 'title'} className="min-w-0 flex-1">
        Home
      </Text>
      <DebugButton />
      {fullWidth ? <IconButton icon="setting-2-bold" size="sm" hitSlop={8} accessibilityLabel="Settings" onPress={onOpenSettings} /> : null}
      <MenuButton icon="add" items={plusItems} size="sm" variant="subtle" tooltip={fullWidth ? undefined : 'New project or organization'} accessibilityLabel="New" />
    </View>
  );
}

function NewsSection({ fullWidth, rows, onOpen, limit, unread, homeActive, onOpenHome, onToggleAll, allShown }: { fullWidth: boolean; rows: ActivityItem[]; onOpen: (item: ActivityItem) => void; limit?: number; unread: number; homeActive: boolean; onOpenHome: () => void; onToggleAll: () => void; allShown: boolean }) {
  const { collapsed } = useSidebar();
  if (collapsed) return <SidebarItem icon="message" label="Home" badge={unread ? { value: unread, tone: 'warning' } : undefined} selected={homeActive} onPress={onOpenHome} />;
  const more = limit != null && rows.length > limit;
  return (
    <SidebarSection
      title="Activity"
      trailing={
        <View className="flex-row items-center gap-1">
          {unread ? <CountBadge value={unread} tone="warning" /> : null}
          {!fullWidth ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Open home" onPress={onOpenHome} className={cn('flex-row items-center gap-0.5 rounded-xs px-1 py-0.5 hover:bg-overlay/[0.08]', Platform.OS === 'web' && 'cursor-pointer')}>
              <Text variant="micro" tone={homeActive ? 'primary-text' : 'subtle'} weight="semibold">
                All
              </Text>
              <Icon name="chevron-right" size={10} tone="subtle" />
            </Pressable>
          ) : null}
        </View>
      }
    >
      <ActivityFeed items={limit ? rows.slice(0, limit) : rows} onOpen={onOpen} compact={!fullWidth} groupByDay={false} showWhere={!!fullWidth} emptyState={<Text variant="caption" tone="subtle" className="px-2.5 py-1.5">Nothing new.</Text>} />
      {more || allShown ? (
        <View className="flex-row justify-center">
          <Button size="sm" variant="ghost" label={allShown ? 'Fewer' : `${rows.length - (limit ?? 0)} more`} onPress={onToggleAll} />
        </View>
      ) : null}
    </SidebarSection>
  );
}

const SearchBar = React.forwardRef<TextInputRef, { value: string; onChangeText: (t: string) => void; shortcut?: string }>(function SearchBar({ value, onChangeText, shortcut }, ref) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return (
    <View className="w-full px-0.5 pb-2">
      <SearchField ref={ref} value={value} onChangeText={onChangeText} placeholder="Search" shortcut={shortcut} />
    </View>
  );
});

function Hint({ text }: { text: string }) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return (
    <Text variant="caption" tone="subtle" className="px-2.5 py-1.5">
      {text}
    </Text>
  );
}
