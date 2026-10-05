import type { RasterStyleLayer } from '../../style/style-layer/raster-style-layer';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import { Cartesian3, Cartographic, Ellipsoid, SceneMode } from 'cesium';
import { EXTENT } from '../../data/extent';
import { tileLocalToCartographic } from '../geometry/tile-to-ecef';
import { constantValue } from '../vector/feature-attributes';

type TileID = CanonicalTileID | OverscaledTileID;

/**
 * Raster tile geometry: a grid of ECEF vertices on the ellipsoid surface,
 * subdivided so low-zoom tiles do not collapse against the globe.
 *
 * One custom Primitive per tile consumes this geometry; the texture is the
 * raster image and the fragment shader applies the style's color filters.
 */

export interface RasterPrimitiveGeometry {
  /** ECEF positions, 3 doubles per vertex, row-major from north-west */
  positions: Float64Array;
  /** Texture coordinates, 2 floats per vertex, north-west maps to (0, 1). */
  st: Float32Array;
  /** triangle indices */
  indices: Uint16Array;
  /** grid resolution in cells per tile edge */
  subdivisions: number;
  /** vertex per edge: subdivisions + 1 */
  gridSize: number;
}

/** A source-local coordinate used by ImageSource/CanvasSource/VideoSource. */
export interface RasterTileCoordinate {
  x: number;
  y: number;
}

/** Grid resolution per tile edge; tiles below zSubdivide are subdivided. */
export const Z_SUBDIVIDE = 6;
export const CELLS_PER_EDGE = 4;
export const GLOBE_CELLS_PER_EDGE = 128;
export const GLOBE_MIN_CELLS_PER_EDGE = 32;
/** Small lift used by the Cesium renderer to avoid z-fighting with the globe. */
export const RASTER_SURFACE_OFFSET_M = 1;

function cellCountForZoom(z: number, mode?: SceneMode): number {
  // Keep the direct helper's historical contract when no frame mode is
  // supplied. Runtime renderers pass the current mode and use the globe tile
  // mesh policy from MapLibre.
  if (mode === undefined) {
    return z >= Z_SUBDIVIDE ? 1 : CELLS_PER_EDGE;
  }
  if (mode !== SceneMode.SCENE3D && mode !== SceneMode.MORPHING) {
    return 1;
  }
  return Math.max(
    Math.floor(GLOBE_CELLS_PER_EDGE / (2 ** Math.max(0, Math.floor(z)))),
    GLOBE_MIN_CELLS_PER_EDGE,
  );
}

interface RasterGridData {
  positions: Float64Array;
  st: Float32Array;
  indices: Uint16Array;
  subdivisions: number;
  gridSize: number;
}

interface RasterGridEntry {
  ellipsoid: Ellipsoid;
  /** Grid at surfaceOffset 0, shared by every layer on the tile. */
  base: RasterGridData;
  /** Surface offsets applied to the shared base positions, cached per offset. */
  shifted: Map<number, Float64Array>;
}

// The ECEF grid depends only on the tile, the frame mode, the source corner
// quad and the winding order - never on the style layer. Raster layers share
// one tile's geometry, so recomputing the full 129x129 grid (one Cartographic
// and one Cartesian3 allocation per vertex at low zoom) per layer per tile
// wasted most of the build time on identical work. The per-layer surface
// offset is small and is applied to the shared base positions instead.
const rasterGridCache = new WeakMap<CanonicalTileID | OverscaledTileID, Map<string, RasterGridEntry>>();

export function rasterGeometryKey(
  tileCoordinates: readonly RasterTileCoordinate[] | undefined,
  flippedWindingOrder: boolean,
  mode?: SceneMode,
): string {
  return `${flippedWindingOrder ? 'flipped' : 'normal'}:${mode ?? 'legacy'}:${tileCoordinates?.map(point => `${point.x},${point.y}`).join(';') ?? 'tile'}`;
}

function offsetGridPositions(positions: Float64Array, ellipsoid: Ellipsoid, meters: number): Float64Array {
  const shifted = positions.slice();
  const point = new Cartesian3();
  const normal = new Cartesian3();
  for (let i = 0; i < shifted.length; i += 3) {
    Cartesian3.fromElements(shifted[i], shifted[i + 1], shifted[i + 2], point);
    ellipsoid.geodeticSurfaceNormal(point, normal);
    shifted[i] += normal.x * meters;
    shifted[i + 1] += normal.y * meters;
    shifted[i + 2] += normal.z * meters;
  }
  return shifted;
}

/**
 * Builds the ECEF grid for a canonical tile at surfaceOffset 0. Vertices are
 * exact ellipsoid points at the tile's cartographic bounds; the grid is
 * uniformly subdivided when the tile is large on screen (low zoom).
 */
