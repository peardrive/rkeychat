/**
 * Settings, minimal: the workspace root (where projects made on this device go) and this device's name.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getApi } from '../api';
import { Button, Dialog, Text, TextField, useToast } from '../kit';
import { useStore } from '../store/context';

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useStore();
  const { toast } = useToast();
  const [workspace, setWorkspace] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    getApi()
      .workspace()
      .then((w) => {
        setWorkspace(w.workspace);
        setSaved(w.workspace);
      })
      .catch((e) => setError((e as Error).message));
  }, [open]);

  const save = async () => {
    const w = workspace.trim();
    if (!w) return setError('A folder path is needed.');
    setBusy(true);
    setError(null);
    try {
      const res = await getApi().setWorkspace({ workspace: w });
      setWorkspace(res.workspace);
      setSaved(res.workspace);
      toast({ title: 'Workspace root saved', description: res.workspace, tone: 'success' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="setting-2-bold"
      title="Settings"
      description="Everything else still lives in the classic page."
      actions={
        <>
          <Button label="Classic page" variant="ghost" onPress={() => window.location.assign('/')} />
          <Button label="Done" variant="secondary" onPress={onClose} />
        </>
      }
    >
      <View className="gap-4">
        <TextField
          label="Workspace root"
          icon="folder"
          mono
          value={workspace}
          onChangeText={(t) => {
            setWorkspace(t);
            if (error) setError(null);
          }}
          onSubmitEditing={save}
          error={error ?? undefined}
          hint={error ? undefined : 'New projects made on this device get a folder here.'}
          trailing={<Button size="sm" variant="primary" label="Save" disabled={workspace.trim() === saved || !workspace.trim()} loading={busy} onPress={save} />}
        />
        <View className="gap-0.5">
          <Text variant="label" weight="semibold" tone="muted">
            This device
          </Text>
          <Text variant="body">{state.me?.device ?? '—'}</Text>
          {state.me?.ref ? (
            <Text variant="micro" tone="subtle" numberOfLines={1}>
              {state.me.ref}
            </Text>
          ) : null}
        </View>
      </View>
    </Dialog>
  );
}
