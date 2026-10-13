import type { SourceTileLod } from './source-tile-lod';
import { mercatorYfromLat } from '../../geo/mercator-coordinate';
import { MAX_TILE_ZOOM } from '../../geo/world-bounds';
import { OverscaledTileID } from '../../tile/tile-id';

export const MAX_LATITUDE = 85.051129;
const TILE_EDGE_EPSILON = 1e-8;

/** Cesium's rendered terrain tile already carries its tiling-scheme rectangle. */
export interface GlobeQuadtreeTileLike {
  level: number;
  x: number;
  y: number;
  rectangle: { west: number; south: number; east: number; north: number };
}

/** Only the rendered quadtree tiles belong in the source's visible covering. */
export interface GlobeLike {
  show?: boolean;
  _surface: { _tilesToRender: readonly GlobeQuadtreeTileLike[] };
}

function tilesForRectangle(
  rectangle: GlobeQuadtreeTileLike['rectangle'],
  minZoom: number,
  maxZoom: number,
): OverscaledTileID[] {
  const longitudeSpan = rectangle.east >= rectangle.west
    ? rectangle.east - rectangle.west
    : rectangle.east - rectangle.west + 2 * Math.PI;
  const terrainZoom = Math.round(Math.log2(2 * Math.PI / longitudeSpan));
  if (terrainZoom < minZoom) {
    return [];
  }
  const zoom = Math.min(maxZoom, terrainZoom);
  const world = 2 ** zoom;
  const south = Math.max(-MAX_LATITUDE, rectangle.south * 180 / Math.PI);
  const north = Math.min(MAX_LATITUDE, rectangle.north * 180 / Math.PI);
  if (north <= south) {
    return [];
  }

  // Terrain rectangle edges and Mercator tile boundaries differ by a few
  // floating-point ulps. Ignore that sliver or adjacent source tiles become
  // visible at every otherwise exact edge.
  const x0 = Math.floor((rectangle.west + Math.PI) / (2 * Math.PI) * world + TILE_EDGE_EPSILON);
  const x1 = Math.ceil((rectangle.west + longitudeSpan + Math.PI) / (2 * Math.PI) * world - TILE_EDGE_EPSILON) - 1;
  const y0 = Math.max(0, Math.floor(mercatorYfromLat(north) * world + TILE_EDGE_EPSILON));
  const y1 = Math.min(world - 1, Math.ceil(mercatorYfromLat(south) * world - TILE_EDGE_EPSILON) - 1);
  const result: OverscaledTileID[] = [];
  for (let x = x0; x <= x1; x++) {
    const wrappedX = ((x % world) + world) % world;
    for (let y = y0; y <= y1; y++) {
      result.push(new OverscaledTileID(zoom, 0, zoom, wrappedX, y));
    }
  }
  return result;
}

/**
 * Resolve one node of the covering, with MapLibre's coveringTiles rule: cull a
 * node the frustum cannot see, split it while its level is still below the
 * level the LOD wants there, and emit the node itself as soon as it is not.
 *
 * An upwards walk to the first satisfied ancestor is equivalent only for nodes
 * that sit at or above that level. On a rectangle the globe has coarsened, the
 * walk's answer is the rectangle's own tile and nothing refines it, so the
 * source level follows Cesium's screen space error rather than the camera.
 */
function collectCovering(
  id: OverscaledTileID,
  ceiling: number,
  lod: SourceTileLod,
  visible: (id: OverscaledTileID) => boolean,
  seen: Set<string>,
  out: OverscaledTileID[],
  rendered: boolean,
): void {
  // Cesium's rendered rectangles are already chosen, but only at their own
  // level: its coarse rectangles stand for their whole ground extent, however
  // little of it is on screen. Splitting them without the frustum test would
  // resolve a level-0 rectangle down to the LOD's level over the whole world.
  if (!visible(id)) {
    return;
  }
  if (id.overscaledZ < Math.min(lod.desiredZoom(id), ceiling)) {
    // Every ancestor decision is shared by the four children, so either all of
    // them split or none does; nothing here can leave a quarter uncovered.
    for (const child of id.children(ceiling)) {
      collectCovering(child, ceiling, lod, visible, seen, out, false);
    }
    return;
  }
  // A rendered rectangle authorizes area, not level: unlike a node reached by
  // splitting, its tile can be far finer than the LOD wants and must still
  // resolve upwards, or terrain detail alone would set the source level. A node
  // the split reached needs no walk, but still resolves to the generation the
  // source parses at that level, so that a coarser rectangle cannot name
  // different tiles than the finer ones it replaced.
  const selected = rendered ? lod.select(id) : lod.resolve(id);
  if (selected === undefined) {
    return;
  }
  if (!seen.has(selected.key)) {
    seen.add(selected.key);
    out.push(selected);
  }
}

/**
 * Map Cesium's rendered globe tiles onto the MVT source pyramid.
 *
 * The globe authorizes the area, through the rectangles it actually rendered,
 * and the LOD authorizes the level. Keeping the globe's own quadtree level out
 * of the level decision is what makes the covering independent of Cesium's
 * screen space error: a coarser rectangle covers the same ground, so it
 * resolves to the same tiles as the finer ones it replaced. `visible` must be
 * the frame's frustum test, which is what keeps a rectangle's ground extent
 * from being resolved in full.
 */
export function globeVisibleTileIDs(
  globe: GlobeLike,
  minZoom: number,
  targetZoom: number,
  lod?: SourceTileLod,
  visible?: (id: OverscaledTileID) => boolean,
): OverscaledTileID[] {
  if (globe.show === false) {
    return [];
  }
  const seen = new Set<string>();
  const result: OverscaledTileID[] = [];
  const ceiling = Math.min(lod?.maxZoom ?? targetZoom, MAX_TILE_ZOOM);
  const onScreen = visible ?? (() => true);
  for (const tile of globe._surface._tilesToRender) {
    for (const root of tilesForRectangle(tile.rectangle, minZoom, ceiling)) {
      if (lod) {
        collectCovering(root, ceiling, lod, onScreen, seen, result, true);
      }
      else if (!seen.has(root.key)) {
        seen.add(root.key);
        result.push(root);
      }
    }
  }
  return result;
}
