import type { Bucket } from '../../data/bucket';
import type { FeatureIndex } from '../../data/feature-index';
import type { DashRow } from '../../source/worker-source';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { GeometryPrimitive } from '../geometry/geometry-primitive';
import type { DashMaterial } from '../line/dash-material';
import type { LineBuildState } from '../line/line-renderer';
import type { Budget } from '../scene/frame-budget';
import type { ExtrusionLighting } from './extrusion-geometry';
import type { TileConversionState, TileRenderResult } from './tile-conversion';
import type { VectorCollection } from './vector-tile-renderer';
import {
  BlendOption,
  BoundingSphere,
  BufferPolygon,
  BufferPolygonCollection,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  GeometryInstanceAttribute,
  HeightReference,
  PerInstanceColorAppearance,
  PrimitiveCollection,
  PrimitiveType,
  SceneMode,
  ShowGeometryInstanceAttribute,
} from 'cesium';
import { CircleBucket, FillBucket, FillExtrusionBucket } from '../../data/bucket-runtime';
import { CircleCollection } from '../circle/circle-collection';
import { fillBoundingSphere } from '../geometry/fill-bounding-sphere';
import { FillBufferPaint } from '../geometry/fill-buffer-paint';
import { fillCameraPaintOwners } from '../geometry/fill-camera-paint';
import { FILL_TRANSLATION_SHADER, FillGeometryPrimitive } from '../geometry/fill-geometry-primitive';
import { tileBoundingSphere } from '../geometry/tile-bounding-sphere';
import { beginLineBuild, commitLineBuild, discardLineBuild, stepLineBuild } from '../line/line-renderer';
import { LineTileClip, SURFACE_TILE_CLIP_FRAGMENT } from '../line/line-tile-clip';
import { registerDrawBatch, registerTileClip } from '../scene/draw-batch';
import { FeaturePicking } from '../scene/feature-picking';
import { iterateExtrusionBucketPrimitives } from './extrusion-geometry';
import { deferredExtrusionLayers, ExtrusionPrimitive } from './extrusion-primitive';
import { constantValue, layerFor, paintRevision } from './feature-attributes';
import { advanceTileConversion, beginTileConversion } from './tile-conversion';

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
  featureIndex?: FeatureIndex;
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
  circleBuild?: Generator<void>;
}

/** Paint ordinals follow collection storage independently of Native picking objects. */
export const bufferPolygonFeatureIndices = new WeakMap<BufferPolygonCollection, readonly number[]>();

export interface StandardRenderEntries {
  polygons: StandardPolygonEntry[];
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

  private readonly _picking: FeaturePicking;

  private _nextGenerationId = 1;

  private readonly _generations = new WeakMap<BucketMap, Map<number, Pick<VectorTileBuildInput, 'tileId' | 'styleRevision' | 'mode' | 'featureIndex'>>>();

  constructor(context: () => VectorBuildContext, picking = new FeaturePicking()) {
    this._context = context;
    this._picking = picking;
  }

