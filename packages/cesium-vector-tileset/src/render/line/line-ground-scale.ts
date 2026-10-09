import { Ellipsoid } from 'cesium';

/** MapLibre's zoom-zero world is 512 CSS pixels in Web Mercator. */
export function lineGroundScale(zoom: number): number {
  return 2 * Math.PI * Ellipsoid.WGS84.maximumRadius / (512 * 2 ** zoom);
}
