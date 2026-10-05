import type { SceneMode } from 'cesium';
import type { Bucket } from '../../data/bucket';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { Budget } from '../scene/frame-budget';
import { BufferPointMaterial, BufferPolygonMaterial, Cartesian3, Color } from 'cesium';
import { CircleBucket, FillBucket, FillExtrusionBucket, LineBucket } from '../../data/bucket-runtime';
import { surfaceGranularity } from '../geometry/surface-subdivision';
import { WGS84_A, WGS84_F } from '../geometry/tile-to-ecef';
import { RASTER_SURFACE_OFFSET_M } from '../raster/raster-geometry';
import { MORPHING, SCENE3D } from '../scene/scene-mode';
import {
  circleBucketPrimitives,
  fillBucketPrimitives,
  fillOutlinePaths,
  lineBucketPrimitives,
} from './bucket-geometry';
import {
  circleStyleForFeature,
  fillStyleForFeature,
} from './feature-attributes';

type TileID = CanonicalTileID | OverscaledTileID;

/**
 * Rendering inputs for one Cesium Buffer*Collection primitive, produced from
 * a bucket. The renderer layer (VectorTileRenderer) turns these into
 * collection.add() calls; the pure layer is what tests assert against.
 */

export interface PolygonRenderPrimitive {
  positions: Float64Array;
  ringVertexCount: number;
  holes: number[];
  triangles: Uint32Array;
  material: BufferPolygonMaterial;
  pickObject: TilePickObject;
}

export interface PointRenderPrimitive {
  position: Cartesian3;
  material: BufferPointMaterial;
  pickObject: TilePickObject;
}

export interface TilePickObject {
  tileId: string;
  layerId: string;
  featureIndex: number;
  generationId: number;
}

export interface TileRenderResult {
  polygons: PolygonRenderPrimitive[];
  points: PointRenderPrimitive[];
  /**
   * Lines (line layer features and fill outline rings) for the
   * antialiased line track. Style evaluation and the PolylineGeometry
   * building happen on the consumer side, at the zoom bucket boundary.
   */
  linePrimitives: import('../line/line-renderer').LinePrimitiveSource[];
  /** Style layers that produced at least one supported render primitive. */
  layerIds: string[];
}

export const LAYER_RADIAL_EPSILON_METERS = 0.01;
const OUTLINE_RADIAL_EPSILON_METERS = 0.001;

// Share shifted geometry between family layers within one build. The source
// tile can outlive many builds, so the cache belongs to the build, not its key.
export type RadialOffsetCache = WeakMap<Float64Array, Map<number, Float64Array>>;

export function radialOffsetPositions(positions: Float64Array, meters: number, radialOffsetCache: RadialOffsetCache): Float64Array {
  if (meters === 0) {
    return positions;
  }
  const cached = radialOffsetCache.get(positions)?.get(meters);
  if (cached) {
    return cached;
  }
  const shifted = positions.slice();
  // Closed-form ellipsoid normal: proportional to (x/a², y/a², z/b²).
  // Cesium's geodeticSurfaceNormal iterates to the same direction; the
  // iteration is pure overhead for a ~1m layer offset, and this runs once
  // per (layer, primitive) on the publish hot path.
  const a2 = WGS84_A * WGS84_A;
  const e2 = WGS84_F * (2 - WGS84_F);
  const b2 = a2 * (1 - e2);
  for (let i = 0; i < shifted.length; i += 3) {
    const nx = shifted[i] / a2;
    const ny = shifted[i + 1] / a2;
    const nz = shifted[i + 2] / b2;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    shifted[i] += (nx / length) * meters;
    shifted[i + 1] += (ny / length) * meters;
    shifted[i + 2] += (nz / length) * meters;
  }
  let offsets = radialOffsetCache.get(positions);
  if (!offsets) {
    offsets = new Map();
    radialOffsetCache.set(positions, offsets);
  }
  offsets.set(meters, shifted);
  return shifted;
}

export function layerRadialOffsetMeters(layerId: string, layerOrder?: ReadonlyMap<string, number>): number {
  return RASTER_SURFACE_OFFSET_M
    + (layerOrder?.get(layerId) ?? 0) * LAYER_RADIAL_EPSILON_METERS;
}

