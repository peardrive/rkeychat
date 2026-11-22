/**
 * PearKit's debug-notes button wired to this app's notes object. Its corner dot says whether the Mac (the reader of
 * this device's notes) is on the notes space; stopping a note hands it to the sync bubble (DebugSyncBubble), which
 * follows the note to the Mac.
 */
import React from 'react';
import { debugNotes } from '../debugNotes';
import { connectionLabel, connectionOf, noteSaved, useDebugSync } from '../debugSync';
import { DebugNotesButton } from '../kit';

export function DebugButton({ className }: { className?: string }) {
  const { sync } = useDebugSync();
  return (
    <DebugNotesButton
      notes={debugNotes()}
      variant="compact"
      size="sm"
      className={className}
      connection={connectionOf(sync)}
      connectionLabel={connectionLabel(sync)}
      onStopped={(saved) => noteSaved(saved ? { id: saved.id, shared: saved.shared !== false && typeof saved.sharelink === 'string', recorded: saved.recorded } : null)}
    />
  );
}
