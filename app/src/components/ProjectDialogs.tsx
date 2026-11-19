/**
 * Small dialogs on a project: rename, move to an organization, remove from this device, new organization.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button, Chip, Dialog, Text, TextField } from '../kit';

function useDialogState<T>(open: boolean, initial: T): [T, React.Dispatch<React.SetStateAction<T>>, string | null, (e: string | null) => void, boolean, (b: boolean) => void] {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setV(initial);
      setError(null);
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return [v, setV, error, setError, busy, setBusy];
}

export function RenameProjectDialog({ open, name, onClose, onSubmit }: { open: boolean; name: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [value, setValue, error, setError, busy, setBusy] = useDialogState(open, name);
  const submit = async () => {
    const n = value.trim();
    if (!n) return setError('A project needs a name.');
    setBusy(true);
    try {
      await onSubmit(n);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} icon="document" title="Rename project" actions={<><Button label="Cancel" variant="ghost" onPress={onClose} /><Button label="Rename" variant="primary" loading={busy} onPress={submit} /></>}>
      <TextField label="Name" value={value} onChangeText={(t) => { setValue(t); setError(null); }} autoFocus selectTextOnFocus onSubmitEditing={submit} error={error ?? undefined} />
    </Dialog>
  );
}

export function MoveToOrgDialog({ open, current, orgs, onClose, onSubmit }: { open: boolean; current: string | null; orgs: string[]; onClose: () => void; onSubmit: (org: string | null) => Promise<void> }) {
  const [value, setValue, error, setError, busy, setBusy] = useDialogState(open, current ?? '');
  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(value.trim() || null);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} icon="grid-1" title="Move to organization" description="A name a set of projects belongs to. Leave it empty for none." actions={<><Button label="Cancel" variant="ghost" onPress={onClose} /><Button label="Move" variant="primary" loading={busy} onPress={submit} /></>}>
      <View className="gap-3">
        <OrgChips orgs={orgs} value={value} onChange={setValue} />
        <TextField label="Organization" value={value} onChangeText={(t) => { setValue(t); setError(null); }} placeholder="None" onSubmitEditing={submit} error={error ?? undefined} />
      </View>
    </Dialog>
  );
}

/** Existing organizations as chips; the selected one is highlighted, "None" clears. */
export function OrgChips({ orgs, value, onChange }: { orgs: string[]; value: string; onChange: (v: string) => void }) {
  if (!orgs.length) return null;
  return (
    <View className="flex-row flex-wrap gap-1.5">
      <Chip size="sm" label="None" selected={!value.trim()} onPress={() => onChange('')} />
      {orgs.map((o) => (
        <Chip key={o} size="sm" label={o} selected={value.trim() === o} onPress={() => onChange(o)} />
      ))}
    </View>
  );
}

export function RemoveProjectDialog({ open, name, folder, onClose, onSubmit }: { open: boolean; name: string; folder?: string | null; onClose: () => void; onSubmit: () => Promise<void> }) {
  const [, , error, setError, busy, setBusy] = useDialogState(open, null);
  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} icon="alert-circle" title={`Remove ${name}?`} description="Removes it from this device; the folder stays." actions={<><Button label="Cancel" variant="ghost" onPress={onClose} /><Button label="Remove" variant="danger" loading={busy} onPress={submit} /></>}>
      <View className="gap-1.5">
        {folder ? (
          <Text variant="caption" tone="muted">
            {folder} is not deleted. Its seat on this device stops.
          </Text>
        ) : (
          <Text variant="caption" tone="muted">
            Other members keep the project; you can be invited back.
          </Text>
        )}
        {error ? (
          <Text variant="caption" tone="danger">
            {error}
          </Text>
        ) : null}
      </View>
    </Dialog>
  );
}

export function NewOrgDialog({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (name: string) => void }) {
  const [value, setValue, error, setError] = useDialogState(open, '');
  const submit = () => {
    const n = value.trim();
    if (!n) return setError('An organization needs a name.');
    onSubmit(n);
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} icon="grid-1" title="New organization" description="Then a first project in it. An organization exists through its projects." actions={<><Button label="Cancel" variant="ghost" onPress={onClose} /><Button label="Continue" variant="primary" onPress={submit} /></>}>
      <TextField label="Name" value={value} onChangeText={(t) => { setValue(t); setError(null); }} placeholder="Bitcoin Audible" autoFocus onSubmitEditing={submit} error={error ?? undefined} />
    </Dialog>
  );
}