function radialOffsetPoint(position: Cartesian3, meters: number): Cartesian3 {
  if (meters === 0) {
    return position;
  }
  const a2 = WGS84_A * WGS84_A;
  const e2 = WGS84_F * (2 - WGS84_F);
  const b2 = a2 * (1 - e2);
  const nx = position.x / a2;
  const ny = position.y / a2;
  const nz = position.z / b2;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return new Cartesian3(
    position.x + (nx / length) * meters,
    position.y + (ny / length) * meters,
    position.z + (nz / length) * meters,
  );
}

function toColor(r: number, g: number, b: number, a: number): Color {
  const clamp = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return new Color(clamp(r), clamp(g), clamp(b), clamp(a));
}

function pickObject(tileId: string, layerId: string, featureIndex: number, generationId: number): TilePickObject {
  return { tileId, layerId, featureIndex, generationId };
}

/**
 * Convert a tile's buckets into per-primitive rendering inputs for the
 * Buffer collection track (fill / line / circle).
 */
type ConvertBranch = 'fill' | 'line' | 'circle';

interface ConvertFamily {
  bucket: Bucket;
  renderLayerIds: string[];
  branch: ConvertBranch;
  tileId: string;
  workerGeometry?: import('../../data/projected-geometry').ProjectedBucketGeometry;
  fill?: import('../../data/projected-geometry').ProjectedBucketGeometry['fill'];
  line?: import('../../data/projected-geometry').ProjectedBucketGeometry['lines'];
  circle?: ReturnType<typeof circleBucketPrimitives>;
}

/**
 * Resumable bucket conversion. A dense tile evaluates thousands of features;
 * slicing by feature keeps publish frames under budget. All accumulation is
 * append-only, so suspending and resuming never duplicates or drops a
 * feature.
 */
export interface TileConversionState {
  generationId: number;
  families: ConvertFamily[];
  familyIndex: number;
  layerIndex: number;
  primIndex: number;
  tileID: TileID;
  layerOrder?: ReadonlyMap<string, number>;
  styleZoom?: number;
  mode?: SceneMode;
  radialOffsetCache?: RadialOffsetCache;
  result: TileRenderResult;
}

export function beginTileConversion(
  buckets: { [layerId: string]: Bucket },
  tileID: TileID,
  generationId: number,
  sourceId?: string,
  layerOrder?: ReadonlyMap<string, number>,
  skipLayerIds?: ReadonlySet<string>,
  styleZoom?: number,
  mode?: SceneMode,
): TileConversionState {
  const result: TileRenderResult = { polygons: [], points: [], linePrimitives: [], layerIds: [] };
  // A worker bucket can be shared by several style-layer ids. Build the
  // reverse index once instead of searching the complete bucket map for every
  // family. With many shared families the old Object.keys(...).filter(...)
  // loop turned tile conversion into O(layerCount * familyCount).
  const bucketLayers = new Map<Bucket, string[]>();
  for (const layerId of Object.keys(buckets)) {
    if (skipLayerIds?.has(layerId)) {
      continue;
    }
    const bucket = buckets[layerId];
    const layerIds = bucketLayers.get(bucket);
    if (layerIds) {
      layerIds.push(layerId);
    }
    else {
      bucketLayers.set(bucket, [layerId]);
    }
  }

  const families: ConvertFamily[] = [];
  const canonicalZoom = 'canonical' in tileID ? tileID.canonical.z : tileID.z;
  for (const [bucket, renderLayerIds] of bucketLayers) {
    // Hidden/pattern-only bucket families must not pay the ECEF conversion and
    // tessellation cost just to be discarded below.
    if (renderLayerIds.length === 0) {
      continue;
    }
    if (bucket instanceof FillBucket
      || bucket instanceof LineBucket
      || bucket instanceof CircleBucket
      || bucket instanceof FillExtrusionBucket) {
      result.layerIds.push(...renderLayerIds);
    }
    const branch: ConvertBranch | undefined = bucket instanceof FillBucket
      ? 'fill'
      : bucket instanceof LineBucket
        ? 'line'
        : bucket instanceof CircleBucket
          ? 'circle'
          : undefined;
    // Buildings use the same Native extrusion track in every scene mode.
    if (branch === undefined)
      continue;
    // Fills and lines share the worker mesh when both modes choose the same
    // subdivision. Coarser globe meshes still need their planar version.
    const sameSurfaceMesh = (branch === 'fill' || branch === 'line') && mode !== undefined
      && surfaceGranularity(branch, canonicalZoom, mode) === surfaceGranularity(branch, canonicalZoom, SCENE3D);
    const sameWorkerGeometry = mode === SCENE3D || mode === MORPHING
      || branch === 'circle'
      || sameSurfaceMesh;
    families.push({
      bucket,
      renderLayerIds,
      branch,
      tileId: sourceId ? `${sourceId}/${tileID.key}` : tileID.key,
      // Geometry conversion is independent of the family member's paint. Keep
      // one ECEF extraction per bucket and reuse it for every mapped layer.
      // The worker precomputes extraction when it parses the tile. Look up
      // only compatible meshes; untouched families never pay conversion.
      workerGeometry: sameWorkerGeometry ? bucket.projectedGeometry : undefined,
    });
  }
  families.sort((a, b) => Number(b.branch === 'fill') - Number(a.branch === 'fill'));
  return { families, familyIndex: 0, layerIndex: 0, primIndex: 0, tileID, layerOrder, styleZoom, mode, generationId, result, radialOffsetCache: new WeakMap() };
}

