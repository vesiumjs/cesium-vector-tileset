/**
 * The maximum world tile zoom (Z).
 * In other words, the upper bound supported for tile zoom.
 */
export const MAX_TILE_ZOOM = 25;

/**
 * The minimum world tile zoom (Z).
 * In other words, the lower bound supported for tile zoom.
 */
export const MIN_TILE_ZOOM = 0;

/**
 * Returns true if a given tile zoom (Z), X, and Y are in the bounds of the world.
 * Zoom bounds are the minimum zoom (inclusive) through the maximum zoom (inclusive).
 * X and Y bounds are 0 (inclusive) to their respective zoom-dependent maxima (exclusive).
 *
 * @param zoom - the tile zoom (Z)
 * @param x - the tile X
 * @param y - the tile Y
 * @returns `true` if a given tile zoom, X, and Y are in the bounds of the world.
 */
export function isInBoundsForTileZoomXY(zoom: number, x: number, y: number): boolean {
  return !(
    zoom < MIN_TILE_ZOOM
    || zoom > MAX_TILE_ZOOM
    || y < 0
    || y >= 2 ** zoom
    || x < 0
    || x >= 2 ** zoom
  );
}
