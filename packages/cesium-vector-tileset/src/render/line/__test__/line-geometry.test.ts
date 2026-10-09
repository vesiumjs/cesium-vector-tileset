import { BoundingSphere, Cartesian3 } from 'cesium';
import { describe, expect, it } from 'vitest';
import { CanonicalTileID } from '../../../tile/tile-id';
import { geometryBoundingSphere } from '../../geometry/geometry-bounds';
import { compileLineGeometry, LineGeometryCache } from '../line-geometry';

function finish<T>(iterator: Generator<void, T>): { value: T; checkpoints: number } {
  let checkpoints = 0;
  let result = iterator.next();
  while (!result.done) {
    checkpoints++;
    result = iterator.next();
  }
  return { value: result.value, checkpoints };
}

function coordinates() {
  // Interior and late duplicates exercise both retained-index initialization
  // and filtered centre copying; sharp bends require round-join fans.
  const values = [0, 0, 4, 0, 4, 0, 4, 4, 8, 1, 1, 7, 1, 7];
  const positions = new Float64Array(values.length / 2 * 3);
  for (let index = 0; index < values.length / 2; index++) {
    Cartesian3.pack(Cartesian3.fromDegrees(values[index * 2], 20 + values[index * 2 + 1]), positions as unknown as number[], index * 3);
  }
  return { positions, tilePositions: new Float64Array(values) };
}

describe('resumable line compiler', () => {
  it('keeps unfinished compilation outside the geometry cache', () => {
    const cache = new LineGeometryCache(new CanonicalTileID(0, 0, 0));
    const small = coordinates();
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

  it('uses local bounds scratch when two compiler scans are interleaved', () => {
    const first = new Float64Array(Array.from({ length: 10 }).flatMap(() => Array.from(coordinates().positions)));
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
