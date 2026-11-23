/**
 * A conversation: one glass bar at the top (chat · files · ⋯), the messages as bubbles, who is thinking, the
 * composer. A tap on a message shows reply / copy / + and the six most-used emoji; selecting text offers a
 * quote-reply of just the selection.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { SAFE_BOTTOM, SAFE_TOP, isTouch, useKeyboardOpen, type TextInputRef } from '../hooks';
import { AskCard, AskFold, Button, Composer, Dialog, EmojiPicker, EmptyState, GlassBar, GlassBarButton, IconButton, MessageList, Pane, SegmentedControl, StatusDot, Text, TextField, Toggle, copyToClipboard, useToast, type AskChoice, type ChatMessage } from '../kit';
import type { Rec } from '../types';
import { useStore } from '../store/context';
import { bumpEmoji, readEmojiCounts, saveEmojiCounts, topEmoji } from '../store/emoji';
import { collapseActivity, inThread, mergeThread, pairAsks, toChatMessage } from '../store/mapping';
import { convKey } from '../store/reducer';
import { convTitle, selectedConv, selectedRoom, selectedThread, thinkingIn } from '../store/selectors';
import { FilesView } from './FilesView';
import { DebugButton } from './DebugButton';
import { setConversationTab } from '../debugNotes';

export type ConversationTab = 'chat' | 'files';

export interface ConversationPaneProps {
  phone: boolean;
  projectOpen: boolean;
  onToggleProject: () => void;
  onBack?: () => void;
  onOpenProfile: (name: string) => void;
  composerRef: React.RefObject<TextInputRef | null>;
}

const STEPS_KEY = 'rkc.app.all-steps';
const BAR = 56;

type Reply = { id: string; name: string; text: string; quote?: string };

export function ConversationPane({ phone, projectOpen, onToggleProject, onBack, onOpenProfile, composerRef }: ConversationPaneProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const room = selectedRoom(state);
  const conv = selectedConv(state);
  const thread = selectedThread(state);
  const topic = state.selected.topic;
  const convId = state.selected.conv;
  const key = topic && convId ? convKey(topic, convId) : null;
  const touch = isTouch();
  const keyboard = useKeyboardOpen();

  const [tab, setTabState] = useState<ConversationTab>('chat');
  const setTab = (t: ConversationTab) => {
    setTabState(t);
    setConversationTab(t);
  };
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [allSteps, setAllSteps] = useState(() => localStorage.getItem(STEPS_KEY) === '1');
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [emojiCounts, setEmojiCounts] = useState(readEmojiCounts);
  const drafts = useRef<Record<string, string>>({});

  useEffect(() => {
    setDraft(key ? drafts.current[key] ?? '' : '');
    setReply(null);
    setRenaming(false);
    setTab('chat');
  }, [key]);
  const changeDraft = (t: string) => {
    setDraft(t);
    if (key) drafts.current[key] = t;
  };

  const activity = key ? state.activity[key] : undefined;
  // the agents' asks in this thread, each with its answer when one came (the first admitted 'answer' control)
  const asks = useMemo(() => pairAsks(thread?.items ?? []), [thread]);
  const { messages, folds } = useMemo(() => {
    if (!thread || !key) return { messages: [] as ChatMessage[], folds: new Map<string, Rec>() };
    const reactions = topic ? state.details[topic]?.reactions : undefined;
    // a seat's settings and the answers to asks are not lines of their own (the profile and the ask's card carry them)
    const merged = mergeThread(thread.items.filter(inThread), activity ?? []);
    const shown = allSteps ? merged : collapseActivity(merged, asks);
    return { messages: shown.map((r) => toChatMessage(r, { me: state.me?.human ?? null, reactions })), folds: new Map(shown.filter((r) => r.kind === 'fold').map((r) => [r.id, r])) };
  }, [thread, key, topic, activity, state.details, state.me, allSteps, asks]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const [answering, setAnswering] = useState<string | null>(null);
  // one of the owner's own devices (the daemon's own test, so the phone counts); an older daemon says only `owner`
  const canAnswer = !!state.me?.human && !!(topic && (state.details[topic]?.ownerDevice ?? state.details[topic]?.owner));
  const answerAsk = async (id: string, choice: AskChoice) => {
    if (!topic) return;
    setAnswering(id);
    try {
      await actions.answerAsk(topic, id, choice);
    } catch (e) {
      toast({ title: 'Could not answer', description: (e as Error).message, tone: 'danger' });
    } finally {
      setAnswering(null);
    }
  };
  const hasSteps = !!activity?.length || asks.size > 0;
  const favourites = useMemo(() => topEmoji(emojiCounts, 6), [emojiCounts]);

  const thinking = topic && convId ? thinkingIn(state, topic, convId) : [];

  const react = (id: string, emoji: string) => {
    const mine = byId.get(id)?.reactions?.find((r) => r.emoji === emoji)?.mine;
    if (!mine) {
      const next = bumpEmoji(emojiCounts, emoji);
      setEmojiCounts(next);
      saveEmojiCounts(next);
    }
    actions.react(topic!, id, emoji, !mine).catch((e) => toast({ title: 'Could not react', description: (e as Error).message, tone: 'danger' }));
  };

  const send = async () => {
    const text = draft;
    if (!topic || !convId || !text.trim()) return;
    setSending(true);
    const body = reply?.quote ? `> ${reply.quote.replace(/\n/g, '\n> ')}\n\n${text}` : text;
    const re = reply ? [reply.id] : undefined;
    changeDraft('');
    setReply(null);
    try {
      await actions.send(topic, convId, body, re);
    } catch (e) {
      changeDraft(text);
      toast({ title: 'Could not send', description: (e as Error).message, tone: 'danger' });
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  };

  const loadOlder = useCallback(() => {
    if (topic && convId) actions.loadOlder(topic, convId).catch((e) => toast({ title: 'Could not load earlier messages', description: (e as Error).message, tone: 'danger' }));
  }, [topic, convId, actions, toast]);

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
      toast({ title: 'Conversation archived', description: 'Find it under Archived in the project.', action: { label: 'Undo', onPress: () => void actions.archiveConversation(topic, convId, false) } });
      void actions.select(topic, 'main');
    } catch (e) {
      toast({ title: 'Could not archive', description: (e as Error).message, tone: 'danger' });
    }
  };

  const title = convTitle(conv);
  // Under the composer: the home bar's inset while the keyboard is down; with the keyboard up the inset is covered,
  // so only a hair of space, and the field sits right on the keyboard.
  const composerStyle = phone ? ({ paddingBottom: keyboard ? 4 : `calc(8px + ${SAFE_BOTTOM})` } as never) : { paddingBottom: 10 };
  // The glass bar is absolute inside a box of its own height, so it reads as a pinned bar under the safe area.
  const barBox = phone ? ({ height: `calc(${BAR}px + ${SAFE_TOP})` } as never) : { height: BAR };
  const back = onBack ? <IconButton icon="chevron-left" size="sm" hitSlop={10} accessibilityLabel="Back" onPress={onBack} className="-ml-1 app-region-no-drag" /> : undefined;

  const bar = (titleText: string, subtitle?: string, buttons?: React.ReactNode) => (
    <View className="relative w-full" style={barBox}>
      <GlassBar inset={phone ? SAFE_TOP : 0} className="app-region-drag">
        {back}
        <Pressable accessibilityRole="button" accessibilityLabel="Conversation" onPress={() => room && setRenaming(true)} className={`min-w-0 flex-1 app-region-no-drag ${Platform.OS === 'web' ? 'cursor-pointer' : ''}`}>
          <Text variant={phone ? 'body-lg' : 'title'} numberOfLines={1}>
            {titleText}
          </Text>
          {subtitle ? (
            <Text variant="caption" tone="subtle" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </Pressable>
        <View className="flex-row items-center gap-1 app-region-no-drag">
          {buttons}
          <DebugButton className="ml-1" />
        </View>
      </GlassBar>
    </View>
  );

  if (!room || !conv) {
    return (
      <Pane glow>
        {bar('rKeyChat', state.ready ? (state.roomOrder.length ? 'Pick a conversation' : 'No projects yet') : 'Connecting…')}
        {state.error ? (
          <EmptyState icon="wifi-slash" title="The daemon is not answering" description={state.error} actions={<Button label="Retry" onPress={() => void actions.reload()} />} />
        ) : state.ready ? (
          <EmptyState icon="message" title={state.roomOrder.length ? 'Pick a conversation' : 'Start with a project'} description={state.roomOrder.length ? 'Choose one on the left, or press ⌘N for a new one.' : 'Press + on the left to start a project.'} />
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
      {bar(
        title,
        room.name,
        <>
          <GlassBarButton icon="message-fill" accessibilityLabel="Chat" active={tab === 'chat'} onPress={() => setTab('chat')} />
          <GlassBarButton icon="document-fill" accessibilityLabel="Files" active={tab === 'files'} onPress={() => setTab('files')} />
          <GlassBarButton icon="more-fill" accessibilityLabel="Project" active={projectOpen} onPress={onToggleProject} />
        </>,
      )}
      {tab === 'files' ? (
        <FilesView topic={topic!} />
      ) : !thread?.loaded ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <View className="min-h-0 flex-1">
          <MessageList
            look="bubbles"
            messages={messages}
            currentUserId={state.me?.human ?? undefined}
            renderMessage={(m) => {
              // the permissions of one stretch of work, as one block (collapseActivity)
              const f = folds.get(m.id);
              if (f?.fold) return <AskFold agent={f.name} asks={f.fold.asks} steps={f.fold.steps} className="my-0.5" />;
              const a = asks.get(m.id);
              if (!a) return undefined;
              return <AskCard agent={a.rec.name} tool={a.rec.tool ?? ''} what={a.rec.what ?? ''} detail={a.rec.input} ts={a.rec.ts} expires={a.rec.expires ?? 0} answer={a.answer} canAnswer={canAnswer} lockHint="Only the owner's own devices can answer" busy={answering === m.id} onAnswer={(c) => void answerAsk(m.id, c)} className="my-1" />;
            }}
            onReact={react}
            quickReactions={favourites}
            onAuthorPress={(a) => onOpenProfile(a.name)}
            onMore={(m) => setPickerFor(m.id)}
            onReply={(id) => {
              const m = byId.get(id);
              if (m) setReply({ id: m.id, name: m.author.name, text: m.text });
              composerRef.current?.focus();
            }}
            onReplyToSelection={(m, text) => {
              setReply({ id: m.id, name: m.author.name, text, quote: text });
              composerRef.current?.focus();
            }}
            onCopy={(text) => {
              void copyToClipboard(text);
              toast({ title: 'Copied', duration: 1200 });
            }}
            onOpenAttachment={(a) => a.url && window.open(a.url, '_blank')}
            onLinkPress={(url) => void window.open(url, '_blank')}
            header={
              !thread.hasOlder && messages.length ? (
                <View className="items-center py-2">
                  <Text variant="micro" tone="subtle">
                    The beginning of this conversation
                  </Text>
                </View>
              ) : undefined
            }
            onReachTop={thread.hasOlder ? loadOlder : undefined}
            loadingOlder={thread.loadingOlder}
            emptyState={<EmptyState icon="message" title="New conversation." description="Say what you want to work on." />}
          />
        </View>
      )}
      {tab === 'chat' ? (
        <View className="gap-1 px-3" style={composerStyle}>
          {/* the status line only when there is something to say: otherwise the messages run right down to the field */}
          {thinking.length || hasSteps ? (
          <View className="h-5 flex-row items-center gap-1.5 px-1">
            {thinking.length ? (
              <>
                <StatusDot tone="primary" size={6} pulse />
                <Pressable onPress={() => onOpenProfile(thinking[0])} className="min-w-0 flex-1">
                  <Text variant="micro" tone="subtle" numberOfLines={1}>
                    {thinking.map((n) => `@${n}`).join(', ')} {thinking.length === 1 ? 'is' : 'are'} thinking…
                  </Text>
                </Pressable>
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
          ) : null}
          <Composer
            ref={composerRef}
            value={draft}
            onChangeText={changeDraft}
            onSend={send}
            sending={sending}
            placeholder={`Message ${room.name}`}
            replyTo={reply ? { name: reply.name, text: reply.quote ? `“${reply.quote}”` : reply.text } : null}
            onCancelReply={() => setReply(null)}
            disabled={!state.me?.human}
          />
        </View>
      ) : null}
      <EmojiPicker open={!!pickerFor} onClose={() => setPickerFor(null)} recent={favourites} onPick={(e) => pickerFor && react(pickerFor, e)} />
      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        icon="document"
        title="Conversation"
        actions={
          <>
            <Button label="Archive" variant="ghost" disabled={convId === 'main'} onPress={() => { setRenaming(false); void archive(); }} />
            <Button label="Runtime…" variant="ghost" onPress={() => { setRenaming(false); setRuntimeOpen(true); }} />
          </>
        }
      >
        {renaming ? <RenameField initial={title} onDone={rename} onCancel={() => setRenaming(false)} /> : null}
      </Dialog>
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
    const t = setTimeout(() => ref.current?.focus(), 60);
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
  return <TextField ref={ref} label="Title" value={value} onChangeText={setValue} onSubmitEditing={() => onDone(value)} selectTextOnFocus accessibilityLabel="Conversation title" hint="Enter saves." {...({ onKeyDown } as object)} />;
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
      <SegmentedControl options={RUNTIMES} value={pick} onChange={setPick} fullWidth />
    </Dialog>
  );
}
