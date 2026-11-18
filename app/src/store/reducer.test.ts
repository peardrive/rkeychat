import { describe, expect, it } from 'vitest';
import type { Conversation, Rec, RoomSnapshot, RoomSummary } from '../types';
import { convKey, initialState, reducer, type Action, type State } from './reducer';

const T = 'topic-a';
const conv = (c: Partial<Conversation> & { conv: string }): Conversation => ({ title: '', created: 1, archived: false, runtime: null, last: null, count: 0, busy: [], ...c });
const room = (r: Partial<RoomSummary> & { topic: string }): RoomSummary => ({ name: r.topic, owner: true, admitted: true, folder: null, app: null, convs: [], ...r });
const msg = (id: string, c: string, name = 'jeffrey', ts = 1000): Rec => ({ id, kind: 'msg', ts, name, human: true, text: `hello ${id}`, conv: c });

function run(actions: Action[], from: State = initialState) {
  return actions.reduce(reducer, from);
}

const booted = run([
  { type: 'init', device: { name: 'studio', human: 'guy' }, rooms: [room({ topic: T, folder: '/x/peardrive', convs: [{ conv: 'main', title: 'General', archived: false, last: null, count: 0 }] })] },
  { type: 'convs', topic: T, convs: [conv({ conv: 'main', title: 'General' }), conv({ conv: 'c2', title: 'Second' })] },
  { type: 'log', topic: T, conv: 'main', log: [msg('m1', 'main')], hasOlder: false, mode: 'replace' },
  { type: 'log', topic: T, conv: 'c2', log: [], hasOlder: false, mode: 'replace' },
  { type: 'select', topic: T, conv: 'main' },
]);

describe('records', () => {
  it('appends a record for the open conversation without counting it unread', () => {
    const s = reducer(booted, { type: 'record', topic: T, rec: msg('m2', 'main') });
    expect(s.threads[convKey(T, 'main')].items.map((x) => x.id)).toEqual(['m1', 'm2']);
    expect(s.unread[convKey(T, 'main')]).toBeUndefined();
  });

  it('counts a record for another conversation as unread, and still stores it', () => {
    const s = reducer(booted, { type: 'record', topic: T, rec: msg('m3', 'c2') });
    expect(s.unread[convKey(T, 'c2')]).toBe(1);
    expect(s.threads[convKey(T, 'c2')].items.map((x) => x.id)).toEqual(['m3']);
    const s2 = reducer(s, { type: 'record', topic: T, rec: msg('m4', 'c2') });
    expect(s2.unread[convKey(T, 'c2')]).toBe(2);
  });

  it('does not count my own messages as unread', () => {
    const s = reducer(booted, { type: 'record', topic: T, rec: msg('m5', 'c2', 'guy') });
    expect(s.unread[convKey(T, 'c2')]).toBeUndefined();
  });

  it('a record without conv belongs to main', () => {
    const rec = { ...msg('m6', 'main') } as Rec;
    delete rec.conv;
    const s = reducer(booted, { type: 'record', topic: T, rec });
    expect(s.threads[convKey(T, 'main')].items.at(-1)?.conv).toBe('main');
  });

  it('replaces a record that arrives twice', () => {
    const s = run([{ type: 'record', topic: T, rec: msg('m2', 'main') }, { type: 'record', topic: T, rec: { ...msg('m2', 'main'), text: 'edited' } }], booted);
    const items = s.threads[convKey(T, 'main')].items;
    expect(items.filter((x) => x.id === 'm2')).toHaveLength(1);
    expect(items.at(-1)?.text).toBe('edited');
  });

  it('routes activity records to the activity list and marks the seat thinking', () => {
    const s = reducer(booted, { type: 'record', topic: T, rec: { ...msg('a1', 'main', 'rkeychat'), kind: 'activity', human: false, text: 'reading src' } });
    expect(s.activity[convKey(T, 'main')]).toHaveLength(1);
    expect(s.threads[convKey(T, 'main')].items).toHaveLength(1);
    expect(s.agents[convKey(T, 'main')].rkeychat).toBe('thinking');
  });
});

describe('selection and unread', () => {
  it('selecting a conversation clears its unread', () => {
    const s = run([{ type: 'record', topic: T, rec: msg('m3', 'c2') }, { type: 'select', topic: T, conv: 'c2' }], booted);
    expect(s.unread[convKey(T, 'c2')]).toBeUndefined();
    expect(s.selected).toEqual({ topic: T, conv: 'c2' });
  });
});

