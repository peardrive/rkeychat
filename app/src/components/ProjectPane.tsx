/**
 * The project (the ⋯ of a conversation): name, prompt, folder and home, organization, seats, members, invite
 * link, archived conversations, remove. A sheet on the phone, the right pane on a desktop.
 */
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { getApi } from '../api';
import { SAFE_TOP, rkc } from '../hooks';
import { Avatar, Button, Chip, DangerZone, Divider, EmptyState, Icon, IconButton, LinkField, Pane, PaneBody, PaneHeader, SectionLabel, SegmentedControl, StatusDot, Text, TextField, copyToClipboard, useToast, type StatusTone } from '../kit';
import { useStore } from '../store/context';
import { archivedConvs, convTitle, homeOf, orgOf, selectedRoom, thinkingIn } from '../store/selectors';
import type { AgentState, Seat } from '../types';
import type { ProjectAction } from './ProjectList';

export interface ProjectPaneProps {
  width?: number;
  phone: boolean;
  onClose: () => void;
  onChangeFolder: () => void;
  onProjectAction: (action: ProjectAction, topic: string) => void;
  onOpenProfile: (name: string) => void;
}

const seatTone: Record<AgentState, StatusTone> = { idle: 'success', thinking: 'primary', waiting: 'warning', error: 'danger', offline: 'neutral' };

