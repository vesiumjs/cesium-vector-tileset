import type { ImagePosition } from '../../assets/image-atlas';
import type { PatternLayoutArray } from '../../data/array-types.g';
import type { FillBucket, FillExtrusionBucket, LineBucket } from '../../data/bucket-runtime';
import type { FeaturePaintRange } from '../../data/program-configuration';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { ExtrusionPrimitiveGeometry } from '../vector/extrusion-geometry';
import { constantValue } from '../vector/feature-attributes';

/**
 * Pattern atlas rect (in texture pixels) for one feature, extracted from the
 * CrossFadedPatternBinder paint array (PatternLayoutArray, 10x uint16
 * per feature: from.tlbr + to.tlbr + from.pixelRatio + to.pixelRatio).
 */
export interface PatternAtlasRect {
  /** atlas rect for the current zoom's pattern, texture pixels */
  tlbr: [number, number, number, number];
  /** sprite pixel ratio */
  pixelRatio: number;
}

const TILE_SIZE_PX = 512;
const EXTENT = 8192;

type PatternBucket = FillBucket | LineBucket | FillExtrusionBucket;
type TileID = CanonicalTileID | OverscaledTileID;

export interface PatternTileCoordinates {
  scale: number;
  offset: [number, number];
}

/** Map zoom controls texture repeats independently of the source's tile LOD. */
export function patternTileCoordinates(tileID: TileID, rect: PatternAtlasRect, zoom: number): PatternTileCoordinates {
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  const wrap = 'wrap' in tileID ? tileID.wrap : 0;
  const scale = 2 ** (Math.max(0, Math.floor(zoom)) - canonical.z);
  const patternSizeX = (rect.tlbr[2] - rect.tlbr[0]) / rect.pixelRatio;
  const patternSizeY = (rect.tlbr[3] - rect.tlbr[1]) / rect.pixelRatio;
  const worldOffsetX = (canonical.x + wrap * 2 ** canonical.z) * TILE_SIZE_PX * scale;
  const worldOffsetY = canonical.y * TILE_SIZE_PX * scale;
  return {
    scale,
    offset: [
      (((worldOffsetX % patternSizeX) + patternSizeX) % patternSizeX) / patternSizeX,
      (((worldOffsetY % patternSizeY) + patternSizeY) % patternSizeY) / patternSizeY,
    ],
  };
}

/**
 * Extracts the pattern atlas rect from a feature's paint slot.
 * Returns null when the property is not data-driven (constant patterns are
 * resolved against the layer paint value, not the attribute array).
 */
export function patternAtlasRectForFeature(bucket: PatternBucket, range: FeaturePaintRange, layerId?: string): PatternAtlasRect | null {
  const layer = layerId
    ? bucket.layers.find(candidate => candidate.id === layerId) ?? bucket.layers[0]
    : bucket.layers[0];
  if (!layer) {
    return null;
  }
  const type = layer.type;
  const configuration = bucket.programConfigurations.get(layer.id);
  const attributeArray = configuration?.getAttributeArray(`${type}-pattern`);
  if (!attributeArray) {
    return null;
  }
  const uint16 = (attributeArray as PatternLayoutArray).uint16;
  const stride = attributeArray.bytesPerElement / Uint16Array.BYTES_PER_ELEMENT;
  const o = range.start * stride;
  if (!Number.isInteger(stride) || stride < 10 || o + 9 >= uint16.length) {
    return null;
  }
  // CrossFadedPatternBinder stores the previous value in slots 0..3 and the
  // current (to) value in slots 4..7. The Cesium material currently samples a
  // single atlas rectangle, so use the current value; reading the previous
  // rectangle makes a pattern stay one zoom step behind even after the
  // crossfade has completed.
  const pixelRatio = uint16[o + 9];
  if (pixelRatio <= 0) {
    return null;
  }
  return {
    tlbr: [uint16[o + 4], uint16[o + 5], uint16[o + 6], uint16[o + 7]],
    pixelRatio,
  };
}

