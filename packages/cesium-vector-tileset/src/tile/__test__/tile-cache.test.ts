import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tile } from '../tile';
import { TileCache } from '../tile-cache';
import { OverscaledTileID } from '../tile-id';

afterEach(() => vi.useRealTimers());

describe('tileCache', () => {
  it('evicts the oldest surviving entry after filtering a newer world copy', () => {
    const removed = vi.fn();
    const cache = new TileCache(3, removed);
    const first = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
    const middle = new Tile(new OverscaledTileID(1, 0, 1, 1, 0), 512);
    const newest = new Tile(new OverscaledTileID(1, 1, 1, 0, 0), 512);
    cache.add(first.tileID, first);
    cache.add(middle.tileID, middle);
    cache.add(newest.tileID, newest);

    cache.filter(tile => tile !== newest);
    cache.setMaxSize(1);

    expect(removed.mock.calls.map(([tile]) => tile)).toEqual([newest, first]);
    expect(cache.has(first.tileID)).toBe(false);
    expect(cache.getAndRemove(middle.tileID)).toBe(middle);
  });

  it('expires the correct world copy and cancels timers for reused and reset entries', () => {
    vi.useFakeTimers();
    const removed = vi.fn();
    const cache = new TileCache(3, removed);
    const first = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
    const middle = new Tile(new OverscaledTileID(1, 0, 1, 1, 0), 512);
    const newest = new Tile(new OverscaledTileID(1, 1, 1, 0, 0), 512);
    cache.add(first.tileID, first, 100);
    cache.add(middle.tileID, middle, 100);
    cache.add(newest.tileID, newest, 10);

    vi.advanceTimersByTime(10);
    expect(removed.mock.calls.map(([tile]) => tile)).toEqual([newest]);
    expect(cache.getAndRemove(newest.tileID)).toBe(first);
    cache.reset();
    vi.advanceTimersByTime(100);

    expect(removed.mock.calls.map(([tile]) => tile)).toEqual([newest, middle]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
