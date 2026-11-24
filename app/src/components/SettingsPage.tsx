/**
 * Settings in PearDrive's shape (PearKit SettingsBlock / SettingsRow): this device, the wiki, media, peers,
 * the agents on this device.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getApi } from '../api';
import { SAFE_TOP } from '../hooks';
import { Avatar, Button, Chip, IconButton, Pane, PaneBody, PaneHeader, SettingsBlock, SettingsRow, StatusDot, StatusPill, Text, TextField, Toggle, useToast } from '../kit';
import { useStore } from '../store/context';
import type { AgentInfo, DebugNoteInfo, DebugSpaceInfo, Person } from '../types';
import { AgentChoices } from './SetupFlow';
import { agentChoices } from '../store/setup';
import { DebugButton } from './DebugButton';
import { notePill, useDebugSync } from '../debugSync';
import { LinkField, copyToClipboard } from '../kit';
import { shortTime } from '../time';

const WIKI_KEY = 'rkc.app.wiki';

export function SettingsPage({ phone, onBack, dock }: { phone: boolean; onBack?: () => void; dock?: boolean }) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const [workspace, setWorkspace] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [wiki, setWiki] = useState(() => localStorage.getItem(WIKI_KEY) ?? '');
  const [people, setPeople] = useState<{ local: Person[]; known: Person[] } | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [debug, setDebug] = useState<(DebugSpaceInfo & { notes: DebugNoteInfo[] }) | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const { sync } = useDebugSync();
  // the AI new bots run on: the Claude login or a provider (the same choice cards as the first-run flow)
  const [aiChoice, setAiChoice] = useState<string | null>(null);
  // a provider of the person's own (a gateway that is none of the presets); the key is written, never read back
  const [provName, setProvName] = useState('');
  const [provUrl, setProvUrl] = useState('');
  const [provKey, setProvKey] = useState('');
  const [provBusy, setProvBusy] = useState(false);

  useEffect(() => {
    getApi()
      .workspace()
      .then((w) => {
        setWorkspace(w.workspace);
        setSaved(w.workspace);
      })
      .catch(() => {});
    getApi().people().then(setPeople).catch(() => setPeople({ local: [], known: [] }));
    getApi().agents().then(setAgents).catch(() => setAgents([]));
    getApi().debugNotes().then(setDebug).catch(() => setDebug({ dir: '', sharelink: null, count: 0, notes: [] }));
  }, []);

  const saveProvider = async () => {
    const name = provName.trim().toLowerCase();
    if (!name || !provUrl.trim()) return;
    setProvBusy(true);
    try {
      const p = await getApi().setProvider({ name, baseUrl: provUrl.trim(), ...(provKey.trim() ? { token: provKey.trim() } : {}) });
      await actions.refreshSetup();
      setProvKey('');
      toast({ title: p.ready ? `${p.name} ready` : `${p.name} saved, no key yet`, description: p.ready ? 'Pick it under From on a bot\'s profile.' : 'Paste its key and save again.', tone: p.ready ? 'success' : undefined });
    } catch (e) {
      toast({ title: 'Could not save the provider', description: (e as Error).message, tone: 'danger' });
    } finally {
      setProvBusy(false);
    }
  };
  const removeProvider = async (name: string) => {
    try {
      await getApi().removeProvider({ name });
      await actions.refreshSetup();
    } catch (e) {
      toast({ title: 'Could not remove it', description: (e as Error).message, tone: 'danger' });
    }
  };

  const [followLink, setFollowLink] = useState('');
  const [followBusy, setFollowBusy] = useState(false);
  const follow = async () => {
    const link = followLink.trim();
    if (!link) return;
    setFollowBusy(true);
    try {
      const r = await getApi().debugFollow({ link });
      setDebug((d) => (d ? { ...d, following: r.following } : d));
      setFollowLink('');
      toast({ title: `Following ${r.host}`, description: 'Their notes arrive whenever that device is heard from.', tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not follow', description: (e as Error).message, tone: 'danger' });
    } finally {
      setFollowBusy(false);
    }
  };
  const unfollow = async (host: string) => {
    try {
      const r = await getApi().debugUnfollow({ host });
      setDebug((d) => (d ? { ...d, following: r.following } : d));
    } catch (e) {
      toast({ title: 'Could not unfollow', description: (e as Error).message, tone: 'danger' });
    }
  };

  const shareNote = async (id: string) => {
    const topic = state.selected.topic;
    if (!topic) return toast({ title: 'Pick a project first', description: 'The note is posted into the open project.' });
    setSharing(id);
    try {
      await getApi().debugShare({ id, room: topic });
      toast({ title: 'Note shared', description: `${id} → ${state.rooms[topic]?.name ?? 'the project'}`, tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not share the note', description: (e as Error).message, tone: 'danger' });
    } finally {
      setSharing(null);
    }
  };

  const saveWorkspace = async () => {
    const w = workspace.trim();
    if (!w) return;
    setBusy(true);
    try {
      const res = await getApi().setWorkspace({ workspace: w });
      setWorkspace(res.workspace);
      setSaved(res.workspace);
      toast({ title: 'Workspace saved', description: res.workspace, tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not save', description: (e as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const saveWiki = (v: string) => {
    setWiki(v);
    localStorage.setItem(WIKI_KEY, v);
  };

  const canHost = state.me?.canHost !== false;
  const value = (t: string) => (
    <Text variant="body" tone="muted" numberOfLines={1}>
      {t}
    </Text>
  );

  return (
    <Pane glow>
      <PaneHeader title="Settings" size={phone ? 'display' : 'title'} style={phone ? ({ paddingTop: `calc(16px + ${SAFE_TOP})` } as never) : undefined} leading={onBack ? <IconButton icon="chevron-left" size="sm" hitSlop={10} accessibilityLabel="Back" onPress={onBack} className="-ml-1 mr-1" /> : undefined} actions={<DebugButton />} />
      <PaneBody contentClassName="gap-3 px-4 pb-8 pt-1">
        <View className="w-full max-w-[720px] gap-3 self-center">
          <SettingsBlock icon="setting-2-bold" title="This device" description="its name, where projects go">
            <SettingsRow label="Name" control={value(state.me?.device ?? '—')} />
            <SettingsRow label="Workspace folder" hint="New projects made here get a folder in it." divider={false} />
            <View className="px-1 pb-3">
              <TextField mono size="sm" value={workspace} onChangeText={setWorkspace} onSubmitEditing={saveWorkspace} placeholder="~/rKeyChat" disabled={!canHost} trailing={<Button size="sm" variant="primary" label="Save" disabled={!canHost || workspace.trim() === saved || !workspace.trim()} loading={busy} onPress={saveWorkspace} />} />
            </View>
            <SettingsRow label="Can hold projects" hint={canHost ? 'Folders and seats live here.' : 'A phone: projects live on one of your computers.'} control={<Toggle value={canHost} onValueChange={() => {}} disabled />} divider={false} />
          </SettingsBlock>

          <SettingsBlock icon="document" title="Wiki" description="one space every agent reads">
            <SettingsRow label="Space link" hint="Markdown synced by PearDrive: where things live, what we learned. Kept on this device until the daemon takes it next round." divider={false} />
            <View className="px-1 pb-3">
              <TextField mono size="sm" value={wiki} onChangeText={saveWiki} placeholder="peardrive://…" />
            </View>
            <SettingsRow
              label={wiki ? 'In every seat’s prompt' : 'No wiki yet'}
              hint={wiki ? 'the wiki is at this space; read its index when you need something outside the folder' : 'Make an empty one; the index fills itself in.'}
              control={wiki ? <Chip size="sm" label="set" tone="success" selected /> : <Button size="sm" variant="subtle" label="Create empty" onPress={() => { saveWiki('peardrive://wiki-pending'); toast({ title: 'Wiki placeholder set', description: 'The daemon creates the space in the next round.' }); }} />}
              divider={false}
            />
          </SettingsBlock>

          {canHost && state.setup ? (
            <SettingsBlock icon="robot" title="AI" description="where new bots get their model; each bot can be moved on its profile">
              <View className="gap-2 px-1 pb-3 pt-1">
                <AgentChoices setup={state.setup} selected={aiChoice ?? agentChoices(state.setup).find((c) => c.chosen)?.key ?? null} onSelect={setAiChoice} />
              </View>
              {state.setup.providers.filter((p) => !p.preset).map((p) => (
                <SettingsRow
                  key={p.name}
                  label={p.name}
                  hint={p.baseUrl ?? undefined}
                  control={
                    <View className="flex-row items-center gap-1.5">
                      <Chip size="sm" label={p.hasToken ? 'key held' : 'no key'} tone={p.hasToken ? 'success' : 'warning'} selected={p.hasToken} />
                      {state.setup?.agent === p.name ? <Chip size="sm" label="in use" tone="primary" selected /> : <Button size="sm" variant="ghost" label="Use for new bots" disabled={!p.ready} onPress={() => void actions.saveSetup({ agent: p.name }).catch((e: Error) => toast({ title: 'Could not save', description: e.message, tone: 'danger' }))} />}
                      <IconButton icon="close" size="xs" accessibilityLabel={`Remove ${p.name}`} onPress={() => void removeProvider(p.name)} />
                    </View>
                  }
                />
              ))}
              <SettingsRow label="Another gateway" hint="Any server that answers the Anthropic API: a name, its root URL (no /v1) and its key. The key is kept here and never shown again." divider={false} />
              <View className="gap-1.5 px-1 pb-3">
                <View className="flex-row gap-1.5">
                  <TextField size="sm" value={provName} onChangeText={setProvName} placeholder="name" autoCapitalize="none" accessibilityLabel="Provider name" className="w-[110px]" />
                  <TextField mono size="sm" value={provUrl} onChangeText={setProvUrl} placeholder="https://gateway.example.com" autoCapitalize="none" accessibilityLabel="Provider URL" className="min-w-0 flex-1" />
                </View>
                <View className="flex-row gap-1.5">
                  <TextField mono size="sm" password value={provKey} onChangeText={setProvKey} placeholder="API key" autoCapitalize="none" accessibilityLabel="Provider key" className="min-w-0 flex-1" />
                  <Button size="sm" variant="secondary" label="Save" loading={provBusy} disabled={!provName.trim() || !provUrl.trim()} onPress={() => void saveProvider()} />
                </View>
              </View>
            </SettingsBlock>
          ) : null}

          <SettingsBlock icon="image" title="Media" description="GIFs and pictures to reply with" trailing={<Chip size="sm" label="soon" />}>
            <SettingsRow label="Media space" hint="Thumbnails cached, bytes fetched from the space." control={value('not yet')} disabled divider={false} />
          </SettingsBlock>

          <SettingsBlock icon="people" title="Peers" description="people and agents from your projects">
            {people ? (
              people.known.length ? (
                people.known.map((p, i) => <SettingsRow key={p.name} label={p.name} hint={p.from ? `from ${p.from}` : undefined} control={<Chip size="sm" label={p.role} />} divider={i < people.known.length - 1} />)
              ) : (
                <SettingsRow label="Nobody yet" hint="People appear here once they join a project of yours." divider={false} />
              )
            ) : (
              <SettingsRow label="Loading…" divider={false} />
            )}
          </SettingsBlock>

          <SettingsBlock icon="microphone" title="Debug" description="voice notes with every step, for your agent">
            <SettingsRow label="Notes space" hint="Your agent on the Mac pulls them with: rkeychat notes pull <link>" control={debug?.sharelink ? undefined : value(debug ? debug.error ?? 'no space yet' : 'loading…')} divider={!debug?.sharelink} />
            {debug?.sharelink ? (
              <View className="px-1 pb-3">
                <LinkField value={debug.sharelink} onCopy={async (v) => { const ok = await copyToClipboard(v); toast({ title: ok ? 'Link copied' : 'Could not copy; long-press the link', duration: 1500 }); }} />
              </View>
            ) : null}
            <SettingsRow label="Following" hint="Another person's notes space (the link under their Settings › Debug): their notes are fetched here whenever their device is heard from, for your agent to read." divider={false} />
            {debug?.following?.length ? (
              <View className="flex-row flex-wrap gap-1.5 px-1 pb-2">
                {debug.following.map((h) => (
                  <Chip key={h} size="sm" label={h} selected onRemove={() => void unfollow(h)} />
                ))}
              </View>
            ) : null}
            <View className="px-1 pb-3">
              <TextField mono size="sm" value={followLink} onChangeText={setFollowLink} placeholder="pearcore://…" autoCapitalize="none" accessibilityLabel="Notes link to follow" onSubmitEditing={() => void follow()} trailing={<Button size="sm" variant="secondary" label="Follow" loading={followBusy} disabled={!followLink.trim()} onPress={() => void follow()} />} />
            </View>
            <SettingsRow label="Notes" hint={debug?.dir || undefined} control={value(debug ? `${debug.count}` : '…')} divider={!!debug?.notes.length} />
            {debug?.notes.map((n, i) => {
              const w = n.where as { page?: string; project?: string; conversation?: string } | undefined;
              const where = [w?.project, w?.conversation ?? w?.page].filter(Boolean).join(' › ');
              return (
                <SettingsRow
                  key={n.id}
                  label={n.id}
                  hint={[n.startedAt ? shortTime(Date.parse(n.startedAt)) : null, n.seconds != null ? `${n.seconds}s` : null, n.steps != null ? `${n.steps} steps` : null, n.audio ? 'voice' : 'steps only', where || null, n.from ? `from ${n.from}` : null].filter(Boolean).join(' · ')}
                  control={
                    <View className="flex-row items-center gap-2">
                      {n.from ? null : <StatusPill {...notePill(sync?.notes[n.id], sync)} />}
                      <Button size="sm" variant="subtle" label="Share into this project" loading={sharing === n.id} disabled={!state.selected.topic} onPress={() => void shareNote(n.id)} />
                    </View>
                  }
                  divider={i < debug.notes.length - 1}
                />
              );
            })}
          </SettingsBlock>

          <SettingsBlock icon="refresh" title="Agents on this device" description="seats hosted here">
            {agents ? (
              agents.length ? (
                agents.map((a, i) => {
                  const enrolled = a.rooms.filter((r) => r.enrolled).length;
                  return (
                    <SettingsRow
                      key={a.name}
                      label={`@${a.name}`}
                      hint={[a.bridge, a.via, a.dir].filter(Boolean).join(' · ')}
                      control={
                        <View className="flex-row items-center gap-1.5">
                          {a.rooms.some((r) => r.busy) ? <StatusDot tone="primary" size={6} pulse /> : null}
                          {value(`${enrolled} ${enrolled === 1 ? 'project' : 'projects'}`)}
                        </View>
                      }
                      divider={i < agents.length - 1}
                    />
                  );
                })
              ) : (
                <SettingsRow label="No seat here" divider={false} />
              )
            ) : (
              <SettingsRow label="Loading…" divider={false} />
            )}
          </SettingsBlock>

          <View className="flex-row items-center gap-2 px-1 pt-2">
            <Avatar seed={state.me?.ref ?? 'me'} size={18} label={state.me?.human ?? '?'} />
            <Text variant="micro" tone="subtle" numberOfLines={1} className="min-w-0 flex-1">
              {state.me?.human ?? '—'} · {state.me?.ref ?? ''}
            </Text>
            <Button size="sm" variant="ghost" label="Classic page" onPress={() => window.location.assign('/')} />
          </View>
          {dock ? <View style={{ height: 92 }} /> : null}
        </View>
      </PaneBody>
    </Pane>
  );
}
