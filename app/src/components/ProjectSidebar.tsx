/**
 * Left column: projects (rooms with a folder) and chats, each with its conversations.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { getApi } from '../api';
import { SAFE_BOTTOM, SAFE_TOP, isTouch, rkc, type TextInputRef } from '../hooks';
import { DropZone, SearchField, Sidebar, SidebarContent, SidebarFooter, SidebarGroupRow, SidebarHeader, SidebarItem, SidebarSection, SidebarSpacer, SidebarThreadItem, SidebarToggle, Text, WindowControls, useSidebar, useToast, type DroppedItem } from '../kit';
import { shortTime } from '../time';
import { useStore } from '../store/context';
import { convTitle, folderName, groupRooms, homeOf, orderedRooms, roomIsThinking, thinkingIn, unreadIn, unreadInRoom, visibleConvs } from '../store/selectors';
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

export interface ProjectSidebarProps {
  onNewProject: (prefill?: { name?: string }) => void;
  onOpenSettings: () => void;
  searchRef: React.RefObject<TextInputRef | null>;
  /** Phone: fill the screen. */
  fullWidth?: number;
  onNavigate?: () => void;
}

export function ProjectSidebar({ onNewProject, onOpenSettings, searchRef, fullWidth, onNavigate }: ProjectSidebarProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 264);
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);

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
  const { projects, chats } = useMemo(() => groupRooms(rooms), [rooms]);
  const q = query.trim().toLowerCase();

  // Message search (daemon-side) for anything longer than one character.
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
    if (r.name.toLowerCase().includes(q) || folderName(r.folder).toLowerCase().includes(q)) return true;
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
            // Phone: the row only opens and closes the group; a conversation row is what navigates.
            if (fullWidth || !expanded || selectedHere) toggle(r.topic);
            else select(r.topic, 'main');
          }}
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
            {!q ? <NewConversationItem onPress={() => newConversation(r.topic)} /> : null}
          </View>
        ) : null}
      </View>
    );
  };

  const shownProjects = projects.filter(matches);
  const shownChats = chats.filter(matches);
  const touch = isTouch();

  return (
    <Sidebar
      resizable={!fullWidth}
      width={fullWidth ?? width}
      maxWidth={fullWidth ?? 420}
      minWidth={fullWidth ?? 220}
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
        <SearchBar ref={searchRef} value={query} onChangeText={setQuery} shortcut={touch ? undefined : '⌘K'} />
        <SidebarContent className="pb-2">
          {q && hits.length ? (
            <SidebarSection title="Messages">
              {hits.map((h) => (
                <SidebarThreadItem key={h.id} nested={false} title={`${h.room ?? ''}${h.name ? ` · ${h.name}` : ''}`} snippet={h.snippet.replace(/[\u0002\u0003]/g, '')} time={shortTime(h.ts)} onPress={() => h.topic && select(h.topic, h.conv ?? 'main')} />
              ))}
            </SidebarSection>
          ) : null}
          <SidebarSection title="Projects">
            {shownProjects.map(renderGroup)}
            {!shownProjects.length ? <Hint text={q ? 'No project matches.' : 'Drop a folder here, or use New project.'} /> : null}
          </SidebarSection>
          {shownChats.length ? <SidebarSection title="Chats">{shownChats.map(renderGroup)}</SidebarSection> : null}
        </SidebarContent>
        <SidebarFooter className="gap-0.5 pt-1">
          <SidebarItem icon="add" label="New project" onPress={() => onNewProject()} className={touch ? 'py-2.5' : undefined} />
          <SidebarItem icon="setting-2-bold" label="Settings" onPress={onOpenSettings} className={touch ? 'py-2.5' : undefined} />
          {fullWidth ? <View style={{ height: SAFE_BOTTOM } as never} /> : null}
        </SidebarFooter>
      </DropZone>
    </Sidebar>
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

function NewConversationItem({ onPress }: { onPress: () => void }) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return <SidebarItem icon="add" iconTone="subtle" label="New conversation" onPress={onPress} className="py-[5px] pl-[42px]" />;
}

function Hint({ text }: { text: string }) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return (
    <Text variant="caption" tone="subtle" className="px-2.5 py-1.5">
      {text}
    </Text>
  );
}
