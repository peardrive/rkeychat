/**
 * The shell. Phone: four pages behind the dock (Home, Activity, Projects, Settings); a conversation, the project
 * sheet and a profile open on top with the dock hidden. Desktop: the sidebar carries the same four as tabs and
 * the middle shows the conversation, a profile or Settings; the project on the right.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { ConversationPane } from './components/ConversationPane';
import { DesktopSidebar } from './components/DesktopSidebar';
import { ActivityPage, HomePage, ProjectsPage } from './components/HomePage';
import { NewProjectDialog, type NewProjectSubmit } from './components/NewProjectDialog';
import { ProfilePage } from './components/ProfilePage';
import { MoveToOrgDialog, NewOrgDialog, RemoveProjectDialog, RenameProjectDialog } from './components/ProjectDialogs';
import { type ProjectAction } from './components/ProjectList';
import { ProjectPane } from './components/ProjectPane';
import { SettingsPage } from './components/SettingsPage';
import { getConversationTab, setDebugWhere } from './debugNotes';
import { SAFE_BOTTOM, rkc, useShortcuts, useViewport, type TextInputRef } from './hooks';
import { AppWindow, Dock, EmptyState, Pane, PaneHeader, ThemeProvider, ToastProvider, useToast, type DockItem } from './kit';
import { StoreProvider, useStore } from './store/context';
import { feedUnread } from './store/feed';
import { readDock, readOrgFilter, writeDock, type DockPage, type OrgFilter } from './store/nav';
import { convTitle, orgNames, orderedRooms, selectedConv, selectedRoom } from './store/selectors';

const PROJECT_WIDTH = 332;
const PROJECT_OPEN_KEY = 'rkc.app.project-open';

/** What sits on top of the dock pages. */
type Overlay = { kind: 'none' } | { kind: 'conversation' } | { kind: 'project' } | { kind: 'profile'; topic: string; name: string };

