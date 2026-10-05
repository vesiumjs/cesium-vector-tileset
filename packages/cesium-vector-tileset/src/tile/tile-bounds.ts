import type { LngLatBoundsLike } from '../geo/lng-lat-bounds';
import type { CanonicalTileID } from './tile-id';
import { LngLatBounds } from '../geo/lng-lat-bounds';

import { mercatorXfromLng, mercatorYfromLat } from '../geo/mercator-coordinate';

export class TileBounds {
  bounds: LngLatBounds;
  minzoom: number;
  maxzoom: number;

  constructor(bounds: [number, number, number, number], minzoom?: number | null, maxzoom?: number | null) {
    this.bounds = LngLatBounds.convert(this.validateBounds(bounds));
    this.minzoom = minzoom ?? 0;
    this.maxzoom = maxzoom ?? 24;
  }

  validateBounds(bounds: [number, number, number, number]): LngLatBoundsLike {
    // make sure the bounds property contains valid longitude and latitudes
    if (!Array.isArray(bounds) || bounds.length !== 4)
      return [-180, -90, 180, 90];
    return [Math.max(-180, bounds[0]), Math.max(-90, bounds[1]), Math.min(180, bounds[2]), Math.min(90, bounds[3])];
  }

  contains(tileID: CanonicalTileID): boolean {
    const worldSize = 2 ** tileID.z;
    const west = this.bounds.getWest();
    const east = this.bounds.getEast();
    const level = {
      minX: Math.floor(mercatorXfromLng(west) * worldSize),
      minY: Math.floor(mercatorYfromLat(this.bounds.getNorth()) * worldSize),
      maxX: Math.ceil(mercatorXfromLng(east) * worldSize),
      maxY: Math.ceil(mercatorYfromLat(this.bounds.getSouth()) * worldSize),
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
