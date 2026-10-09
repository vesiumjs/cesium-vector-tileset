import { BoundingSphere, Cartesian3 } from 'cesium';
import * as Cesium from 'cesium';

interface EncodedPosition { high: Cartesian3; low: Cartesian3 }
// Cesium exports this Native encoder at runtime but omits its declaration.
const EncodedCartesian3 = (Cesium as unknown as { EncodedCartesian3: { fromCartesian: (position: Cartesian3, result: EncodedPosition) => EncodedPosition } }).EncodedCartesian3;

/** World-space fill bounds, computed in small build quanta before Native allocation. */
export function* fillBoundingSphere(polygons: readonly { positions: Float64Array }[]): Generator<void, BoundingSphere> {
  const minimum = new Cartesian3(Infinity, Infinity, Infinity);
  const maximum = new Cartesian3(-Infinity, -Infinity, -Infinity);
  const point = new Cartesian3();
  const decoded = new Cartesian3();
  const encoded: EncodedPosition = { high: new Cartesian3(), low: new Cartesian3() };
  let maximumErrorSquared = 0;
  let vertices = 0;
  for (const { positions } of polygons) {
    for (let offset = 0; offset < positions.length; offset += 3) {
      point.x = positions[offset];
      point.y = positions[offset + 1];
      point.z = positions[offset + 2];
      Cartesian3.minimumByComponent(minimum, point, minimum);
      Cartesian3.maximumByComponent(maximum, point, maximum);
      // Native BufferPolygon writes these high/low components into Float32
      // attributes. Include that decoded position as well as the source double.
      EncodedCartesian3.fromCartesian(point, encoded);
      decoded.x = Math.fround(encoded.high.x) + Math.fround(encoded.low.x);
      decoded.y = Math.fround(encoded.high.y) + Math.fround(encoded.low.y);
      decoded.z = Math.fround(encoded.high.z) + Math.fround(encoded.low.z);
      maximumErrorSquared = Math.max(maximumErrorSquared, Cartesian3.distanceSquared(point, decoded));
      if (++vertices % 32 === 0)
        yield;
    }
  }
  if (vertices === 0)
    return new BoundingSphere();
  const center = Cartesian3.midpoint(minimum, maximum, new Cartesian3());
  let maximumRadiusSquared = 0;
  let radiusVertices = 0;
  // As in Native's naive fromVertices sphere, measure actual points rather
  // than box corners that may not exist in a rotated fill.
  for (const { positions } of polygons) {
    for (let offset = 0; offset < positions.length; offset += 3) {
      point.x = positions[offset];
      point.y = positions[offset + 1];
      point.z = positions[offset + 2];
      maximumRadiusSquared = Math.max(maximumRadiusSquared, Cartesian3.distanceSquared(point, center));
      if (++radiusVertices % 32 === 0)
        yield;
    }
  }
  const radius = Math.sqrt(maximumRadiusSquared) + Math.sqrt(maximumErrorSquared);
  // Cover double rounding in the midpoint and distance arithmetic.
  const rounding = Math.max(1, radius, Cartesian3.magnitude(center)) * Number.EPSILON * 8;
  return new BoundingSphere(center, radius + rounding);
}
