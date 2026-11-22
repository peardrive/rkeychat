import { describe, expect, it } from 'vitest';
import type { Rec, RoomSummary } from '../types';
import { bumpEmoji, topEmoji } from './emoji';
import { feedUnread, mentions, pushFeed, type FeedItem } from './feed';
import { initialState, reducer, type State } from './reducer';
import { groupByOrg, orgNames } from './selectors';

const room = (r: Partial<RoomSummary> & { topic: string }): RoomSummary => ({ name: r.topic, owner: true, admitted: true, folder: null, app: null, convs: [], ...r });
const withOrg = (topic: string, org: string | null) => room({ topic, name: topic, app: { app: 'rkeychat', role: 'project', name: topic, org } });

describe('organizations', () => {
  it('groups projects by organization with the ungrouped ones first', () => {
    const { ungrouped, orgs } = groupByOrg([withOrg('a', 'Bitcoin Audible'), withOrg('b', null), withOrg('c', 'Anjou'), withOrg('d', ' '), withOrg('e', 'Bitcoin Audible')]);
    expect(ungrouped.map((r) => r.topic)).toEqual(['b', 'd']);
    expect(orgs.map((o) => [o.name, o.rooms.map((r) => r.topic)])).toEqual([['Anjou', ['c']], ['Bitcoin Audible', ['a', 'e']]]);
    expect(orgNames([withOrg('a', 'Zed'), withOrg('b', 'Anjou'), withOrg('c', 'Zed')])).toEqual(['Anjou', 'Zed']);
  });
});

describe('most-used emoji', () => {
  it('counts reactions and puts the most used first, then the defaults', () => {
    let c = {};
    for (const e of ['🔥', '🔥', '👀', '🔥', '👀', '🚀']) c = bumpEmoji(c, e);
    expect(topEmoji(c)).toEqual(['🔥', '👀', '🚀', '👍', '❤️', '😂']);
    expect(topEmoji({})).toEqual(['👍', '❤️', '😂', '🎉', '🤔', '👀']);
    expect(topEmoji(c, 2)).toEqual(['🔥', '👀']);
  });
});

describe('feed', () => {
  const item = (id: string, ts: number, unread = true): FeedItem => ({ id, kind: 'done', ts, title: id, unread });
  it('keeps the newest first, replaces repeats and caps at 200', () => {
    let f: FeedItem[] = [];
    for (let i = 0; i < 205; i++) f = pushFeed(f, item(`i${i}`, i));
    expect(f).toHaveLength(200);
    expect(f[0].id).toBe('i204');
    f = pushFeed(f, { ...item('i204', 999), title: 'again' });
    expect(f.filter((x) => x.id === 'i204')).toHaveLength(1);
    expect(feedUnread([item('a', 1), item('b', 2, false)])).toBe(1);
  });
  it('finds a mention as a word', () => {
    expect(mentions('hey @guy, look', 'guy')).toBe(true);
    expect(mentions('@guy2 look', 'guy')).toBe(false);
    expect(mentions('mail guy@example.com', 'guy')).toBe(false);
    expect(mentions('x', null)).toBe(false);
  });

  const T = 't';
  const booted: State = reducer(initialState, { type: 'init', device: { name: 'studio', human: 'guy' }, rooms: [room({ topic: T, name: 'PearDrive', convs: [{ conv: 'main', title: 'General', archived: false, last: null, count: 0 }] })] });
  const msg = (id: string, text: string, name = 'rkeychat', att?: Rec['att']): Rec => ({ id, kind: 'msg', ts: 5, name, human: false, text, conv: 'main', att });

  it('a project that appears after boot lands in the feed; the ones there at boot do not', () => {
    expect(booted.feed).toEqual([]);
    const s = reducer(booted, { type: 'rooms', rooms: [...Object.values(booted.rooms), room({ topic: 'u', name: 'Show notes', folder: '/w/show-notes', app: { role: 'project', org: 'Bitcoin Audible' } as never })] });
    expect(s.feed.map((x) => [x.kind, x.title, x.where?.org, x.unread])).toEqual([['project', 'New project: Show notes', 'Bitcoin Audible', true]]);
    // the same list again announces nothing twice
    expect(reducer(s, { type: 'rooms', rooms: Object.values(s.rooms) }).feed).toHaveLength(1);
  });

  it('a mention of me and a shared file become feed items, my own messages do not', () => {
    let s = reducer(booted, { type: 'log', topic: T, conv: 'main', log: [], hasOlder: false, mode: 'replace' });
    s = reducer(s, { type: 'record', topic: T, rec: msg('m1', 'done, @guy have a look') });
    s = reducer(s, { type: 'record', topic: T, rec: msg('m2', 'here', 'jeffrey', [{ hash: 'abc', kind: 'file', name: 'shot.png' }]) });
    s = reducer(s, { type: 'record', topic: T, rec: msg('m3', '@guy me', 'guy') });
    expect(s.feed.map((x) => [x.kind, x.title, x.who])).toEqual([['file', 'shared shot.png', 'jeffrey'], ['mention', 'mentioned you', 'rkeychat']]);
    expect(feedUnread(s.feed)).toBe(2);
    s = reducer(s, { type: 'feedOpen', id: 'mention:m1' });
    expect(feedUnread(s.feed)).toBe(1);
    s = reducer(s, { type: 'feedOpenAll' });
    expect(feedUnread(s.feed)).toBe(0);
  });

  it('a seat going thinking → idle is "done", error is "error"', () => {
    let s = reducer(booted, { type: 'agentState', topic: T, name: 'rkeychat', conv: 'main', state: 'thinking' });
    s = reducer(s, { type: 'agentState', topic: T, name: 'rkeychat', conv: 'main', state: 'idle' });
    expect(s.feed[0]).toMatchObject({ kind: 'done', title: 'finished', who: 'rkeychat', where: { project: 'PearDrive', conversation: 'General' }, conv: 'main' });
    s = reducer(s, { type: 'agentState', topic: T, name: 'rkeychat', conv: 'main', state: 'error' });
    expect(s.feed[0].kind).toBe('error');
    // idle without a turn before is not news
    expect(reducer(booted, { type: 'agentState', topic: T, name: 'x', conv: 'main', state: 'idle' }).feed).toEqual([]);
  });

  it('a new conversation after boot is news; the boot list is not', () => {
    const s = reducer(booted, { type: 'convs', topic: T, convs: [{ conv: 'main', title: 'General', created: 1, archived: false, runtime: null, last: null, count: 0, busy: [] }, { conv: 'c2', title: 'Share row', created: 2, archived: false, runtime: null, last: null, count: 0, busy: [] }] });
    expect(s.feed.map((x) => [x.kind, x.title, x.conv])).toEqual([['conversation', 'New conversation: Share row', 'c2']]);
  });

  it('a login ask is an approval until granted or denied; the pending list syncs', () => {
    const ask = { topic: 'k', device: 'd', deviceName: 'guy-phone', names: [{ name: 'guy', role: 'human' }], action: 'login' as const, at: 7 };
    let s = reducer(booted, { type: 'loginAsk', ask });
    expect(s.feed[0]).toMatchObject({ kind: 'approval', title: 'wants to log in', who: 'guy-phone', text: 'as guy', unread: true });
    expect(reducer(s, { type: 'feedOpenAll' }).feed[0].unread).toBe(true);
    s = reducer(s, { type: 'loginAsks', asks: [] });
    expect(s.feed).toEqual([]);
    s = reducer(s, { type: 'loginAsks', asks: [{ ...ask, room: 'PearDrive', action: 'room' }] });
    expect(s.feed[0].title).toBe('wants into PearDrive');
    s = reducer(s, { type: 'feedRemove', id: 'ask:k' });
    expect(s.feed).toEqual([]);
  });
});

