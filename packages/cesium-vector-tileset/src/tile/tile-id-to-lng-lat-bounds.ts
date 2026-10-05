import type { CanonicalTileID } from './tile-id';
import { LngLatBounds } from '../geo/lng-lat-bounds';
import { latFromMercatorY, lngFromMercatorX } from '../geo/mercator-coordinate';

export function tileIdToLngLatBounds(
  { x, y, z }: CanonicalTileID,
  buffer: number = 0,
): LngLatBounds {
  const lngMin = lngFromMercatorX((x - buffer) / 2 ** z);
  const latMin = latFromMercatorY((y + 1 + buffer) / 2 ** z);

  const lngMax = lngFromMercatorX((x + 1 + buffer) / 2 ** z);
  const latMax = latFromMercatorY((y - buffer) / 2 ** z);

  return new LngLatBounds([lngMin, latMin], [lngMax, latMax]);
}
