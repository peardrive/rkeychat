import { describe, expect, it } from 'vitest';
import type { Rec, RoomSummary } from '../types';
import { initialState, reducer, type State } from './reducer';
import { controlLine, toChatMessage } from './mapping';

const room = (r: Partial<RoomSummary> & { topic: string }): RoomSummary => ({ name: r.topic, owner: true, admitted: true, folder: null, app: null, convs: [], ...r });
const ask: Rec = { id: 'ask1', kind: 'ask', ts: 1000, name: 'pear', human: false, text: '', conv: 'main', tool: 'Bash', what: 'brew install jq', input: 'brew install jq', expires: 2000 };
const answer: Rec = { id: 'ans1', kind: 'control', action: 'answer', ts: 1500, name: 'guy', device: 'macbook', human: true, text: '', conv: 'main', ask: 'ask1', choice: 'allow_once' };

function booted(): State {
  let s = reducer(initialState, { type: 'init', device: { name: 'macbook', human: 'guy' }, rooms: [room({ topic: 't1', name: 'PearDrive' })] });
  s = reducer(s, { type: 'log', topic: 't1', conv: 'main', log: [], hasOlder: false, mode: 'replace' } as never);
  return { ...s, ready: true };
}

describe('an agent asking for a permission', () => {
  it('lands in the thread and in Needs you; the answer updates the thread and clears Needs you', () => {
    let s = reducer(booted(), { type: 'record', topic: 't1', rec: ask });
    expect(s.threads['t1/main'].items.map((x) => x.id)).toEqual(['ask1']);
    expect(s.feed[0]).toMatchObject({ id: 'perm:ask1', kind: 'approval', title: 'asks for Bash', text: 'brew install jq', who: 'pear', whoAgent: true, unread: true, where: { project: 'PearDrive', conversation: 'General' }, permission: { topic: 't1', conv: 'main', id: 'ask1', tool: 'Bash', what: 'brew install jq', expires: 2000 } });
    s = reducer(s, { type: 'record', topic: 't1', rec: answer });
    expect(s.threads['t1/main'].items.map((x) => x.id)).toEqual(['ask1', 'ans1']);
    expect(s.feed.find((f) => f.id === 'perm:ask1')).toBeUndefined();
    // the same push again changes nothing
    const again = reducer(s, { type: 'record', topic: 't1', rec: answer });
    expect(again.threads['t1/main'].items.length).toBe(2);
  });

  it('whether this device may answer comes from the snapshot\'s ownerDevice, with owner as the older fallback', () => {
    const snap = { name: 'PearDrive', topic: 't1', owner: false, ownerDevice: true, admitted: true, participants: [], members: [], reactions: {}, charter: { text: '', order: [], agents: {} }, convs: [], conv: 'main', seats: [], folder: null, app: null, log: [], hasOlder: false } as never;
    const s = reducer(booted(), { type: 'room', snapshot: snap });
    expect(s.details.t1.ownerDevice).toBe(true);
    expect(s.details.t1.owner).toBe(false);
  });

  it('the daemon\'s open asks at boot become Needs-you items, one per ask', () => {
    let s = reducer(booted(), { type: 'asks', asks: [{ ...ask, topic: 't1', room: 'PearDrive' } as never] });
    expect(s.feed.map((f) => f.id)).toEqual(['perm:ask1']);
    s = reducer(s, { type: 'asks', asks: [{ ...ask, topic: 't1', room: 'PearDrive' } as never] });
    expect(s.feed.length).toBe(1);
  });

  it('reads as a line in the chat: the ask names the tool, the answer says who allowed it', () => {
    expect(toChatMessage(ask)).toMatchObject({ id: 'ask1', text: 'asks for Bash: brew install jq', author: { name: 'pear', agent: true } });
    expect(toChatMessage(answer)).toMatchObject({ system: true, text: 'guy: allowed once' });
    expect(controlLine({ ...answer, choice: 'reject_always' })).toBe('guy: refused always');
    expect(controlLine({ ...answer, action: 'rename', choice: undefined })).toBe('guy renamed the project');
  });
});
