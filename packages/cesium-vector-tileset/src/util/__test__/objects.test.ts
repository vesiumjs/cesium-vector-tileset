import { describe, expect, it } from 'vitest';
import { clone, deepEqual } from '../objects';

describe('style objects containing live canvas resources', () => {
  it('copies configuration without replacing the canvas resource with a plain object', () => {
    const canvas = document.createElement('canvas');
    const configuration = { canvas, coordinates: [[1, 2], [3, 4]] };
    const copied = clone(configuration);

    expect(copied.canvas).toBe(canvas);
    copied.coordinates[0][0] = 5;
    expect(configuration.coordinates[0][0]).toBe(1);
  });

  it('distinguishes different live resources in otherwise equal configuration', () => {
    const first = document.createElement('canvas');
    const second = document.createElement('canvas');
    expect(deepEqual({ canvas: first }, { canvas: second })).toBe(false);
    expect(deepEqual({ canvas: first }, { canvas: first })).toBe(true);
    expect(deepEqual({ coordinates: [[1, 2]] }, { coordinates: [[1, 2]] })).toBe(true);
  });
});
