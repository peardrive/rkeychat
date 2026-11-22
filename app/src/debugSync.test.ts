import { describe, expect, it } from 'vitest';
import { bubbleFor, connectionLabel, connectionOf, notePill, pollEvery, readerName } from './debugSync';
import type { DebugSyncInfo } from './types';

const MAC = 'ab'.repeat(32);
const saved = { id: '2026-11-22T18-09-52', shared: true, recorded: true };
const sync = (over: Partial<DebugSyncInfo> = {}): DebugSyncInfo => ({ connected: false, peers: 0, readers: [], notes: {}, ...over });
const note = (state: 'local' | 'fetching' | 'fetched', got = 0) => ({ files: 3, state, by: got || state !== 'local' ? { [MAC]: { name: 'macbook', got, of: 3 } } : {} });

describe('the note bubble', () => {
  it('says what happened to a note that could not be saved or announced', () => {
    expect(bubbleFor(null, null, 0)).toMatchObject({ state: 'failed', label: 'Debug note not saved' });
    expect(bubbleFor({ ...saved, shared: false }, sync(), 0)).toMatchObject({ state: 'offline', label: 'Saved on this device' });
  });

  it('waits for the Mac, names it once it is connected, and tells a long wait what to do', () => {
    expect(bubbleFor(saved, null, 0)).toMatchObject({ state: 'saving', label: 'Saved' });
    expect(bubbleFor(saved, sync({ notes: { [saved.id]: note('local') } }), 1000)).toEqual({ state: 'waiting', label: 'Waiting for the Mac', detail: 'open rKeyChat there' });
    expect(bubbleFor(saved, sync({ notes: { [saved.id]: note('local') } }), 30_000).detail).toMatch(/keep this app open/);
    const connected = sync({ connected: true, peers: 1, readers: [{ key: MAC, name: 'macbook' }], notes: { [saved.id]: note('local') } });
    expect(bubbleFor(saved, connected, 1000)).toEqual({ state: 'waiting', label: 'macbook is connected', detail: 'waiting for it to fetch the note' });
  });

  it('counts the files on their way and glows once they are all there', () => {
    const s = (st: 'fetching' | 'fetched', got: number) => sync({ connected: true, peers: 1, readers: [{ key: MAC, name: 'macbook' }], notes: { [saved.id]: note(st, got) } });
    expect(bubbleFor(saved, s('fetching', 0), 1000)).toEqual({ state: 'sending', label: 'Sending to macbook', detail: '0 of 3 files' });
    expect(bubbleFor(saved, s('fetching', 2), 1000)).toEqual({ state: 'sending', label: 'Sending to macbook', detail: '2 of 3 files' });
    expect(bubbleFor(saved, s('fetched', 3), 1000)).toEqual({ state: 'synced', label: 'On macbook', detail: '3 files' });
  });

  it('names the reader from the note first, then from the space, then "the Mac"', () => {
    expect(readerName(null)).toBe('the Mac');
    expect(readerName(sync({ readers: [{ key: 'x', name: null }] }))).toBe('the Mac');
    expect(readerName(sync({ readers: [{ key: 'x', name: 'zorin' }] }))).toBe('zorin');
    expect(readerName(sync({ readers: [{ key: 'x', name: 'zorin' }] }), note('fetched', 3))).toBe('macbook');
  });

  it('drives the dot and the pills', () => {
    expect(connectionOf(null)).toBeUndefined();
    expect(connectionOf(sync())).toBe('offline');
    expect(connectionOf(sync({ connected: true, peers: 1 }))).toBe('connected');
    expect(connectionLabel(sync({ connected: true, peers: 1, readers: [{ key: MAC, name: 'macbook' }] }))).toBe('macbook is connected');
    expect(connectionLabel(sync())).toBe('No reader connected');
    expect(notePill(undefined, sync())).toEqual({ label: 'Saved here', tone: 'neutral' });
    expect(notePill(note('local'), sync())).toEqual({ label: 'Waiting for the Mac', tone: 'warning' });
    expect(notePill(note('local'), sync({ connected: true }))).toEqual({ label: 'Not fetched yet', tone: 'warning' });
    expect(notePill(note('fetching', 1), sync())).toEqual({ label: 'Sending to macbook', tone: 'info' });
    expect(notePill(note('fetched', 3), sync())).toEqual({ label: 'On macbook', tone: 'success' });
    expect(pollEvery(true)).toBeLessThan(pollEvery(false));
  });
});