/**
 * Convert features while budget allows; true when the requested stage completes.
 * Fill families precede other content so their collections can publish without
 * extracting road or point geometry.
 * Each call converts at least one feature (or finishes), so a zero budget
 * stalls but never livelocks.
 */
export function advanceTileConversion(state: TileConversionState, budget: Budget, stage: 'surface' | 'all' = 'all'): boolean {
  let first = true;
  while (state.familyIndex < state.families.length) {
    const family = state.families[state.familyIndex];
    if (stage === 'surface' && family.branch !== 'fill') {
      return true;
    }
    if (!first && budget.exhausted) {
      return false;
    }
    first = false;
    if (state.layerIndex >= family.renderLayerIds.length) {
      state.familyIndex++;
      state.layerIndex = 0;
      state.primIndex = 0;
      continue;
    }
    const layerId = family.renderLayerIds[state.layerIndex];
    const prims = convertFamilyPrims(state, family);
    if (state.primIndex >= prims.length) {
      state.layerIndex++;
      state.primIndex = 0;
      continue;
    }
    convertOneFeature(state, family, layerId, prims[state.primIndex]);
    state.primIndex++;
  }
  state.radialOffsetCache = undefined;
  return true;
}

/** Lazily resolve a family's primitive list for one layer (cached per family). */
function convertFamilyPrims(
  state: TileConversionState,
  family: ConvertFamily,
): Array<{ featureIndex: number }> {
  const { bucket } = family;
  if (family.branch === 'fill') {
    return family.fill ??= bucket instanceof FillBucket
      ? (family.workerGeometry?.fill ?? fillBucketPrimitives(bucket, state.tileID, state.mode))
      : [];
  }
  if (family.branch === 'line') {
    return family.line ??= bucket instanceof LineBucket
      ? (family.workerGeometry?.lines ?? lineBucketPrimitives(bucket, state.tileID, state.mode))
      : [];
  }
  if (family.branch === 'circle') {
    return family.circle ??= bucket instanceof CircleBucket
      ? (family.workerGeometry?.circles ?? circleBucketPrimitives(bucket, state.tileID))
      : [];
  }
  return [];
}

type FillPrimitive = NonNullable<import('../../data/projected-geometry').ProjectedBucketGeometry['fill']>[number];
type LinePrimitive = NonNullable<import('../../data/projected-geometry').ProjectedBucketGeometry['lines']>[number];
type CirclePrimitive = ReturnType<typeof circleBucketPrimitives>[number];