function buildRasterGrid(
  tileID: TileID,
  ellipsoid: Ellipsoid,
  tileCoordinates: readonly RasterTileCoordinate[] | undefined,
  flippedWindingOrder: boolean,
  mode: SceneMode | undefined,
): RasterGridData {
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  const cells = cellCountForZoom(canonical.z, mode);
  const size = cells + 1;
  const positions = new Float64Array(size * size * 3);
  const st = new Float32Array(size * size * 2);
  const indices = new Uint16Array(cells * cells * 6);
  const corners = tileCoordinates?.length === 4
    && tileCoordinates.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    ? tileCoordinates
    : undefined;

  const sourcePoint = (u: number, v: number): RasterTileCoordinate => {
    if (!corners) {
      return { x: EXTENT * u, y: EXTENT * v };
    }
    const topLeft = corners[0];
    const topRight = corners[1];
    const bottomRight = corners[2];
    const bottomLeft = corners[3];
    const topX = topLeft.x + (topRight.x - topLeft.x) * u;
    const topY = topLeft.y + (topRight.y - topLeft.y) * u;
    const bottomX = bottomLeft.x + (bottomRight.x - bottomLeft.x) * u;
    const bottomY = bottomLeft.y + (bottomRight.y - bottomLeft.y) * u;
    return {
      x: topX + (bottomX - topX) * v,
      y: topY + (bottomY - topY) * v,
    };
  };

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      // Tile rows are uniformly spaced in Web Mercator, not latitude.  The
      // distinction is material for the low-zoom subdivisions near the poles.
      const point = sourcePoint(col / cells, row / cells);
      const cart = tileLocalToCartographic(
        tileID,
        point.x,
        point.y,
      );
      const p = ellipsoid.cartographicToCartesian(new Cartographic(cart.lng, cart.lat));
      const o = (row * size + col) * 3;
      positions[o] = p.x;
      positions[o + 1] = p.y;
      positions[o + 2] = p.z;
      const textureOffset = (row * size + col) * 2;
      st[textureOffset] = col / cells;
      // Image sources with a flipped winding order (hasWrongWindingOrder)
      // project their corner quad with an inverted V axis. The triangles keep
      // the outward winding - Cesium's EllipsoidSurfaceAppearance culls back
      // faces for aboveGround:false, and the outward winding matches Cesium's
      // own RectangleGeometry (upperLeft, lowerLeft, upperRight) - so the
      // texture is mirrored in V instead, which is exactly what MapLibre's
      // cull-face flip produces for such sources.
      st[textureOffset + 1] = flippedWindingOrder ? row / cells : 1 - row / cells;
    }
  }

  let i = 0;
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      const a = row * size + col;
      const b = a + 1;
      const c = a + size;
      const d = c + 1;
      indices[i++] = a;
      indices[i++] = c;
      indices[i++] = b;
      indices[i++] = b;
      indices[i++] = c;
      indices[i++] = d;
    }
  }

  return { positions, st, indices, subdivisions: cells, gridSize: size };
}

/**
 * Builds the ECEF grid for a canonical tile. Vertices are exact ellipsoid
 * points at the tile's cartographic bounds; the grid is uniformly subdivided
 * when the tile is large on screen (low zoom). The grid is memoized per tile
 * and shared by every raster layer; `surfaceOffset` lifts a copy of the
 * shared positions along the surface normal.
 */
export function rasterPrimitiveGeometry(
  tileID: TileID,
  ellipsoid: Ellipsoid = Ellipsoid.WGS84,
  surfaceOffset = 0,
  tileCoordinates?: readonly RasterTileCoordinate[],
  flippedWindingOrder = false,
  mode?: SceneMode,
): RasterPrimitiveGeometry {
  const key = rasterGeometryKey(tileCoordinates, flippedWindingOrder, mode);
  let entry = rasterGridCache.get(tileID)?.get(key);
  if (!entry || entry.ellipsoid !== ellipsoid) {
    entry = {
      ellipsoid,
      base: buildRasterGrid(tileID, ellipsoid, tileCoordinates, flippedWindingOrder, mode),
      shifted: new Map(),
    };
    let tileCache = rasterGridCache.get(tileID);
    if (!tileCache) {
      tileCache = new Map();
      rasterGridCache.set(tileID, tileCache);
    }
    tileCache.set(key, entry);
  }
  if (surfaceOffset === 0) {
    return { ...entry.base };
  }
  let positions = entry.shifted.get(surfaceOffset);
  if (!positions) {
    positions = offsetGridPositions(entry.base.positions, ellipsoid, surfaceOffset);
    entry.shifted.set(surfaceOffset, positions);
  }
  return {
    positions,
    st: entry.base.st,
    indices: entry.base.indices,
    subdivisions: entry.base.subdivisions,
    gridSize: entry.base.gridSize,
  };
}

export interface RasterStyle {
  opacity: number;
  brightnessMin: number;
  brightnessMax: number;
  contrast: number;
  saturation: number;
  hueRotate: number;
  resampling: 'linear' | 'nearest';
}

/**
 * Feature-independent raster paint values, evaluated once per tile build
 * (the spec's no-fade policy: raster layer style is uniform per tile).
 */
export function rasterStyle(layer: RasterStyleLayer): RasterStyle {
  const paint = layer as unknown as { paint: { get: (property: string) => unknown } };
  const value = (property: string, fallback: number): number => {
    const resolved = constantValue(paint, property);
    return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : fallback;
  };
  const resampling = constantValue(paint, 'resampling') === 'nearest'
    || constantValue(paint, 'raster-resampling') === 'nearest'
    ? 'nearest'
    : 'linear';
  return {
    opacity: value('raster-opacity', 1),
    brightnessMin: value('raster-brightness-min', 0),
    brightnessMax: value('raster-brightness-max', 1),
    contrast: value('raster-contrast', 0),
    saturation: value('raster-saturation', 0),
    hueRotate: value('raster-hue-rotate', 0),
    resampling,
  };
}
