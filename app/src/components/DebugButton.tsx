/**
 * PearKit's debug-notes button wired to this app's notes object, with the toasts when a note is saved.
 */
import React from 'react';
import { debugNotes } from '../debugNotes';
import { DebugNotesButton, useToast } from '../kit';

export function DebugButton({ className }: { className?: string }) {
  const { toast } = useToast();
  return (
    <DebugNotesButton
      notes={debugNotes()}
      variant="compact"
      size="sm"
      className={className}
      onStopped={(saved) => {
        if (!saved) {
          toast({ title: 'Debug note not saved', tone: 'danger' });
          return;
        }
        const sharelink = typeof saved.sharelink === 'string' ? saved.sharelink : null;
        const audio = saved.recorded ? '' : ' · steps only, no microphone';
        toast({ title: 'Debug note saved', description: `${saved.id}${audio}`, tone: 'success', duration: 5000 });
        if (sharelink) toast({ title: 'Note shared to your notes space', description: 'Pull it on the Mac: rkeychat notes pull <link> (the link is in Settings › Debug).', duration: 6000 });
      }}
    />
  );
}
