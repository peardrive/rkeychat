/**
 * A profile: a bot (seat) in a project, or a person. The owner edits the bot's role, rules and runtime.
 * Built on PearKit's ProfileCard (sections of settings rows).
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SAFE_TOP } from '../hooks';
import { Button, Chip, EmptyState, IconButton, Pane, PaneBody, PaneHeader, ProfileCard, SegmentedControl, StatusDot, Text, TextField, useToast, type ProfileSection } from '../kit';
import { useStore } from '../store/context';
import { homeOf, thinkingIn } from '../store/selectors';

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

  useEffect(() => {
    setRole(rule.role ?? '');
    setWake(rule.wake ?? 'order');
    setBackupFor(rule.backupFor ?? '');
    setCap(rule.tokensPerDay ? String(rule.tokensPerDay) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, name, rule.role, rule.wake, rule.backupFor, rule.tokensPerDay]);

  const owner = !!room?.owner;
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

  const badges = isAgent
    ? [
        { label: 'agent', icon: 'people' as const, tone: 'primary' as const },
        ...(home.name ? [{ label: home.here ? 'runs here' : `runs on ${home.name}`, icon: 'folder' as const }] : []),
        ...(seat?.bridge === 'claude' ? [{ label: seat.via ?? 'acp', icon: 'refresh' as const }] : seat ? [{ label: seat.bridge }] : []),
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
          ],
        },
        ...(seat?.bridge === 'claude'
          ? [
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
                        value={seat.via ?? 'acp'}
                        onChange={(via) => actions.setSeatVia(name, via as 'acp' | 'cli').catch((e) => toast({ title: 'Could not change the runtime', description: (e as Error).message, tone: 'danger' }))}
                        disabled={!owner}
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

  return (
    <Pane glow>
      {header}
      <PaneBody contentClassName="px-4 pb-8 pt-1">
        <View className="w-full max-w-[720px] self-center">
          <ProfileCard
            name={isAgent ? `@${name}` : name}
            avatar={{ seed: name }}
            agent={isAgent}
            subtitle={isAgent ? `Bot in ${room.name} · runs on ${runsOn}${!owner ? ' · read only' : ''}` : `In ${room.name}.`}
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
