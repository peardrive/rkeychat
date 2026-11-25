import { describe, expect, it } from 'vitest';
import { noticeOf, runningLabel, runsFromLabel, updatesBlurb } from './updates';
import type { UpdatesState } from '../types';

const base = (over: Partial<UpdatesState> = {}): UpdatesState => ({
  app: 'rkeychat-desktop',
  appName: 'rKeyChat',
  running: { version: '0.3.1', build: '2026-11-25.1', commit: 'abc1234', from: '/Applications/rKeyChat.app', source: false, desktop: true },
  platform: { os: 'mac', arch: 'arm64' },
  status: 'available',
  latest: { id: 'b', version: '0.3.2', build: '2026-11-25.2', at: 1, size: 1, notes: '', file: 'rkeychat-desktop-0.3.2-mac-arm64.zip' },
  available: true,
  behind: 1,
  progress: null,
  error: null,
  canInstall: true,
  versions: [],
  pending: [{ id: 'b', version: '0.3.2', build: '2026-11-25.2', at: 1, size: 1, notes: '', file: 'rkeychat-desktop-0.3.2-mac-arm64.zip' }],
  job: { state: 'idle' },
  channel: { name: 'rKeyChat', publisher: 'ed25519:ab', link: 'pearcore://x', connected: true, isDefault: true, publisherIsMe: false },
  rejected: 0,
  checkedAt: 1,
  refused: null,
  phone: false,
  ...over,
});

describe('the updates state, read for the page', () => {
  it('the notice: a version waiting, the download with its progress, the restart, an error; nothing on a phone or when up to date', () => {
    expect(noticeOf(base())).toEqual({ version: '0.3.2', behind: 1, state: 'available' });
    expect(noticeOf(base({ status: 'downloading', progress: 0.4, job: { state: 'downloading', version: '0.3.2', progress: 0.4 } }))).toEqual({ version: '0.3.2', behind: 1, state: 'downloading', progress: 0.4 });
    expect(noticeOf(base({ status: 'installing', job: { state: 'installing', version: '0.3.2' } }))).toEqual({ version: '0.3.2', behind: 1, state: 'restarting' });
    expect(noticeOf(base({ job: { state: 'error', version: '0.3.2', error: 'offline' } }))).toEqual({ version: '0.3.2', behind: 1, state: 'error', error: 'offline' });
    expect(noticeOf(base({ status: 'up-to-date', available: false, behind: 0, pending: [] }))).toBeNull();
    expect(noticeOf(base({ phone: true }))).toBeNull();
    expect(noticeOf(null)).toBeNull();
  });

  it('the running copy is written with what it knows, and says when it runs from a source tree', () => {
    expect(runningLabel(base())).toBe('0.3.1 · build 2026-11-25.1 · abc1234');
    expect(runningLabel(base({ running: { version: '0.3.1', build: null, commit: null, from: '/x', source: true, desktop: false } }))).toBe('0.3.1');
    expect(runsFromLabel(base())).toBe('/Applications/rKeyChat.app');
    expect(runsFromLabel(base({ running: { version: '0.3.1', build: null, commit: null, from: '/Users/me/rKeyChat', source: true, desktop: false } }))).toBe('the source tree at /Users/me/rKeyChat');
  });

  it('the blurb follows the status', () => {
    expect(updatesBlurb(base())).toBe('rKeyChat 0.3.2 is ready');
    expect(updatesBlurb(base({ behind: 3 }))).toBe('rKeyChat 0.3.2 is ready, 3 versions behind');
    expect(updatesBlurb(base({ status: 'up-to-date' }))).toBe('you are on the newest version');
    expect(updatesBlurb(base({ status: 'installing', job: { state: 'installing', version: '0.3.2' } }))).toBe('installing 0.3.2, the app restarts on it');
    expect(updatesBlurb(base({ status: 'no-channel' }))).toBe('no update channel set');
    expect(updatesBlurb(base({ status: 'connecting' }))).toBe('reaching the update channel…');
  });
});