export function App() {
  return (
    <ThemeProvider theme="system">
      <ToastProvider>
        <StoreProvider>
          <Shell />
        </StoreProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

function Shell() {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const { phone, narrow } = useViewport();
  const [dock, setDockState] = useState<DockPage>(readDock);
  const [orgFilter, setOrgFilter] = useState<OrgFilter>(readOrgFilter);
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });
  const [projectOpen, setProjectOpen] = useState(() => {
    const saved = localStorage.getItem(PROJECT_OPEN_KEY);
    return saved ? saved === '1' : window.innerWidth >= 1040;
  });
  const [dialog, setDialog] = useState<{ mode: 'create' | 'rebind'; prefill?: { name?: string; folder?: string; org?: string } } | null>(null);
  const [orgDialog, setOrgDialog] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ action: ProjectAction; topic: string } | null>(null);
  const searchRef = useRef<TextInputRef>(null);
  const composerRef = useRef<TextInputRef>(null);

  const setDock = useCallback((p: DockPage) => {
    setDockState(p);
    writeDock(p);
    setOverlay({ kind: 'none' });
  }, []);

  useEffect(() => {
    if (narrow && !localStorage.getItem(PROJECT_OPEN_KEY)) setProjectOpen(false);
  }, [narrow]);

  // Debug notes are stamped with where the app is.
  const whereRef = useRef({ state, dock, overlay, phone });
  whereRef.current = { state, dock, overlay, phone };
  useEffect(() => {
    setDebugWhere(() => {
      const { state: s, dock: d, overlay: o } = whereRef.current;
      const room = selectedRoom(s);
      const conv = selectedConv(s);
      const page = o.kind === 'conversation' ? (getConversationTab() === 'files' ? 'files' : 'conversation') : o.kind === 'project' ? 'project' : o.kind === 'profile' ? 'profile' : d;
      return { page, org: room?.app?.org ?? null, project: room?.name ?? null, conversation: conv ? convTitle(conv) : null };
    });
  }, []);

  // A conversation got selected: show it on top.
  const lastConv = useRef<string | null>(null);
  useEffect(() => {
    const key = state.selected.topic && state.selected.conv ? `${state.selected.topic}/${state.selected.conv}` : null;
    if (key && key !== lastConv.current && lastConv.current !== null) setOverlay({ kind: 'conversation' });
    if (key && lastConv.current === null && !phone) setOverlay({ kind: 'conversation' });
    lastConv.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selected]);

  const goConversation = useCallback(() => setOverlay({ kind: 'conversation' }), []);
  const closeOverlay = useCallback(() => setOverlay({ kind: 'none' }), []);

  const toggleProject = useCallback(() => {
    if (phone) {
      setOverlay((o) => (o.kind === 'project' ? { kind: 'conversation' } : { kind: 'project' }));
      return;
    }
    setProjectOpen((o) => {
      localStorage.setItem(PROJECT_OPEN_KEY, o ? '0' : '1');
      return !o;
    });
  }, [phone]);

  const createProject = useCallback(
    async (p: NewProjectSubmit) => {
      const res = await actions.createProject(p);
      if ('pending' in res) {
        toast({ title: `Asked ${res.asked} to create it.`, description: res.online ? 'It will appear in a moment.' : `It will appear when ${res.asked} is online.`, tone: 'info', duration: 6000 });
        return;
      }
      toast({ title: 'Project ready.', description: `@${res.seat} is listening.`, tone: 'success' });
      goConversation();
    },
    [actions, toast, goConversation],
  );
  const newProject = useCallback((prefill?: { name?: string; org?: string }) => setDialog({ mode: 'create', prefill }), []);

  const changeFolder = useCallback(async () => {
    const topic = state.selected.topic;
    if (!topic) return;
    const bridge = rkc();
    const bind = async (folder: string) => {
      await actions.bindFolder(topic, folder);
      toast({ title: 'Folder bound', description: folder, tone: 'success' });
    };
    if (bridge?.pickFolder) {
      try {
        const folder = await bridge.pickFolder();
        if (folder) await bind(folder);
      } catch (e) {
        toast({ title: 'Could not bind the folder', description: (e as Error).message, tone: 'danger' });
      }
      return;
    }
    setDialog({ mode: 'rebind', prefill: { folder: state.rooms[topic]?.folder ?? '' } });
  }, [actions, state.selected.topic, state.rooms, toast]);

  const newConversation = useCallback(async () => {
    const topic = state.selected.topic ?? state.roomOrder[0];
    if (!topic) return;
    try {
      await actions.createConversation(topic);
      goConversation();
      setTimeout(() => composerRef.current?.focus(), 50);
    } catch (e) {
      toast({ title: 'Could not create the conversation', description: (e as Error).message, tone: 'danger' });
    }
  }, [actions, state.selected.topic, state.roomOrder, goConversation, toast]);

  const shortcuts = useMemo(
    () => [
      { key: 'n', mod: true, handler: (e: KeyboardEvent) => { e.preventDefault(); void newConversation(); } },
      { key: 'k', mod: true, handler: (e: KeyboardEvent) => { e.preventDefault(); setDock('projects'); setTimeout(() => searchRef.current?.focus(), 30); } },
      { key: 'i', mod: true, handler: (e: KeyboardEvent) => { e.preventDefault(); toggleProject(); } },
    ],
    [newConversation, toggleProject, setDock],
  );
  useShortcuts(shortcuts);

  const openProfile = useCallback(
    (name: string) => {
      const topic = state.selected.topic ?? state.roomOrder.find((t) => (state.details[t]?.participants ?? []).some((p) => p.name === name)) ?? state.roomOrder[0];
      if (!topic) return;
      setOverlay({ kind: 'profile', topic, name });
    },
    [state.selected.topic, state.roomOrder, state.details],
  );
  const onProjectAction = useCallback((action: ProjectAction, topic: string) => setProjectDialog({ action, topic }), []);
  const openProjects = useCallback(
    (org?: string) => {
      if (org) setOrgFilter(org);
      setDock('projects');
    },
    [setDock],
  );

  const projectDialogRoom = projectDialog ? state.rooms[projectDialog.topic] : null;
  const dialogs = (
    <>
      <NewProjectDialog
        open={!!dialog}
        mode={dialog?.mode ?? 'create'}
        prefill={dialog?.prefill}
        onClose={() => setDialog(null)}
        onCreate={createProject}
        onRebind={async (folder) => {
          if (!state.selected.topic) return;
          await actions.bindFolder(state.selected.topic, folder);
          toast({ title: 'Folder bound', description: folder, tone: 'success' });
        }}
      />
      <NewOrgDialog open={orgDialog} onClose={() => setOrgDialog(false)} onSubmit={(org) => setDialog({ mode: 'create', prefill: { org } })} />
      <RenameProjectDialog open={projectDialog?.action === 'rename'} name={projectDialogRoom?.name ?? ''} onClose={() => setProjectDialog(null)} onSubmit={async (name) => { await actions.renameRoom(projectDialog!.topic, name); toast({ title: 'Renamed', description: name, tone: 'success' }); }} />
      <MoveToOrgDialog open={projectDialog?.action === 'org'} current={projectDialogRoom?.app?.org ?? null} orgs={orgNames(orderedRooms(state))} onClose={() => setProjectDialog(null)} onSubmit={async (org) => { await actions.setRoomOrg(projectDialog!.topic, org); toast({ title: org ? `Moved to ${org}` : 'Removed from its organization', tone: 'success' }); }} />
      <RemoveProjectDialog
        open={projectDialog?.action === 'remove'}
        name={projectDialogRoom?.name ?? ''}
        folder={projectDialogRoom?.folder}
        onClose={() => setProjectDialog(null)}
        onSubmit={async () => {
          await actions.removeRoom(projectDialog!.topic);
          toast({ title: 'Removed from this device', description: projectDialogRoom?.folder ? 'The folder stays on disk.' : undefined });
          setOverlay({ kind: 'none' });
        }}
      />
    </>
  );

  const unread = feedUnread(state.feed);
  const dockItems: DockItem[] = [
    { key: 'home', icon: 'home', label: 'Home' },
    { key: 'activity', icon: 'bell-fill', label: 'Activity', badge: unread || undefined },
    { key: 'projects', icon: 'folder-fill', label: 'Projects' },
    { key: 'settings', icon: 'setting-2-bold', label: 'Settings' },
  ];

  const pageNode = (dockPage: DockPage) =>
    dockPage === 'home' ? (
      <HomePage phone={phone} onOpenProjects={openProjects} onOpenActivity={() => setDock('activity')} onOpenProfile={openProfile} onNavigate={goConversation} />
    ) : dockPage === 'activity' ? (
      <ActivityPage phone={phone} onNavigate={goConversation} />
    ) : dockPage === 'projects' ? (
      <ProjectsPage phone={phone} orgFilter={orgFilter} onOrgFilter={setOrgFilter} onNewProject={newProject} onNewOrg={() => setOrgDialog(true)} onProjectAction={onProjectAction} onNavigate={goConversation} />
    ) : (
      <SettingsPage phone={phone} dock />
    );

  const overlayNode =
    overlay.kind === 'conversation' ? (
      <ConversationPane phone={phone} projectOpen={phone ? false : projectOpen} onToggleProject={toggleProject} onBack={phone ? closeOverlay : undefined} onOpenProfile={openProfile} composerRef={composerRef} />
    ) : overlay.kind === 'project' ? (
      <ProjectPane phone onClose={() => setOverlay({ kind: 'conversation' })} onChangeFolder={changeFolder} onProjectAction={onProjectAction} onOpenProfile={openProfile} />
    ) : overlay.kind === 'profile' ? (
      <ProfilePage topic={overlay.topic} name={overlay.name} phone={phone} onBack={() => setOverlay(state.selected.topic && state.selected.conv && !phone ? { kind: 'conversation' } : { kind: 'none' })} />
    ) : null;

  if (phone) {
    return (
      <AppWindow>
        <View className="relative min-h-0 flex-1">
          {overlayNode ?? pageNode(dock)}
          {overlay.kind === 'none' ? <Dock items={dockItems} value={dock} onChange={(k) => setDock(k as DockPage)} inset={`calc(10px + ${SAFE_BOTTOM})`} /> : null}
        </View>
        {dialogs}
      </AppWindow>
    );
  }

  // Desktop: the sidebar's tab is the dock page; Settings and a profile take the middle; otherwise the conversation.
  const middle =
    dock === 'settings' ? (
      <SettingsPage phone={false} onBack={() => setDock(state.selected.conv ? 'projects' : 'home')} />
    ) : overlay.kind === 'profile' ? (
      overlayNode
    ) : state.selected.topic && state.selected.conv ? (
      <ConversationPane phone={false} projectOpen={projectOpen} onToggleProject={toggleProject} onOpenProfile={openProfile} composerRef={composerRef} />
    ) : (
      <Pane glow>
        <PaneHeader title="rKeyChat" subtitle={state.ready ? 'Pick a conversation' : 'Connecting…'} dragRegion />
        <EmptyState icon="message" title={state.roomOrder.length ? 'Pick a conversation' : 'Start with a project'} description={state.roomOrder.length ? 'Choose one under Projects, or press ⌘N.' : 'Press + under Projects, or drop a folder on the sidebar.'} />
      </Pane>
    );

  return (
    <AppWindow>
      <DesktopSidebar tab={dock} onTab={setDock} orgFilter={orgFilter} onOrgFilter={setOrgFilter} onNewProject={newProject} onNewOrg={() => setOrgDialog(true)} onProjectAction={onProjectAction} onOpenProfile={openProfile} searchRef={searchRef} />
      {middle}
      {projectOpen && dock !== 'settings' && overlay.kind !== 'profile' && state.selected.topic && state.selected.conv ? <ProjectPane width={PROJECT_WIDTH} phone={false} onClose={toggleProject} onChangeFolder={changeFolder} onProjectAction={onProjectAction} onOpenProfile={openProfile} /> : null}
      {dialogs}
    </AppWindow>
  );
}

export default App;
