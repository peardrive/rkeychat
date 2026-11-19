/**
 * What the Home page shows: what needs you, recent conversations, organizations, who is online.
 */
import type { Conversation, Person, RoomSummary } from '../types';
import type { FeedItem } from './feed';
import type { State } from './reducer';
import { orgOf } from './selectors';

/** Unread approvals and mentions, newest first. */
export const needsYou = (feed: FeedItem[]) => feed.filter((f) => f.unread && (f.kind === 'approval' || f.kind === 'mention'));

export type RecentConversation = { topic: string; room: string; conv: Conversation; ts: number };

/** The last `n` conversations with a message, across every project. */
export function recentConversations(state: Pick<State, 'rooms' | 'roomOrder' | 'convs'>, n = 5): RecentConversation[] {
  const out: RecentConversation[] = [];
  for (const topic of state.roomOrder) {
    const room = state.rooms[topic];
    if (!room) continue;
    for (const conv of state.convs[topic] ?? []) {
      if (conv.archived || !conv.last) continue;
      out.push({ topic, room: room.name, conv, ts: conv.last.ts });
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, n);
}

export type OrgSummary = { name: string; count: number; seed: string };

/** Organizations with how many projects each has, the busiest first. */
export function orgSummaries(rooms: RoomSummary[]): OrgSummary[] {
  const m = new Map<string, number>();
  for (const r of rooms) {
    const o = orgOf(r);
    if (o) m.set(o, (m.get(o) ?? 0) + 1);
  }
  return [...m.entries()].map(([name, count]) => ({ name, count, seed: `org:${name}` })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export type Presence = { id: string; name: string; agent?: boolean; online: boolean };

/**
 * Peers and bots: everyone seen in a loaded room's participants (online when any room says so), plus the
 * people and local agents the daemon knows. Me first, then online, then by name.
 */
export function onlineNow(state: Pick<State, 'details' | 'me'>, people?: { local: Person[]; known: Person[] } | null): Presence[] {
  const m = new Map<string, Presence>();
  for (const d of Object.values(state.details)) {
    for (const p of d.participants) {
      const prev = m.get(p.name);
      m.set(p.name, { id: p.name, name: p.name, agent: p.role === 'agent', online: !!prev?.online || !!p.online || !!p.local });
    }
  }
  for (const p of [...(people?.local ?? []), ...(people?.known ?? [])]) {
    if (!m.has(p.name)) m.set(p.name, { id: p.name, name: p.name, agent: p.role === 'agent', online: !!p.local });
  }
  const me = state.me?.human;
  return [...m.values()].sort((a, b) => Number(b.name === me) - Number(a.name === me) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}
