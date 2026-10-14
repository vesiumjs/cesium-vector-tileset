import type Point from '@mapbox/point-geometry';
import type { CanonicalTileID } from '../../tile/tile-id';
import { LngLat } from '../../geo/lng-lat';
import { MercatorCoordinate } from '../../geo/mercator-coordinate';
import { EXTENT } from '../extent';

/**
 * Rounds polygon corners by calculating arc points at each corner vertex.
 * @param polygon - Collection of polygon rings (outer ring and hole rings)
 * @param distanceInMeters - Desired corner rounding distance in meters
 * @param canonical - Canonical tile ID used for meter to tile unit conversion
 */
export function roundPolygonCorners(
  polygon: Point[][],
  distanceInMeters: number,
  canonical: CanonicalTileID,
): Point[][] {
  if (distanceInMeters <= 0 || !polygon || polygon.length === 0) {
    return polygon;
  }

  const distanceInTileUnits = getTileUnitsForMeters(distanceInMeters, canonical);
  return polygon.map(ring => roundRing(ring, distanceInTileUnits));
}

function tileCoordinatesToLocation(x: number, y: number, canonical: CanonicalTileID): LngLat {
  const worldSize = (1 << canonical.z) * EXTENT;
  const mx = (canonical.x * EXTENT + x) / worldSize;
  const my = (canonical.y * EXTENT + y) / worldSize;
  const lng = mx * 360 - 180;
  const lat = 360 / Math.PI * Math.atan(Math.exp((1 - 2 * my) * Math.PI)) - 90;
  return new LngLat(lng, lat);
}

function getTileUnitsForMeters(distanceInMeters: number, canonical: CanonicalTileID): number {
  const centerLocation = tileCoordinatesToLocation(EXTENT / 2, EXTENT / 2, canonical);
  const mercatorCoord = MercatorCoordinate.fromLngLat(centerLocation);
  const meterInMercator = mercatorCoord.meterInMercatorCoordinateUnits();
  const tileUnitsPerMercator = (1 << canonical.z) * EXTENT;
  return distanceInMeters * meterInMercator * tileUnitsPerMercator;
}

function roundRing(ring: Point[], distanceInTileUnits: number): Point[] {
  if (!ring || ring.length < 3) {
    return ring;
  }

  const isClosed = ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y;
  const vertexCount = isClosed ? ring.length - 1 : ring.length;

  if (vertexCount < 3) {
    return ring;
  }

  const newRing: Point[] = [];
  let previousIsBoundary = isBoundaryEdge(ring[vertexCount - 1], ring[0]);

  for (let i = 0; i < vertexCount; i++) {
    const prev = ring[(i - 1 + vertexCount) % vertexCount];
    const current = ring[i];
    const next = ring[(i + 1) % vertexCount];
    const nextIsBoundary = isBoundaryEdge(current, next);

    if (previousIsBoundary || nextIsBoundary)
      newRing.push(current.clone());
    else appendRoundCorner(newRing, prev, current, next, distanceInTileUnits);
    previousIsBoundary = nextIsBoundary;
  }

  const snapped: Point[] = [];
  for (const point of newRing) {
    const rounded = point.round();
    const previous = snapped[snapped.length - 1];
    if (!previous || !previous.equals(rounded))
      snapped.push(rounded);
  }
  while (snapped.length > 1 && snapped[0].equals(snapped[snapped.length - 1])) {
    snapped.pop();
  }
  if (snapped.length < 3)
    return ring;
  if (isClosed)
    snapped.push(snapped[0].clone());

  return snapped;
}

function isBoundaryEdge(first: Point, second: Point): boolean {
  return (first.x === second.x && (first.x < 0 || first.x > EXTENT))
    || (first.y === second.y && (first.y < 0 || first.y > EXTENT));
}

function appendRoundCorner(
  newRing: Point[],
  prev: Point,
  current: Point,
  next: Point,
  distanceInTileUnits: number,
): void {
  // Unit edge vectors from the current vertex towards its neighbours
  const ua = prev.sub(current);
  const ub = next.sub(current);
  const lenA = ua.mag();
  const lenB = ub.mag();

  if (lenA < 1e-6 || lenB < 1e-6) {
    newRing.push(current.clone());
    return;
  }

  ua._div(lenA);
  ub._div(lenB);

  // Straight lines or zero-degree turns
  const dot = ua.x * ub.x + ua.y * ub.y;
  if (Math.abs(dot) > Math.cos(5 * Math.PI / 180)) {
    newRing.push(current.clone());
    return;
  }

  // we clamp to not have circles in the extremes
  const maxEdgeLenPercent = 0.2;
  const r = Math.min(distanceInTileUnits, lenA * maxEdgeLenPercent, lenB * maxEdgeLenPercent);

  // Tangent points on edges to prevPoint and nextPoint
  const tangentA = current.add(ua.mult(r));
  const tangentB = current.add(ub.mult(r));

  // Center of the rounding arc, at r / cos(theta/2) along the bisector
  const cosHalfTheta = Math.sqrt((1 + dot) / 2);
  const center = current.add(ua.add(ub)._unit()._mult(r / cosHalfTheta));

  // Both tangent points lie on the arc circle.
  // Rotating tangent A around the center traces the fillet onto tangent B along the shortest arc.
  const sweepAngle = tangentA.sub(center).angleWith(tangentB.sub(center));

  // ~30 deg per segment; epsilon keeps fp noise from adding one at exact multiples.
  const numSegments = Math.max(2, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 6) - 1e-6));
  for (let s = 0; s <= numSegments; s++) {
    newRing.push(tangentA.rotateAround(sweepAngle * (s / numSegments), center));
  }
}
