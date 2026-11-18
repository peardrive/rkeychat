import { describe, expect, it } from 'vitest';
import type { Rec } from '../types';
import { mergeThread, toChatMessage } from './mapping';

const rec: Rec = { id: 'm1', kind: 'msg', ts: 1700000000000, name: 'rkeychat', human: false, text: 'Done.', conv: 'main', re: [] };

describe('toChatMessage', () => {
  it('maps a daemon message to a ChatMessage, agents from !human', () => {
    const m = toChatMessage(rec);
    expect(m).toMatchObject({ id: 'm1', ts: rec.ts, text: 'Done.', author: { id: 'rkeychat', name: 'rkeychat', agent: true } });
    expect(m.re).toBeUndefined();
    expect(m.system).toBeUndefined();
    expect(toChatMessage({ ...rec, name: 'guy', human: true }).author.agent).toBe(false);
  });

  it('carries replies, pending and redaction', () => {
    expect(toChatMessage({ ...rec, re: ['m0'] }).re).toEqual(['m0']);
    expect(toChatMessage({ ...rec, pending: true }).pending).toBe(true);
    expect(toChatMessage({ ...rec, redacted: { by: 'guy', ts: 1 }, text: '' }).redacted).toBe(true);
  });

  it('never hands Markdown an undefined text', () => {
    expect(toChatMessage({ ...rec, text: undefined as unknown as string }).text).toBe('');
    expect(toChatMessage({ ...rec, kind: 'activity', text: undefined as unknown as string }).text).toBe('rkeychat: ');
  });

  it('turns activity into a system line "name: text"', () => {
    const m = toChatMessage({ ...rec, kind: 'activity', text: 'reading src/index.ts' });
    expect(m.system).toBe(true);
    expect(m.text).toBe('rkeychat: reading src/index.ts');
    expect(m.reactions).toBeUndefined();
  });

  it('folds the room reactions map into counts with mine', () => {
    const m = toChatMessage(rec, { me: 'guy', reactions: { m1: { '👍': ['guy', 'jeffrey'], '🎉': [] } } });
    expect(m.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    expect(toChatMessage(rec, { me: 'guy', reactions: {} }).reactions).toBeUndefined();
  });

  it('maps attachments to name/size/kind/url', () => {
    const m = toChatMessage({ ...rec, att: [{ hash: 'abc', kind: 'file', name: 'shot.png', mime: 'image/png', size: 1234 }, { hash: 'def', mime: 'audio/webm', size: 9, ms: 4000 }] });
    expect(m.attachments).toEqual([
      { name: 'shot.png', size: 1234, kind: 'image', url: '/api/blob/abc' },
      { name: 'Voice memo', size: 9, kind: 'audio', url: '/api/blob/def' },
    ]);
  });
});

describe('mergeThread', () => {
  it('interleaves activity by time and keeps pending sends last', () => {
    const msgs: Rec[] = [{ ...rec, id: 'a', ts: 10 }, { ...rec, id: 'p', ts: 5, pending: true }];
    const acts: Rec[] = [{ ...rec, id: 'x', kind: 'activity', ts: 7 }, { ...rec, id: 'a', kind: 'activity', ts: 10 }];
    expect(mergeThread(msgs, acts).map((r) => r.id)).toEqual(['x', 'a', 'p']);
    expect(mergeThread(msgs, [])).toBe(msgs);
  });
});

describe('collapseActivity', () => {
  it('keeps the last step of each run and counts the rest', async () => {
    const { collapseActivity } = await import('./mapping');
    const a = (id: string, ts: number): Rec => ({ ...rec, id, kind: 'activity', ts, text: `step ${id}` });
    const m = (id: string, ts: number): Rec => ({ ...rec, id, ts });
    const out = collapseActivity([a('1', 1), a('2', 2), a('3', 3), m('x', 4), a('4', 5), m('y', 6)]);
    expect(out.map((r) => r.id)).toEqual(['3', 'x', '4', 'y']);
    expect(out[0].text).toBe('step 3  (+2 earlier steps)');
    expect(out[2].text).toBe('step 4');
  });
});
