/**
 * Middle column: one conversation. Header (rename inline, menu), the messages, who is thinking, the composer.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { rkc, type TextInputRef } from '../hooks';
import { Button, Composer, Dialog, EmptyState, IconButton, MenuButton, MessageList, Pane, PaneHeader, SegmentedControl, StatusDot, Text, TextField, Toggle, useToast, type MenuItem } from '../kit';
import { useStore } from '../store/context';
import { collapseActivity, mergeThread, toChatMessage } from '../store/mapping';
import { convKey } from '../store/reducer';
import { convTitle, selectedConv, selectedRoom, selectedThread, thinkingIn } from '../store/selectors';

export interface ConversationPaneProps {
  phone: boolean;
  projectOpen: boolean;
  onToggleProject: () => void;
  onBack?: () => void;
  composerRef: React.RefObject<TextInputRef | null>;
}

const STEPS_KEY = 'rkc.app.all-steps';

export function ConversationPane({ phone, projectOpen, onToggleProject, onBack, composerRef }: ConversationPaneProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const room = selectedRoom(state);
  const conv = selectedConv(state);
  const thread = selectedThread(state);
  const topic = state.selected.topic;
  const convId = state.selected.conv;
  const key = topic && convId ? convKey(topic, convId) : null;

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [allSteps, setAllSteps] = useState(() => localStorage.getItem(STEPS_KEY) === '1');
  const drafts = useRef<Record<string, string>>({});

  // One draft per conversation.
  useEffect(() => {
    setDraft(key ? drafts.current[key] ?? '' : '');
    setReplyTo(null);
    setRenaming(false);
  }, [key]);
  const changeDraft = (t: string) => {
    setDraft(t);
    if (key) drafts.current[key] = t;
  };

  const activity = key ? state.activity[key] : undefined;
  const messages = useMemo(() => {
    if (!thread || !key) return [];
    const reactions = topic ? state.details[topic]?.reactions : undefined;
    const merged = mergeThread(thread.items, activity ?? []);
    return (allSteps ? merged : collapseActivity(merged)).map((r) => toChatMessage(r, { me: state.me?.human ?? null, reactions }));
  }, [thread, key, topic, activity, state.details, state.me, allSteps]);
  const hasSteps = !!activity?.length;

  const thinking = topic && convId ? thinkingIn(state, topic, convId) : [];

  const send = async () => {
    const text = draft;
    if (!topic || !convId || !text.trim()) return;
    setSending(true);
    const re = replyTo ? [replyTo] : undefined;
    changeDraft('');
    setReplyTo(null);
    try {
      await actions.send(topic, convId, text, re);
    } catch (e) {
      changeDraft(text);
      toast({ title: 'Could not send', description: (e as Error).message, tone: 'danger' });
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  };

  const loadOlder = () => {
    if (topic && convId) actions.loadOlder(topic, convId).catch((e) => toast({ title: 'Could not load earlier messages', description: (e as Error).message, tone: 'danger' }));
  };

  const rename = async (title: string) => {
    setRenaming(false);
    const t = title.trim();
    if (!topic || !convId || !conv || !t || t === convTitle(conv)) return;
    try {
      await actions.renameConversation(topic, convId, t);
    } catch (e) {
      toast({ title: 'Could not rename', description: (e as Error).message, tone: 'danger' });
    }
  };

  const archive = async () => {
    if (!topic || !convId) return;
    try {
      await actions.archiveConversation(topic, convId, true);
      toast({ title: 'Conversation archived', description: 'Find it under Archived in the project pane.', action: { label: 'Undo', onPress: () => void actions.archiveConversation(topic, convId, false) } });
      void actions.select(topic, 'main');
    } catch (e) {
      toast({ title: 'Could not archive', description: (e as Error).message, tone: 'danger' });
    }
  };

  const bridge = rkc();
  const menu: MenuItem[] = [
    { key: 'rename', label: 'Rename', icon: 'document', onSelect: () => setRenaming(true) },
    { key: 'archive', label: 'Archive', icon: 'import', disabled: convId === 'main', onSelect: archive },
    { key: 'runtime', label: 'Switch runtime…', icon: 'refresh', onSelect: () => setRuntimeOpen(true) },
    ...(bridge?.openFolder && room?.folder ? [{ key: 'sep', separator: true } as MenuItem, { key: 'open', label: 'Open folder', icon: 'folder-open', onSelect: () => void bridge.openFolder?.(room.folder!) } as MenuItem] : []),
  ];

  const title = convTitle(conv);
  const replyRec = replyTo ? thread?.items.find((x) => x.id === replyTo) : null;
  const back = onBack ? <IconButton icon="chevron-left" size="sm" accessibilityLabel="Back" onPress={onBack} className="-ml-1 mr-1 app-region-no-drag" /> : undefined;

  if (!room || !conv) {
    return (
      <Pane glow>
        <PaneHeader title="rKeyChat" subtitle={state.ready ? (state.roomOrder.length ? 'Pick a conversation' : 'No projects yet') : 'Connecting…'} dragRegion leading={back} />
        {state.error ? (
          <EmptyState icon="wifi-slash" title="The daemon is not answering" description={state.error} actions={<Button label="Retry" onPress={() => void actions.reload()} />} />
        ) : state.ready ? (
          <EmptyState icon="message" title={state.roomOrder.length ? 'Pick a conversation' : 'Start with a project'} description={state.roomOrder.length ? 'Choose one on the left, or press ⌘N for a new one.' : 'Drop a folder on the sidebar, or press New project.'} />
        ) : (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator />
          </View>
        )}
      </Pane>
    );
  }

  return (
    <Pane glow>
      <PaneHeader
        dragRegion
        size={phone ? 'display' : 'title'}
        title={renaming ? ' ' : title}
        subtitle={renaming ? undefined : room.name}
        leading={back}
        actions={
          <View className="flex-row items-center gap-1">
            {renaming ? (
              <View className="w-[300px] app-region-no-drag">
                <RenameField initial={title} onDone={rename} onCancel={() => setRenaming(false)} />
              </View>
            ) : (
              <IconButton icon="document" size="sm" tooltip="Rename" onPress={() => setRenaming(true)} className="app-region-no-drag" />
            )}
            <MenuButton items={menu} tooltip="Conversation" size="sm" className="app-region-no-drag" />
            <IconButton icon="info-circle" size="sm" active={projectOpen} tooltip={{ label: projectOpen ? 'Hide project' : 'Show project', shortcut: '⌘I' }} onPress={onToggleProject} className="app-region-no-drag" />
          </View>
        }
      />
      {!thread?.loaded ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <>
          {thread.hasOlder ? (
            <View className="items-center pb-1">
              <Button size="sm" variant="ghost" icon="arrow-up" label="Earlier messages" loading={thread.loadingOlder} onPress={loadOlder} />
            </View>
          ) : null}
          <MessageList
            look="flat"
            messages={messages}
            currentUserId={state.me?.human ?? undefined}
            onReact={(id, emoji) => {
              const mine = messages.find((m) => m.id === id)?.reactions?.find((r) => r.emoji === emoji)?.mine;
              actions.react(topic!, id, emoji, !mine).catch((e) => toast({ title: 'Could not react', description: (e as Error).message, tone: 'danger' }));
            }}
            onReply={(id) => {
              setReplyTo(id);
              composerRef.current?.focus();
            }}
            onOpenAttachment={(a) => a.url && window.open(a.url, '_blank')}
            onCopy={(text) => void navigator.clipboard?.writeText(text)}
            emptyState={<EmptyState icon="message" title="New conversation." description="Say what you want to work on." />}
          />
        </>
      )}
      <View className="gap-1.5 px-4 pb-4 pt-1">
        <View className="h-5 flex-row items-center gap-1.5 px-1">
          {thinking.length ? (
            <>
              <StatusDot tone="primary" size={6} pulse />
              <Text variant="micro" tone="subtle" numberOfLines={1} className="min-w-0 flex-1">
                {thinking.map((n) => `@${n}`).join(', ')} {thinking.length === 1 ? 'is' : 'are'} thinking…
              </Text>
            </>
          ) : (
            <View className="flex-1" />
          )}
          {hasSteps ? (
            <Toggle
              size="sm"
              label="All steps"
              value={allSteps}
              onValueChange={(v) => {
                setAllSteps(v);
                localStorage.setItem(STEPS_KEY, v ? '1' : '0');
              }}
            />
          ) : null}
        </View>
        <Composer
          ref={composerRef}
          value={draft}
          onChangeText={changeDraft}
          onSend={send}
          sending={sending}
          placeholder={`Message ${room.name}`}
          replyTo={replyRec ? { name: replyRec.name, text: replyRec.text } : null}
          onCancelReply={() => setReplyTo(null)}
          disabled={!state.me?.human}
        />
      </View>
      <RuntimeDialog
        open={runtimeOpen}
        onClose={() => setRuntimeOpen(false)}
        value={conv.runtime}
        onSave={async (rt) => {
          setRuntimeOpen(false);
          try {
            await actions.setRuntime(topic!, convId!, rt);
            toast({ title: rt ? `Runtime switched to ${rt}` : 'Runtime set to the seat default', description: 'The next turn starts a fresh session with the same history.' });
          } catch (e) {
            toast({ title: 'Could not switch the runtime', description: (e as Error).message, tone: 'danger' });
          }
        }}
      />
    </Pane>
  );
}

function RenameField({ initial, onDone, onCancel }: { initial: string; onDone: (t: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<TextInputRef>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  const onKeyDown = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onDone(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  return <TextField ref={ref} size="sm" value={value} onChangeText={setValue} onBlur={() => onDone(value)} onSubmitEditing={() => onDone(value)} selectTextOnFocus accessibilityLabel="Conversation title" {...({ onKeyDown } as object)} />;
}

const RUNTIMES = [
  { value: 'default', label: 'Seat default' },
  { value: 'acp', label: 'acp' },
  { value: 'cli', label: 'cli' },
];

function RuntimeDialog({ open, onClose, value, onSave }: { open: boolean; onClose: () => void; value: string | null; onSave: (rt: string | null) => void }) {
  const [pick, setPick] = useState(value ?? 'default');
  useEffect(() => setPick(value ?? 'default'), [value, open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="refresh"
      title="Switch runtime"
      description="How this conversation's seat is driven. Switching retires the current session; the next turn re-reads the thread in the new runtime."
      actions={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label="Switch" variant="primary" onPress={() => onSave(pick === 'default' ? null : pick)} />
        </>
      }
    >
      <View className="gap-3">
        <SegmentedControl options={RUNTIMES} value={pick} onChange={setPick} fullWidth />
        <Text variant="caption" tone="subtle">
          Codex, Goose and a Hermes adapter arrive here as ACP commands later.
        </Text>
      </View>
    </Dialog>
  );
}