export function ProjectPane({ width, phone, onClose, onChangeFolder, onProjectAction, onOpenProfile }: ProjectPaneProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const room = selectedRoom(state);
  const topic = room?.topic ?? null;
  const detail = topic ? state.details[topic] : undefined;
  const charter = detail?.charter.text ?? '';
  const [prompt, setPrompt] = useState(charter);
  const [saving, setSaving] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);

  useEffect(() => setPrompt(charter), [charter, topic]);
  useEffect(() => {
    setInvite(null);
    if (!topic || !room?.owner) return;
    let alive = true;
    getApi()
      .invite(topic)
      .then((r) => alive && setInvite(r.invite))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [topic, room?.owner]);

  const dirty = prompt !== charter;
  const save = async () => {
    if (!topic) return;
    setSaving(true);
    try {
      await actions.saveCharter(topic, prompt);
      toast({ title: 'Prompt saved', tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not save the prompt', description: (e as Error).message, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const seatState = (s: Seat): AgentState => {
    if (!topic) return 'offline';
    const busy = (state.convs[topic] ?? []).some((c) => !c.archived && thinkingIn(state, topic, c.conv).includes(s.name));
    if (busy) return 'thinking';
    const live = Object.values(state.agents).flatMap((m) => (m[s.name] ? [m[s.name]] : []));
    if (live.includes('error')) return 'error';
    const p = detail?.participants.find((x) => x.name === s.name);
    return p && p.online === false ? 'offline' : 'idle';
  };

  const header = (
    <PaneHeader
      title="Project"
      subtitle={room?.name}
      size={phone ? 'display' : 'title'}
      style={phone ? ({ paddingTop: `calc(16px + ${SAFE_TOP})` } as never) : undefined}
      leading={phone ? <IconButton icon="chevron-left" size="sm" hitSlop={10} accessibilityLabel="Back" onPress={onClose} className="-ml-1 mr-1" /> : undefined}
      actions={phone ? undefined : [{ icon: 'close', label: 'Hide project', onPress: onClose }]}
    />
  );

  if (!room) {
    return (
      <Pane width={width} surface="pane" className="border-l border-overlay/[0.06]">
        {header}
        <EmptyState icon="folder" title="Nothing selected" />
      </Pane>
    );
  }

  const seats = detail?.seats ?? [];
  const members = (detail?.participants ?? []).filter((p) => !seats.some((s) => s.name === p.name));
  const archived = archivedConvs(state, room.topic);
  const bridge = rkc();
  const home = homeOf({ folder: room.folder, app: detail?.app ?? room.app }, state.me?.ref);
  const homeDevice = home.name ? state.devices.find((d) => d.name === home.name || d.ref === (detail?.app ?? room.app)?.home?.device) : state.devices.find((d) => d.here);
  const org = orgOf(room);

  return (
    <Pane width={width} surface="pane" className={phone ? undefined : 'border-l border-overlay/[0.06]'}>
      {header}
      <PaneBody contentClassName="gap-1 px-4 pb-6">
        {/* Name + organization */}
        <View className="flex-row items-center gap-2 pb-1">
          <Avatar seed={room.topic} size={36} label={room.name} />
          <View className="min-w-0 flex-1">
            <Pressable accessibilityRole="button" accessibilityLabel="Rename project" onPress={() => onProjectAction('rename', room.topic)} className={Platform.OS === 'web' ? 'cursor-pointer' : undefined}>
              <Text variant="body-lg" numberOfLines={1}>
                {room.name}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Move to organization" onPress={() => onProjectAction('org', room.topic)} className={Platform.OS === 'web' ? 'cursor-pointer' : undefined}>
              <Text variant="caption" tone="subtle" numberOfLines={1}>
                {org ? `in ${org}` : 'No organization · add one'}
              </Text>
            </Pressable>
          </View>
          <IconButton icon="document" size="sm" tooltip="Rename" onPress={() => onProjectAction('rename', room.topic)} />
        </View>

        <SectionLabel label="Prompt" inset="none" className="pb-1.5 pt-2" />
        <TextField multiline value={prompt} onChangeText={setPrompt} placeholder="What this project is, what its agents should keep in mind." numberOfLines={5} accessibilityLabel="Project prompt" inputStyle={{ minHeight: 88 }} />
        <View className="flex-row items-center justify-end gap-2 pt-1.5">
          {dirty ? <Button label="Revert" variant="ghost" size="sm" onPress={() => setPrompt(charter)} /> : null}
          <Button label="Save" variant="primary" size="sm" disabled={!dirty} loading={saving} onPress={save} />
        </View>

        {/* Folder + home */}
        <SectionLabel label="Folder" inset="none" className="pb-1.5 pt-4" />
        <View className="flex-row items-center gap-1.5 rounded-field border border-overlay/[0.08] bg-overlay/5 py-1.5 pl-3 pr-1">
          <Icon name="folder" size={14} tone={room.folder ? 'accent' : 'subtle'} />
          <Text variant="label" tone={room.folder ? 'foreground' : 'subtle'} numberOfLines={1} className="min-w-0 flex-1" style={{ fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Menlo' }}>
            {room.folder ?? (home.name && !home.here ? `on ${home.name}` : 'No folder on this device')}
          </Text>
          {room.folder ? (
            <IconButton
              icon="copy"
              size="xs"
              tooltip="Copy path"
              onPress={async () => {
                await copyToClipboard(room.folder!);
                toast({ title: 'Path copied', duration: 1500 });
              }}
            />
          ) : null}
          {bridge?.openFolder && room.folder ? <IconButton icon="folder-open" size="xs" tooltip="Open folder" onPress={() => void bridge.openFolder?.(room.folder!)} /> : null}
        </View>
        <View className="flex-row items-center gap-2 pt-2">
          <StatusDot tone={homeDevice ? (homeDevice.online || homeDevice.here ? 'success' : 'neutral') : 'neutral'} size={8} />
          <Text variant="caption" tone="muted" numberOfLines={1} className="min-w-0 flex-1">
            Home: {home.here ? `${home.name ?? state.me?.device ?? 'this device'} (this device)` : home.name ?? 'nowhere yet'}
          </Text>
          {home.here || !home.name ? <Button label={room.folder ? 'Change…' : 'Bind a folder…'} variant="subtle" size="sm" onPress={onChangeFolder} /> : null}
        </View>

        {/* Seats */}
        <SectionLabel label="Seats" count={seats.length || undefined} inset="none" className="pb-1 pt-4" />
        {seats.length ? (
          seats.map((s) => {
            const st = seatState(s);
            return (
              <Pressable key={s.name} accessibilityRole="button" accessibilityLabel={`@${s.name}`} onPress={() => onOpenProfile(s.name)} className={`flex-row items-center gap-2.5 rounded-md py-1.5 hover:bg-overlay/5 ${Platform.OS === 'web' ? 'cursor-pointer' : ''}`}>
                <StatusDot tone={seatTone[st]} size={8} pulse={st === 'thinking'} accessibilityLabel={st} />
                <View className="min-w-0 flex-1">
                  <Text variant="body" numberOfLines={1}>
                    @{s.name}
                  </Text>
                  <Text variant="caption" tone="subtle" numberOfLines={1}>
                    {st === 'thinking' ? 'thinking…' : st}
                    {detail?.charter.agents?.[s.name]?.role ? ` · ${detail.charter.agents[s.name].role}` : ''}
                  </Text>
                </View>
                <Chip size="sm" label={s.bridge} />
                {s.bridge === 'claude' ? (
                  <SegmentedControl
                    size="sm"
                    options={[
                      { value: 'cli', label: 'cli' },
                      { value: 'acp', label: 'acp' },
                    ]}
                    value={s.via ?? 'acp'}
                    onChange={(via) => actions.setSeatVia(s.name, via as 'acp' | 'cli').catch((e) => toast({ title: 'Could not change the bridge', description: (e as Error).message, tone: 'danger' }))}
                  />
                ) : null}
                <Icon name="chevron-right" size={12} tone="subtle" />
              </Pressable>
            );
          })
        ) : (
          <Text variant="caption" tone="subtle" className="py-1">
            No agent seat in this project.
          </Text>
        )}

        {/* Members */}
        <SectionLabel label="Members" count={members.length || undefined} inset="none" className="pb-1 pt-4" />
        {members.map((m) => (
          <Pressable key={m.name} accessibilityRole="button" accessibilityLabel={m.name} onPress={() => onOpenProfile(m.name)} className={`flex-row items-center gap-2.5 rounded-md py-1.5 hover:bg-overlay/5 ${Platform.OS === 'web' ? 'cursor-pointer' : ''}`}>
            <Avatar seed={m.name} size={22} label={m.name} />
            <Text variant="body" numberOfLines={1} className="min-w-0 flex-1">
              {m.name}
            </Text>
            {m.online ? <StatusDot tone="success" size={6} /> : null}
            <Chip size="sm" label={m.role === 'human' ? (m.local ? 'you' : 'member') : 'agent'} />
          </Pressable>
        ))}
        {!members.length ? (
          <Text variant="caption" tone="subtle" className="py-1">
            Only you so far.
          </Text>
        ) : null}
        {invite ? (
          <View className="pt-2">
            <LinkField value={invite} onCopy={async (v) => { const ok = await copyToClipboard(v); toast({ title: ok ? 'Invite copied' : 'Could not copy; long-press the link', duration: 1500 }); }} />
            <Text variant="micro" tone="subtle" className="pt-1">
              Send this to someone to let them in; you approve their device when it knocks.
            </Text>
          </View>
        ) : null}

        {/* Archived */}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: archivedOpen }} onPress={() => setArchivedOpen((o) => !o)} className="flex-row items-center pt-4">
          <SectionLabel label="Archived" count={archived.length} inset="none" className="flex-1 pb-1" />
          <Icon name={archivedOpen ? 'chevron-down' : 'chevron-right'} size={12} tone="subtle" />
        </Pressable>
        {archivedOpen
          ? archived.length
            ? archived.map((c) => (
                <Pressable
                  key={c.conv}
                  accessibilityRole="button"
                  accessibilityLabel={`Reopen ${convTitle(c)}`}
                  onPress={async () => {
                    try {
                      await actions.archiveConversation(room.topic, c.conv, false);
                      await actions.select(room.topic, c.conv);
                    } catch (e) {
                      toast({ title: 'Could not reopen', description: (e as Error).message, tone: 'danger' });
                    }
                  }}
                  className="flex-row items-center gap-2 rounded-md px-1 py-1.5 hover:bg-overlay/5"
                >
                  <Icon name="export" size={13} tone="subtle" />
                  <Text variant="body" tone="muted" numberOfLines={1} className="min-w-0 flex-1">
                    {convTitle(c)}
                  </Text>
                  <Text variant="micro" tone="subtle">
                    {c.count}
                  </Text>
                </Pressable>
              ))
            : (
                <Text variant="caption" tone="subtle" className="py-1">
                  Nothing archived.
                </Text>
              )
          : null}

        <Divider className="my-3" />
        <SectionLabel label="Tasks" inset="none" className="pb-1" />
        <Text variant="caption" tone="subtle" className="py-1">
          No tasks file yet. {room.folder ? 'A TASKS.md in the folder will show here.' : 'Bind a folder first.'}
        </Text>

        <View className="pt-4">
          <DangerZone actionLabel="Remove from this device" icon="close" description="The project leaves this device; its folder stays on disk and other members keep it." onPress={() => onProjectAction('remove', room.topic)} />
        </View>
      </PaneBody>
    </Pane>
  );
}
