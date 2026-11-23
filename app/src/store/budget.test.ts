import { describe, expect, it } from 'vitest';
import type { Budget } from '../types';
import { agentPostLimit, roundsLine } from './budget';

const b = (x: Partial<Budget> = {}): Budget => ({ paused: false, unlimited: false, until: null, rounds: 3, limit: 3, remaining: 3, agents: { paused: [], limits: {}, posts: {} }, ...x });

describe('roundsLine', () => {
  it('says the standing rounds, what is left of this exchange, and the open states', () => {
    expect(roundsLine(b())).toBe('3 rounds per message');
    expect(roundsLine(b({ rounds: 5, limit: 5, remaining: 5 }))).toBe('5 rounds per message');
    expect(roundsLine(b({ rounds: 5, limit: 5, remaining: 2 }))).toBe('2 of 5 rounds left, then 5 per message');
    expect(roundsLine(b({ rounds: 3, limit: 13, remaining: 10 }))).toBe('10 of 13 rounds left, then 3 per message');
    expect(roundsLine(b({ rounds: 1, limit: 1, remaining: 1 }))).toBe('1 round per message');
    expect(roundsLine(b({ unlimited: true, remaining: null }))).toBe('no round limit');
    expect(roundsLine(b({ until: 2_000_000, remaining: null }), 1_000_000)).toMatch(/^open until /);
    expect(roundsLine(b({ until: 500, remaining: 3 }), 1_000_000)).toBe('3 rounds per message'); // an until that passed
    expect(roundsLine(b({ paused: true }))).toBe('paused');
    expect(roundsLine(null)).toBe('');
  });

  it('an older daemon without rounds in the budget still reads', () => {
    const old = { ...b(), rounds: undefined } as unknown as Budget;
    expect(roundsLine(old)).toBe('3 rounds per message');
  });
});

describe('agentPostLimit', () => {
  it('reads the standing per-agent limit, 0 when none', () => {
    expect(agentPostLimit(b({ agents: { paused: [], limits: { pear: 2 }, posts: {} } }), 'pear')).toBe(2);
    expect(agentPostLimit(b(), 'pear')).toBe(0);
    expect(agentPostLimit(null, 'pear')).toBe(0);
  });
});
