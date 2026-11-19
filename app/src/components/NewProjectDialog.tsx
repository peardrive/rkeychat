/**
 * "New project": a name, where it lives (one of your devices), an optional existing folder when it lives here
 * and the desktop picker exists, an optional prompt. "Change folder": a path for this device.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getApi } from '../api';
import { rkc } from '../hooks';
import { Button, Dialog, SegmentedControl, StatusDot, Text, TextField } from '../kit';
import { useStore } from '../store/context';
import { folderName, orderDevices, slugOf } from '../store/selectors';
import type { Device } from '../types';

export type NewProjectSubmit = { name: string; home?: string; folder?: string; prompt?: string };

export interface NewProjectDialogProps {
  open: boolean;
  mode: 'create' | 'rebind';
  prefill?: { name?: string; folder?: string };
  onClose: () => void;
  onCreate: (p: NewProjectSubmit) => Promise<void>;
  onRebind: (folder: string) => Promise<void>;
}

export function NewProjectDialog({ open, mode, prefill, onClose, onCreate, onRebind }: NewProjectDialogProps) {
  const { state, actions } = useStore();
  const [name, setName] = useState('');
  const [home, setHome] = useState<string>('');
  const [folder, setFolder] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workspace, setWorkspace] = useState('~/Projects');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const devices = orderDevices(state.devices);
  const here = devices.find((d) => d.here) ?? null;
  // A phone cannot hold a folder: the default is the first online computer, else the first other device.
  const canHostHere = here ? here.canHost !== false && state.me?.canHost !== false : state.me?.canHost !== false;
  const fallback = devices.find((d) => !d.here && d.online && d.canHost !== false) ?? devices.find((d) => !d.here) ?? null;
  const chosen = devices.find((d) => d.ref === home) ?? (canHostHere ? here : fallback);
  const livesHere = !!chosen?.here || (!chosen && canHostHere);
  const picker = canHostHere ? rkc()?.pickFolder : undefined;

  useEffect(() => {
    if (!open) return;
    setName(prefill?.name ?? '');
    setFolder(prefill?.folder ?? '');
    setPrompt('');
    setError(null);
    setHome('');
    if (mode === 'create') {
      actions.loadDevices().catch(() => {});
      getApi()
        .workspace()
        .then((w) => setWorkspace(w.workspace))
        .catch(() => {});
    }
  }, [open, prefill, mode, actions]);

  const fail = (m: string) => {
    setError(m);
    setBusy(false);
  };

  const submit = async () => {
    setError(null);
    if (mode === 'rebind') {
      const f = folder.trim();
      if (!f) return fail('A folder path is needed.');
      if (!/^(\/|~|[A-Za-z]:[\\/])/.test(f)) return fail('Use an absolute path (it is read on this device).');
      setBusy(true);
      try {
        await onRebind(f);
        onClose();
      } catch (e) {
        fail((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    const n = name.trim();
    if (!n) return fail('A project needs a name.');
    if (!canHostHere && (!chosen || chosen.here)) return fail('This device cannot hold a project; pick one of your computers.');
    if (chosen && !chosen.online && !chosen.here) return fail(`${chosen.name} is offline; the request would wait.`);
    setBusy(true);
    try {
      await onCreate({ name: n, home: chosen && !chosen.here ? chosen.ref : undefined, folder: livesHere && folder ? folder : undefined, prompt: prompt.trim() || undefined });
      onClose();
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    try {
      const f = await picker?.();
      if (f) {
        setFolder(f);
        if (!name.trim()) setName(folderName(f));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const title = mode === 'create' ? 'New project' : 'Change folder';
  const slug = slugOf(name.trim() || 'project');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="folder"
      title={title}
      description={mode === 'create' ? 'A folder on one of your devices, a room, and a seat for its agent.' : 'Bind this room to another folder on this device.'}
      actions={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} disabled={busy} />
          <Button label={mode === 'create' ? 'Create' : 'Bind'} variant="primary" onPress={submit} loading={busy} />
        </>
      }
    >
      {mode === 'rebind' ? (
        <TextField
          label="Folder"
          icon="folder"
          mono
          value={folder}
          onChangeText={(t) => {
            setFolder(t);
            if (error) setError(null);
          }}
          placeholder="/Users/you/Projects/my-app"
          autoFocus
          onSubmitEditing={submit}
          error={error ?? undefined}
          hint={error ? undefined : 'Absolute path on this device.'}
        />
      ) : (
        <View className="gap-4">
          <TextField label="Name" value={name} onChangeText={(t) => { setName(t); if (error) setError(null); }} placeholder="What the project is called" autoFocus onSubmitEditing={submit} error={error ?? undefined} />
          <View className="gap-1.5">
            <Text variant="label" weight="semibold" tone="muted">
              Where it lives
            </Text>
            {devices.length ? (
              <SegmentedControl
                fullWidth
                options={devices.map((d: Device) => ({
                  value: d.ref,
                  label: d.here ? (canHostHere ? `${d.name} · here` : d.name) : d.online ? d.name : `${d.name} · offline`,
                  disabled: d.here ? !canHostHere : !d.online,
                }))}
                value={chosen?.ref ?? ''}
                onChange={setHome}
              />
            ) : (
              <Text variant="caption" tone="subtle">
                Only this device.
              </Text>
            )}
            {chosen && !chosen.here ? (
              <View className="gap-1">
                <View className="flex-row items-center gap-1.5">
                  <StatusDot tone={chosen.online ? 'success' : 'neutral'} size={6} />
                  <Text variant="caption" tone="subtle">
                    Will be created on {chosen.name} in its Projects folder.
                  </Text>
                </View>
                {!canHostHere ? (
                  <Text variant="caption" tone="subtle">
                    This device cannot hold projects; pick one of your computers.
                  </Text>
                ) : null}
              </View>
            ) : folder ? (
              <View className="flex-row items-center gap-2">
                <Text variant="caption" tone="muted" numberOfLines={1} className="min-w-0 flex-1" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                  {folder}
                </Text>
                <Button size="sm" variant="ghost" label="Clear" onPress={() => setFolder('')} />
              </View>
            ) : (
              <View className="flex-row items-center gap-2">
                <Text variant="caption" tone="subtle" numberOfLines={1} className="min-w-0 flex-1">
                  Will be created in {workspace.replace(/^\/Users\/[^/]+/, '~')}/{slug}
                </Text>
                {picker ? <Button size="sm" variant="subtle" icon="folder-open" label="Choose an existing folder…" onPress={pick} /> : null}
              </View>
            )}
          </View>
          <TextField label="Prompt" multiline value={prompt} onChangeText={setPrompt} placeholder="Optional. What the project is, what the agent should keep in mind." inputStyle={{ minHeight: 64 }} />
        </View>
      )}
    </Dialog>
  );
}
