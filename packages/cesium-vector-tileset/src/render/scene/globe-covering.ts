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
  targetZoom: number,
): OverscaledTileID[] {
  const longitudeSpan = rectangle.east >= rectangle.west
    ? rectangle.east - rectangle.west
    : rectangle.east - rectangle.west + 2 * Math.PI;
  const terrainZoom = Math.round(Math.log2(2 * Math.PI / longitudeSpan));
  if (terrainZoom < minZoom) {
    return [];
  }
  const zoom = Math.min(targetZoom, terrainZoom);
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

/** Map Cesium's rendered globe tiles onto the MVT source pyramid. */
export function globeVisibleTileIDs(
  globe: GlobeLike,
  minZoom: number,
  targetZoom: number,
  lod?: SourceTileLod,
): OverscaledTileID[] {
  if (globe.show === false) {
    return [];
  }
  const seen = new Set<string>();
  const result: OverscaledTileID[] = [];
  const zoom = Math.min(lod?.maxZoom ?? targetZoom, MAX_TILE_ZOOM);
  for (const tile of globe._surface._tilesToRender) {
    for (const web of tilesForRectangle(tile.rectangle, minZoom, zoom)) {
      const selected = lod ? lod.select(web) : web;
      if (selected && !seen.has(selected.key)) {
        seen.add(selected.key);
        result.push(selected);
      }
    }
  }
  return result;
}
