import { describe, expect, it } from 'vitest';
import { symbolGroundPosition, symbolMapPerspectiveRatio, symbolMercatorDelta, symbolMercatorPosition, symbolMetersPerPixel, symbolPerspectiveRatio, symbolViewportGroundAxes } from '../symbol-perspective';

describe('viewport point perspective units', () => {
  it('keeps the collision ratio beyond the four-times drawing cap', () => {
    expect(symbolPerspectiveRatio(900, 100, false)).toBe(5);
    expect(symbolPerspectiveRatio(900000, 100000, false)).toBe(5);
    expect(symbolPerspectiveRatio(100, 100, false)).toBe(1);
    expect(symbolPerspectiveRatio(100, 1000, false)).toBe(0.55);
  });
  it('uses ratio one for orthographic projection without a fabricated focus distance', () => {
    expect(symbolPerspectiveRatio(undefined, 1, true)).toBe(1);
  });
  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid perspective distance %s', (distance) => {
    expect(symbolPerspectiveRatio(distance, 100, false)).toBeUndefined();
  });
});

it('keeps drawing, glyph walking and collision ratios distinct for map pitch', () => {
  expect(symbolMapPerspectiveRatio(900, 100, false)).toBeCloseTo(0.5 + 0.5 / 9, 12);
  expect(symbolPerspectiveRatio(900, 100, false)).toBe(5);
  expect(symbolMapPerspectiveRatio(100, 900, false)).toBe(4);
  expect(symbolPerspectiveRatio(100, 900, false)).toBeCloseTo(0.5 + 0.5 / 9, 12);
  expect(symbolMapPerspectiveRatio(undefined, 1, true)).toBe(1);
  expect(symbolMapPerspectiveRatio(undefined, 1, false)).toBeUndefined();
});

it('retains actual ground coordinates and local longitude-seam displacements', () => {
  const circumference = 2 * Math.PI * 6378137;
  expect(symbolMetersPerPixel(0)).toBe(circumference / 512);
  expect(symbolMetersPerPixel(14)).toBe(circumference / (512 * 2 ** 14));
  for (const latitude of [0, 31.23, 70, -70]) {
    const y = -6378137 * Math.asinh(Math.tan(latitude * Math.PI / 180));
    const x = 121.5 * Math.PI / 180 * 6378137;
    const ground = symbolGroundPosition(x, y);
    const plane = symbolMercatorPosition(ground.x, ground.y, ground.z)!;
    expect(plane.x).toBeCloseTo(x, 6);
    expect(plane.y).toBeCloseTo(y, 6);
  }
  expect(symbolMercatorPosition(0, 0, 0)).toBeUndefined();
  expect(symbolMercatorDelta(-circumference / 2 + 10, circumference / 2 - 10)).toBeCloseTo(20, 6);
});

it.each([[75, 35, 0], [75, 35, 20], [85, -40, -15]])('matches independently normalized MapLibre ground skew at pitch %s bearing %s roll %s', (pitch, bearing, roll) => {
  const p = pitch * Math.PI / 180;
  const b = bearing * Math.PI / 180;
  const r = roll * Math.PI / 180;
  // Ground-to-screen linear transform, before perspective division:
  // R(-roll) * diag(1, cos(pitch)) * R(-bearing).
  const east = { x: Math.cos(r) * Math.cos(b) - Math.sin(r) * Math.cos(p) * Math.sin(b), y: -Math.sin(r) * Math.cos(b) - Math.cos(r) * Math.cos(p) * Math.sin(b) };
  const south = { x: Math.cos(r) * Math.sin(b) + Math.sin(r) * Math.cos(p) * Math.cos(b), y: -Math.sin(r) * Math.sin(b) + Math.cos(r) * Math.cos(p) * Math.cos(b) };
  const axes = symbolViewportGroundAxes(east, south);
  const expectedEast = [Math.cos(b) * Math.cos(p) * Math.cos(r) - Math.sin(b) * Math.sin(r), Math.sin(b) * Math.cos(p) * Math.cos(r) + Math.cos(b) * Math.sin(r)];
  const expectedSouth = [-Math.cos(b) * Math.cos(p) * Math.sin(r) - Math.sin(b) * Math.cos(r), -Math.sin(b) * Math.cos(p) * Math.sin(r) + Math.cos(b) * Math.cos(r)];
  for (const [axis, expected] of [[axes.east, expectedEast], [axes.south, expectedSouth]] as const) {
    const length = Math.hypot(...expected);
    expect(axis.x).toBeCloseTo(expected[0] / length, 12);
    expect(axis.y).toBeCloseTo(expected[1] / length, 12);
  }
  if (roll !== 0)
    expect(Math.abs(axes.east.x * axes.south.x + axes.east.y * axes.south.y)).toBeGreaterThan(0.5);
});
