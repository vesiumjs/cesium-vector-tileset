import { describe, expect, it } from 'vitest';
import { GpuMemoryBudget } from '../gpu-memory-budget';

/**
 * Evictability is reported by the tracks (pinned = live/attached), not derived
 * from a tileset-built protected set. These pin the contract the tileset now relies
 * on: only unpinned (retired) entries can be evicted, oldest-first.
 */
describe('gpuMemoryBudget', () => {
  it('evicts only unpinned entries, oldest-first', () => {
    const budget = new GpuMemoryBudget(100);
    expect(budget.update((visit) => {
      visit('a', 40);
      visit('b', 40);
    })).toEqual([]);
    expect(budget.update((visit) => {
      visit('a', 40);
      visit('b', 40);
      visit('c', 40, true);
    })).toEqual(['a']);
    expect(budget.has('a')).toBe(false);
    expect(budget.has('b')).toBe(true);
    expect(budget.has('c')).toBe(true);
    expect(budget.stats().evictions).toBe(1);
    expect(budget.stats().totalBytes).toBe(80);
  });

  it('never evicts a pinned entry even when it is the oldest', () => {
    const budget = new GpuMemoryBudget(10);
    expect(budget.update(visit => visit('live', 100, true))).toEqual([]);
    expect(budget.has('live')).toBe(true);
    expect(budget.stats().totalBytes).toBe(100);
  });
});