/**
 * Per-vertex pattern UVs in repeat units (fragment shader applies fract() and
 * maps through the atlas rect). A tile's pattern repeats every
 * patternSizePx tile pixels, so the UV is linear in the layout vertex.
 *
 * @param positions layout vertices, 2 components each
 * @param rect pattern atlas rect + pixel ratio
 * @param tileID optional tile id used to put the coordinates in world pixel
 * space. Without it the function retains the local-tile behavior used by
 * callers that only need to inspect the linear mapping.
 * @returns 2 floats per vertex
 */
export function patternUVs(positions: Float64Array, rect: PatternAtlasRect, tileID?: TileID, zoom?: number): Float32Array {
  const patternSizeX = (rect.tlbr[2] - rect.tlbr[0]) / rect.pixelRatio;
  const patternSizeY = (rect.tlbr[3] - rect.tlbr[1]) / rect.pixelRatio;
  const coordinates = tileID
    ? patternTileCoordinates(tileID, rect, zoom ?? ('overscaledZ' in tileID ? tileID.overscaledZ : tileID.z))
    : { scale: 1, offset: [0, 0] };
  const tileUnitsToPixels = TILE_SIZE_PX / EXTENT * coordinates.scale;
  // Reduce the shared tile origin in double precision before uploading UVs.
  // Keep each vertex's local repeats continuous so triangle interpolation
  // crosses sprite boundaries; wrapping individual vertices would collapse it.
  const out = new Float32Array(positions.length / 2 * 2);
  for (let i = 0; i < positions.length / 2; i++) {
    out[i * 2] = coordinates.offset[0] + positions[i * 2] * tileUnitsToPixels / patternSizeX;
    out[i * 2 + 1] = coordinates.offset[1] + positions[i * 2 + 1] * tileUnitsToPixels / patternSizeY;
  }
  return out;
}

/** Resolves a constant fill-pattern name from a layer's evaluated paint. */
export function constantPatternName(layer: PatternBucket['layers'][number]): string | undefined {
  const constant = constantValue(layer as { paint: { get: (property: string) => unknown } }, `${layer.type}-pattern`) as { to?: unknown } | string | undefined;
  const value = typeof constant === 'string' ? constant : constant?.to;
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string') {
    return value.name;
  }
  return undefined;
}

/** Resolves an ImagePosition for a pattern from an image positions map. */
export function patternPosition(imagePositions: { [name: string]: ImagePosition }, name: string | null): ImagePosition | null {
  return name ? imagePositions[name] ?? null : null;
}

/** Roof planar repeats and wall edge/height repeats share the same tile phase. */
export function extrusionPatternUVs(geometry: ExtrusionPrimitiveGeometry, rect: PatternAtlasRect, tileID: TileID): Float32Array {
  const out = patternUVs(geometry.tilePositions, rect);
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  const patternSizeX = (rect.tlbr[2] - rect.tlbr[0]) / rect.pixelRatio;
  const patternSizeY = (rect.tlbr[3] - rect.tlbr[1]) / rect.pixelRatio;
  // Upstream tileRatio * u_height_factor = -2^floorStyleZoom / (8192 * 8).
  // Encode the canonical scale here; the owner applies its live zoom scale.
  const heightScale = -(2 ** canonical.z) / (EXTENT * 8);
  for (let index = 0; index < geometry.vertexCount; index++) {
    if (geometry.normals[index * 3 + 2] !== 0)
      continue;
    const elevation = geometry.style.base + (geometry.style.height - geometry.style.base) * geometry.topWeights[index];
    out[index * 2] = geometry.edgeDistances[index] * TILE_SIZE_PX / EXTENT / patternSizeX;
    out[index * 2 + 1] = elevation * heightScale / patternSizeY;
  }
  return out;
}
