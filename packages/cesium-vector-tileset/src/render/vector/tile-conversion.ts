import type { SceneMode } from 'cesium';
import type { Bucket } from '../../data/bucket';
import type { CirclePrimitiveGeometry, FillPrimitiveGeometry, LinePrimitiveGeometry, ProjectedGeometryList } from '../../data/projected-geometry';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { Budget } from '../scene/frame-budget';
import type { CircleFeatureStyle } from './feature-attributes';
import { BufferPolygonMaterial, Cartesian3, Color } from 'cesium';
import { CircleBucket, FillBucket, FillExtrusionBucket, LineBucket } from '../../data/bucket-runtime';
import { projectCircleGeometry, projectFillGeometry, projectLineGeometry } from '../../data/projected-geometry-transfer';
import { surfaceGranularity } from '../geometry/surface-subdivision';
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
  style: CircleFeatureStyle;
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
   * antialiased line track. Solid globe strips arrive from the worker;
   * atlas-dependent and scene-specific planar layouts compile on consumption.
   */
  linePrimitives: import('../line/line-renderer').LinePrimitiveSource[];
  /** Style layers that produced at least one supported render primitive. */
  layerIds: string[];
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
  fill?: import('../../data/projected-geometry').ProjectedBucketGeometry['fill'] | FillPrimitiveGeometry[];
  line?: import('../../data/projected-geometry').ProjectedBucketGeometry['lines'];
  circle?: import('../../data/projected-geometry').ProjectedBucketGeometry['circles'];
}

/**
 * Resumable bucket conversion. A dense tile evaluates thousands of features;
 * Feature style and outline extraction run under the build budget; Worker
 * coordinates remain shared with each published layer.
 */
export interface TileConversionState {
  generationId: number;
  families: ConvertFamily[];
  familyIndex: number;
  layerIndex: number;
  primIndex: number;
  featureWork?: Generator<void, number>;
  tileID: TileID;
  styleZoom?: number;
  mode?: SceneMode;
  draped: boolean;
  result: TileRenderResult;
}

export function beginTileConversion(
  buckets: { [layerId: string]: Bucket },
  tileID: TileID,
  generationId: number,
  sourceId?: string,
  skipLayerIds?: ReadonlySet<string>,
  styleZoom?: number,
  mode?: SceneMode,
  draped = false,
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
    if (!(bucket instanceof FillBucket
      || bucket instanceof LineBucket
      || bucket instanceof CircleBucket
      || bucket instanceof FillExtrusionBucket)) {
      continue;
    }
    result.layerIds.push(...renderLayerIds);
    // Buildings use the same Native extrusion track in every scene mode.
    if (bucket instanceof FillExtrusionBucket)
      continue;
    const branch: ConvertBranch = bucket instanceof FillBucket
      ? 'fill'
      : bucket instanceof LineBucket
        ? 'line'
        : 'circle';
    // Fill owns distinct masked planar and clipped globe meshes. Lines share
    // a mesh when both modes choose the same subdivision.
    const sameSurfaceMesh = branch === 'line' && mode !== undefined
      && surfaceGranularity(branch, canonicalZoom, mode) === surfaceGranularity(branch, canonicalZoom, SCENE3D);
    const sameWorkerGeometry = mode === SCENE3D || mode === MORPHING
      || branch === 'circle'
      || (branch === 'fill' && mode !== undefined)
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
  return { families, familyIndex: 0, layerIndex: 0, primIndex: 0, tileID, styleZoom, mode, draped, generationId, result };
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
    const outlineBucket = family.branch === 'fill' && family.bucket instanceof FillBucket ? family.bucket : undefined;
    if (state.primIndex >= prims.length + (outlineBucket?.polygons.length ?? 0)) {
      state.layerIndex++;
      state.primIndex = 0;
      continue;
    }
    // Source outlines remain drawable when clipping removes every fill face.
    // Keep their traversal in this family's existing cooperative cursor.
    state.featureWork ??= outlineBucket && state.primIndex >= prims.length
      ? convertFillOutline(state, outlineBucket, layerId, state.primIndex - prims.length, prims.length)
      : convertOneFeature(state, family, layerId, Array.isArray(prims) ? prims[state.primIndex] : prims.get(state.primIndex));
    let work = state.featureWork.next();
    while (!work.done) {
      if (budget.exhausted)
        return false;
      work = state.featureWork.next();
    }
    state.featureWork = undefined;
    state.primIndex = work.value;
  }
  return true;
}

