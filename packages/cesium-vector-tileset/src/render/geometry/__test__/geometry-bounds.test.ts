import { BoundingSphere, Cartesian3 } from 'cesium';
import { expect, it } from 'vitest';
import { geometryBoundingSphere } from '../geometry-bounds';

it('resumes interleaved projected coordinates with Cesium-equivalent bounds', () => {
  const positions = new Float64Array(1000 * 6);
  for (let index = 0; index < 1000; index++) {
    positions.set([Math.sin(index) * index, Math.cos(index) * 3, index % 23, 1e20, 1e20, 1e20], index * 6);
  }
  const bounds = geometryBoundingSphere(positions, 6);
  let result = bounds.next();
  expect(result.done).toBe(false);
  while (!result.done) result = bounds.next();
  expect(result.value).toEqual(BoundingSphere.fromVertices(positions, Cartesian3.ZERO, 6));
});
