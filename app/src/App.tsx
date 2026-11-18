/**
 * The shell: three PearKit panes (projects · conversation · project) on a desktop, three pages on a phone.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextInputRef } from './hooks';
import { ConversationPane } from './components/ConversationPane';
import { NewProjectDialog } from './components/NewProjectDialog';
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
    async (folder: string, name?: string) => {
      const { seat } = await actions.createProject(folder, name);
      toast({ title: 'Project ready.', description: `@${seat} is listening.`, tone: 'success' });
      if (phone) setPage('conv');
    },
    [actions, toast, phone],
  );

  const newProject = useCallback(
    async (prefill?: { name?: string }) => {
      const bridge = rkc();
      if (bridge?.pickFolder && !prefill) {
        try {
          const folder = await bridge.pickFolder();
          if (folder) await createProject(folder);
          return;
        } catch (e) {
          toast({ title: 'Could not create the project', description: (e as Error).message, tone: 'danger' });
          return;
        }
      }
      // No native picker (a browser tab): type the path.
      setDialog({ mode: 'create', prefill });
    },
    [createProject, toast],
  );

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

  const openSettings = () =>
    toast({ title: 'Settings live in the classic page for now.', action: { label: 'Open', onPress: () => window.location.assign('/') } });

  const dialogNode = (
    <NewProjectDialog
      open={!!dialog}
      mode={dialog?.mode ?? 'create'}
      prefill={dialog?.prefill}
      onClose={() => setDialog(null)}
      onSubmit={async (folder, name) => {
        if (dialog?.mode === 'rebind' && state.selected.topic) {
          await actions.bindFolder(state.selected.topic, folder);
          toast({ title: 'Folder bound', description: folder, tone: 'success' });
        } else await createProject(folder, name);
      }}
    />
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
