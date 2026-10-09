import type { PointPrimitive } from 'cesium';
import type { Bucket } from '../../data/bucket';
import type { DashRow } from '../../source/worker-source';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { DashMaterial } from '../line/dash-material';
import type { LineBuildState } from '../line/line-renderer';
import type { Budget } from '../scene/frame-budget';
import type { ExtrusionLighting } from './extrusion-geometry';
import type { TileConversionState, TileRenderResult } from './tile-conversion';
import type { VectorCollection } from './vector-tile-renderer';
import {
  BlendOption,
  BoundingSphere,
  BufferPoint,
  BufferPointCollection,
  BufferPolygon,
  BufferPolygonCollection,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  GeometryInstanceAttribute,
  HeightReference,
  PerInstanceColorAppearance,
  PointPrimitiveCollection,
  PrimitiveCollection,
  PrimitiveType,
  SceneMode,
  ShowGeometryInstanceAttribute,
} from 'cesium';
import { FillExtrusionBucket } from '../../data/bucket-runtime';
import { fillBoundingSphere } from '../geometry/fill-bounding-sphere';
import { GeometryPrimitive } from '../geometry/geometry-primitive';
import { tileBoundingSphere } from '../geometry/tile-bounding-sphere';
import { beginLineBuild, commitLineBuild, discardLineBuild, stepLineBuild } from '../line/line-renderer';
import { registerDrawBatch } from '../scene/draw-batch';
import { iterateExtrusionBucketPrimitives } from './extrusion-geometry';
import { deferredExtrusionLayers, ExtrusionPrimitive } from './extrusion-primitive';
import { circlePaintVisible, constantValue, layerFor, paintRevision } from './feature-attributes';
import { advanceTileConversion, beginTileConversion } from './tile-conversion';

function groupByStyleLayer<T extends { pickObject: { layerId: string } }>(primitives: readonly T[]): Map<string, T[]> {
  const byLayer = new Map<string, T[]>();
  for (const primitive of primitives) {
    const layerId = primitive.pickObject.layerId;
    const layer = byLayer.get(layerId);
    if (layer) {
      layer.push(primitive);
    }
    else {
      byLayer.set(layerId, [primitive]);
    }
  }
  return byLayer;
}

export type TileID = CanonicalTileID | OverscaledTileID;

/**
 * The zoom a tile's content was built for. Solid line strips bake their
 * paint-derived widths at this zoom once per tile; the current camera zoom
 * never re-bakes them (MapLibre re-buffers a line bucket at the tile's own
 * zoom and crossfades tiles instead).
 */
export function tileZoomOf(tileID: TileID): number {
  return 'canonical' in tileID ? tileID.canonical.z : tileID.z;
}
export interface BucketMap { [layerId: string]: Bucket }

/**
 * Resumable per-tile vector build. Dense
 * tiles convert and bake for hundreds of milliseconds, so the publish path
 * spreads them across frames. Fills can commit before the slower line and
 * point tracks, which append to the same generation.
 */
export interface VectorTileBuildInput {
  /** Resume a generation previously reserved for these buckets and this tile. */
  generationId?: number;
  tileId: string;
  buckets: BucketMap;
  tileID: TileID;
  sourceId?: string;
  layerOrder?: ReadonlyMap<string, number>;
  skipLayerIds?: ReadonlySet<string>;
  styleZoom: number;
  mode: SceneMode;
  styleRevision?: number;
  lightRevision?: number;
  dashRows?: Record<string, DashRow>;
}

export interface VectorTileBuildState extends VectorTileBuildInput {
  generationId: number;
  paintBuckets: readonly Bucket[];
  paintRevisions: readonly number[];
  phase: 'convert' | 'polygons' | 'details' | 'lines' | 'extrusions' | 'points' | 'done';
  convert?: TileConversionState;
  result?: TileRenderResult;
  standard?: StandardRenderEntries;
  entries: Array<[string, VectorCollection]>;
  lineBuild?: LineBuildState;
  extrusionBuild?: ExtrusionBuildState;
  polygonBuild?: StandardPolygonBuildState;
  bufferPolygonBuild?: BufferPolygonBuildState;
}

