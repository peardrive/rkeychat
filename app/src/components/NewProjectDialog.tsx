/**
 * "New project" and "Change folder" in a browser (no native picker): a path and a name.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button, Dialog, Text, TextField } from '../kit';
import { folderName } from '../store/selectors';

export interface NewProjectDialogProps {
  open: boolean;
  mode: 'create' | 'rebind';
  prefill?: { name?: string; folder?: string };
  onClose: () => void;
  onSubmit: (folder: string, name?: string) => Promise<void>;
}

export function NewProjectDialog({ open, mode, prefill, onClose, onSubmit }: NewProjectDialogProps) {
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFolder(prefill?.folder ?? '');
      setName(prefill?.name ?? '');
      setError(null);
    }
  }, [open, prefill]);

  const submit = async () => {
    const f = folder.trim();
    if (!f) {
      setError('A folder path is needed.');
      return;
    }
    if (!/^(\/|~|[A-Za-z]:[\\/])/.test(f)) {
      setError('Use an absolute path (it is read on this device).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(f, name.trim() || undefined);
      onClose();
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
      icon="folder"
      title={mode === 'create' ? 'New project' : 'Change folder'}
      description={mode === 'create' ? 'A folder becomes a project: a space, a chain, and a seat for the project agent.' : 'Bind this room to another folder on this device.'}
      actions={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} disabled={busy} />
          <Button label={mode === 'create' ? 'Create' : 'Bind'} variant="primary" onPress={submit} loading={busy} />
        </>
      }
    >
      <View className="gap-3">
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
          hint={error ? undefined : 'Absolute path on this device. In the desktop app, a folder dialog opens instead.'}
        />
        {mode === 'create' ? (
          <TextField label="Name" value={name} onChangeText={setName} placeholder={folderName(folder) || 'Defaults to the folder name'} onSubmitEditing={submit} />
        ) : null}
        {mode === 'create' ? (
          <Text variant="caption" tone="subtle">
            The project agent is added as @rkeychat over ACP; change it in the project pane afterwards.
          </Text>
        ) : null}
      </View>
    </Dialog>
  );
}
