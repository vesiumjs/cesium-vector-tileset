import type { TilePoint } from '../surface-subdivision';
import earcut from 'earcut';
import { describe, expect, it } from 'vitest';
import { clipPlanarFill } from '../planar-fill';

function meshArea(mesh: ReturnType<typeof clipPlanarFill>) {
  let total = 0;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const [a, b, c] = mesh.indices.slice(index, index + 3).map(vertex => mesh.points[vertex]);
    total += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return total;
}

function meshContains(mesh: ReturnType<typeof clipPlanarFill>, point: TilePoint) {
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const triangle = mesh.indices.slice(index, index + 3).map(vertex => mesh.points[vertex]);
    const crosses = triangle.map((from, side) => {
      const to = triangle[(side + 1) % 3];
      return (to[0] - from[0]) * (point[1] - from[1]) - (to[1] - from[1]) * (point[0] - from[0]);
    });
    if (crosses.every(value => value >= 0) || crosses.every(value => value <= 0))
      return true;
  }
  return false;
}

function clip(points: TilePoint[], holes: number[] = []) {
  return clipPlanarFill(points, earcut(points.flat(), holes));
}

describe('clipped planar fill boundary', () => {
  it('renders the actual Shanghai fill whose thin clipped source triangle collapses under integer rounding', () => {
    const points: TilePoint[] = [[332, 4], [360, 26], [364, 56], [350, 88], [298, 122], [196, 82], [204, 56], [188, 46], [176, 8], [220, -14], [196, -32], [200, -46], [228, -38], [206, -50], [212, -60], [196, -84], [214, -76], [212, -92], [226, -94], [232, -52], [240, -100], [258, -100], [260, -62], [246, -52], [258, -56], [274, -38], [266, -8], [286, -2], [264, 32], [300, 26], [316, -12], [356, -38], [362, -20], [336, -10], [346, -4], [332, 4]];
    const triangles = [0, 2, 1, 0, 3, 2, 0, 4, 3, 4, 6, 5, 6, 8, 7, 6, 9, 8, 9, 11, 10, 9, 12, 11, 12, 14, 13, 12, 15, 14, 12, 16, 15, 12, 17, 16, 12, 18, 17, 12, 19, 18, 19, 21, 20, 19, 22, 21, 19, 23, 22, 23, 25, 24, 23, 26, 25, 26, 28, 27, 29, 31, 30, 31, 33, 32, 33, 0, 34, 33, 4, 0, 4, 9, 6, 4, 12, 9, 4, 19, 12, 19, 26, 23, 19, 28, 26, 29, 33, 31, 29, 4, 33, 4, 28, 19, 4, 29, 28];
    const mesh = clipPlanarFill(points, triangles);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(meshContains(mesh, [280, 80])).toBe(true);
    expect(meshContains(mesh, [280, 10])).toBe(false);
    expect(meshArea(mesh)).toBeCloseTo(15970.978328173374, 8);
    expect(mesh.points.every(([x, y]) => x >= 0 && x <= 8192 && y >= 0 && y <= 8192)).toBe(true);
  });

  it('retains source winding when two distinct tile intersections round to the same point', () => {
    // These are unchanged source vertices/triangles 4,28,19 and 4,29,28
    // from the actual Shanghai capture. Top crossings 251.724... and
    // 251.809... both round to 252; the clipped thin face changes sign.
    const mesh = clipPlanarFill([[298, 122], [264, 32], [232, -52], [300, 26]], [0, 1, 2, 0, 3, 1]);
    expect(meshContains(mesh, [280, 60])).toBe(true);
    expect(meshContains(mesh, [240, 30])).toBe(false);
    expect(meshArea(mesh)).toBeCloseTo(1731.7799671592784, 8);
    const boundary = mesh.points.filter(point => point[1] === 0).map(point => point[0]).sort((a, b) => a - b);
    expect(boundary).toHaveLength(2);
    expect(boundary[0]).toBeCloseTo(251.72413793103448, 12);
    expect(boundary[1]).toBeCloseTo(251.8095238095238, 12);
  });

  it('shares fractional crossings exactly across reversed source edges and duplicated chunk vertices', () => {
    const points: TilePoint[] = [[298, 122], [264, 32], [232, -52], [300, 26]];
    const triangles = [0, 1, 2, 0, 3, 1];
    const source = clipPlanarFill(points, triangles);
    const reversed = clipPlanarFill(points, [2, 1, 0, 1, 3, 0]);
    const chunkPoints = triangles.map(vertex => points[vertex]);
    const chunks = clipPlanarFill(chunkPoints, [0, 1, 2, 3, 4, 5]);
    for (const mesh of [source, reversed, chunks]) {
      expect(mesh.points).toHaveLength(5);
      expect(mesh.indices).toHaveLength(9);
      expect(meshArea(mesh)).toBeCloseTo(1731.7799671592784, 8);
      expect(mesh.points.filter(point => point[1] === 0).map(point => point[0]).sort((a, b) => a - b)).toEqual([251.72413793103448, 251.8095238095238]);
    }
  });

  it('does not create boundary edges for outside faces that only touch a tile corner or edge', () => {
    const mesh = clipPlanarFill([[-10, 0], [0, 0], [0, -10], [-20, 0], [0, 0], [0, -20], [-10, 200], [0, 100], [0, 300]], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(mesh.indices).toEqual([]);
    expect(mesh.points).toEqual([]);
  });

  it('removes arbitrary source diagonal intersections from both water seam edges', () => {
    const mesh = clip([[-2048, 2987], [-2048, -2048], [10240, -2048], [10240, 2987], [-2048, 2987]]);
    for (const edge of [0, 8192])
      expect(mesh.points.filter(point => point[0] === edge).map(point => point[1]).sort((a, b) => a - b)).toEqual([0, 2987]);
    expect(meshArea(mesh)).toBe(8192 * 2987);
  });

  it('preserves a hole wholly inside the clipped outer ring', () => {
    const mesh = clip([[-100, -100], [9000, -100], [9000, 9000], [-100, 9000], [1000, 1000], [1000, 3000], [3000, 3000], [3000, 1000]], [4]);
    expect(meshArea(mesh)).toBe(8192 ** 2 - 2000 ** 2);
    expect(meshContains(mesh, [2000, 2000])).toBe(false);
    expect(meshContains(mesh, [4000, 2000])).toBe(true);
  });

  it('opens a hole crossing the tile boundary without filling the notch', () => {
    const mesh = clip([[-1000, -1000], [9000, -1000], [9000, 9000], [-1000, 9000], [-500, 1000], [-500, 3000], [3000, 3000], [3000, 1000]], [4]);
    expect(meshArea(mesh)).toBe(8192 ** 2 - 3000 * 2000);
    expect(meshContains(mesh, [1000, 2000])).toBe(false);
    expect(meshContains(mesh, [4000, 2000])).toBe(true);
  });

  it('keeps disconnected pieces of a concave polygon separate', () => {
    const mesh = clip([[-200, 1000], [2000, 1000], [2000, 2000], [-100, 2000], [-100, 5000], [2000, 5000], [2000, 6000], [-200, 6000]]);
    expect(meshArea(mesh)).toBe(4000000);
    expect(meshContains(mesh, [1000, 1500])).toBe(true);
    expect(meshContains(mesh, [1000, 5500])).toBe(true);
    expect(meshContains(mesh, [1000, 3500])).toBe(false);
  });

  it('rejoins duplicated triangle vertices from two chunks of one polygon', () => {
    const points: TilePoint[] = [[-2048, 2987], [-2048, -2048], [10240, -2048], [10240, 2987], [-2048, 2987]];
    const triangles = earcut(points.flat());
    const chunkPoints = triangles.map(vertex => points[vertex]);
    const mesh = clipPlanarFill(chunkPoints, chunkPoints.map((_point, index) => index));
    expect(meshArea(mesh)).toBe(8192 * 2987);
    for (const edge of [0, 8192])
      expect(mesh.points.filter(point => point[0] === edge).map(point => point[1]).sort((a, b) => a - b)).toEqual([0, 2987]);
    // The same chunk data processed independently preserves artificial cuts,
    // demonstrating why explicit polygon lineage is required at the caller.
    const separate = [0, 3].map(start => clipPlanarFill(chunkPoints.slice(start, start + 3), [0, 1, 2]));
    expect(separate.flatMap(part => part.points.filter(point => point[0] === 8192))).toHaveLength(4);
  });

  it('keeps components that touch at one vertex from bridging empty space', () => {
    const points: TilePoint[] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]];
    const mesh = clipPlanarFill(points, [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    expect(meshArea(mesh)).toBe(2000000);
    expect(meshContains(mesh, [500, 1500])).toBe(false);
    expect(meshContains(mesh, [1500, 500])).toBe(false);
  });

  it('preserves a hole tangent to the tile boundary at a single vertex', () => {
    const mesh = clip([[-100, -100], [9000, -100], [9000, 9000], [-100, 9000], [0, 2000], [1000, 3000], [2000, 2000], [1000, 1000]], [4]);
    expect(meshArea(mesh)).toBe(8192 ** 2 - 2000000);
    expect(meshContains(mesh, [1000, 2000])).toBe(false);
    expect(meshContains(mesh, [3000, 2000])).toBe(true);
  });
});
