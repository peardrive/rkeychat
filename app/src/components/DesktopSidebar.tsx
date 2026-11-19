/**
 * The desktop sidebar: the four dock pages as small tabs at the top; the body shows Home's blocks, the Activity
 * feed or the Projects (organization tabs + list). Settings opens the page in the middle.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { rkc, type TextInputRef } from '../hooks';
import { ALL_ORGS, DropZone, IconButton, MenuButton, OrgTabs, SearchField, SegmentedControl, Sidebar, SidebarContent, SidebarHeader, SidebarSpacer, SidebarToggle, WindowControls, useSidebar, useToast, type DroppedItem, type MenuItem } from '../kit';
import { useStore } from '../store/context';
import { feedUnread } from '../store/feed';
import { filterByOrg, orgTabs, writeOrgFilter, type DockPage, type OrgFilter } from '../store/nav';
import { folderName, orderedRooms } from '../store/selectors';
import { ActivityFeedView, MarkAllRead } from './ActivityPage';
import { DebugButton } from './DebugButton';
import { HomeBlocks } from './HomeBlocks';
import { ProjectList, type ProjectAction } from './ProjectList';

const WIDTH_KEY = 'rkc.app.sidebar';

export interface DesktopSidebarProps {
  tab: DockPage;
  onTab: (t: DockPage) => void;
  orgFilter: OrgFilter;
  onOrgFilter: (f: OrgFilter) => void;
  onNewProject: (prefill?: { name?: string; org?: string }) => void;
  onNewOrg: () => void;
  onProjectAction: (action: ProjectAction, topic: string) => void;
  onOpenProfile: (name: string) => void;
  searchRef: React.RefObject<TextInputRef | null>;
}

export function DesktopSidebar({ tab, onTab, orgFilter, onOrgFilter, onNewProject, onNewOrg, onProjectAction, onOpenProfile, searchRef }: DesktopSidebarProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 300);
  const [query, setQuery] = useState('');
  const rooms = orderedRooms(state);
  const tabs = useMemo(() => orgTabs(rooms), [rooms]);
  const current = tabs.some((t) => t.key === orgFilter) ? orgFilter : 'all';
  const shown = useMemo(() => filterByOrg(rooms, current), [rooms, current]);
  const unread = feedUnread(state.feed);

  const plusItems: MenuItem[] = [
    { key: 'project', label: 'New project', icon: 'folder', onSelect: () => onNewProject(current !== 'all' && current !== 'none' ? { org: current } : undefined) },
    { key: 'org', label: 'New organization', icon: 'grid-1', onSelect: onNewOrg },
  ];

  const onDrop = async (items: DroppedItem[]) => {
    const dir = items.find((i) => i.kind === 'directory') ?? items[0];
    if (!dir) return;
    const path = dir.file ? rkc()?.pathForFile?.(dir.file) : null;
    if (!path) return onNewProject({ name: dir.name.replace(/\.[^.]+$/, '') });
    try {
      const res = await actions.createProject({ folder: path, name: folderName(path) });
      if (!('pending' in res)) toast({ title: 'Project ready.', description: `@${res.seat} is listening.`, tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not create the project', description: (e as Error).message, tone: 'danger' });
    }
  };

  return (
    <Sidebar resizable width={width} maxWidth={460} minWidth={240} onWidthChange={setWidth} onResizeEnd={(w) => localStorage.setItem(WIDTH_KEY, String(w))} contentClassName="px-2.5">
      <DropZone onDrop={onDrop} overlay="Drop a folder to start a project" className="w-full min-h-0 flex-1">
        <SidebarHeader className="px-1.5">
          <WindowControls />
          <SidebarSpacer />
          <SidebarToggle />
        </SidebarHeader>
        <Tabs tab={tab} onTab={onTab} unread={unread} />
        <Body
          tab={tab}
          query={query}
          setQuery={setQuery}
          searchRef={searchRef}
          tabs={tabs}
          current={current}
          onOrgFilter={(k) => { onOrgFilter(k); writeOrgFilter(k); }}
          onNewOrg={onNewOrg}
          plusItems={plusItems}
          shown={shown}
          onProjectAction={onProjectAction}
          onOpenProfile={onOpenProfile}
          onTabChange={onTab}
        />
      </DropZone>
    </Sidebar>
  );
}

function Tabs({ tab, onTab, unread }: { tab: DockPage; onTab: (t: DockPage) => void; unread: number }) {
  const { collapsed } = useSidebar();
  if (collapsed) {
    return (
      <View className="items-center gap-1">
        <IconButton icon="grid-1" size="sm" active={tab === 'home'} tooltip={{ label: 'Home', placement: 'right' }} onPress={() => onTab('home')} />
        <IconButton icon="message" size="sm" active={tab === 'activity'} tooltip={{ label: `Activity${unread ? ` · ${unread}` : ''}`, placement: 'right' }} onPress={() => onTab('activity')} />
        <IconButton icon="folder" size="sm" active={tab === 'projects'} tooltip={{ label: 'Projects', placement: 'right' }} onPress={() => onTab('projects')} />
        <IconButton icon="setting-2-bold" size="sm" active={tab === 'settings'} tooltip={{ label: 'Settings', placement: 'right' }} onPress={() => onTab('settings')} />
      </View>
    );
  }
  return (
    <View className="w-full flex-row items-center gap-1.5 px-0.5 pb-2">
      <SegmentedControl
        fullWidth
        size="sm"
        value={tab}
        onChange={(v) => onTab(v as DockPage)}
        options={[
          { value: 'home', icon: 'grid-1', accessibilityLabel: 'Home' },
          { value: 'activity', icon: 'message', label: unread ? String(unread) : undefined, accessibilityLabel: 'Activity' },
          { value: 'projects', icon: 'folder', accessibilityLabel: 'Projects' },
          { value: 'settings', icon: 'setting-2-bold', accessibilityLabel: 'Settings' },
        ]}
      />
      <DebugButton />
    </View>
  );
}

function Body({ tab, query, setQuery, searchRef, tabs, current, onOrgFilter, onNewOrg, plusItems, shown, onProjectAction, onOpenProfile, onTabChange }: { tab: DockPage; query: string; setQuery: (q: string) => void; searchRef: React.RefObject<TextInputRef | null>; tabs: ReturnType<typeof orgTabs>; current: OrgFilter; onOrgFilter: (f: OrgFilter) => void; onNewOrg: () => void; plusItems: MenuItem[]; shown: ReturnType<typeof filterByOrg>; onProjectAction: (a: ProjectAction, t: string) => void; onOpenProfile: (n: string) => void; onTabChange: (t: DockPage) => void }) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  if (tab === 'home') {
    return (
      <SidebarContent className="pb-3">
        <HomeBlocks compact onOpenProjects={(org) => { if (org) onOrgFilter(org); onTabChange('projects'); }} onOpenActivity={() => onTabChange('activity')} onOpenProfile={onOpenProfile} />
      </SidebarContent>
    );
  }
  if (tab === 'activity') {
    return (
      <SidebarContent className="pb-3">
        <View className="flex-row justify-end px-1">
          <MarkAllRead />
        </View>
        <ActivityFeedView compact />
      </SidebarContent>
    );
  }
  return (
    <>
      <View className="w-full flex-row items-center gap-1.5 px-0.5 pb-1.5">
        <View className="min-w-0 flex-1">
          <SearchField ref={searchRef} value={query} onChangeText={setQuery} placeholder="Search" shortcut="⌘K" />
        </View>
        <MenuButton icon="add" items={plusItems} size="sm" variant="subtle" tooltip="New project or organization" accessibilityLabel="New" />
      </View>
      <OrgTabs size="sm" className="-mx-2.5" items={tabs.filter((t) => t.key !== 'all').map((t) => ({ key: t.key, name: t.name, count: t.count, avatar: { seed: `org:${t.key}` } }))} value={current === 'all' ? ALL_ORGS : current} onChange={(k) => onOrgFilter(k === ALL_ORGS ? 'all' : k)} onAdd={onNewOrg} />
      <SidebarContent className="pb-3 pt-1">
        <ProjectList rooms={shown} query={query} grouped={current === 'all'} onProjectAction={onProjectAction} />
      </SidebarContent>
    </>
  );
}
