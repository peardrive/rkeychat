import { describe, expect, it, vi } from 'vitest';
import { catchUp } from './gap';

describe('catchUp', () => {
  it('marks every thread stale and fetches the open one again after a reconnect', () => {
    const dispatch = vi.fn();
    const select = vi.fn();
    expect(catchUp({ topic: 't1', conv: 'main' }, dispatch, select)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: 'stale' });
    expect(select).toHaveBeenCalledWith('t1', 'main');
  });
  it('a catch-up in another room only marks that room', () => {
    const dispatch = vi.fn();
    const select = vi.fn();
    expect(catchUp({ topic: 't1', conv: 'main' }, dispatch, select, 't2')).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({ type: 'stale', topic: 't2' });
    expect(select).not.toHaveBeenCalled();
  });
  it('nothing open: nothing to fetch', () => {
    const select = vi.fn();
    expect(catchUp({ topic: null, conv: null }, vi.fn(), select)).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });
});
