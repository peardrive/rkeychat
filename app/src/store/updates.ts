/**
 * The update channel's state, read for the page: what the sidebar notice shows, how the running copy is written,
 * what the Updates block says under its title. The state itself comes from the daemon (`GET /api/updates`, pushed as
 * `updates` events); pearkit's `noticeFor` turns it into the notice's words.
 */
// pearkit/updates is plain TypeScript built to lib/: no React Native in it, so this file (and its test) load under Node
import { noticeFor, type UpdateChannelState } from 'pearkit/updates';
import type { UpdatesState } from '../types';

export type Notice = ReturnType<typeof noticeFor>;

/** The sidebar notice, or null when there is nothing to press. */
export function noticeOf(u: UpdatesState | null): Notice {
  if (!u || u.phone) return null;
  const running = { version: u.running.version, build: u.running.build ?? undefined, commit: u.running.commit ?? undefined, from: u.running.from };
  return noticeFor({ ...u, running } as unknown as UpdateChannelState);
}

/** "0.3.1 · build 2026-11-25.3 · 3698535", as much of it as the copy knows. */
export function runningLabel(u: UpdatesState): string {
  return [u.running.version, u.running.build ? `build ${u.running.build}` : null, u.running.commit].filter(Boolean).join(' · ');
}

/** Where this copy runs from, for the row's hint: the app, the AppImage, or "the source tree at …". */
export function runsFromLabel(u: UpdatesState): string {
  return u.running.source ? `the source tree at ${u.running.from}` : u.running.from;
}

/** The line under "Updates" in Settings. */
export function updatesBlurb(u: UpdatesState): string {
  switch (u.status) {
    case 'available':
      return `${u.appName} ${u.latest?.version ?? ''} is ready${u.behind > 1 ? `, ${u.behind} versions behind` : ''}`;
    case 'downloading':
      return `downloading ${u.job.version ?? ''}…`;
    case 'installing':
      return `installing ${u.job.version ?? ''}, the app restarts on it`;
    case 'up-to-date':
      return 'you are on the newest version';
    case 'no-channel':
      return 'no update channel set';
    case 'starting':
    case 'connecting':
      return 'reaching the update channel…';
    default:
      return 'new versions arrive through the update channel';
  }
}
