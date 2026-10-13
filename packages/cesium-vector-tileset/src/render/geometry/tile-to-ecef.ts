import { Cartesian3, Ellipsoid } from 'cesium';
import { EXTENT } from '../../data/extent';
import { latFromMercatorY, lngFromMercatorX } from '../../geo/mercator-coordinate';

/** WGS84 dimensions shared with Cesium's explicit ellipsoid. */
export const WGS84_A = Ellipsoid.WGS84.radii.x;
export const WGS84_F = (WGS84_A - Ellipsoid.WGS84.radii.z) / WGS84_A;

/**
 * The mercator fraction of a local point inside a canonical tile.
 * Fraction 0 is the north-west corner of the world; 1 is the south-east corner.
 * Tile coordinates use the y-down convention of the vector tile spec.
 */
export function tileLocalToMercatorFraction(
  tileID: { canonical: { z: number; x: number; y: number }; wrap?: number } | { z: number; x: number; y: number },
  localX: number,
  localY: number,
): { x: number; y: number } {
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  const wrap = 'wrap' in tileID ? tileID.wrap ?? 0 : 0;
  const worldSize = 2 ** canonical.z;
  // A bucket is built from the canonical tile, but a Cesium scene can display
  // an unwrapped world copy. Keep the wrap in the mercator coordinate instead
  // of placing every copy on top of the zero-wrap tile.
  const mx = (canonical.x + wrap * worldSize + localX / EXTENT) / worldSize;
  const my = (canonical.y + localY / EXTENT) / worldSize;
  return { x: mx, y: my };
}

/**
 * Convert a local point in a canonical tile to WGS84 lon/lat in radians.
 */
export function tileLocalToCartographic(
  tileID: { canonical: { z: number; x: number; y: number }; wrap?: number } | { z: number; x: number; y: number },
  localX: number,
  localY: number,
): { lng: number; lat: number } {
  // MapLibre reserves these signed-int16 coordinates for exact globe poles.
  // Treating them as ordinary Mercator values leaves a longitude-dependent
  // ring of near-pole vertices, which can open a visible crack at low zoom.
  if (localY === -32768) {
    return { lng: 0, lat: Math.PI / 2 };
  }
  if (localY === 32767) {
    return { lng: 0, lat: -Math.PI / 2 };
  }
  const { x, y } = tileLocalToMercatorFraction(tileID, localX, localY);
  return {
    lng: lngFromMercatorX(x) * Math.PI / 180,
    lat: latFromMercatorY(y) * Math.PI / 180,
  };
}

/**
 * Convert a local point in a canonical tile to WGS84 ECEF coordinates
 * (meters on the ellipsoid surface).
 */
export function tileLocalToWgs84Ecef(
  tileID: { canonical: { z: number; x: number; y: number }; wrap?: number } | { z: number; x: number; y: number },
  localX: number,
  localY: number,
): { x: number; y: number; z: number } {
  const { lng, lat } = tileLocalToCartographic(tileID, localX, localY);
  return Cartesian3.fromRadians(lng, lat, 0, Ellipsoid.WGS84);
}
