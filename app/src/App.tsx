/**
 * The shell. Desktop: Home list (feed + projects) on the left, the view in the middle (home, a conversation, a
 * profile, settings), the project on the right. Phone: the same as pages.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConversationPane } from './components/ConversationPane';
import { HomeList, type ProjectAction } from './components/HomeList';
import { HomePage } from './components/HomePage';
import { NewProjectDialog, type NewProjectSubmit } from './components/NewProjectDialog';
import { ProfilePage } from './components/ProfilePage';
import { MoveToOrgDialog, NewOrgDialog, RemoveProjectDialog, RenameProjectDialog } from './components/ProjectDialogs';
import { ProjectPane } from './components/ProjectPane';
import { SettingsPage } from './components/SettingsPage';
import { rkc, useShortcuts, useViewport, type TextInputRef } from './hooks';
import { AppWindow, ThemeProvider, ToastProvider, useToast } from './kit';
import { StoreProvider, useStore } from './store/context';
import { convTitle, orgNames, orderedRooms, selectedConv, selectedRoom } from './store/selectors';
import { getConversationTab, setDebugWhere } from './debugNotes';

const PROJECT_WIDTH = 332;
const PROJECT_OPEN_KEY = 'rkc.app.project-open';

type View = { kind: 'home' } | { kind: 'conversation' } | { kind: 'profile'; topic: string; name: string } | { kind: 'settings' };

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
  const { width, phone, narrow } = useViewport();
  const [view, setView] = useState<View>({ kind: 'home' });
  // Phone: the home list is its own page under the view; the project is a sheet over a conversation.
  const [phonePage, setPhonePage] = useState<'home' | 'view' | 'project'>('home');
  const [projectOpen, setProjectOpen] = useState(() => {
    const saved = localStorage.getItem(PROJECT_OPEN_KEY);
    return saved ? saved === '1' : window.innerWidth >= 1040;
  });
  const [dialog, setDialog] = useState<{ mode: 'create' | 'rebind'; prefill?: { name?: string; folder?: string; org?: string } } | null>(null);
  const [orgDialog, setOrgDialog] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ action: ProjectAction; topic: string } | null>(null);
  const searchRef = useRef<TextInputRef>(null);
  const composerRef = useRef<TextInputRef>(null);

  useEffect(() => {
    if (narrow && !localStorage.getItem(PROJECT_OPEN_KEY)) setProjectOpen(false);
  }, [narrow]);

  // Debug notes are stamped with where the app is.
  const whereRef = useRef({ state, view, phonePage, phone });
  whereRef.current = { state, view, phonePage, phone };
  useEffect(() => {
    setDebugWhere(() => {
      const { state: s, view: v, phonePage: pp, phone: ph } = whereRef.current;
      const room = selectedRoom(s);
      const conv = selectedConv(s);
      const page = ph && pp === 'home' ? 'home' : ph && pp === 'project' ? 'project' : v.kind === 'conversation' ? (getConversationTab() === 'files' ? 'files' : 'conversation') : v.kind;
      return { page, org: room?.app?.org ?? null, project: room?.name ?? null, conversation: conv ? convTitle(conv) : null };
    });
  }, []);

  const toggleProject = useCallback(() => {
    if (phone) {
      setPhonePage((p) => (p === 'project' ? 'view' : 'project'));
      return;
    }
    setProjectOpen((o) => {
      localStorage.setItem(PROJECT_OPEN_KEY, o ? '0' : '1');
      return !o;
    });
  }, [phone]);

  // A conversation got selected: show it.
  const lastConv = useRef<string | null>(null);
  useEffect(() => {
    const key = state.selected.topic && state.selected.conv ? `${state.selected.topic}/${state.selected.conv}` : null;
    if (key && key !== lastConv.current) {
      if (lastConv.current !== null || view.kind !== 'home') setView({ kind: 'conversation' });
      if (phone && lastConv.current !== null) setPhonePage('view');
    }
    lastConv.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selected, phone]);

  const goConversation = useCallback(() => {
    setView({ kind: 'conversation' });
    if (phone) setPhonePage('view');
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
      { key: 'k', mod: true, handler: (e: KeyboardEvent) => { e.preventDefault(); if (phone) setPhonePage('home'); searchRef.current?.focus(); } },
      { key: 'i', mod: true, handler: (e: KeyboardEvent) => { e.preventDefault(); toggleProject(); } },
    ],
    [newConversation, toggleProject, phone],
  );
  useShortcuts(shortcuts);

  const openProfile = useCallback(
    (name: string) => {
      const topic = state.selected.topic;
      if (!topic) return;
      setView({ kind: 'profile', topic, name });
      if (phone) setPhonePage('view');
    },
    [state.selected.topic, phone],
  );
  const openSettings = useCallback(() => {
    setView({ kind: 'settings' });
    if (phone) setPhonePage('view');
  }, [phone]);
  const openHome = useCallback(() => {
    setView({ kind: 'home' });
    if (phone) setPhonePage('home');
  }, [phone]);
  const backToConversation = useCallback(() => {
    if (state.selected.topic && state.selected.conv) setView({ kind: 'conversation' });
    else setView({ kind: 'home' });
    if (phone && !(state.selected.topic && state.selected.conv)) setPhonePage('home');
  }, [state.selected, phone]);

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
      <RenameProjectDialog
        open={projectDialog?.action === 'rename'}
        name={projectDialogRoom?.name ?? ''}
        onClose={() => setProjectDialog(null)}
        onSubmit={async (name) => {
          await actions.renameRoom(projectDialog!.topic, name);
          toast({ title: 'Renamed', description: name, tone: 'success' });
        }}
      />
      <MoveToOrgDialog
        open={projectDialog?.action === 'org'}
        current={projectDialogRoom?.app?.org ?? null}
        orgs={orgNames(orderedRooms(state))}
        onClose={() => setProjectDialog(null)}
        onSubmit={async (org) => {
          await actions.setRoomOrg(projectDialog!.topic, org);
          toast({ title: org ? `Moved to ${org}` : 'Removed from its organization', tone: 'success' });
        }}
      />
      <RemoveProjectDialog
        open={projectDialog?.action === 'remove'}
        name={projectDialogRoom?.name ?? ''}
        folder={projectDialogRoom?.folder}
        onClose={() => setProjectDialog(null)}
        onSubmit={async () => {
          await actions.removeRoom(projectDialog!.topic);
          toast({ title: 'Removed from this device', description: projectDialogRoom?.folder ? 'The folder stays on disk.' : undefined });
          openHome();
        }}
      />
    </>
  );

  const onProjectAction = useCallback((action: ProjectAction, topic: string) => setProjectDialog({ action, topic }), []);

  const middle =
    view.kind === 'home' ? (
      <HomePage onNavigate={goConversation} />
    ) : view.kind === 'profile' ? (
      <ProfilePage topic={view.topic} name={view.name} phone={phone} onBack={backToConversation} />
    ) : view.kind === 'settings' ? (
      <SettingsPage phone={phone} onBack={backToConversation} />
    ) : (
      <ConversationPane phone={phone} projectOpen={phone ? phonePage === 'project' : projectOpen} onToggleProject={toggleProject} onBack={phone ? () => setPhonePage('home') : undefined} onOpenProfile={openProfile} composerRef={composerRef} />
    );

  const list = <HomeList onNewProject={newProject} onNewOrg={() => setOrgDialog(true)} onOpenSettings={openSettings} onOpenHome={openHome} onProjectAction={onProjectAction} searchRef={searchRef} fullWidth={phone ? width : undefined} onNavigate={phone ? goConversation : undefined} homeActive={view.kind === 'home'} />;

  if (phone) {
    const page = phonePage === 'home' || (phonePage === 'view' && view.kind === 'home') ? 'home' : phonePage;
    return (
      <AppWindow>
        {page === 'home' ? list : page === 'project' ? <ProjectPane phone onClose={() => setPhonePage('view')} onChangeFolder={changeFolder} onProjectAction={onProjectAction} onOpenProfile={openProfile} /> : middle}
        {dialogs}
      </AppWindow>
    );
  }

  return (
    <AppWindow>
      {list}
      {middle}
      {projectOpen && view.kind === 'conversation' ? <ProjectPane width={PROJECT_WIDTH} phone={false} onClose={toggleProject} onChangeFolder={changeFolder} onProjectAction={onProjectAction} onOpenProfile={openProfile} /> : null}
      {dialogs}
    </AppWindow>
  );
}

export default App;
