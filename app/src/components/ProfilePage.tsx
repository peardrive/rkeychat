/**
 * A profile: a bot (seat) in a project, or a person. The owner edits the bot's role, rules and runtime; from any of
 * the owner's devices (the phone too) the bot's settings — permission mode, model and provider, how long an ask
 * waits — go to the device that hosts the seat as a signed `seat` control, and come back as how it now runs.
 * Built on PearKit's ProfileCard (sections of settings rows).
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SAFE_TOP } from '../hooks';
import { Button, Chip, EmptyState, IconButton, Pane, PaneBody, PaneHeader, ProfileCard, SegmentedControl, StatusDot, Text, TextField, useToast, type ProfileSection } from '../kit';
import { useStore } from '../store/context';
import { homeOf, thinkingIn } from '../store/selectors';
import { MODELS, PERMISSION_MODES, autoLeft, autoWords, isCustomModel, permissionModeHint, providerOptions, runLine } from '../store/seatSettings';
import { agentPostLimit } from '../store/budget';
import type { PermissionMode, SeatChange } from '../types';

export interface ProfilePageProps {
  topic: string;
  name: string;
  phone: boolean;
  onBack: () => void;
}

const WAKES = [
  { value: 'order', label: 'In turn' },
  { value: 'mention', label: 'On mention' },
  { value: 'backup', label: 'Backup' },
];

export function ProfilePage({ topic, name, phone, onBack }: ProfilePageProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const room = state.rooms[topic];
  const detail = state.details[topic];
  const seat = detail?.seats.find((s) => s.name === name) ?? null;
  const participant = detail?.participants.find((p) => p.name === name) ?? null;
  const rule = detail?.charter.agents?.[name] ?? {};
  const [role, setRole] = useState(rule.role ?? '');
  const [wake, setWake] = useState<string>(rule.wake ?? 'order');
  const [backupFor, setBackupFor] = useState(rule.backupFor ?? '');
  const [cap, setCap] = useState(rule.tokensPerDay ? String(rule.tokensPerDay) : '');
  const [saving, setSaving] = useState(false);
  // the agent's posts per human message, from the room's budget ('limit' control; 0 = no limit)
  const postLimit = agentPostLimit(detail?.budget, name);
  const [posts, setPosts] = useState(postLimit ? String(postLimit) : '');
  const [savingPosts, setSavingPosts] = useState(false);
  useEffect(() => setPosts(postLimit ? String(postLimit) : ''), [postLimit, topic, name]);
  const savePosts = async () => {
    if (!topic) return;
    setSavingPosts(true);
    try {
      await actions.setAgentLimit(topic, name, Number(posts) || 0);
      toast({ title: Number(posts) ? `@${name}: ${Number(posts)} posts per message` : `@${name}: no post limit`, tone: 'success', duration: 1500 });
    } catch (e) {
      toast({ title: 'Could not set the limit', description: (e as Error).message, tone: 'danger' });
    } finally {
      setSavingPosts(false);
    }
  };
  // the bot's settings: typed values wait for Use / blur; the chips and segments go at once
  const [customModel, setCustomModel] = useState(isCustomModel(seat?.model) ? seat?.model ?? '' : '');
  const [askMin, setAskMin] = useState(seat?.askMinutes ? String(seat.askMinutes) : '');
  // Auto's grant: typed, then Set; the host's echo fills the fields back in
  const [autoMin, setAutoMin] = useState(seat?.auto?.minutes ? String(seat.auto.minutes) : '');
  const [autoTurns, setAutoTurns] = useState(seat?.auto?.turns ? String(seat.auto.turns) : '');
  const [sending, setSending] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setRole(rule.role ?? '');
    setWake(rule.wake ?? 'order');
    setBackupFor(rule.backupFor ?? '');
    setCap(rule.tokensPerDay ? String(rule.tokensPerDay) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, name, rule.role, rule.wake, rule.backupFor, rule.tokensPerDay]);
  useEffect(() => {
    setCustomModel(isCustomModel(seat?.model) ? seat?.model ?? '' : '');
    setAskMin(seat?.askMinutes ? String(seat.askMinutes) : '');
  }, [seat?.model, seat?.askMinutes]);
  useEffect(() => {
    setAutoMin(seat?.auto?.minutes ? String(seat.auto.minutes) : '');
    setAutoTurns(seat?.auto?.turns ? String(seat.auto.turns) : '');
  }, [seat?.auto?.minutes, seat?.auto?.turns, seat?.auto?.since]);
  // the minutes left tick down while the page is open
  useEffect(() => {
    if (seat?.permissionMode !== 'auto') return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [seat?.permissionMode]);

  // the room's owner edits the role and rules (charter); the owner's own devices change how the seat runs
  const owner = !!room?.owner;
  const ownerDevice = !!(detail?.ownerDevice ?? room?.owner);
  const isAgent = !!seat || participant?.role === 'agent';
  const home = homeOf(room, state.me?.ref);
  const thinking = !!room && (state.convs[topic] ?? []).some((c) => !c.archived && thinkingIn(state, topic, c.conv).includes(name));
  const dirty = role !== (rule.role ?? '') || wake !== (rule.wake ?? 'order') || backupFor !== (rule.backupFor ?? '') || cap !== (rule.tokensPerDay ? String(rule.tokensPerDay) : '');

  const save = async () => {
    setSaving(true);
    try {
      await actions.saveAgentRule(topic, name, { role: role.trim(), wake: wake as 'order' | 'mention' | 'backup', backupFor: wake === 'backup' ? backupFor.trim() || null : null, tokensPerDay: Number(cap) || 0 });
      toast({ title: 'Saved', tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not save', description: (e as Error).message, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  // one change at a time to the seat; the host's answer updates the row this page reads
  const change = async (what: string, c: SeatChange) => {
    setSending(what);
    try {
      await actions.setSeat(topic, name, c);
      if (seat?.remote) toast({ title: `Sent to ${home.name ?? 'its device'}`, description: 'The bot runs with it as soon as its device applies it.', duration: 2500 });
    } catch (e) {
      toast({ title: 'Could not change it', description: (e as Error).message, tone: 'danger' });
    } finally {
      setSending(null);
    }
  };

  const header = <PaneHeader title={isAgent ? 'Bot' : 'Person'} subtitle={room?.name} size={phone ? 'display' : 'title'} style={phone ? ({ paddingTop: `calc(16px + ${SAFE_TOP})` } as never) : undefined} leading={<IconButton icon="chevron-left" size="sm" hitSlop={10} accessibilityLabel="Back" onPress={onBack} className="-ml-1 mr-1" />} />;

  if (!room) {
    return (
      <Pane glow>
        {header}
        <EmptyState icon="people" title="No such project" />
      </Pane>
    );
  }

  const otherSeats = (detail?.seats ?? []).filter((s) => s.name !== name).map((s) => s.name);
  const homeDevice = state.devices.find((d) => d.name === home.name);
  const runsOn = home.name ?? state.me?.device ?? 'this device';
  const claude = seat?.bridge === 'claude';
  const mode: PermissionMode = seat?.permissionMode ?? 'acceptEdits';
  const providers = providerOptions(seat?.providers ?? []);
  const canRun = ownerDevice && claude;
  const roomCap = detail?.autoCap ?? null;
  const autoNow = mode === 'auto' ? autoLeft(seat?.auto, roomCap, now) : '';
  const grantDirty = (Number(autoMin) || 0) !== (seat?.auto?.minutes ?? 0) || (Number(autoTurns) || 0) !== (seat?.auto?.turns ?? 0);

  const badges = isAgent
    ? [
        { label: 'agent', icon: 'people' as const, tone: 'primary' as const },
        ...(home.name ? [{ label: home.here ? 'runs here' : `runs on ${home.name}`, icon: 'folder' as const }] : []),
        ...(claude ? [{ label: seat?.via ?? 'acp', icon: 'refresh' as const }] : seat ? [{ label: seat.bridge }] : []),
        ...(thinking ? [{ label: 'thinking…', tone: 'success' as const }] : []),
      ]
    : [{ label: participant?.local ? 'you' : 'member', tone: participant?.local ? ('primary' as const) : undefined }, ...(participant?.online ? [{ label: 'online', tone: 'success' as const }] : [])];

  const sections: ProfileSection[] = isAgent
    ? [
        {
          title: 'Role in this project',
          icon: 'document',
          description: 'goes into its prompt',
          rows: [
            {
              label: 'Role',
              hint: owner ? undefined : 'Only the owner changes it.',
              control: <TextField multiline value={role} onChangeText={setRole} placeholder={owner ? 'Keeps the design system honest; reviews every PR.' : 'No role written.'} disabled={!owner} inputStyle={{ minHeight: 56 }} className="w-full" />,
            },
          ],
        },
        {
          title: 'Rules',
          icon: 'setting-2-bold',
          description: 'when it wakes, what it may spend',
          rows: [
            { label: 'Wakes', control: <SegmentedControl size="sm" options={WAKES} value={wake} onChange={owner ? setWake : () => {}} disabled={!owner} /> },
            ...(wake === 'backup'
              ? [
                  {
                    label: 'Backup for',
                    control: (
                      <View className="flex-row flex-wrap justify-end gap-1.5">
                        {otherSeats.length ? otherSeats.map((s) => <Chip key={s} size="sm" label={`@${s}`} selected={backupFor === s} onPress={owner ? () => setBackupFor(s) : undefined} />) : <Text variant="caption" tone="subtle">No other seat here.</Text>}
                      </View>
                    ),
                  },
                ]
              : []),
            { label: 'Tokens per day', hint: '0 is no cap', control: <TextField value={cap} onChangeText={(t) => setCap(t.replace(/[^\d]/g, ''))} placeholder="0" keyboardType="numeric" size="sm" disabled={!owner} className="w-[120px]" /> },
            {
              label: 'Posts per message',
              hint: `how often it may speak between two of yours; 0 is no limit${postLimit ? `. Now: ${postLimit}` : ''}`,
              control: (
                <View className="flex-row items-center gap-1.5">
                  <TextField value={posts} onChangeText={(t) => setPosts(t.replace(/[^\d]/g, ''))} placeholder="0" keyboardType="numeric" size="sm" disabled={!owner} accessibilityLabel="Posts per message" className="w-[72px]" />
                  <Button label="Set" size="sm" variant="secondary" disabled={!owner || (Number(posts) || 0) === postLimit} loading={savingPosts} onPress={() => void savePosts()} />
                </View>
              ),
            },
          ],
        },
        ...(claude
          ? [
              {
                title: 'Permissions',
                icon: 'bolt' as const,
                description: 'what it may do without asking you',
                rows: [
                  {
                    label: 'Mode',
                    hint: mode === 'auto' ? `${permissionModeHint(mode)} Now: ${autoNow}.` : permissionModeHint(mode),
                    control: (
                      <SegmentedControl
                        size="sm"
                        options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label }))}
                        value={mode}
                        onChange={(m) => void change('mode', { permissionMode: m as PermissionMode })}
                        disabled={!canRun || sending === 'mode'}
                        accessibilityLabel="Permission mode"
                      />
                    ),
                  },
                  ...(mode === 'auto'
                    ? [
                        {
                          label: 'For',
                          hint: `Empty is no limit. When it runs out the bot goes back to ${PERMISSION_MODES.find((m) => m.value === (seat?.auto?.back ?? 'default'))?.label ?? 'Ask'}.${roomCap && autoWords(roomCap) ? ` This project caps Auto at ${autoWords(roomCap)}.` : ''}`,
                          control: (
                            <View className="flex-row items-center gap-1.5">
                              <TextField value={autoMin} onChangeText={(t) => setAutoMin(t.replace(/[^\d]/g, ''))} placeholder="min" keyboardType="numeric" size="sm" disabled={!canRun} accessibilityLabel="Auto minutes" className="w-[72px]" />
                              <TextField value={autoTurns} onChangeText={(t) => setAutoTurns(t.replace(/[^\d]/g, ''))} placeholder="turns" keyboardType="numeric" size="sm" disabled={!canRun} accessibilityLabel="Auto turns" className="w-[72px]" />
                              <Button label="Set" size="sm" variant="secondary" disabled={!canRun || !grantDirty} loading={sending === 'auto'} onPress={() => void change('auto', { permissionMode: 'auto', auto: { minutes: Number(autoMin) || null, turns: Number(autoTurns) || null } })} />
                            </View>
                          ),
                        },
                      ]
                    : []),
                  {
                    label: 'An ask waits',
                    hint: 'minutes before an unanswered question counts as no (1–120; empty is the device default)',
                    control: (
                      <TextField
                        value={askMin}
                        onChangeText={(t) => setAskMin(t.replace(/[^\d]/g, ''))}
                        onBlur={() => { const n = Number(askMin); if (n >= 1 && n <= 120 && n !== (seat?.askMinutes ?? 0)) void change('ask', { askMinutes: n }); }}
                        placeholder="10"
                        keyboardType="numeric"
                        size="sm"
                        disabled={!canRun}
                        accessibilityLabel="Ask minutes"
                        className="w-[120px]"
                      />
                    ),
                  },
                ],
              },
              {
                title: 'Model',
                icon: 'robot' as const,
                description: 'which model answers, and from where',
                rows: [
                  {
                    label: 'From',
                    hint: providers.length > 1 ? undefined : `Only this computer's Claude login so far. Add a provider (PPQ, a gateway) in Settings on ${runsOn}.`,
                    control: (
                      <SegmentedControl
                        size="sm"
                        options={providers}
                        value={seat?.provider ?? 'claude'}
                        onChange={(p) => void change('provider', { provider: p === 'claude' ? null : p })}
                        disabled={!canRun || providers.length < 2 || sending === 'provider'}
                        accessibilityLabel="Provider"
                      />
                    ),
                  },
                  {
                    label: 'Model',
                    hint: 'Default is the login\'s own; a provider may want its own id',
                    control: (
                      <View className="flex-row flex-wrap justify-end gap-1.5">
                        <Chip size="sm" label="Default" selected={!seat?.model} onPress={canRun ? () => void change('model', { model: null }) : undefined} />
                        {MODELS.map((m) => (
                          <Chip key={m.id} size="sm" label={m.name} selected={seat?.model === m.id} onPress={canRun ? () => void change('model', { model: m.id }) : undefined} />
                        ))}
                      </View>
                    ),
                  },
                  {
                    label: 'Other id',
                    control: (
                      <View className="flex-row items-center gap-1.5">
                        <TextField value={customModel} onChangeText={setCustomModel} placeholder="model id" size="sm" disabled={!canRun} accessibilityLabel="Model id" className="w-[180px]" autoCapitalize="none" />
                        <Button label="Use" size="sm" variant="secondary" disabled={!canRun || !customModel.trim() || customModel.trim() === seat?.model} loading={sending === 'model'} onPress={() => void change('model', { model: customModel.trim() })} />
                      </View>
                    ),
                  },
                ],
              },
              {
                title: 'Runtime',
                icon: 'refresh' as const,
                description: 'cli, or ACP: interruptible, resumable',
                rows: [
                  {
                    label: 'Driven over',
                    control: (
                      <SegmentedControl
                        size="sm"
                        options={[
                          { value: 'cli', label: 'cli' },
                          { value: 'acp', label: 'acp' },
                        ]}
                        value={seat?.via ?? 'acp'}
                        onChange={(via) => void change('via', { via: via as 'acp' | 'cli' })}
                        disabled={!canRun || sending === 'via'}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          title: 'Where it runs',
          icon: 'folder',
          rows: [
            { label: 'Device', hint: home.here ? 'this device' : undefined, control: <View className="flex-row items-center gap-2"><StatusDot tone={home.here || homeDevice?.online ? 'success' : 'neutral'} size={8} /><Text variant="body" tone="muted">{runsOn}</Text></View> },
            ...(seat?.dir ? [{ label: 'Folder', value: seat.dir }] : []),
          ],
        },
      ]
    : [
        {
          title: 'Devices',
          icon: 'people',
          rows: participant?.devices?.length ? participant.devices.map((d) => ({ label: d })) : [{ label: 'No device listed' }],
        },
        { title: 'Role', icon: 'setting-2-bold', rows: [{ label: participant?.role === 'human' ? 'Member' : 'Agent', hint: participant?.role === 'human' ? 'Admin: steers budget, pause, prompts.' : undefined }] },
      ];

  const subtitle = isAgent ? `Bot in ${room.name} · runs on ${runsOn}${claude ? ` · ${runLine(seat)}` : ''}${!ownerDevice ? ' · read only' : ''}` : `In ${room.name}.`;

  return (
    <Pane glow>
      {header}
      <PaneBody contentClassName="px-4 pb-8 pt-1">
        <View className="w-full max-w-[720px] self-center">
          <ProfileCard
            name={isAgent ? `@${name}` : name}
            avatar={{ seed: name }}
            agent={isAgent}
            subtitle={subtitle}
            badges={badges}
            sections={sections}
            editable={owner && isAgent}
            onEditName={() => toast({ title: 'A seat is named after its project', description: 'Renaming a bot comes with the next daemon round.' })}
            actions={isAgent && owner ? <Button label="Save" variant="primary" disabled={!dirty} loading={saving} onPress={save} /> : undefined}
          />
        </View>
      </PaneBody>
    </Pane>
  );
}
