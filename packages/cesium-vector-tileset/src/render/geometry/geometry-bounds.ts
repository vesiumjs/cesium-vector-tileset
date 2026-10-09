import { BoundingSphere, Cartesian3 } from 'cesium';

const POINT_QUANTUM = 32;

/** Cesium's Ritter/naive bounds selection with resumable vertex scans. */
export function* geometryBoundingSphere(positions: Float64Array, stride = 3): Generator<void, BoundingSphere> {
  if (positions.length === 0)
    return new BoundingSphere();
  const resumable = positions.length > POINT_QUANTUM * stride;
  const point = Cartesian3.unpack(positions as unknown as number[], 0);
  const xMin = Cartesian3.clone(point);
  const xMax = Cartesian3.clone(point);
  const yMin = Cartesian3.clone(point);
  const yMax = Cartesian3.clone(point);
  const zMin = Cartesian3.clone(point);
  const zMax = Cartesian3.clone(point);
  for (let index = 0; index < positions.length; index += stride) {
    Cartesian3.unpack(positions as unknown as number[], index, point);
    if (point.x < xMin.x)
      Cartesian3.clone(point, xMin);
    if (point.x > xMax.x)
      Cartesian3.clone(point, xMax);
    if (point.y < yMin.y)
      Cartesian3.clone(point, yMin);
    if (point.y > yMax.y)
      Cartesian3.clone(point, yMax);
    if (point.z < zMin.z)
      Cartesian3.clone(point, zMin);
    if (point.z > zMax.z)
      Cartesian3.clone(point, zMax);
    if (resumable && (index / stride + 1) % POINT_QUANTUM === 0)
      yield;
  }
  if (resumable)
    yield;
  const xSpan = Cartesian3.distanceSquared(xMax, xMin);
  const ySpan = Cartesian3.distanceSquared(yMax, yMin);
  const zSpan = Cartesian3.distanceSquared(zMax, zMin);
  let diameter1 = xMin;
  let diameter2 = xMax;
  let maxSpan = xSpan;
  if (ySpan > maxSpan) {
    maxSpan = ySpan;
    diameter1 = yMin;
    diameter2 = yMax;
  }
  if (zSpan > maxSpan) {
    diameter1 = zMin;
    diameter2 = zMax;
  }
  const ritterCenter = Cartesian3.midpoint(diameter1, diameter2, new Cartesian3());
  let radiusSquared = Cartesian3.distanceSquared(diameter2, ritterCenter);
  let ritterRadius = Math.sqrt(radiusSquared);
  const naiveCenter = Cartesian3.midpoint(
    new Cartesian3(xMin.x, yMin.y, zMin.z),
    new Cartesian3(xMax.x, yMax.y, zMax.z),
    new Cartesian3(),
  );
  let naiveRadius = 0;
  for (let index = 0; index < positions.length; index += stride) {
    Cartesian3.unpack(positions as unknown as number[], index, point);
    naiveRadius = Math.max(naiveRadius, Cartesian3.distance(point, naiveCenter));
    const distanceSquared = Cartesian3.distanceSquared(point, ritterCenter);
    if (distanceSquared > radiusSquared) {
      const distance = Math.sqrt(distanceSquared);
      ritterRadius = (ritterRadius + distance) * 0.5;
      radiusSquared = ritterRadius * ritterRadius;
      const oldToNew = distance - ritterRadius;
      ritterCenter.x = (ritterRadius * ritterCenter.x + oldToNew * point.x) / distance;
      ritterCenter.y = (ritterRadius * ritterCenter.y + oldToNew * point.y) / distance;
      ritterCenter.z = (ritterRadius * ritterCenter.z + oldToNew * point.z) / distance;
    }
    if (resumable && (index / stride + 1) % POINT_QUANTUM === 0)
      yield;
  }
  if (resumable)
    yield;
  return ritterRadius < naiveRadius
    ? new BoundingSphere(ritterCenter, ritterRadius)
    : new BoundingSphere(naiveCenter, naiveRadius);
}