export interface StandardRenderEntries {
  polygons: StandardPolygonEntry[];
  points: PointPrimitive[];
}

export interface StandardPolygonEntry {
  primitive: GeometryPrimitive;
  id: TileRenderResult['polygons'][number]['pickObject'];
  rgba: number;
  show: boolean;
}

export interface VectorBuildContext {
  pixelRatio: number;
  heightReference: HeightReference;
  lighting?: ExtrusionLighting;
  dashMaterial?: DashMaterial;
}

/** Builds detached Cesium geometry while TilePublishQueue owns the in-flight state. */
export class VectorTileBuilder {
  private readonly _context: () => VectorBuildContext;
  private _nextGenerationId = 1;
  private readonly _generations = new WeakMap<BucketMap, Map<number, Pick<VectorTileBuildInput, 'tileId' | 'styleRevision' | 'mode'>>>();

  constructor(context: () => VectorBuildContext) {
    this._context = context;
  }

  /**
   * Start a budgeted vector build. Detached collections enter the scene only
   * at the fill and final publication boundaries.
   */
  begin(input: VectorTileBuildInput): VectorTileBuildState {
    let generationId = input.generationId;
    if (generationId === undefined) {
      generationId = this._nextGenerationId++;
      let generations = this._generations.get(input.buckets);
      if (!generations) {
        generations = new Map();
        this._generations.set(input.buckets, generations);
      }
      generations.set(generationId, { tileId: input.tileId, styleRevision: input.styleRevision, mode: input.mode });
    }
    else {
      const generation = this._generations.get(input.buckets)?.get(generationId);
      if (!generation || generation.tileId !== input.tileId
        || generation.styleRevision !== input.styleRevision || generation.mode !== input.mode) {
        throw new Error('Cannot resume a vector generation with different tile, buckets, style or scene mode');
      }
    }
    const paintBuckets = [...new Set(Object.values(input.buckets))];
    return {
      ...input,
      generationId,
      paintBuckets,
      // Conversion and Native preparation can span feature-state updates.
      // Keep the revisions that preceded construction, not the commit's values.
      paintRevisions: paintBuckets.map(paintRevision),
      phase: 'convert',
      entries: [],
    };
  }

