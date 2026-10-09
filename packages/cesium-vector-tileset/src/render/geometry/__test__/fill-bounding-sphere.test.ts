import { Cartesian3 } from 'cesium';
import * as Cesium from 'cesium';
import { describe, expect, it } from 'vitest';
import { fillBoundingSphere } from '../fill-bounding-sphere';

const EncodedCartesian3 = (Cesium as unknown as { EncodedCartesian3: { fromCartesian: (position: Cartesian3, result: { high: Cartesian3; low: Cartesian3 }) => { high: Cartesian3; low: Cartesian3 } } }).EncodedCartesian3;

function rectanglePositions(u: Cartesian3, v: Cartesian3, halfLength: number, halfWidth: number) {
  const center = new Cartesian3(4000000.1, -4000000.3, 2000000.2);
  const values: number[] = [];
  for (const x of [-halfLength, halfLength]) {
    for (const y of [-halfWidth, halfWidth]) {
      values.push(center.x + u.x * x + v.x * y, center.y + u.y * x + v.y * y, center.z + u.z * x + v.z * y);
    }
  }
  return new Float64Array(values);
}

describe('fill content bounding sphere', () => {
  it.each([
    { shape: 'rotated narrow strip', u: new Cartesian3(Math.SQRT1_2, Math.SQRT1_2, 0), v: new Cartesian3(-Math.SQRT1_2, Math.SQRT1_2, 0), length: 100, width: 20 },
    { shape: 'oblique square', u: new Cartesian3(Math.SQRT1_2, -Math.SQRT1_2, 0), v: new Cartesian3(1 / Math.sqrt(6), 1 / Math.sqrt(6), -2 / Math.sqrt(6)), length: 100, width: 100 },
  ])('uses actual vertices instead of absent box corners for $shape', ({ u, v, length, width }) => {
    const positions = rectanglePositions(u, v, length, width);
    const original = positions.slice();
    const iterator = fillBoundingSphere([{ positions }]);
    let step = iterator.next();
    while (!step.done)
      step = iterator.next();
    const sphere = step.value;
    expect(sphere.radius).toBeLessThan(Math.hypot(length, width) + 0.01);
    const point = new Cartesian3();
    const decoded = new Cartesian3();
    const encoded = { high: new Cartesian3(), low: new Cartesian3() };
    for (let offset = 0; offset < positions.length; offset += 3) {
      point.x = positions[offset];
      point.y = positions[offset + 1];
      point.z = positions[offset + 2];
      expect(Cartesian3.distance(point, sphere.center)).toBeLessThanOrEqual(sphere.radius);
      EncodedCartesian3.fromCartesian(point, encoded);
      decoded.x = Math.fround(encoded.high.x) + Math.fround(encoded.low.x);
      decoded.y = Math.fround(encoded.high.y) + Math.fround(encoded.low.y);
      decoded.z = Math.fround(encoded.high.z) + Math.fround(encoded.low.z);
      expect(Cartesian3.distance(decoded, sphere.center)).toBeLessThanOrEqual(sphere.radius);
    }
    expect(positions).toEqual(original);
  });
});