describe('a project asked of another device', () => {
  const T = 't';
  const booted: State = reducer(initialState, { type: 'init', device: { name: 'phone', human: 'guy' }, rooms: [room({ topic: T, name: 'PearDrive' })] });
  const asked = reducer(booted, { type: 'pendingProject', id: 'req1', name: 'Leaf Note', asked: 'macbook', online: true });

  it('waits until a room answers the request by id, whatever the room is called', () => {
    expect(asked.pendingProjects.map((p) => [p.id, p.topic])).toEqual([['req1', undefined]]);
    // a room called after the author (the 2026-11-19 bug) answers nothing
    const wrong = reducer(asked, { type: 'rooms', rooms: [...Object.values(asked.rooms), room({ topic: 'g', name: 'guy', app: { app: 'rkeychat', role: 'project', name: 'guy' } })] });
    expect(wrong.pendingProjects[0].topic).toBeUndefined();
    // the room whose note names the request does, under any name
    const right = reducer(wrong, { type: 'rooms', rooms: [...Object.values(wrong.rooms), room({ topic: 'l', name: 'Leaf Note by Anjou', app: { app: 'rkeychat', role: 'project', name: 'Leaf Note by Anjou', request: 'req1' } })] });
    expect(right.pendingProjects[0].topic).toBe('l');
    // an older daemon writes no request id: a new room with the same name still counts
    const byName = reducer(asked, { type: 'rooms', rooms: [...Object.values(asked.rooms), room({ topic: 'n', name: 'Leaf Note', app: { app: 'rkeychat', role: 'project', name: 'Leaf Note' } })] });
    expect(byName.pendingProjects[0].topic).toBe('n');
  });

  it("the daemon's list survives a restart; a dismissed wait stays hidden; an arrival is kept until opened", () => {
    const list = [{ id: 'req1', name: 'Leaf Note', asked: 'macbook', home: 'd1', via: 'Family', ts: 5, online: false }, { id: 'req2', name: 'Show notes', asked: 'zorin', home: 'd2', via: 'Family', ts: 6, online: true }];
    const s = reducer(booted, { type: 'pendingProjects', list, hidden: ['req2'] });
    expect(s.pendingProjects.map((p) => [p.id, p.asked, p.online, p.via])).toEqual([['req1', 'macbook', false, 'Family']]);
    const arrived = reducer(reducer(asked, { type: 'rooms', rooms: [...Object.values(asked.rooms), room({ topic: 'l', name: 'Leaf Note', app: { app: 'rkeychat', role: 'project', name: 'Leaf Note', request: 'req1' } })] }), { type: 'pendingProjects', list: [], hidden: [] });
    expect(arrived.pendingProjects.map((p) => [p.id, p.topic])).toEqual([['req1', 'l']]);
    expect(reducer(arrived, { type: 'pendingDone', id: 'req1' }).pendingProjects).toEqual([]);
  });

  it('a room closed by its owner takes the selection with it', () => {
    const inRoom = reducer(booted, { type: 'select', topic: T, conv: 'main' });
    const gone = reducer(inRoom, { type: 'rooms', rooms: [room({ topic: 'other', name: 'Other' })] });
    expect(gone.rooms[T]).toBeUndefined();
    expect(gone.selected).toEqual({ topic: null, conv: null });
    expect(gone.roomOrder).toEqual(['other']);
    // still there: nothing changes
    expect(reducer(inRoom, { type: 'rooms', rooms: Object.values(inRoom.rooms) }).selected).toEqual({ topic: T, conv: 'main' });
  });
});
