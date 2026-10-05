import type Point from '@mapbox/point-geometry';

import type { VectorTileFeature } from '../source/vector-tile-data';

import { warnOnce } from '../util/errors';
import { clamp } from '../util/math';
import { EXTENT } from './extent';

// These bounds define the minimum and maximum supported coordinate values.
// While visible coordinates are within [0, EXTENT], tiles may theoretically
// contain coordinates within [-Infinity, Infinity]. Our range is limited by the
// number of bits used to represent the coordinate.
const BITS = 15;
const MAX = 2 ** (BITS - 1) - 1;
const MIN = -MAX - 1;

/**
 * Loads source feature geometry and scales it to the common extent
 * used internally.
 * @param feature - the vector tile feature to load
 */
export function loadGeometry(feature: VectorTileFeature): Point[][] {
  const scale = EXTENT / feature.extent;
  const geometry = feature.loadGeometry();
  for (const ring of geometry) {
    for (const point of ring) {
      // round here because mapbox-gl-native uses integers to represent
      // points and we need to do the same to avoid rendering differences.
      const x = Math.round(point.x * scale);
      const y = Math.round(point.y * scale);

      point.x = clamp(x, MIN, MAX);
      point.y = clamp(y, MIN, MAX);

      if (x < point.x || x > point.x + 1 || y < point.y || y > point.y + 1) {
        // warn when exceeding allowed extent except for the 1-px-off case
        // https://github.com/mapbox/mapbox-gl-js/issues/8992
        warnOnce('Geometry exceeds allowed extent, reduce your vector tile buffer size');
      }
    }
  }
  return geometry;
}
