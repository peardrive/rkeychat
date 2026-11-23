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

describe('the quiet thread (2026-11-23 memo)', () => {
  const NOW = 1_000_000;
  const a = (id: string, ts: number): Rec => ({ ...rec, id, kind: 'activity', ts, text: `step ${id}` });
  const m = (id: string, ts: number): Rec => ({ ...rec, id, ts, name: 'guy', human: true });
  const ask = (id: string, ts: number, what = `cmd ${id}`): Rec => ({ ...rec, id, kind: 'ask', ts, text: '', tool: 'Bash', what, input: what, expires: NOW + 60_000 });
  const ans = (id: string, ask: string, ts: number, choice = 'allow_once'): Rec => ({ ...rec, id, kind: 'control', action: 'answer', ts, name: 'guy', human: true, text: '', ask, choice });
  const seat = (id: string, ts: number, applied: boolean): Rec => ({ ...rec, id, kind: 'control', action: 'seat', ts, name: 'guy', human: true, text: '', agent: 'rkeychat', seat: applied ? { permissionMode: 'acceptEdits', applied: true } : { permissionMode: 'acceptEdits' } } as Rec);

  it('a seat\'s settings and the answers to asks are not lines of the thread', async () => {
    const { inThread } = await import('./mapping');
    expect(inThread(seat('s1', 1, false))).toBe(false);
    expect(inThread(seat('s2', 2, true))).toBe(false);
    expect(inThread(ans('n1', 'q1', 3))).toBe(false);
    expect(inThread(ask('q1', 4))).toBe(true);
    expect(inThread(m('x', 5))).toBe(true);
    expect(inThread({ ...rec, kind: 'control', action: 'auto', auto: { minutes: 60, turns: null } } as Rec)).toBe(true); // the room's cap is a person's act, said once
  });

  it('pairs each ask with its first answer', async () => {
    const { pairAsks } = await import('./mapping');
    const asks = pairAsks([ask('q1', 1), ans('n1', 'q1', 2, 'allow_always'), ans('n2', 'q1', 3, 'reject_once'), ask('q2', 4)]);
    expect(asks.get('q1')?.answer).toMatchObject({ choice: 'allow_always', by: 'guy' });
    expect(asks.get('q2')?.answer).toBeNull();
  });

  it('folds the asks between two messages into ONE block; the open ask stands; the answered one at the tail joins the block at once (8:58 memo)', async () => {
    const { collapseActivity, inThread, pairAsks } = await import('./mapping');
    const items: Rec[] = [m('g1', 1), ask('q1', 2), ans('n1', 'q1', 3), a('s1', 4), a('s2', 5), ask('q2', 6), ans('n2', 'q2', 7), a('s3', 8), m('b1', 9), ask('q3', 10), ans('n3', 'q3', 11), a('s4', 12), ask('q4', 13)];
    const asks = pairAsks(items);
    const out = collapseActivity(items.filter(inThread), asks, NOW);
    expect(out.map((r) => r.id)).toEqual(['g1', 'q1~fold', 'b1', 'q3~fold', 's4', 'q4']);
    // between guy's message and the bot's reply: one block, two asks allowed, three steps folded with it
    expect(out[1]).toMatchObject({ kind: 'fold', name: 'rkeychat', text: 'asked for 2 permissions · 2 allowed · 3 steps' });
    expect(out[1].fold?.asks.map((x) => [x.what, x.status, x.by])).toEqual([['cmd q1', 'allowed', 'guy'], ['cmd q2', 'allowed', 'guy']]);
    // the tail: the ask just answered is a line of its block (not a card), the live step line is under it, q4 is open
    expect(out[3]).toMatchObject({ kind: 'fold', text: 'asked for Bash: cmd q3 · allowed' });
    expect(out[4]).toMatchObject({ kind: 'activity', text: 'step s4' });
    expect(out[5].kind).toBe('ask');
  });

  it('ten allows are ten lines of one block, never ten blocks', async () => {
    const { collapseActivity, inThread, pairAsks } = await import('./mapping');
    const items: Rec[] = [m('g1', 0)];
    for (let i = 1; i <= 10; i++) items.push(ask(`q${i}`, i * 3), ans(`n${i}`, `q${i}`, i * 3 + 1), a(`s${i}`, i * 3 + 2));
    items.push(m('b1', 100));
    const out = collapseActivity(items.filter(inThread), pairAsks(items), NOW);
    expect(out.map((r) => r.id)).toEqual(['g1', 'q1~fold', 'b1']);
    expect(out[1].text).toBe('asked for 10 permissions · 10 allowed · 10 steps');
    expect(out[1].fold?.asks).toHaveLength(10);
  });

  it('a refused ask and a lapsed one are lines of the block too, said so; steps alone keep their one line', async () => {
    const { collapseActivity, pairAsks } = await import('./mapping');
    const lapsed: Rec = { ...ask('q0', 1), expires: NOW - 1 };
    const items: Rec[] = [m('g1', 0), lapsed, a('s1', 2), ask('q1', 3), ans('n1', 'q1', 4, 'reject_once'), m('b1', 5), a('s2', 6), a('s3', 7), m('b2', 8)];
    const asks = pairAsks(items);
    const out = collapseActivity(items.filter((r) => r.kind !== 'control'), asks, NOW);
    expect(out.map((r) => r.id)).toEqual(['g1', 'q0~fold', 'b1', 's3', 'b2']);
    expect(out[1].text).toBe('asked for 2 permissions · 1 refused · 1 lapsed · 1 step');
    expect(out[1].fold?.asks.map((x) => x.status)).toEqual(['lapsed', 'refused']);
    expect(out[3].text).toBe('step s3  (+1 earlier step)');
  });
});
