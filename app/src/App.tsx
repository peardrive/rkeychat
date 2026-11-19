/**
 * The shell: three PearKit panes (projects · conversation · project) on a desktop, three pages on a phone.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextInputRef } from './hooks';
import { ConversationPane } from './components/ConversationPane';
import { NewProjectDialog, type NewProjectSubmit } from './components/NewProjectDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { ProjectSidebar } from './components/ProjectSidebar';
import { ProjectPane } from './components/ProjectPane';
import { rkc, useShortcuts, useViewport } from './hooks';
import { AppWindow, ThemeProvider, ToastProvider, useToast } from './kit';
import { StoreProvider, useStore } from './store/context';

const PROJECT_WIDTH = 320;
const PROJECT_OPEN_KEY = 'rkc.app.project-open';

type Page = 'list' | 'conv' | 'project';

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
  const [page, setPage] = useState<Page>('list');
  const [projectOpen, setProjectOpen] = useState(() => {
    const saved = localStorage.getItem(PROJECT_OPEN_KEY);
    return saved ? saved === '1' : window.innerWidth >= 1040;
  });
  const [dialog, setDialog] = useState<{ mode: 'create' | 'rebind'; prefill?: { name?: string; folder?: string } } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRef = useRef<TextInputRef>(null);
  const composerRef = useRef<TextInputRef>(null);

  // Narrow desktop: the project pane starts hidden; widening again brings back the saved choice.
  useEffect(() => {
    if (narrow && !localStorage.getItem(PROJECT_OPEN_KEY)) setProjectOpen(false);
  }, [narrow]);

  const toggleProject = useCallback(() => {
    if (phone) {
      setPage((p) => (p === 'project' ? 'conv' : 'project'));
      return;
    }
    setProjectOpen((o) => {
      localStorage.setItem(PROJECT_OPEN_KEY, o ? '0' : '1');
      return !o;
    });
  }, [phone]);

  // A conversation got selected on the phone: go to it.
  const lastConv = useRef<string | null>(null);
  useEffect(() => {
    const key = state.selected.topic && state.selected.conv ? `${state.selected.topic}/${state.selected.conv}` : null;
    if (key && key !== lastConv.current && lastConv.current !== null && phone) setPage('conv');
    lastConv.current = key;
  }, [state.selected, phone]);

  const createProject = useCallback(
    async (p: NewProjectSubmit) => {
      const res = await actions.createProject(p);
      if ('pending' in res) {
        toast({ title: `Asked ${res.asked} to create it.`, description: res.online ? `It will appear in a moment.` : `It will appear when ${res.asked} is online.`, tone: 'info', duration: 6000 });
        return;
      }
      toast({ title: 'Project ready.', description: `@${res.seat} is listening.`, tone: 'success' });
      if (phone) setPage('conv');
    },
    [actions, toast, phone],
  );

  // One dialog: name, where it lives, an existing folder (desktop, this device only), a prompt.
  const newProject = useCallback((prefill?: { name?: string }) => setDialog({ mode: 'create', prefill }), []);

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
      if (phone) setPage('conv');
      setTimeout(() => composerRef.current?.focus(), 50);
    } catch (e) {
      toast({ title: 'Could not create the conversation', description: (e as Error).message, tone: 'danger' });
    }
  }, [actions, state.selected.topic, state.roomOrder, phone, toast]);

  const shortcuts = useMemo(
    () => [
      { key: 'n', mod: true, handler: (e: KeyboardEvent) => { e.preventDefault(); void newConversation(); } },
      { key: 'k', mod: true, handler: (e: KeyboardEvent) => { e.preventDefault(); if (phone) setPage('list'); searchRef.current?.focus(); } },
      { key: 'i', mod: true, handler: (e: KeyboardEvent) => { e.preventDefault(); toggleProject(); } },
    ],
    [newConversation, toggleProject, phone],
  );
  useShortcuts(shortcuts);

  const openSettings = () => setSettingsOpen(true);

  const dialogNode = (
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
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );

  if (phone) {
    return (
      <AppWindow>
        {page === 'list' ? (
          <ProjectSidebar onNewProject={newProject} onOpenSettings={openSettings} searchRef={searchRef} fullWidth={width} onNavigate={() => setPage('conv')} />
        ) : page === 'conv' ? (
          <ConversationPane phone projectOpen={false} onToggleProject={toggleProject} onBack={() => setPage('list')} composerRef={composerRef} />
        ) : (
          <ProjectPane phone onClose={() => setPage('conv')} onChangeFolder={changeFolder} />
        )}
        {dialogNode}
      </AppWindow>
    );
  }

  return (
    <AppWindow>
      <ProjectSidebar onNewProject={newProject} onOpenSettings={openSettings} searchRef={searchRef} />
      <ConversationPane phone={false} projectOpen={projectOpen} onToggleProject={toggleProject} composerRef={composerRef} />
      {projectOpen ? <ProjectPane width={PROJECT_WIDTH} phone={false} onClose={toggleProject} onChangeFolder={changeFolder} /> : null}
      {dialogNode}
    </AppWindow>
  );
}

export default App;