  /**
   * Advance a vector build while budget allows; true when every track is
   * built. Each call advances at least one unit (a track or a line feature)
   * even when its budget is spent, preventing livelock.
   */
  step(state: VectorTileBuildState, budget: Budget): boolean {
    const context = this._context();
    // Later phases yield on a spent budget, but the first unit attempted per
    // call always runs: a zero budget stalls the build but never livelocks
    // it (single oversized units can still overrun — see stepLineBuild).
    let progressed = false;
    const yieldable = (): boolean => {
      if (budget.exhausted && progressed) {
        return true;
      }
      progressed = true;
      return false;
    };
    if (state.phase === 'convert') {
      state.convert ??= beginTileConversion(
        state.buckets,
        state.tileID,
        state.generationId,
        state.sourceId,
        state.layerOrder,
        state.skipLayerIds,
        state.styleZoom,
        state.mode,
      );
      if (!advanceTileConversion(state.convert, budget, 'surface')) {
        return false;
      }
      state.result = state.convert.result;
      state.phase = 'polygons';
      progressed = true;
    }
    if (state.phase === 'polygons') {
      if (yieldable()) {
        return false;
      }
      const result = state.result!;
      if (state.mode !== SceneMode.SCENE3D) {
        state.standard ??= { polygons: [], points: [] };
        state.polygonBuild ??= beginStandardPolygonBuild(result.polygons, state.tileId, state.mode);
        if (!stepStandardPolygonBuild(state.polygonBuild, budget)) {
          return false;
        }
        const polygons = finishStandardPolygonBuild(state.polygonBuild);
        if (polygons) {
          state.standard.polygons = polygons.entries;
          state.entries.push(['polygons', polygons.collection]);
        }
        state.polygonBuild = undefined;
      }
      else if (result.polygons.length > 0) {
        state.bufferPolygonBuild ??= beginBufferPolygonBuild(result.polygons, state.tileID, state.tileId, context.heightReference);
        if (!stepBufferPolygonBuild(state.bufferPolygonBuild, budget))
          return false;
        state.entries.push(...state.bufferPolygonBuild.entries);
        state.bufferPolygonBuild = undefined;
      }
      // The completed track owns these inputs; details never rescan fills.
      result.polygons = [];
      state.phase = 'details';
      // Yield even on tiles without fills: publication advances the whole
      // surface queue before allowing any tile's detail conversion to run.
      return false;
    }
    if (state.phase === 'details') {
      if (!advanceTileConversion(state.convert!, budget)) {
        return false;
      }
      state.convert = undefined;
      state.phase = 'lines';
    }
    if (state.phase === 'lines') {
      const result = state.result!;
      if (result.linePrimitives.length > 0) {
        const planar = state.mode !== SceneMode.SCENE3D;
        state.lineBuild ??= beginLineBuild(
          result.linePrimitives,
          state.buckets,
          state.tileId,
          state.tileID,
          state.generationId,
          state.styleZoom,
          planar,
          context.dashMaterial ? { material: context.dashMaterial, rows: state.dashRows } : undefined,
        );
        if (!stepLineBuild(state.lineBuild, budget)) {
          return false;
        }
        const lines = commitLineBuild(state.lineBuild);
        if (lines) {
          state.entries.push(['lines', lines]);
        }
        state.lineBuild = undefined;
      }
      state.phase = 'extrusions';
      // A completed line owner can enter Native preparation while the
      // remaining vector tracks continue on later build admissions.
      if (state.entries.some(([kind]) => kind === 'lines'))
        return false;
      // The lines phase always advances its own stepper by at least one
      // feature, so later phases may yield from here on.
      progressed = true;
    }
    if (state.phase === 'extrusions') {
      state.extrusionBuild ??= beginExtrusionBuild(
        state.buckets,
        state.tileID,
        state.tileId,
        state.generationId,
        state.styleZoom,
        context.lighting,
        state.skipLayerIds,
      );
      if (!stepExtrusionBuild(state.extrusionBuild, budget)) {
        return false;
      }
      const extrusions = finishExtrusionBuild(state.extrusionBuild);
      if (extrusions) {
        state.entries.push(['extrusions', extrusions]);
      }
      state.extrusionBuild = undefined;
      state.phase = 'points';
    }
    if (state.phase === 'points') {
      if (yieldable()) {
        return false;
      }
      const result = state.result!;
      if (state.mode === SceneMode.SCENE3D && result.points.length > 0) {
        for (const [layerId, points] of groupByStyleLayer(result.points)) {
          const collection = buildPointCollection(points, state.tileID);
          registerDrawBatch(collection, { layerId, tileId: state.tileId, kind: 'circle' });
          state.entries.push([`points:${layerId}`, collection]);
        }
      }
      else if (state.standard) {
        const points = buildStandardPoints(result.points, state.tileId);
        if (points) {
          state.standard.points = points.entries;
          state.entries.push(['points', points.collection]);
        }
      }
      result.points = [];
      state.phase = 'done';
    }
    return true;
  }

  /**
   * Discard an unfinished build, destroying the collections it staged.
   *
   * {@link step} pushes each finished track's collection straight
   * into `state.entries`, so an abandoned build owns real Cesium buffers that
   * the scene never received and no map references. Without this they leak
   * for the lifetime of the context. A committed build must not be passed
   * here: its collections are registered and owned by the store.
   */
  discard(state: VectorTileBuildState): void {
    for (const [, collection] of state.entries) {
      collection.destroy();
    }
    state.entries = [];
    state.standard = undefined;
    if (state.lineBuild) {
      discardLineBuild(state.lineBuild);
    }
    state.lineBuild = undefined;
    state.extrusionBuild?.collection.destroy();
    state.extrusionBuild = undefined;
    state.polygonBuild?.collection.destroy();
    state.polygonBuild = undefined;
    if (state.bufferPolygonBuild) {
      state.bufferPolygonBuild.iterator.return();
      for (const [, collection] of state.bufferPolygonBuild.entries)
        collection.destroy();
      state.bufferPolygonBuild = undefined;
    }
    state.convert = undefined;
    state.result = undefined;
  }
}

