/**
 * Where a debug note stands with the Mac that pulls it, for the bubble at the bottom of the screen and the dot on
 * the debug button. The daemon's `GET /api/debug/sync` says who is on the notes space and which reader has asked
 * for which note files (src/debug-notes.js); this file turns that into words and a state, and keeps the one
 * bubble the app shows (the last note saved) with a small store any component can read.
 */
import { useSyncExternalStore } from 'react';
import { getApi } from './api';
import { syncBubbleLinger, syncProgressLabel, type SyncState } from 'pearkit/sync';
import type { NetworkState } from './kit';
import type { DebugNoteSync, DebugSyncInfo } from './types';

/** What the button hands over when a note stops: null when it could not be saved at all. */
export type SavedNote = { id: string; shared: boolean; recorded: boolean } | null;
export type Bubble = { state: SyncState; label: string; detail?: string };

/** The device the note is going to, by name when one is known: the reader that has it, else any reader, else "the Mac". */
export function readerName(sync: DebugSyncInfo | null, note?: DebugNoteSync): string {
  const by = note ? Object.values(note.by) : [];
  const got = by.find((b) => b.got >= b.of)?.name ?? by.find((b) => b.name)?.name;
  return got ?? sync?.readers.find((r) => r.name)?.name ?? 'the Mac';
}

/** The bubble for the note just saved, `waitedMs` after it was. */
export function bubbleFor(saved: SavedNote, sync: DebugSyncInfo | null, waitedMs: number): Bubble {
  if (!saved) return { state: 'failed', label: 'Debug note not saved' };
  if (!saved.shared) return { state: 'offline', label: 'Saved on this device', detail: 'the notes space is down; it goes when the space is back' };
  const note = sync?.notes[saved.id];
  const who = readerName(sync, note);
  if (!sync) return { state: 'saving', label: 'Saved', detail: 'checking the sync…' };
  if (note?.state === 'fetched') return { state: 'synced', label: `On ${who}`, detail: syncProgressLabel(note.files, note.files) };
  if (note?.state === 'fetching') {
    const b = Object.values(note.by).sort((x, y) => y.got - x.got)[0];
    return { state: 'sending', label: `Sending to ${who}`, detail: b ? syncProgressLabel(b.got, b.of) : undefined };
  }
  if (sync.connected) return { state: 'waiting', label: `${who} is connected`, detail: 'waiting for it to fetch the note' };
  return { state: 'waiting', label: `Waiting for ${who}`, detail: waitedMs > 20_000 ? 'keep this app open; it goes when the Mac connects' : 'open rKeyChat there' };
}

/** The dot on the debug button: green when a reader is on the notes space, grey when none is; nothing until we know. */
export function connectionOf(sync: DebugSyncInfo | null): NetworkState | undefined {
  if (!sync) return undefined;
  return sync.connected ? 'connected' : 'offline';
}

/** Words for the dot: "macbook is connected" / "No reader connected". */
export function connectionLabel(sync: DebugSyncInfo | null): string | undefined {
  if (!sync) return undefined;
  return sync.connected ? `${readerName(sync)} is connected` : 'No reader connected';
}

/** The pill beside a note in Settings. */
export function notePill(note: DebugNoteSync | undefined, sync: DebugSyncInfo | null): { label: string; tone: 'success' | 'info' | 'warning' | 'neutral' } {
  if (!note) return { label: 'Saved here', tone: 'neutral' };
  if (note.state === 'fetched') return { label: `On ${readerName(sync, note)}`, tone: 'success' };
  if (note.state === 'fetching') return { label: `Sending to ${readerName(sync, note)}`, tone: 'info' };
  return sync?.connected ? { label: 'Not fetched yet', tone: 'warning' } : { label: 'Waiting for the Mac', tone: 'warning' };
}

/** How often to ask the daemon: quickly while a bubble is up, now and then otherwise (the dot). */
export const pollEvery = (bubbleShown: boolean) => (bubbleShown ? 1500 : 10_000);

/* ───────────────────────── the store ───────────────────────── */

export type DebugSyncState = { sync: DebugSyncInfo | null; shown: { saved: SavedNote; since: number } | null; now: number };

let state: DebugSyncState = { sync: null, shown: null, now: Date.now() };
const listeners = new Set<() => void>();
const set = (patch: Partial<DebugSyncState>) => {
  state = { ...state, ...patch, now: Date.now() };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The sync state and the bubble, live. */
export function useDebugSync(): DebugSyncState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** The button stopped a note: show its bubble. */
export function noteSaved(saved: SavedNote) {
  set({ shown: { saved, since: Date.now() } });
  void refreshSync().then(() => {
    if (running) arm(); // the quick pace, from now
  });
}

export function dismissBubble() {
  set({ shown: null });
  if (running) arm(); // back to the slow pace
}

let refreshing: Promise<void> | null = null;
export function refreshSync(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = getApi()
    .debugSync()
    .then((sync) => set({ sync }))
    .catch(() => set({})) // keep what we had; the tick still moves the clock
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
function arm() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (!running) return;
    void refreshSync().then(() => {
      // a settled bubble goes on its own after its linger
      const s = state.shown;
      if (s) {
        const b = bubbleFor(s.saved, state.sync, Date.now() - s.since);
        const linger = syncBubbleLinger(b.state);
        if (linger !== null) {
          const settled = (settledAt.get(s.since) ?? (settledAt.set(s.since, Date.now()), Date.now()));
          if (Date.now() - settled >= linger) dismissBubble();
        } else settledAt.delete(s.since);
      }
      arm();
    });
  }, pollEvery(!!state.shown));
}
const settledAt = new Map<number, number>();

/** Mount once (the shell): polls the daemon while the app is up. Returns the stop function. */
export function startDebugSync(): () => void {
  running++;
  if (running === 1) {
    void refreshSync().then(arm);
  }
  return () => {
    running = Math.max(0, running - 1);
    if (!running && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** Tests: reset the store. */
export function resetDebugSync() {
  state = { sync: null, shown: null, now: Date.now() };
  settledAt.clear();
}
