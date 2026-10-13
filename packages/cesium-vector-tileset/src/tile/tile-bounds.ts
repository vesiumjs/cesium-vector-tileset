import type { CanonicalTileID } from './tile-id';

import { mercatorXfromLng, mercatorYfromLat } from '../geo/mercator-coordinate';

export class TileBounds {
  bounds: [number, number, number, number];

  constructor(bounds: [number, number, number, number]) {
    // make sure the bounds property contains valid longitude and latitudes
    if (!Array.isArray(bounds) || bounds.length !== 4)
      this.bounds = [-180, -90, 180, 90];
    else
      this.bounds = [Math.max(-180, bounds[0]), Math.max(-90, bounds[1]), Math.min(180, bounds[2]), Math.min(90, bounds[3])];
    if (this.bounds.some(Number.isNaN))
      throw new TypeError('Invalid TileJSON bounds coordinates');
    if (this.bounds[1] > 90 || this.bounds[3] < -90)
      throw new Error('Invalid TileJSON bounds latitude: must be between -90 and 90');
  }

  contains(tileID: CanonicalTileID): boolean {
    const worldSize = 2 ** tileID.z;
    const [west, south, east, north] = this.bounds;
    const level = {
      minX: Math.floor(mercatorXfromLng(west) * worldSize),
      minY: Math.floor(mercatorYfromLat(north) * worldSize),
      maxX: Math.ceil(mercatorXfromLng(east) * worldSize),
      maxY: Math.ceil(mercatorYfromLat(south) * worldSize),
    };
    if (tileID.y < level.minY || tileID.y >= level.maxY) {
      return false;
    }

    // TileJSON bounds are allowed to cross the antimeridian, for example
    // [170, -10, -170, 10].  In that case the longitude interval is the union
    // of the right and left edges of the world rather than an empty interval
    // with minX > maxX.
    const inLongitude = west <= east
      ? tileID.x >= level.minX && tileID.x < level.maxX
      : tileID.x >= level.minX || tileID.x < level.maxX;
    return inLongitude;
  }
}