export function buildExtrusionCollection(
  buckets: BucketMap,
  tileID: TileID,
  tileId: string,
  generationId: number,
  zoom: number,
  lighting?: ExtrusionLighting,
): PrimitiveCollection | undefined {
  const state = beginExtrusionBuild(buckets, tileID, tileId, generationId, zoom, lighting);
  stepExtrusionBuild(state, { exhausted: false });
  return finishExtrusionBuild(state);
}

interface ExtrusionBuildState {
  collection: PrimitiveCollection;
  hasSourceGeometry: boolean;
  iterator: Generator<void>;
}

function beginExtrusionBuild(
  buckets: BucketMap,
  tileID: TileID,
  tileId: string,
  generationId: number,
  zoom: number,
  lighting?: ExtrusionLighting,
  skipLayerIds?: ReadonlySet<string>,
): ExtrusionBuildState {
  const collection = new PrimitiveCollection();
  return {
    collection,
    // Zero opacity skips extraction, but its source still needs an owner so
    // live paint can build it later without republishing the tile.
    hasSourceGeometry: Object.entries(buckets).some(([layerId, bucket]) => !skipLayerIds?.has(layerId)
      && bucket instanceof FillExtrusionBucket
      && bucket.geometryRanges.length > 0
      && bucket.layoutVertexArray.length > 0
      && bucket.indexArray.length > 0),
    iterator: appendExtrusions(collection, buckets, tileID, tileId, generationId, zoom, lighting, skipLayerIds),
  };
}

function stepExtrusionBuild(state: ExtrusionBuildState, budget: Budget): boolean {
  do {
    if (state.iterator.next().done) {
      return true;
    }
  } while (!budget.exhausted);
  return false;
}

function finishExtrusionBuild(state: ExtrusionBuildState): PrimitiveCollection | undefined {
  if (state.collection.length === 0 && !state.hasSourceGeometry) {
    state.collection.destroy();
    return undefined;
  }
  return state.collection;
}

function* appendExtrusions(
  collection: PrimitiveCollection,
  buckets: BucketMap,
  tileID: TileID,
  tileId: string,
  generationId: number,
  zoom: number,
  lighting?: ExtrusionLighting,
  skipLayerIds?: ReadonlySet<string>,
): Generator<void> {
  for (const layerId in buckets) {
    if (skipLayerIds?.has(layerId)) {
      continue;
    }
    const bucket = buckets[layerId];
    if (!(bucket instanceof FillExtrusionBucket)) {
      continue;
    }
    // A layer whose opacity evaluates to zero paints nothing; MapLibre skips
    // the whole layer, and so must we - otherwise every feature still builds
    // geometry, a GpuMemory entry and pick ids for an invisible layer.
    if (constantValue(layerFor(bucket, layerId), 'fill-extrusion-opacity') === 0) {
      if (bucket.geometryRanges.length > 0 && bucket.indexArray.length > 0) {
        const deferred = deferredExtrusionLayers.get(collection);
        if (deferred)
          deferred.push(layerId);
        else deferredExtrusionLayers.set(collection, [layerId]);
      }
      continue;
    }
    const instances: GeometryInstance[] = [];
    // Cesium owns projection and morphing. Retain globe topology even when
    // the first upload happens in a planar mode.
    for (const primitive of iterateExtrusionBucketPrimitives(bucket, tileID, layerId, SceneMode.SCENE3D, zoom, lighting, 'solid')) {
      if (!primitive) {
        yield;
        continue;
      }
      if (primitive.triangles.length === 0 || primitive.vertexCount === 0) {
        yield;
        continue;
      }
      const attributes = {
        position: new GeometryAttribute({
          componentDatatype: ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: primitive.positions,
        }),
        a_extrusionNormal: new GeometryAttribute({
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: primitive.normals,
        }),
        a_extrusionTop: new GeometryAttribute({
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 1,
          values: primitive.topWeights,
        }),
        color: undefined,
        st: undefined,
        normal: undefined,
        bitangent: undefined,
        tangent: undefined,
      };
      const geometry = new Geometry({
        attributes,
        indices: primitive.triangles,
        primitiveType: PrimitiveType.TRIANGLES,
        boundingSphere: BoundingSphere.fromVertices(primitive.positions),
      });
      instances.push(new GeometryInstance({
        geometry,
        id: { type: 'extrusion', tileId, layerId, featureIndex: primitive.featureIndex, generationId },
        attributes: {
          extrusionColor: new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 4,
            value: [primitive.style.color.red, primitive.style.color.green, primitive.style.color.blue, primitive.style.color.alpha],
          }),
          extrusionShape: new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            value: [primitive.style.base, primitive.style.height, primitive.style.verticalGradient ? 1 : 0],
          }),
        },
      }));
      yield;
    }
    if (instances.length > 0) {
      const primitive = new ExtrusionPrimitive(instances, lighting);
      registerDrawBatch(primitive, { layerId, tileId, kind: 'extrusion' });
      collection.add(primitive);
    }
  }
}

