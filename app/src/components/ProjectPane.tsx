/**
 * Right column: the project. Prompt, folder, seats, members, archived conversations, tasks.
 */
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { SAFE_TOP, rkc } from '../hooks';
import { Avatar, Button, Chip, Divider, EmptyState, Icon, IconButton, Pane, PaneBody, PaneHeader, SectionLabel, SegmentedControl, StatusDot, Text, TextField, copyToClipboard, useToast, type StatusTone } from '../kit';
import { useStore } from '../store/context';
import { archivedConvs, convTitle, homeOf, selectedRoom, thinkingIn } from '../store/selectors';
import type { AgentState, Seat } from '../types';

export interface ProjectPaneProps {
  width?: number;
  phone: boolean;
  onClose: () => void;
  onChangeFolder: () => void;
}

const seatTone: Record<AgentState, StatusTone> = { idle: 'success', thinking: 'primary', waiting: 'warning', error: 'danger', offline: 'neutral' };

export function ProjectPane({ width, phone, onClose, onChangeFolder }: ProjectPaneProps) {
  const { state, actions } = useStore();
  const { toast } = useToast();
  const room = selectedRoom(state);
  const topic = room?.topic ?? null;
  const detail = topic ? state.details[topic] : undefined;
  const charter = detail?.charter.text ?? '';
  const [prompt, setPrompt] = useState(charter);
  const [saving, setSaving] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  useEffect(() => setPrompt(charter), [charter, topic]);

  const dirty = prompt !== charter;

  const save = async () => {
    if (!topic) return;
    setSaving(true);
    try {
      await actions.saveCharter(topic, prompt);
      toast({ title: 'Project prompt saved', tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not save the prompt', description: (e as Error).message, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const seatState = (s: Seat): AgentState => {
    if (!topic) return 'offline';
    // Thinking anywhere in the room wins; otherwise the participant's presence.
    const busy = (state.convs[topic] ?? []).some((c) => !c.archived && thinkingIn(state, topic, c.conv).includes(s.name));
    if (busy) return 'thinking';
    const live = Object.values(state.agents).flatMap((m) => (m[s.name] ? [m[s.name]] : []));
    if (live.includes('error')) return 'error';
    const p = detail?.participants.find((x) => x.name === s.name);
    return p && p.online === false ? 'offline' : 'idle';
  };

  const header = (
    <PaneHeader
      title={room && !room.folder ? 'Chat' : 'Project'}
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
  const home = homeOf({ folder: room.folder, app: detail?.app ?? room.app }, state.me?.ref);
  const homeDevice = home.name ? state.devices.find((d) => d.name === home.name || d.ref === (detail?.app ?? room.app)?.home?.device) : state.devices.find((d) => d.here);
  const isProject = !!room.folder || !!home.name;
  const members = (detail?.participants ?? []).filter((p) => !seats.some((s) => s.name === p.name));
  const archived = archivedConvs(state, room.topic);
  const bridge = rkc();

  return (
    <Pane width={width} surface="pane" className={phone ? undefined : 'border-l border-overlay/[0.06]'}>
      {header}
      <PaneBody contentClassName="gap-1 px-4 pb-5">
        {/* Prompt */}
        <SectionLabel label={room.folder ? 'Project prompt' : 'Room prompt'} inset="none" className="pb-1.5 pt-1" />
        <TextField
          multiline
          value={prompt}
          onChangeText={setPrompt}
          placeholder={room.folder ? 'What this project is, what the agent should keep in mind.' : 'What this room is for.'}
          numberOfLines={5}
          accessibilityLabel="Project prompt"
          inputStyle={{ minHeight: 96 }}
        />
        <View className="flex-row items-center justify-end gap-2 pt-1.5">
          {dirty ? <Button label="Revert" variant="ghost" size="sm" onPress={() => setPrompt(charter)} /> : null}
          <Button label="Save" variant="primary" size="sm" disabled={!dirty} loading={saving} onPress={save} />
        </View>

        {/* Folder */}
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
        {home.here || !home.name ? (
          <View className="flex-row justify-end pt-1.5">
            <Button label={room.folder ? 'Change…' : 'Bind a folder…'} variant="subtle" size="sm" onPress={onChangeFolder} />
          </View>
        ) : null}

        {/* Home: the device whose disk holds the folder and runs the seat */}
        {isProject ? (
          <>
            <SectionLabel label="Home" inset="none" className="pb-1.5 pt-4" />
            <View className="flex-row items-center gap-2 py-1">
              <StatusDot tone={homeDevice ? (homeDevice.online || homeDevice.here ? 'success' : 'neutral') : 'neutral'} size={8} accessibilityLabel={homeDevice?.online ? 'online' : 'offline'} />
              <Text variant="body" numberOfLines={1} className="min-w-0 flex-1">
                {home.here ? `${home.name ?? state.me?.device ?? 'this device'}` : home.name ?? '—'}
              </Text>
              <Chip size="sm" label={home.here ? 'this device' : homeDevice ? (homeDevice.online ? 'online' : 'offline') : 'unknown'} />
            </View>
          </>
        ) : null}

        {/* Seats */}
        <SectionLabel label="Seats" count={seats.length || undefined} inset="none" className="pb-1 pt-4" />
        {seats.length ? (
          seats.map((s) => {
            const st = seatState(s);
            return (
              <View key={s.name} className="flex-row items-center gap-2.5 py-1.5">
                <StatusDot tone={seatTone[st]} size={8} pulse={st === 'thinking'} accessibilityLabel={st} />
                <View className="min-w-0 flex-1">
                  <Text variant="body" numberOfLines={1}>
                    @{s.name}
                  </Text>
                  <Text variant="caption" tone="subtle" numberOfLines={1}>
                    {st === 'thinking' ? 'thinking…' : st}
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
                    onChange={(via) =>
                      actions.setSeatVia(s.name, via as 'acp' | 'cli').catch((e) => toast({ title: 'Could not change the bridge', description: (e as Error).message, tone: 'danger' }))
                    }
                  />
                ) : s.via ? (
                  <Chip size="sm" label={s.via} />
                ) : null}
              </View>
            );
          })
        ) : (
          <Text variant="caption" tone="subtle" className="py-1">
            No agent seat in this room.
          </Text>
        )}

        {/* Members */}
        <SectionLabel label="Members" count={members.length || undefined} inset="none" className="pb-1 pt-4" />
        {members.map((m) => (
          <View key={m.name} className="flex-row items-center gap-2.5 py-1.5">
            <Avatar seed={m.name} size={22} label={m.name} />
            <Text variant="body" numberOfLines={1} className="min-w-0 flex-1">
              {m.name}
            </Text>
            {m.online ? <StatusDot tone="success" size={6} /> : null}
            <Chip size="sm" label={m.role === 'human' ? (m.local ? 'you' : 'member') : 'agent'} />
          </View>
        ))}
        {!members.length ? (
          <Text variant="caption" tone="subtle" className="py-1">
            Only you so far.
          </Text>
        ) : null}

        {/* Archived */}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: archivedOpen }} onPress={() => setArchivedOpen((o) => !o)} className="flex-row items-center pt-4">
          <SectionLabel label="Archived" count={archived.length} inset="none" className="flex-1 pb-1" />
          <Icon name={archivedOpen ? 'chevron-left' : 'chevron-right'} size={12} tone="subtle" style={archivedOpen ? { transform: [{ rotate: '-90deg' }] } : undefined} />
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

        {/* Tasks */}
        <SectionLabel label="Tasks" inset="none" className="pb-1" />
        <Text variant="caption" tone="subtle" className="py-1">
          No tasks file yet. {room.folder ? 'A TASKS.md in the folder will show here.' : 'Bind a folder first.'}
        </Text>
      </PaneBody>
    </Pane>
  );
}
