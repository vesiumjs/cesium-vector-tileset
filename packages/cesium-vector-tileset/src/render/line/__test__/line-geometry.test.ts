import type { Geometry } from 'cesium';
import { BoundingSphere, Cartesian3 } from 'cesium';
import { describe, expect, it } from 'vitest';
import { CanonicalTileID } from '../../../tile/tile-id';
import { geometryBoundingSphere } from '../../geometry/geometry-bounds';
import { lineInputs } from '../../geometry/line-input';
import { compileLineGeometry, createLineGeometry, LineGeometryCache } from '../line-geometry';

function finish<T>(iterator: Generator<void, T>): { value: T; checkpoints: number } {
  let checkpoints = 0;
  let result = iterator.next();
  while (!result.done) {
    checkpoints++;
    result = iterator.next();
  }
  return { value: result.value, checkpoints };
}

function coordinates(closed: boolean) {
  // Interior and late duplicates exercise both retained-index initialization
  // and filtered centre copying; sharp bends require round-join fans.
  const values = [0, 0, 4, 0, 4, 0, 4, 4, 8, 1, 1, 7, 1, 7];
  if (closed)
    values.push(0, 0);
  const positions = new Float64Array(values.length / 2 * 3);
  for (let index = 0; index < values.length / 2; index++) {
    Cartesian3.pack(Cartesian3.fromDegrees(values[index * 2], 20 + values[index * 2 + 1]), positions as unknown as number[], index * 3);
  }
  return { positions, tilePositions: new Float64Array(values) };
}

describe('resumable line compiler', () => {
  for (const join of ['miter', 'bevel', 'round']) {
    for (const cap of ['butt', 'square', 'round']) {
      for (const planar of [false, true]) {
        for (const closed of [false, true]) {
          it(`preserves ${join}/${cap} topology, planar=${planar}, closed=${closed}`, () => {
            const source = coordinates(closed);
            const options = {
              join,
              cap,
              miterLimit: 2,
              roundLimit: 1.05,
              widthPx: 12,
              dashFrom: { y: 0.25, width: 16, height: 0.125 },
              dashTo: { y: 0.5, width: 32, height: 0.125 },
            };
            const tileSource = { tileID: new CanonicalTileID(2, 1, 1), tilePositions: source.tilePositions };
            const expected = createLineGeometry(source.positions, options, planar, tileSource)!;
            const result = finish(compileLineGeometry(source.positions, options, planar, tileSource));
            const actual = result.value as Geometry;
            expect(result.checkpoints).toBe(0);
            expect(actual.attributes).toEqual(expected.attributes);
            expect(actual.indices).toEqual(expected.indices);
            expect(actual.boundingSphere).toEqual(expected.boundingSphere);
            expect(lineInputs.get(actual)).toEqual(lineInputs.get(expected));
            const input = lineInputs.get(actual)!;
            expect(input.closed).toBe(closed);
            expect(input.positions.length / 3).toBe(5);
            expect(actual.boundingSphere).toEqual(BoundingSphere.fromVertices(input.positions));
          });
        }
      }
    }
  }

  it('keeps unfinished compilation outside the geometry cache', () => {
    const cache = new LineGeometryCache(new CanonicalTileID(0, 0, 0));
    const small = coordinates(false);
    const source = {
      positions: new Float64Array(Array.from({ length: 10 }).flatMap(() => Array.from(small.positions))),
      tilePositions: new Float64Array(Array.from({ length: 10 }).flatMap(() => Array.from(small.tilePositions))),
    };
    const options = { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05, widthPx: 12 };
    const abandoned = cache.compile(source, options);
    expect(abandoned.next().done).toBe(false);
    abandoned.return(undefined);
    const result = finish(cache.compile(source, options));
    expect(result.checkpoints).toBeGreaterThan(0);
    expect(result.value).toBeDefined();
    expect(cache.compile(source, options).next()).toEqual({ done: true, value: result.value });
    expect(cache.geometry(source, options)).toBe(result.value);
  });

  it('finishes an entire tiny path at the quantum boundary and resumes larger paths', () => {
    const options = { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05, widthPx: 12 };
    const positions = new Float64Array(33 * 3);
    for (let index = 0; index < 33; index++) Cartesian3.pack(Cartesian3.fromDegrees(index / 1000, 30), positions as unknown as number[], index * 3);
    expect(finish(compileLineGeometry(positions.subarray(0, 32 * 3), options)).checkpoints).toBe(0);
    expect(finish(compileLineGeometry(positions, options)).checkpoints).toBeGreaterThan(0);
  });

  it('uses local bounds scratch when two compiler scans are interleaved', () => {
    const first = new Float64Array(Array.from({ length: 10 }).flatMap(() => Array.from(coordinates(false).positions)));
    const second = new Float64Array(Array.from({ length: 20 }).flatMap(() => [1, 2, 3, 7, -3, 4, 9, 9, 9, -8, 4, 5]));
    const a = geometryBoundingSphere(first);
    const b = geometryBoundingSphere(second);
    a.next();
    b.next();
    expect(finish(a).value).toEqual(BoundingSphere.fromVertices(first));
    expect(finish(b).value).toEqual(BoundingSphere.fromVertices(second));
  });

  it('retains validation and collapsed-path behavior', () => {
    const options = { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05, widthPx: 12 };
    expect(finish(compileLineGeometry(new Float64Array([1, 2, NaN, 4, 5, 6]), options)).value).toBeUndefined();
    expect(finish(compileLineGeometry(new Float64Array([1, 2, 3, 1, 2, 3]), options)).value).toBeUndefined();
    expect(() => finish(compileLineGeometry(new Float64Array(6), options, true))).toThrow('requires source coordinates');
    expect(() => finish(compileLineGeometry(new Float64Array(6), options, false, {
      tileID: new CanonicalTileID(0, 0, 0),
      tilePositions: new Float64Array(2),
    }))).toThrow('must match');
  });
});
