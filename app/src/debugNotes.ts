/**
 * Debug notes: the one module every app gets (pearkit/src/debug). A voice note plus every step taken while it
 * ran, saved by the daemon (`POST /api/debug/note`) into the notes space, so an agent on the Mac can pull it.
 */
import { createDebugNotes, type DebugNotes } from 'pearkit';
import { getApi } from './api';
import { describeFrom, whereFrom, type WhereInput } from './debug/where';

let whereNow: () => WhereInput = () => ({ page: 'home' });
let conversationTab: 'chat' | 'files' = 'chat';

/** The conversation screen says which of its tabs is showing. */
export function setConversationTab(tab: 'chat' | 'files') {
  conversationTab = tab;
}
export const getConversationTab = () => conversationTab;

/** The app tells the notes where it is (App.tsx keeps this current). */
export function setDebugWhere(fn: () => WhereInput) {
  whereNow = fn;
}

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(s);
}

export const MAX_NOTE_BYTES = 8 * 1024 * 1024;

let notes: DebugNotes | null = null;

/** The one notes object; made on first use (it installs document listeners). */
export function debugNotes(): DebugNotes {
  if (notes) return notes;
  notes = createDebugNotes({
    app: 'rkeychat',
    where: () => whereFrom(whereNow()) as unknown as Record<string, unknown>,
    describe: (target, hit) => describeFrom(target, hit),
    save: async (note) => {
      let audio: string | null = null;
      if (note.blob && note.blob.size) {
        if (note.blob.size > MAX_NOTE_BYTES) throw new Error(`the recording is ${(note.blob.size / 1048576).toFixed(1)} MB; the daemon takes 8 MB`);
        audio = await toBase64(note.blob);
      }
      return getApi().debugSaveNote({ id: note.id, audio, audioType: note.type ?? note.blob?.type ?? null, trace: note.steps, meta: note.meta });
    },
  });
  return notes;
}
