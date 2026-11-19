import { describe, expect, it } from 'vitest';
import type { RoomSummary } from '../types';
import { needsYou, onlineNow, orgSummaries, recentConversations } from './home';
import { filterByOrg, neighbourTab, orgTabs, readDock, readOrgFilter, writeDock, writeOrgFilter } from './nav';
import { initialState, reducer } from './reducer';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const room = (topic: string, org: string | null, name = topic): RoomSummary => ({ name, topic, owner: true, admitted: true, folder: null, app: { app: 'rkeychat', role: 'project', name, org }, convs: [] });

describe('dock', () => {
  it('remembers the page and falls back to home', () => {
    const s = mem();
    expect(readDock(s)).toBe('home');
    writeDock('projects', s);
    expect(readDock(s)).toBe('projects');
    s.setItem('rkc.app.dock', 'bogus');
    expect(readDock(s)).toBe('home');
    expect(readDock(null)).toBe('home');
  });
  it('remembers the organization filter', () => {
    const s = mem();
    expect(readOrgFilter(s)).toBe('all');
    writeOrgFilter('Anjou', s);
    expect(readOrgFilter(s)).toBe('Anjou');
  });
});

describe('organization tabs and filter', () => {
  const rooms = [room('a', 'Anjou'), room('b', null), room('c', 'Bitcoin Audible'), room('d', 'Anjou')];
  it('lists All, each organization, and No organization', () => {
    expect(orgTabs(rooms).map((t) => [t.key, t.count])).toEqual([['all', 4], ['Anjou', 2], ['Bitcoin Audible', 1], ['none', 1]]);
    expect(orgTabs([room('x', null)]).map((t) => t.key)).toEqual(['all']);
  });
  it('filters by organization, including the ones without', () => {
    expect(filterByOrg(rooms, 'all').map((r) => r.topic)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterByOrg(rooms, 'Anjou').map((r) => r.topic)).toEqual(['a', 'd']);
    expect(filterByOrg(rooms, 'none').map((r) => r.topic)).toEqual(['b']);
  });
  it('swipes to the neighbour and stops at the ends', () => {
    const tabs = orgTabs(rooms);
    expect(neighbourTab(tabs, 'all', 1)).toBe('Anjou');
    expect(neighbourTab(tabs, 'Anjou', -1)).toBe('all');
    expect(neighbourTab(tabs, 'all', -1)).toBe('all');
    expect(neighbourTab(tabs, 'none', 1)).toBe('none');
  });
});

describe('home blocks', () => {
  it('needs you = unread approvals and mentions', () => {
    const f = [
      { id: '1', kind: 'approval' as const, ts: 1, title: 'x', unread: true },
      { id: '2', kind: 'mention' as const, ts: 2, title: 'y', unread: false },
      { id: '3', kind: 'done' as const, ts: 3, title: 'z', unread: true },
      { id: '4', kind: 'mention' as const, ts: 4, title: 'w', unread: true },
    ];
    expect(needsYou(f).map((x) => x.id)).toEqual(['1', '4']);
  });
  it('recent conversations across projects, newest first, archived skipped', () => {
    const conv = (conv: string, ts: number | null, archived = false) => ({ conv, title: conv, created: 1, archived, runtime: null, last: ts ? { ts, name: 'g', text: 'hi' } : null, count: 1, busy: [] });
    const s = { rooms: { a: room('a', null, 'A'), b: room('b', null, 'B') }, roomOrder: ['a', 'b'], convs: { a: [conv('main', 5), conv('x', 9), conv('old', 20, true)], b: [conv('main', 7), conv('empty', null)] } };
    expect(recentConversations(s, 2).map((r) => [r.room, r.conv.conv])).toEqual([['A', 'x'], ['B', 'main']]);
  });
  it('organizations by size', () => {
    expect(orgSummaries([room('a', 'Anjou'), room('b', 'Zed'), room('c', 'Zed'), room('d', null)]).map((o) => [o.name, o.count])).toEqual([['Zed', 2], ['Anjou', 1]]);
  });
  it('who is online: me first, then online, from participants and known people', () => {
    let s = reducer(initialState, { type: 'init', device: { name: 'd', human: 'guy' }, rooms: [room('t', null)] });
    s = reducer(s, { type: 'room', snapshot: { name: 't', topic: 't', owner: true, admitted: true, participants: [{ name: 'rkeychat', role: 'agent', online: true }, { name: 'guy', role: 'human', local: true }, { name: 'jeffrey', role: 'human', online: false }], members: [], reactions: {}, charter: { text: '', order: [], agents: {} }, log: [], hasOlder: false, convs: [], folder: null, app: null, seats: [] } });
    const out = onlineNow(s, { local: [{ name: 'claude', role: 'agent', local: true }], known: [{ name: 'amir', role: 'human', from: 'x' }] });
    expect(out.map((p) => [p.name, p.online, !!p.agent])).toEqual([['guy', true, false], ['claude', true, true], ['rkeychat', true, true], ['amir', false, false], ['jeffrey', false, false]]);
  });
});