/** Lazily resolve a family's primitive list for one layer (cached per family). */
function convertFamilyPrims(
  state: TileConversionState,
  family: ConvertFamily,
): ProjectedGeometryList<{ featureIndex: number }> | FillPrimitiveGeometry[] {
  const { bucket } = family;
  if (family.branch === 'fill') {
    return family.fill ??= bucket instanceof FillBucket
      ? state.draped
        ? fillBucketPrimitives(bucket, state.tileID, state.mode, 'drape')
        : ((state.mode !== undefined && state.mode !== SCENE3D && state.mode !== MORPHING ? family.workerGeometry?.fillPlanar : family.workerGeometry?.fill)
          ?? projectFillGeometry(fillBucketPrimitives(bucket, state.tileID, state.mode)))
      : projectFillGeometry([]);
  }
  if (family.branch === 'line') {
    return family.line ??= bucket instanceof LineBucket
      ? (family.workerGeometry?.lines ?? projectLineGeometry(lineBucketPrimitives(bucket, state.tileID, state.mode)))
      : projectLineGeometry([]);
  }
  if (family.branch === 'circle') {
    return family.circle ??= bucket instanceof CircleBucket
      ? (family.workerGeometry?.circles ?? projectCircleGeometry(circleBucketPrimitives(bucket, state.tileID)))
      : projectCircleGeometry([]);
  }
  throw new TypeError('unsupported projected geometry family');
}

type FillPrimitive = FillPrimitiveGeometry;
type LinePrimitive = LinePrimitiveGeometry;
type CirclePrimitive = CirclePrimitiveGeometry;

/**
 * Convert a single feature primitive: style evaluation and pick-object bookkeeping.
 * Ground positions are shared with the Worker; style order belongs to commands.
 */
function* convertOneFeature(
  state: TileConversionState,
  family: ConvertFamily,
  layerId: string,
  prim: { featureIndex: number },
): Generator<void, number> {
  const { bucket } = family;
  const { result } = state;
  const tileId = family.tileId;
  const styleZoom = state.styleZoom;

  if (family.branch === 'fill' && bucket instanceof FillBucket) {
    const primitive = prim as FillPrimitive;
    const style = fillStyleForFeature(bucket, primitive.featureIndex, layerId, styleZoom);
    result.polygons.push({
      positions: primitive.positions,
      ringVertexCount: primitive.ringVertexCount,
      holes: primitive.holes,
      triangles: primitive.triangles,
      material: new BufferPolygonMaterial({
        color: toColor(style.color.red, style.color.green, style.color.blue, style.color.alpha),
      }),
      pickObject: pickObject(tileId, layerId, primitive.featureIndex, state.generationId),
    });
  }
  else if (family.branch === 'line' && bucket instanceof LineBucket) {
    const primitive = prim as LinePrimitive;
    // Live paint can reveal an initially invisible strip in every mode.
    // Keep its centerline; the shader suppresses zero width and opacity.
    result.linePrimitives.push({
      layerId,
      featureIndex: primitive.featureIndex,
      positions: primitive.positions,
      tilePositions: primitive.tilePositions,
      prepared: state.mode === SCENE3D ? primitive.prepared : undefined,
    });
  }
  else if (family.branch === 'circle' && bucket instanceof CircleBucket) {
    const primitive = prim as CirclePrimitive;
    const style = circleStyleForFeature(bucket, primitive.featureIndex, layerId, styleZoom);
    result.points.push({
      position: Cartesian3.fromElements(
        primitive.position[0],
        primitive.position[1],
        primitive.position[2],
      ),
      style,
      pickObject: pickObject(tileId, layerId, primitive.featureIndex, state.generationId),
    });
  }
  return state.primIndex + 1;
}

/** Consume Worker-owned source rings independently of the clipped surface. */
function* convertFillOutline(
  state: TileConversionState,
  bucket: FillBucket,
  layerId: string,
  polygonIndex: number,
  primitiveCount: number,
): Generator<void, number> {
  const polygon = bucket.polygons[polygonIndex];
  const canonical = 'canonical' in state.tileID ? state.tileID.canonical : state.tileID;
  const subdivision = state.mode === undefined ? 1 : surfaceGranularity('fill', canonical.z, state.mode);
  let end = polygonIndex + 1;
  if (subdivision === 1) {
    while (end < bucket.polygons.length && bucket.polygons[end].polygonGroupId === polygon.polygonGroupId)
      end++;
  }
  const style = fillStyleForFeature(bucket, polygon.featureIndex, layerId, state.styleZoom);
  if (style.outlineWidthPx > 0 && style.outlineColor.alpha > 0) {
    for (const path of fillOutlinePaths(bucket, { polygonIndex, subdivision }, state.mode)) {
      // Closed source rings already carry their final closing sample.
      if (path.positions.length < 6)
        continue;
      state.result.linePrimitives.push({ layerId, featureIndex: polygon.featureIndex, positions: path.positions, tilePositions: path.tilePositions });
      yield;
    }
  }
  return primitiveCount + end;
}