describe('conversation lists', () => {
  it('a convs push replaces the list and keeps the selection', () => {
    const s = reducer(booted, { type: 'convs', topic: T, convs: [conv({ conv: 'main', title: 'Renamed' }), conv({ conv: 'c3', title: 'Third' })] });
    expect(s.convs[T].map((c) => c.conv)).toEqual(['main', 'c3']);
    expect(s.selected).toEqual({ topic: T, conv: 'main' });
  });

  it('an archived conversation disappears from the visible list but keeps its thread', async () => {
    const { visibleConvs, archivedConvs } = await import('./selectors');
    const s = reducer(booted, { type: 'conv', topic: T, conv: conv({ conv: 'c2', title: 'Second', archived: true }) });
    expect(visibleConvs(s, T).map((c) => c.conv)).toEqual(['main']);
    expect(archivedConvs(s, T).map((c) => c.conv)).toEqual(['c2']);
    expect(s.threads[convKey(T, 'c2')]).toBeDefined();
  });

  it('a room snapshot refreshes convs and details, and its log only when the conversation is known', () => {
    const snap: RoomSnapshot = {
      name: 'PearDrive', topic: T, owner: true, admitted: true, participants: [], members: [], reactions: {}, charter: { text: 'be kind', order: [], agents: {} },
      log: [msg('m9', 'c2')], hasOlder: true, convs: [conv({ conv: 'main' }), conv({ conv: 'c2', busy: ['rkeychat'] })], folder: '/x/peardrive', app: null, seats: [],
    };
    const blind = reducer(booted, { type: 'room', snapshot: snap });
    expect(blind.threads[convKey(T, 'c2')].items).toEqual([]);
    expect(blind.details[T].charter.text).toBe('be kind');
    const scoped = reducer(booted, { type: 'room', snapshot: snap, conv: 'c2' });
    expect(scoped.threads[convKey(T, 'c2')].items.map((x) => x.id)).toEqual(['m9']);
    expect(scoped.threads[convKey(T, 'c2')].hasOlder).toBe(true);
  });
});

describe('optimistic send', () => {
  const pending: Rec = { id: 'local-1', kind: 'msg', ts: 2000, name: 'guy', human: true, text: 'hi', conv: 'main' };

  it('shows the pending message, then swaps it for the daemon record by id', () => {
    const s1 = reducer(booted, { type: 'sendPending', topic: T, conv: 'main', rec: pending });
    expect(s1.threads[convKey(T, 'main')].items.at(-1)).toMatchObject({ id: 'local-1', pending: true });
    const s2 = reducer(s1, { type: 'sendDone', topic: T, conv: 'main', localId: 'local-1', rec: { ...pending, id: 'real-1' } });
    const ids = s2.threads[convKey(T, 'main')].items.map((x) => x.id);
    expect(ids).toEqual(['m1', 'real-1']);
    expect(s2.threads[convKey(T, 'main')].items.at(-1)?.pending).toBe(false);
  });

  it('does not duplicate when the push arrives before the POST returns', () => {
    const s = run(
      [
        { type: 'sendPending', topic: T, conv: 'main', rec: pending },
        { type: 'record', topic: T, rec: { ...pending, id: 'real-1' } },
        { type: 'sendDone', topic: T, conv: 'main', localId: 'local-1', rec: { ...pending, id: 'real-1' } },
      ],
      booted,
    );
    expect(s.threads[convKey(T, 'main')].items.map((x) => x.id)).toEqual(['m1', 'real-1']);
    expect(s.unread[convKey(T, 'main')]).toBeUndefined();
  });

  it('removes the bubble when the send fails', () => {
    const s = run([{ type: 'sendPending', topic: T, conv: 'main', rec: pending }, { type: 'sendFailed', topic: T, conv: 'main', localId: 'local-1' }], booted);
    expect(s.threads[convKey(T, 'main')].items.map((x) => x.id)).toEqual(['m1']);
  });

  it('a page reload keeps unconfirmed sends at the tail', () => {
    const s = run([{ type: 'sendPending', topic: T, conv: 'main', rec: pending }, { type: 'log', topic: T, conv: 'main', log: [msg('m0', 'main', 'x', 500), msg('m1', 'main')], hasOlder: false, mode: 'replace' }], booted);
    expect(s.threads[convKey(T, 'main')].items.map((x) => x.id)).toEqual(['m0', 'm1', 'local-1']);
  });
});

describe('paging', () => {
  it('prepends an older page without duplicates and records hasOlder', () => {
    const s = run(
      [
        { type: 'loadingOlder', topic: T, conv: 'main', value: true },
        { type: 'log', topic: T, conv: 'main', log: [msg('m-2', 'main', 'x', 100), msg('m-1', 'main', 'x', 200), msg('m1', 'main')], hasOlder: false, mode: 'older' },
      ],
      booted,
    );
    const t = s.threads[convKey(T, 'main')];
    expect(t.items.map((x) => x.id)).toEqual(['m-2', 'm-1', 'm1']);
    expect(t.hasOlder).toBe(false);
    expect(t.loadingOlder).toBe(false);
  });
});

describe('agent state', () => {
  it('tracks seats per conversation', () => {
    const s = run([{ type: 'agentState', topic: T, name: 'rkeychat', conv: 'c2', state: 'thinking' }, { type: 'agentState', topic: T, name: 'rkeychat', conv: 'c2', state: 'idle' }], booted);
    expect(s.agents[convKey(T, 'c2')].rkeychat).toBe('idle');
  });
});