/**
 * Convert a single feature primitive: style evaluation plus the radial
 * layer offset and pick-object bookkeeping. Bodies are the four branches of
 * the old per-family loop, unchanged; the stepper above supplies the loop.
 */
function convertOneFeature(
  state: TileConversionState,
  family: ConvertFamily,
  layerId: string,
  prim: { featureIndex: number },
): void {
  const { bucket } = family;
  const { result } = state;
  // Keep vector and raster layers in one radial ordering. Raster tiles are
  // lifted by RASTER_SURFACE_OFFSET_M to avoid fighting Cesium's globe, so
  // vector ground geometry needs the same base offset when the style places
  // a vector layer above or below a raster layer.
  const layerOffset = layerRadialOffsetMeters(layerId, state.layerOrder);
  const tileId = family.tileId;
  const styleZoom = state.styleZoom;

  if (family.branch === 'fill' && bucket instanceof FillBucket) {
    const primitive = prim as FillPrimitive;
    const style = fillStyleForFeature(bucket, primitive.featureIndex, layerId, styleZoom);
    const shiftedPositions = radialOffsetPositions(primitive.positions, layerOffset, state.radialOffsetCache);
    result.polygons.push({
      positions: shiftedPositions,
      ringVertexCount: primitive.ringVertexCount,
      holes: primitive.holes,
      triangles: primitive.triangles,
      material: new BufferPolygonMaterial({
        color: toColor(style.color.red, style.color.green, style.color.blue, style.color.alpha),
      }),
      pickObject: pickObject(tileId, layerId, primitive.featureIndex, state.generationId),
    });

    // Cesium's BufferPolygonMaterial only stores the fill color; its
    // outline fields are not rendered. Build explicit closed polylines
    // for a declared MapLibre fill outline instead of silently dropping
    // the border. The source polygon's hole offsets delimit each ring, and the
    // line pipeline renders them in every scene mode.
    if (style.outlineWidthPx > 0 && style.outlineColor.alpha > 0) {
      for (const outlinePath of fillOutlinePaths(bucket, primitive, state.tileID)) {
        const outlinePositions = radialOffsetPositions(
          outlinePath.positions,
          layerOffset + OUTLINE_RADIAL_EPSILON_METERS,
          state.radialOffsetCache,
        );
        // Outline paths already contain the closing sample for closed
        // rings. Appending it again creates a zero-length final segment
        // and changes the line geometry at every polygon corner.
        if (outlinePositions.length < 6) {
          continue;
        }
        result.linePrimitives.push({
          layerId,
          featureIndex: primitive.featureIndex,
          positions: outlinePositions,
          tilePositions: outlinePath.tilePositions,
        });
      }
    }
  }
  else if (family.branch === 'line' && bucket instanceof LineBucket) {
    const primitive = prim as LinePrimitive;
    // Live paint can reveal an initially invisible strip in every mode.
    // Keep its centerline; the shader suppresses zero width and opacity.
    result.linePrimitives.push({
      layerId,
      featureIndex: primitive.featureIndex,
      // Keep the shared centerline intact; each layer applies its height
      // in the shader, in projected x or along the world ellipsoid normal.
      positions: primitive.positions,
      tilePositions: primitive.tilePositions,
      offsetMeters: layerOffset,
    });
  }
  else if (family.branch === 'circle' && bucket instanceof CircleBucket) {
    const primitive = prim as CirclePrimitive;
    const style = circleStyleForFeature(bucket, primitive.featureIndex, layerId, styleZoom);
    result.points.push({
      position: radialOffsetPoint(Cartesian3.fromElements(
        primitive.position[0],
        primitive.position[1],
        primitive.position[2],
      ), layerOffset),
      material: new BufferPointMaterial({
        color: toColor(style.color.red, style.color.green, style.color.blue, style.color.alpha),
        outlineColor: toColor(style.outlineColor.red, style.outlineColor.green, style.outlineColor.blue, style.outlineColor.alpha),
        outlineWidth: Math.max(0, Math.min(255, style.outlineWidthPx)),
        size: Math.max(1, Math.min(255, style.sizePx)),
      }),
      pickObject: pickObject(tileId, layerId, primitive.featureIndex, state.generationId),
    });
  }
}
