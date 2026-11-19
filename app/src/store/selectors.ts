/**
 * Derived views of the state: projects vs chats, titles, unread totals, the open thread.
 */
import type { Conversation, Device, RoomSummary } from '../types';
import { convKey, type State } from './reducer';

export const isProject = (r: RoomSummary) => !!r.folder || r.app?.role === 'project';

export function groupRooms(rooms: RoomSummary[]): { projects: RoomSummary[]; chats: RoomSummary[] } {
  const projects: RoomSummary[] = [];
  const chats: RoomSummary[] = [];
  for (const r of rooms) (isProject(r) ? projects : chats).push(r);
  return { projects, chats };
}

export const orderedRooms = (s: State) => s.roomOrder.map((t) => s.rooms[t]).filter(Boolean);

export function convTitle(c: Pick<Conversation, 'conv' | 'title' | 'last'> | null | undefined): string {
  if (!c) return '';
  const t = (c.title ?? '').trim();
  if (t) return t;
  if (c.conv === 'main') return 'General';
  const snippet = c.last?.text?.trim();
  return snippet ? snippet.slice(0, 40) : 'New conversation';
}

export const folderName = (folder: string | null | undefined) => (folder ? folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder : '');

export function visibleConvs(s: State, topic: string): Conversation[] {
  const list = s.convs[topic] ?? [];
  return list.filter((c) => !c.archived).sort((a, b) => (a.conv === 'main' ? -1 : b.conv === 'main' ? 1 : (b.last?.ts ?? b.created) - (a.last?.ts ?? a.created)));
}

export const archivedConvs = (s: State, topic: string) => (s.convs[topic] ?? []).filter((c) => c.archived);

export const unreadIn = (s: State, topic: string, conv: string) => s.unread[convKey(topic, conv)] ?? 0;

export function unreadInRoom(s: State, topic: string): number {
  let n = 0;
  for (const c of s.convs[topic] ?? []) if (!c.archived) n += unreadIn(s, topic, c.conv);
  return n;
}

/** Seat names with a turn in flight in a conversation (daemon's `busy` or a live agent-state). */
export function thinkingIn(s: State, topic: string, conv: string): string[] {
  const live = s.agents[convKey(topic, conv)] ?? {};
  const names = new Set(Object.entries(live).filter(([, st]) => st === 'thinking' || st === 'waiting').map(([n]) => n));
  const c = (s.convs[topic] ?? []).find((x) => x.conv === conv);
  // `busy` from the server is the ground truth unless a later agent-state said idle.
  for (const n of c?.busy ?? []) if (live[n] === undefined) names.add(n);
  return [...names];
}

export const roomIsThinking = (s: State, topic: string) => (s.convs[topic] ?? []).some((c) => !c.archived && thinkingIn(s, topic, c.conv).length > 0);

export const selectedRoom = (s: State) => (s.selected.topic ? s.rooms[s.selected.topic] ?? null : null);
export const selectedConv = (s: State): Conversation | null => {
  const { topic, conv } = s.selected;
  if (!topic || !conv) return null;
  return (s.convs[topic] ?? []).find((c) => c.conv === conv) ?? null;
};
export const selectedThread = (s: State) => (s.selected.topic && s.selected.conv ? s.threads[convKey(s.selected.topic, s.selected.conv)] ?? null : null);

/** Where a project's folder lives. A room without a `home` note is at home wherever it has a folder. */
export function homeOf(room: Pick<RoomSummary, 'folder' | 'app'> | null | undefined, myRef: string | undefined): { name: string | null; here: boolean } {
  const home = room?.app?.home ?? null;
  if (!home) return { name: null, here: !!room?.folder };
  return { name: home.name, here: !!myRef && home.device === myRef };
}

/** This device first, then online ones, then offline, each group alphabetical. */
export function orderDevices(devices: Device[]): Device[] {
  return [...devices].sort((a, b) => Number(b.here) - Number(a.here) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** The folder name the home makes under its workspace root for a project name (the daemon's rule). */
export const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