function surfaceGeometry(primitive: TileRenderResult['polygons'][number]): Geometry {
  // Only 'position' may be present. Cesium's geometry pipeline reads
  // values.length on every entry of attributes for the 2D and Columbus view
  // projections, so an explicitly undefined entry throws there and stops the
  // whole scene render.
  return new Geometry({
    attributes: {
      position: new GeometryAttribute({
        componentDatatype: ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: primitive.positions,
      }),
    },
    indices: primitive.triangles,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(primitive.positions),
  } as never);
}

function surfaceVertexShader(morph: boolean): string {
  return `
in vec3 position2DHigh;
in vec3 position2DLow;
${morph ? 'in vec3 a_positionHigh;\nin vec3 a_positionLow;' : ''}
in vec4 color;
in float batchId;
out vec4 v_color;

void main()
{
    vec4 p = czm_translateRelativeToEye(position2DHigh.zxy * 65536.0, position2DLow.zxy);
${morph
  ? `    p = czm_columbusViewMorph(p,
        czm_translateRelativeToEye(a_positionHigh * 65536.0, a_positionLow), czm_morphTime);`
  : ''}
    v_color = color;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;
}

function standardPolygonPrimitive(instances: GeometryInstance[], mode: SceneMode): GeometryPrimitive {
  const morph = mode === SceneMode.MORPHING;
  return new GeometryPrimitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({
      // Alpha can change with a data/zoom expression after construction. Keep
      // blending enabled for the shared primitive so a later translucent
      // value is not silently rendered as opaque.
      translucent: true,
      flat: true,
      faceForward: true,
      closed: false,
      vertexShaderSource: surfaceVertexShader(morph),
    }),
    compressVertices: true,
    vertexCacheOptimize: true,
  }, morph ? 'surface-morph' : 'surface-planar');
}

function standardPointCollection(
  points: TileRenderResult['points'],
): { collection: PointPrimitiveCollection; entries: PointPrimitive[] } | undefined {
  if (points.length === 0) {
    return undefined;
  }
  const collection = new PointPrimitiveCollection({ blendOption: BlendOption.OPAQUE_AND_TRANSLUCENT });
  const entries: PointPrimitive[] = [];
  for (const primitive of points) {
    const point = collection.add({
      position: primitive.position,
      pixelSize: Math.max(1, Math.min(255, primitive.material.size)),
      color: Color.clone(primitive.material.color),
      outlineColor: Color.clone(primitive.material.outlineColor),
      outlineWidth: Math.max(0, Math.min(255, primitive.material.outlineWidth)),
      id: primitive.pickObject,
      show: circlePaintVisible(primitive.material.color, primitive.material.outlineColor, primitive.material.outlineWidth),
    });
    entries.push(point);
  }
  return { collection, entries };
}

interface StandardPolygonBuildState {
  collection: PrimitiveCollection;
  entries: StandardPolygonEntry[];
  iterator: Generator<void>;
}

function beginStandardPolygonBuild(
  polygons: TileRenderResult['polygons'],
  tileId: string,
  mode: SceneMode,
): StandardPolygonBuildState {
  const collection = new PrimitiveCollection();
  const entries: StandardPolygonEntry[] = [];
  return { collection, entries, iterator: appendStandardPolygons(collection, entries, polygons, tileId, mode) };
}

function stepStandardPolygonBuild(state: StandardPolygonBuildState, budget: Budget): boolean {
  do {
    if (state.iterator.next().done) {
      return true;
    }
  } while (!budget.exhausted);
  return false;
}

function finishStandardPolygonBuild(state: StandardPolygonBuildState): StandardPolygonBuildState | undefined {
  if (state.collection.length === 0) {
    state.collection.destroy();
    return undefined;
  }
  return state;
}

function* appendStandardPolygons(
  collection: PrimitiveCollection,
  entries: StandardPolygonEntry[],
  polygons: TileRenderResult['polygons'],
  tileId: string,
  mode: SceneMode,
): Generator<void> {
  const byLayer = new Map<string, TileRenderResult['polygons']>();
  for (const polygon of polygons) {
    const layerId = polygon.pickObject.layerId;
    const layer = byLayer.get(layerId);
    if (layer) {
      layer.push(polygon);
    }
    else {
      byLayer.set(layerId, [polygon]);
    }
    yield;
  }
  // Native's two Float64 headers plus 21 geometry and 19 instance metadata
  // slots per polygon, all position values and indices. Keep the same packed
  // input boundary while preparing each feature on the existing frame budget.
  const maximumBytes = 512 * 1024;
  for (const [layerId, layer] of byLayer) {
    let bytes = 16;
    let instances: GeometryInstance[] = [];
    let primitive: GeometryPrimitive | undefined;
    for (const polygon of layer) {
      const inputBytes = 8 * (40 + polygon.positions.length + polygon.triangles.length);
      if (instances.length > 0 && bytes + inputBytes > maximumBytes) {
        registerDrawBatch(primitive!, { layerId, tileId, kind: 'fill' });
        instances = [];
        primitive = undefined;
        bytes = 16;
      }
      if (!primitive) {
        primitive = standardPolygonPrimitive(instances, mode);
        // Own partial as well as sealed batches until the complete track is
        // handed off. Discard can then destroy every unpublished primitive.
        collection.add(primitive);
      }
      const show = polygon.material.color.alpha > 0;
      instances.push(new GeometryInstance({
        geometry: surfaceGeometry(polygon),
        id: polygon.pickObject,
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(polygon.material.color),
          // Native needs the full attribute object with its packed value.
          show: new ShowGeometryInstanceAttribute(show),
        },
      }));
      entries.push({ primitive, id: polygon.pickObject, rgba: polygon.material.color.toRgba(), show });
      bytes += inputBytes;
      yield;
    }
    // Registration snapshots input memory, so seal only once all instance
    // payloads are present. Partial batches remain owned by the collection.
    if (primitive) {
      registerDrawBatch(primitive, { layerId, tileId, kind: 'fill' });
    }
  }
}

function buildStandardPoints(
  points: TileRenderResult['points'],
  tileId: string,
): { collection: PrimitiveCollection; entries: PointPrimitive[] } | undefined {
  if (points.length === 0) {
    return undefined;
  }
  const collection = new PrimitiveCollection();
  const entries: PointPrimitive[] = [];
  for (const [layerId, layer] of groupByStyleLayer(points)) {
    const built = standardPointCollection(layer);
    if (built) {
      registerDrawBatch(built.collection, { layerId, tileId, kind: 'circle' });
      collection.add(built.collection);
      entries.push(...built.entries);
    }
  }
  return { collection, entries };
}

interface BufferPolygonBuildState {
  entries: Array<[string, BufferPolygonCollection]>;
  iterator: Generator<void, void>;
}

function beginBufferPolygonBuild(polygons: TileRenderResult['polygons'], tileID: TileID, tileId: string, heightReference: HeightReference): BufferPolygonBuildState {
  const entries: BufferPolygonBuildState['entries'] = [];
  return { entries, iterator: appendBufferPolygonCollections(polygons, tileID, tileId, heightReference, entries) };
}

function stepBufferPolygonBuild(state: BufferPolygonBuildState, budget: Budget): boolean {
  do {
    if (state.iterator.next().done)
      return true;
  } while (!budget.exhausted);
  return false;
}

function* appendBufferPolygonCollections(polygons: TileRenderResult['polygons'], tileID: TileID, tileId: string, heightReference: HeightReference, entries: BufferPolygonBuildState['entries']): Generator<void, void> {
  const layers = new Map<string, TileRenderResult['polygons']>();
  for (let index = 0; index < polygons.length; index++) {
    const primitive = polygons[index];
    const layerId = primitive.pickObject.layerId;
    let layer = layers.get(layerId);
    if (!layer)
      layers.set(layerId, layer = []);
    layer.push(primitive);
    if ((index + 1) % 64 === 0)
      yield;
  }
  for (const [layerId, layer] of layers) {
    yield* appendBufferPolygonCollection(layer, tileID, tileId, layerId, heightReference, entries);
  }
}

function* appendBufferPolygonCollection(polygons: TileRenderResult['polygons'], tileID: TileID, tileId: string, layerId: string, heightReference: HeightReference, entries: BufferPolygonBuildState['entries']): Generator<void, void> {
  let vertexCount = 0;
  let holeCount = 0;
  let triangleCount = 0;
  let opaque = true;
  for (let index = 0; index < polygons.length; index++) {
    const primitive = polygons[index];
    vertexCount += primitive.positions.length / 3;
    holeCount += primitive.holes.length;
    triangleCount += primitive.triangles.length / 3;
    opaque &&= primitive.material.color.alpha >= 1;
    if ((index + 1) % 64 === 0)
      yield;
  }
  const clamped = heightReference === HeightReference.CLAMP_TO_GROUND
    || heightReference === HeightReference.CLAMP_TO_TERRAIN
    || heightReference === HeightReference.CLAMP_TO_3D_TILE;
  const boundingVolume = clamped ? tileBoundingSphere(tileID) : yield* fillBoundingSphere(polygons);
  const collection = new BufferPolygonCollection({
    allowPicking: true,
    blendOption: opaque ? BlendOption.OPAQUE : BlendOption.TRANSLUCENT,
    // Non-draped 3D fills use their actual content. Both precomputed paths
    // disable Native's per-update scan over all vertices.
    boundingVolume,
    heightReference,
    primitiveCountMax: polygons.length,
    vertexCountMax: vertexCount,
    holeCountMax: holeCount,
    triangleCountMax: triangleCount,
  });
  registerDrawBatch(collection, { layerId, tileId, kind: 'fill' });
  // This build owns the allocation until all layers finish and transfer it.
  entries.push([`polygons:${layerId}`, collection]);
  // One flyweight per build: add() copies the payload into the collection
  // buffers, so per-feature instances are pure garbage.
  const scratch = new BufferPolygon();
  for (const primitive of polygons) {
    collection.add({
      positions: primitive.positions,
      holes: new Uint32Array(primitive.holes),
      triangles: primitive.triangles,
      material: primitive.material,
      pickObject: primitive.pickObject,
    }, scratch);
    yield;
  }
}

function buildPointCollection(points: TileRenderResult['points'], tileID: TileID): BufferPointCollection {
  const collection = new BufferPointCollection({
    allowPicking: true,
    // Native's circle shader encodes edge coverage in alpha even for opaque paint.
    blendOption: BlendOption.TRANSLUCENT,
    // Precomputed tile sphere: disables Cesium's per-update fromVertices
    // scan over every vertex (see tile-bounding-sphere.ts).
    boundingVolume: tileBoundingSphere(tileID),
    primitiveCountMax: points.length,
  });
  // One flyweight per build (see buildPolygonCollection).
  const scratch = new BufferPoint();
  for (const primitive of points) {
    collection.add({
      position: primitive.position,
      material: primitive.material,
      pickObject: primitive.pickObject,
      show: circlePaintVisible(primitive.material.color, primitive.material.outlineColor, Math.floor(primitive.material.outlineWidth)),
    }, scratch);
  }
  return collection;
}