  /**
   * Start a budgeted vector build. Detached collections enter the scene only
   * at the fill and final publication boundaries.
   */
  begin(input: VectorTileBuildInput): VectorTileBuildState {
    let generationId = input.generationId;
    let featureIndex = input.featureIndex;
    if (generationId === undefined) {
      generationId = this._nextGenerationId++;
      let generations = this._generations.get(input.buckets);
      if (!generations) {
        generations = new Map();
        this._generations.set(input.buckets, generations);
      }
      generations.set(generationId, { tileId: input.tileId, styleRevision: input.styleRevision, mode: input.mode, featureIndex });
    }
    else {
      const generation = this._generations.get(input.buckets)?.get(generationId);
      if (!generation || generation.tileId !== input.tileId
        || generation.styleRevision !== input.styleRevision || generation.mode !== input.mode) {
        throw new Error('Cannot resume a vector generation with different tile, buckets, style or scene mode');
      }
      if (featureIndex && featureIndex !== generation.featureIndex)
        throw new Error('Cannot resume a vector generation with a different feature index');
      featureIndex = generation.featureIndex;
    }
    const paintBuckets = [...new Set(Object.values(input.buckets))];
    return {
      ...input,
      generationId,
      featureIndex,
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
        state.skipLayerIds,
        state.styleZoom,
        state.mode,
        state.mode === SceneMode.SCENE3D && (context.heightReference === HeightReference.CLAMP_TO_GROUND
          || context.heightReference === HeightReference.CLAMP_TO_TERRAIN
          || context.heightReference === HeightReference.CLAMP_TO_3D_TILE),
        this._picking,
        state.featureIndex,
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
        state.standard ??= { polygons: [] };
        state.polygonBuild ??= beginStandardPolygonBuild(result.polygons, state.tileId, state.tileID, state.mode, this._picking.enabled('fill'));
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
        state.bufferPolygonBuild ??= beginBufferPolygonBuild(result.polygons, state.tileID, state.tileId, context.heightReference, state.buckets, state.styleZoom, this._picking.enabled('fill'));
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
          this._picking,
          state.featureIndex,
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
        this._picking,
        state.featureIndex,
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
      state.circleBuild ??= appendCircleCollections(result.points, state.buckets, state.tileId, context.pixelRatio, state.mode, state.entries, this._picking.enabled('circle'));
      do {
        if (state.circleBuild.next().done)
          break;
        if (budget.exhausted)
          return false;
      } while (true);
      state.circleBuild = undefined;
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
    state.circleBuild?.return(undefined);
    state.circleBuild = undefined;
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
  picking = new FeaturePicking(),
  featureIndex?: FeatureIndex,
): PrimitiveCollection | undefined {
  const state = beginExtrusionBuild(buckets, tileID, tileId, generationId, zoom, lighting, undefined, picking, featureIndex);
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
  picking = new FeaturePicking(),
  featureIndex?: FeatureIndex,
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
    iterator: appendExtrusions(collection, buckets, tileID, tileId, generationId, zoom, lighting, skipLayerIds, picking, featureIndex),
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
  picking = new FeaturePicking(),
  featureIndex?: FeatureIndex,
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
      const attributes: Geometry['attributes'] & Record<string, GeometryAttribute | undefined> = {
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
        id: {
          tileId,
          layerId,
          featureIndex: primitive.featureIndex,
          generationId,
          ...(picking.enabled('fill-extrusion') ? picking.feature(layerFor(bucket, layerId), featureIndex, primitive.featureIndex) : {}),
        },
        attributes: {
          ...(picking.enabled('fill-extrusion') ? { show: new ShowGeometryInstanceAttribute(true) } : {}),
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
      const primitive = new ExtrusionPrimitive(instances, lighting, picking.enabled('fill-extrusion'));
      primitive.updateCameraPaint(bucket, layerId, zoom);
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
out vec3 v_centerEye;
${FILL_TRANSLATION_SHADER}

void main()
{
    vec4 p = czm_translateRelativeToEye(position2DHigh.zxy * 65536.0, position2DLow.zxy);
${morph
  ? `    p = czm_columbusViewMorph(p,
        czm_translateRelativeToEye(a_positionHigh * 65536.0, a_positionLow), czm_morphTime);`
  : ''}
    if (any(notEqual(u_fillTranslate, vec2(0.0)))) {
    vec3 normal = vec3(1.0, 0.0, 0.0);
    if (czm_morphTime > 0.0 || !u_fillMercator) {
${morph
  ? '    normal = normalize((a_positionHigh * 65536.0 + a_positionLow) / (czm_ellipsoidRadii * czm_ellipsoidRadii));'
  : `    vec2 angular = (position2DHigh.xy * 65536.0 + position2DLow.xy) / czm_ellipsoidRadii.x;
    float latitude = u_fillMercator ? atan(sinh(angular.y)) : angular.y;
    normal = vec3(cos(latitude) * cos(angular.x), cos(latitude) * sin(angular.x), sin(latitude));`}
    }
    p = cvt_translateFillPosition(p, normal);
    }
    v_centerEye = (czm_modelViewRelativeToEye * p).xyz;
    v_color = color;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;
}

function standardPolygonPrimitive(instances: GeometryInstance[], mode: SceneMode, allowPicking: boolean): FillGeometryPrimitive {
  const morph = mode === SceneMode.MORPHING;
  return new FillGeometryPrimitive(instances, new PerInstanceColorAppearance({
    // Alpha can change with a data/zoom expression after construction. Keep
    // blending enabled for the shared primitive so a later translucent
    // value is not silently rendered as opaque.
    translucent: true,
    flat: true,
    faceForward: true,
    closed: false,
    vertexShaderSource: surfaceVertexShader(morph),
    fragmentShaderSource: `
in vec4 v_color;
${SURFACE_TILE_CLIP_FRAGMENT}
void main()
{
    clipSurfaceTile();
    out_FragColor = czm_gammaCorrect(v_color);
}
`,
  }), morph ? 'surface-morph' : 'surface-planar', true, allowPicking);
}

interface StandardPolygonBuildState {
  collection: PrimitiveCollection;
  entries: StandardPolygonEntry[];
  iterator: Generator<void>;
}

function beginStandardPolygonBuild(
  polygons: TileRenderResult['polygons'],
  tileId: string,
  tileID: TileID,
  mode: SceneMode,
  allowPicking: boolean,
): StandardPolygonBuildState {
  const collection = new PrimitiveCollection();
  const entries: StandardPolygonEntry[] = [];
  return { collection, entries, iterator: appendStandardPolygons(collection, entries, polygons, tileId, tileID, mode, allowPicking) };
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
  tileID: TileID,
  mode: SceneMode,
  allowPicking: boolean,
): Generator<void> {
  const clip = new LineTileClip(tileID);
  const owners: Array<{ layerId: string; paint: FillGeometryPrimitive }> = [];
  fillCameraPaintOwners.set(collection, owners);
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
    let primitive: FillGeometryPrimitive | undefined;
    for (const polygon of layer) {
      const inputBytes = 8 * (40 + polygon.positions.length + polygon.triangles.length);
      if (instances.length > 0 && bytes + inputBytes > maximumBytes) {
        registerDrawBatch(primitive!, { layerId, tileId, kind: 'fill' });
        instances = [];
        primitive = undefined;
        bytes = 16;
      }
      if (!primitive) {
        primitive = standardPolygonPrimitive(instances, mode, allowPicking);
        owners.push({ layerId, paint: primitive });
        registerTileClip(primitive, clip);
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

interface BufferPolygonBuildState {
  entries: Array<[string, BufferPolygonCollection]>;
  iterator: Generator<void, void>;
}

function beginBufferPolygonBuild(polygons: TileRenderResult['polygons'], tileID: TileID, tileId: string, heightReference: HeightReference, buckets: BucketMap, zoom: number, allowPicking: boolean): BufferPolygonBuildState {
  const entries: BufferPolygonBuildState['entries'] = [];
  return { entries, iterator: appendBufferPolygonCollections(polygons, tileID, tileId, heightReference, buckets, zoom, entries, allowPicking) };
}

function stepBufferPolygonBuild(state: BufferPolygonBuildState, budget: Budget): boolean {
  do {
    if (state.iterator.next().done)
      return true;
  } while (!budget.exhausted);
  return false;
}

function* appendBufferPolygonCollections(polygons: TileRenderResult['polygons'], tileID: TileID, tileId: string, heightReference: HeightReference, buckets: BucketMap, zoom: number, entries: BufferPolygonBuildState['entries'], allowPicking: boolean): Generator<void, void> {
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
    const bucket = buckets[layerId];
    if (!(bucket instanceof FillBucket))
      throw new Error(`Missing fill bucket ${layerId}`);
    yield* appendBufferPolygonCollection(layer, tileID, tileId, layerId, heightReference, bucket, zoom, entries, allowPicking);
  }
}

function* appendBufferPolygonCollection(polygons: TileRenderResult['polygons'], tileID: TileID, tileId: string, layerId: string, heightReference: HeightReference, bucket: FillBucket, zoom: number, entries: BufferPolygonBuildState['entries'], allowPicking: boolean): Generator<void, void> {
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
    allowPicking,
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
  bufferPolygonFeatureIndices.set(collection, polygons.map(polygon => polygon.pickObject.featureIndex));
  const paint = new FillBufferPaint(collection, polygons.map(polygon => polygon.positions));
  fillCameraPaintOwners.set(collection, [{ layerId, paint }]);
  registerDrawBatch(collection, { layerId, tileId, kind: 'fill' });
  // This build owns the allocation until all layers finish and transfer it.
  entries.push([`polygons:${layerId}`, collection]);
  // Native drillPick toggles each retained flyweight's show value. Without
  // picking, one scratch view suffices because add() copies the payload.
  const scratch = allowPicking ? undefined : new BufferPolygon();
  for (const primitive of polygons) {
    const polygon = scratch ?? new BufferPolygon();
    collection.add({
      positions: primitive.positions,
      holes: new Uint32Array(primitive.holes),
      triangles: primitive.triangles,
      material: primitive.material,
      ...(allowPicking ? { pickObject: { primitive: polygon, id: primitive.pickObject } } : {}),
    }, polygon);
    yield;
  }
  paint.updateCameraPaint(layerFor(bucket, layerId), zoom);
}

function* appendCircleCollections(points: TileRenderResult['points'], buckets: BucketMap, tileId: string, pixelRatio: number, mode: SceneMode, entries: VectorTileBuildState['entries'], allowPicking: boolean): Generator<void> {
  const layers = new Map<string, CircleCollection>();
  for (const point of points) {
    const layerId = point.pickObject.layerId;
    let collection = layers.get(layerId);
    if (!collection) {
      collection = new CircleCollection(layerId, tileId, pixelRatio, mode, allowPicking);
      const bucket = buckets[layerId];
      if (!(bucket instanceof CircleBucket))
        throw new Error(`Missing circle bucket ${layerId}`);
      collection.updatePolicy(bucket, pixelRatio);
      layers.set(layerId, collection);
      entries.push([`points:${layerId}`, collection]);
    }
    collection.append(point);
    yield;
  }
  for (const collection of layers.values()) {
    collection.finish();
    yield;
  }
}
