import { describe, expect, it } from 'vitest';
import type { RoomSummary } from '../types';
import { initialState, reducer, type State } from './reducer';
import { convTitle, folderName, groupRooms, thinkingIn, unreadInRoom } from './selectors';

const room = (r: Partial<RoomSummary> & { topic: string }): RoomSummary => ({ name: r.topic, owner: true, admitted: true, folder: null, app: null, convs: [], ...r });

describe('groupRooms', () => {
  it('puts rooms with a folder (or a project app record) under projects, the rest under chats', () => {
    const { projects, chats } = groupRooms([
      room({ topic: 'a', folder: '/x/peardrive' }),
      room({ topic: 'b' }),
      room({ topic: 'c', app: { app: 'rkeychat', role: 'project', name: 'c' } }),
      room({ topic: 'd', app: { app: 'rkeychat', role: 'chat', name: 'd' } }),
    ]);
    expect(projects.map((r) => r.topic)).toEqual(['a', 'c']);
    expect(chats.map((r) => r.topic)).toEqual(['b', 'd']);
  });
});

describe('convTitle', () => {
  it('uses the title, then General for main, then the last message, then a default', () => {
    expect(convTitle({ conv: 'x', title: 'Redesign', last: null })).toBe('Redesign');
    expect(convTitle({ conv: 'main', title: '', last: null })).toBe('General');
    expect(convTitle({ conv: 'x', title: '  ', last: { ts: 1, name: 'guy', text: 'Fix the share row please' } })).toBe('Fix the share row please');
    expect(convTitle({ conv: 'x', title: '', last: null })).toBe('New conversation');
    expect(convTitle(null)).toBe('');
  });
});

describe('folderName', () => {
  it('takes the basename, tolerating trailing slashes and Windows paths', () => {
    expect(folderName('/Users/guy/Anjou/peardrive')).toBe('peardrive');
    expect(folderName('/Users/guy/Anjou/peardrive/')).toBe('peardrive');
    expect(folderName('C:\\Code\\pearcast')).toBe('pearcast');
    expect(folderName(null)).toBe('');
  });
});

describe('unread and thinking', () => {
  const base: State = reducer(initialState, { type: 'init', device: { name: 'd', human: 'guy' }, rooms: [room({ topic: 't', convs: [{ conv: 'main', title: 'General', archived: false, last: null, count: 0 }, { conv: 'c2', title: 'Two', archived: false, last: null, count: 0 }, { conv: 'c3', title: 'Old', archived: true, last: null, count: 0 }] })] });

  it('sums unread over the visible conversations of a room only', () => {
    let s = reducer(base, { type: 'select', topic: 't', conv: 'main' });
    s = reducer(s, { type: 'log', topic: 't', conv: 'c2', log: [], hasOlder: false, mode: 'replace' });
    s = reducer(s, { type: 'record', topic: 't', rec: { id: '1', kind: 'msg', ts: 1, name: 'j', human: true, text: 'x', conv: 'c2' } });
    s = reducer(s, { type: 'record', topic: 't', rec: { id: '2', kind: 'msg', ts: 2, name: 'j', human: true, text: 'y', conv: 'c3' } });
    expect(unreadInRoom(s, 't')).toBe(1);
  });

  it('reads the daemon busy list until a live agent-state overrides it', () => {
    let s = reducer(base, { type: 'convs', topic: 't', convs: [{ conv: 'main', title: 'General', created: 1, archived: false, runtime: null, last: null, count: 0, busy: ['rkeychat'] }] });
    expect(thinkingIn(s, 't', 'main')).toEqual(['rkeychat']);
    s = reducer(s, { type: 'agentState', topic: 't', name: 'rkeychat', conv: 'main', state: 'idle' });
    expect(thinkingIn(s, 't', 'main')).toEqual([]);
    s = reducer(s, { type: 'agentState', topic: 't', name: 'hermes', conv: 'main', state: 'thinking' });
    expect(thinkingIn(s, 't', 'main')).toEqual(['hermes']);
  });
});
