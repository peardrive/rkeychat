/**
 * The phone's four dock pages: Home (blocks), Activity (the feed), Projects (organization tabs + the list),
 * Settings lives in SettingsPage. Each has a header under the safe area and the dock below.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { SAFE_TOP, isTouch, rkc, useSwipe } from '../hooks';
import { DropZone, MenuButton, OrgTabs, Pane, PaneBody, PaneHeader, SearchField, WindowControls, useToast, type DroppedItem, type MenuItem } from '../kit';
import { useStore } from '../store/context';
import { filterByOrg, neighbourTab, orgTabs, writeOrgFilter, type OrgFilter } from '../store/nav';
import { folderName, orderedRooms } from '../store/selectors';
import { ActivityFeedView, MarkAllRead } from './ActivityPage';
import { DebugButton } from './DebugButton';
import { HomeBlocks } from './HomeBlocks';
import { ProjectList, type ProjectAction } from './ProjectList';

/** Space the dock takes at the bottom of a page. */
export const DOCK_SPACE = 92;
export const DockSpace = ({ phone }: { phone: boolean }) => (phone ? <View style={{ height: DOCK_SPACE }} /> : null);

const headerStyle = (phone: boolean) => (phone ? ({ paddingTop: `calc(16px + ${SAFE_TOP})` } as never) : undefined);

export function HomePage({ phone, onOpenProjects, onOpenActivity, onOpenProfile, onNavigate }: { phone: boolean; onOpenProjects: (org?: string) => void; onOpenActivity: () => void; onOpenProfile: (name: string) => void; onNavigate?: () => void }) {
  const { state } = useStore();
  return (
    <Pane glow>
      <PaneHeader title="Home" subtitle={state.me?.device ? `${state.me.human ?? ''} · ${state.me.device}` : undefined} size={phone ? 'display' : 'title'} style={headerStyle(phone)} dragRegion={!phone} leading={phone && rkc()?.desktop ? <WindowControls /> : undefined} actions={<DebugButton />} />
      <PaneBody contentClassName="px-4 pb-6 pt-1">
        <View className="w-full max-w-[760px] self-center">
          <HomeBlocks onOpenProjects={onOpenProjects} onOpenActivity={onOpenActivity} onOpenProfile={onOpenProfile} onNavigate={onNavigate} />
        </View>
        <DockSpace phone={phone} />
      </PaneBody>
    </Pane>
  );
}

export function ActivityPage({ phone, onNavigate }: { phone: boolean; onNavigate?: () => void }) {
  return (
    <Pane glow>
      <PaneHeader title="Activity" size={phone ? 'display' : 'title'} style={headerStyle(phone)} dragRegion={!phone} actions={<View className="flex-row items-center gap-1"><MarkAllRead /><DebugButton /></View>} />
      <PaneBody contentClassName="px-3 pb-6 pt-1">
        <View className="w-full max-w-[760px] self-center">
          <ActivityFeedView onNavigate={onNavigate} />
        </View>
        <DockSpace phone={phone} />
      </PaneBody>
    </Pane>
  );
}

export interface ProjectsPageProps {
  phone: boolean;
  orgFilter: OrgFilter;
  onOrgFilter: (f: OrgFilter) => void;
  onNewProject: (prefill?: { name?: string; org?: string }) => void;
  onNewOrg: () => void;
  onProjectAction: (action: ProjectAction, topic: string) => void;
  onNavigate?: () => void;
}

export function ProjectsPage({ phone, orgFilter, onOrgFilter, onNewProject, onNewOrg, onProjectAction, onNavigate }: ProjectsPageProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const rooms = orderedRooms(state);
  const tabs = useMemo(() => orgTabs(rooms), [rooms]);
  const current = tabs.some((t) => t.key === orgFilter) ? orgFilter : 'all';
  const shown = useMemo(() => filterByOrg(rooms, current), [rooms, current]);
  const touch = isTouch();
  const swipe = useSwipe((dir) => onOrgFilter(neighbourTab(tabs, current, dir === -1 ? 1 : -1)));

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
      const res = await actions.createProject({ folder: path, name: folderName(path), org: current !== 'all' && current !== 'none' ? current : undefined });
      if (!('pending' in res)) toast({ title: 'Project ready.', description: `@${res.seat} is listening.`, tone: 'success' });
      onNavigate?.();
    } catch (e) {
      toast({ title: 'Could not create the project', description: (e as Error).message, tone: 'danger' });
    }
  };

  return (
    <Pane glow>
      <PaneHeader title="Projects" size={phone ? 'display' : 'title'} style={headerStyle(phone)} dragRegion={!phone} actions={<View className="flex-row items-center gap-1"><DebugButton /><MenuButton icon="add" items={plusItems} size="sm" variant="subtle" tooltip={touch ? undefined : 'New project or organization'} accessibilityLabel="New" /></View>} />
      <OrgTabs items={tabs.map((t) => ({ key: t.key, name: t.name, count: t.count, avatar: t.key === 'all' || t.key === 'none' ? null : undefined }))} value={current} onChange={(k) => { onOrgFilter(k); writeOrgFilter(k); }} onAdd={onNewOrg} />
      <View className="px-3 pb-1 pt-1">
        <SearchField value={query} onChangeText={setQuery} placeholder="Search projects and conversations" />
      </View>
      <DropZone onDrop={onDrop} overlay={touch ? null : 'Drop a folder to start a project'} disabled={touch} className="min-h-0 w-full flex-1">
        <PaneBody contentClassName="px-2 pb-6 pt-1">
          <View className="w-full max-w-[760px] self-center" {...(touch ? (swipe as object) : {})}>
            <ProjectList rooms={shown} query={query} grouped={current === 'all'} phone={phone} onNavigate={onNavigate} onProjectAction={onProjectAction} emptyText={current === 'all' ? undefined : 'No project here yet. Press + to start one.'} />
          </View>
          <DockSpace phone={phone} />
        </PaneBody>
      </DropZone>
    </Pane>
  );
}
