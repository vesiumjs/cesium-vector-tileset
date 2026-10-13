import { describe, expect, it } from 'vitest';
import { TileBounds } from '../tile-bounds';
import { CanonicalTileID } from '../tile-id';

describe('tileJSON bounds', () => {
  it('covers both world edges when bounds cross the antimeridian', () => {
    const bounds = new TileBounds([170, -10, -170, 10]);
    expect(bounds.contains(new CanonicalTileID(4, 0, 7))).toBe(true);
    expect(bounds.contains(new CanonicalTileID(4, 15, 8))).toBe(true);
    expect(bounds.contains(new CanonicalTileID(4, 1, 7))).toBe(false);
    expect(bounds.contains(new CanonicalTileID(4, 14, 8))).toBe(false);
    expect(bounds.contains(new CanonicalTileID(4, 0, 5))).toBe(false);
  });

  it('excludes neighboring tiles when longitude bounds align with tile edges', () => {
    const bounds = new TileBounds([0, -10, 22.5, 10]);
    expect(bounds.contains(new CanonicalTileID(4, 8, 7))).toBe(true);
    expect(bounds.contains(new CanonicalTileID(4, 7, 7))).toBe(false);
    expect(bounds.contains(new CanonicalTileID(4, 9, 7))).toBe(false);
  });

  it('retains coverage at polar world edges', () => {
    const bounds = new TileBounds([-180, -90, 180, 90]);
    expect(bounds.contains(new CanonicalTileID(4, 0, 0))).toBe(true);
    expect(bounds.contains(new CanonicalTileID(4, 15, 15))).toBe(true);
  });
});
