import type { ImageAtlas } from '../../assets/image-atlas';
import type { Bucket } from '../../data/bucket';
import type { FeatureIndex } from '../../data/feature-index';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';

import type { Budget } from '../scene/frame-budget';
import type { MemoryBudgetVisitor } from '../scene/gpu-memory-budget';
import type { RadialOffsetCache } from '../vector/tile-conversion';
import type { PatternAtlasRect } from './pattern-geometry';
import type { PatternStyleLayer } from './pattern-layer';
import {
  ArcType,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartesian4,
  ComponentDatatype,
  EllipsoidSurfaceAppearance,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  Material,
  PolylineGeometry,
  PolylineMaterialAppearance,
  Primitive,
  PrimitiveCollection,
  PrimitiveType,
  SceneMode,
  TextureMagnificationFilter,
  TextureMinificationFilter,
} from 'cesium';
import {
  atlasLayoutHash,
  SharedAtlasTextures,
} from '../../assets/shared-atlas-textures';
import { FillBucket, FillExtrusionBucket, LineBucket } from '../../data/bucket-runtime';
import { EXTENT } from '../../data/extent';
import { geometryBytes } from '../geometry/geometry-bytes';
import { RASTER_SURFACE_OFFSET_M } from '../raster/raster-geometry';
import { registerDrawBatch } from '../scene/draw-batch';
import { RetiredPool } from '../scene/retired-pool';
import { fillBucketPrimitives, lineBucketPrimitives } from '../vector/bucket-geometry';
import { extrusionBucketPrimitives } from '../vector/extrusion-geometry';
import {
  constantValue,
  extrusionPatternOpacityForFeature,
  extrusionStyleForFeature,
  fillPatternOpacityForFeature,
  linePatternOpacityForFeature,
  lineStyleForFeature,
} from '../vector/feature-attributes';
import { radialOffsetPositions } from '../vector/tile-conversion';
import {
  constantPatternName,
  patternAtlasRectForFeature,
  patternPosition,
  patternUVs,
} from './pattern-geometry';

type TileID = CanonicalTileID | OverscaledTileID;

export interface PatternPrimitiveID {
  type: 'pattern';
  tileId: string;
  layerId: string;
  featureIndex: number;
  tileFeatureIndex: FeatureIndex | undefined;
}

export interface PatternTileUpdate {
  removed: Primitive[];
  added: Primitive[];
  removedMaterials: Material[];
  tileId?: string;
  parents?: ReadonlyMap<Primitive, PrimitiveCollection>;
  retained?: { parents: ReadonlyMap<Primitive, PrimitiveCollection>; release: () => void };
}

interface PatternPrimitiveEntry {
  primitive: Primitive;
  /** Paint visibility before the tileset temporarily hides this tile. */
  paintVisible: boolean;
  material: Material;
  materialKey: string;
  /**
   * Content key of the shared atlas this entry samples (see
   * patternAtlasKey). Entries never hold the per-tile atlas object: tiles
   * with byte-identical atlases share one GPU texture, and the key (not
   * object identity) decides reuse.
   */
  atlasKey: string;
  atlasVersion: string;
  tileId: string;
  collection: PrimitiveCollection;
  id: PatternPrimitiveID;
  layer: PatternStyleLayer;
  styleZoom: number | undefined;
  styleRevision: number;
  styleMutationRevision: number;
  paintRevision: number;
  zoomDependentPaint: boolean;
  mode: SceneMode | undefined;
  layerKey: string;
  styleSignature: string;
  /**
   * CPU-retained geometry bytes feeding the entry's primitive (see
   * geometryBytes): the memory budget's per-tile estimate. Shared atlas
   * textures are owned once and excluded.
   */
  bytes: number;
}

export type PatternImageSource = HTMLCanvasElement | OffscreenCanvas;

interface PatternAtlasEntry {
  /** Content key in _atlases and the shared texture registry (see patternAtlasKey). */
  key: string;
  source: PatternImageSource;
  materials: Map<string, { material: Material; refs: number }>;
}

/**
 * Identity of one shareable pattern atlas: the packed pattern layout
 * (names + rects + sprite versions). Per-vertex pattern UVs are
 * repeat-unit based (see patternUVs) and materials normalize rects by the
 * shared canvas dims, so tiles whose patterns pack identically share one
 * canvas and one GPU texture even when their icon regions or canvas dims
 * differ - pattern materials never sample outside the pattern rects, where
 * identical names + versions guarantee identical pixels.
 */
export function patternAtlasKey(atlas: ImageAtlas): string {
  return `pattern/${atlasLayoutHash(atlas.patternPositions)}`;
}

interface PendingPatternEntry {
  geometryInstance: GeometryInstance;
  material: Material;
  materialKey: string;
  opacity: number;
  id: PatternPrimitiveID;
  styleSignature: string;
}

interface PatternGeometryGroup {
  material: Material;
  materialKey: string;
  opacity: number;
  geometryInstances: GeometryInstance[];
  entries: PendingPatternEntry[];
}

/** One layer's detached staging collection plus what it is staged for. */
interface PatternStagedLayer {
  layerId: string;
  staging: PrimitiveCollection;
}

/** Resume cursor for a suspended fill-branch extraction. */
export interface PatternFillResume {
  fillIndex: number;
  groups: Map<string, PatternGeometryGroup>;
}

/**
 * A begun pattern build: either already complete or resumable state.
 *
 * Discriminated by the string literal `status` rather than a boolean
 * `complete` flag: the library compiles with `strictNullChecks: false`
 * (MapLibre heritage), and that mode widens boolean literals to `boolean`,
 * which disables narrowing on a boolean discriminant.
 */
export type PatternBuildBegun
  = | { status: 'complete'; update: PatternTileUpdate }
    | { status: 'resumable'; state: PatternBuildState };

export interface PatternBuildInput {
  tileId: string;
  tileID: TileID;
  tileFeatureIndex: FeatureIndex | undefined;
  buckets: { [layerId: string]: Bucket };
  atlas: ImageAtlas | undefined;
  layers: readonly PatternStyleLayer[];
  layerOrder?: ReadonlyMap<string, number>;
  sourceId?: string;
  styleZoom?: number;
  mode?: SceneMode;
  styleRevision?: number;
  styleMutationRevision?: number;
  transitions?: boolean;
}

/** Resumable per-layer pattern build state (see beginPatternBuild). */
export interface PatternBuildState {
  radialOffsetCache?: RadialOffsetCache;
  patternGeometry: Map<string, string>;
  tileId: string;
  tileID: TileID;
  tileFeatureIndex: FeatureIndex | undefined;
  buckets: { [layerId: string]: Bucket };
  atlas: ImageAtlas | undefined;
  layers: PatternStyleLayer[];
  layerOrder?: ReadonlyMap<string, number>;
  sourceId?: string;
  styleZoom?: number;
  mode?: SceneMode;
  layerKey: string;
  atlasVersion: string;
  styleRevision: number;
  styleMutationRevision: number;
  atlasState: PatternAtlasEntry | undefined;
  layerIndex: number;
  layerResume: PatternFillResume | undefined;
  entries: PatternPrimitiveEntry[];
  staged: PatternStagedLayer[];
  addedPrimitives: Set<Primitive>;
}

interface PatternTileState {
  patternGeometry: Map<string, string>;
  tileFeatureIndex: FeatureIndex | undefined;
  atlas: ImageAtlas | undefined;
  mode: SceneMode | undefined;
  layerKey: string;
  atlasVersion: string;
  layerIds: string[];
  buckets: Map<string, Bucket>;
  paintRevisions: Map<string, number>;
  zoomDependentPaint: boolean;
  styleRevision: number;
  styleMutationRevision: number;
  styleZoom: number | undefined;
}

const TILE_SIZE_PX = 512;
const LAYER_RADIAL_EPSILON_METERS = 0.01;
const PATTERN_RADIAL_EPSILON_METERS = 0.002;

function patternLayerOffset(layerId: string, layerOrder?: ReadonlyMap<string, number>): number {
  return RASTER_SURFACE_OFFSET_M
    + (layerOrder?.get(layerId) ?? 0) * LAYER_RADIAL_EPSILON_METERS
    + PATTERN_RADIAL_EPSILON_METERS;
}

function samePatternGeometry(previous: Map<string, string>, current: Map<string, string>): boolean {
  return previous.size === current.size
    && [...current].every(([layerId, key]) => previous.get(layerId) === key);
}

/**
 * Cesium material equivalent of MapLibre's fill/line pattern sampling. The
 * atlas is shared by all primitives produced from one worker ImageAtlas.
 * Line repeat counts live in vertex coordinates, so lines of different
 * lengths can share a material and one draw command.
 */
export const PATTERN_MATERIAL_SOURCE = `
vec2 patternCoordinate(vec2 coordinate)
{
    return mod(coordinate, vec2(1.0));
}

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    vec2 coordinate = materialInput.st;
    coordinate = patternCoordinate(coordinate);

    vec2 topLeft = vec2(patternRect.x / atlasSize.x, 1.0 - patternRect.y / atlasSize.y);
    vec2 bottomRight = vec2(patternRect.z / atlasSize.x, 1.0 - patternRect.w / atlasSize.y);
    vec2 uv = mix(topLeft, bottomRight, coordinate);
    vec4 patternColor = texture(image, uv);
    material.diffuse = patternColor.rgb;
    material.alpha = patternColor.a * opacity;
    return material;
}
`;

function isPatternBucket(bucket: Bucket | undefined): bucket is FillBucket | LineBucket | FillExtrusionBucket {
  return bucket instanceof FillBucket || bucket instanceof LineBucket || bucket instanceof FillExtrusionBucket;
}

function createAtlasCanvas(width: number, height: number): PatternImageSource {
  let canvas: PatternImageSource | undefined;
  if (typeof OffscreenCanvas !== 'undefined') {
    const candidate = new OffscreenCanvas(width, height);
    // Some node test environments expose a placeholder OffscreenCanvas
    // constructor without the 2D API. Do not select it as the source.
    if (typeof candidate.getContext === 'function') {
      canvas = candidate;
    }
  }
  if (!canvas && typeof document !== 'undefined') {
    const candidate = document.createElement('canvas');
    candidate.width = width;
    candidate.height = height;
    canvas = candidate;
  }
  if (!canvas) {
    throw new Error('A canvas implementation is required to upload pattern atlases');
  }
  return canvas;
}

function createAtlasSource(atlas: ImageAtlas): PatternImageSource {
  const canvas = createAtlasCanvas(atlas.image.width, atlas.image.height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('A 2D canvas context is required to upload pattern atlases');
  }
  const data = new Uint8ClampedArray(
    atlas.image.data.buffer,
    atlas.image.data.byteOffset,
    atlas.image.data.byteLength,
  );
  context.putImageData(new ImageData(data as never, atlas.image.width, atlas.image.height), 0, 0);
  return canvas;
}

function rectForFeature(
  bucket: FillBucket | LineBucket | FillExtrusionBucket,
  layer: PatternStyleLayer,
  featureIndex: number,
  atlas: ImageAtlas,
): PatternAtlasRect | undefined {
  const range = bucket.programConfigurations.getFeatureRange(featureIndex);
  if (!range) {
    return undefined;
  }

  const dataDriven = patternAtlasRectForFeature(bucket, range, layer.id);
  if (dataDriven) {
    return dataDriven;
  }

  const name = constantPatternName(layer);
  const position = patternPosition(atlas.patternPositions, name ?? null);
  return position ? { tlbr: position.tlbr, pixelRatio: position.pixelRatio } : undefined;
}

function patternStyleSignature(
  bucket: FillBucket | LineBucket | FillExtrusionBucket,
  layer: PatternStyleLayer,
  featureIndex: number,
  atlas: ImageAtlas,
  styleZoom: number | undefined,
): string | undefined {
  const rect = rectForFeature(bucket, layer, featureIndex, atlas);
  if (!rect) {
    return undefined;
  }
  const rectKey = `${rect.tlbr.join(',')}/${rect.pixelRatio}`;
  if (bucket instanceof FillBucket) {
    return `fill/${rectKey}/${fillPatternOpacityForFeature(bucket, featureIndex, layer.id, styleZoom)}`;
  }
  if (bucket instanceof LineBucket) {
    const style = lineStyleForFeature(bucket, featureIndex, layer.id, styleZoom);
    return `line/${rectKey}/${style.widthPx}/${linePatternOpacityForFeature(bucket, featureIndex, layer.id, styleZoom)}`;
  }
  const style = extrusionStyleForFeature(bucket, featureIndex, layer.id, styleZoom);
  return `extrusion/${rectKey}/${style.height}/${style.base}/${extrusionPatternOpacityForFeature(bucket, featureIndex, layer.id, styleZoom)}`;
}

function patternMaterial(
  source: PatternImageSource,
  rect: PatternAtlasRect,
  opacity: number,
  atlas: ImageAtlas,
): Material {
  let translucent = opacity < 1;
  const [left, top, right, bottom] = rect.tlbr;
  // Material creation is shared by rect/opacity. Inspect only this sprite;
  // the wrapped border copies its edge pixels, so other atlas rects do not
  // determine its blending or depth writes.
  for (let y = top; y < bottom && !translucent; y++) {
    for (let x = left; x < right; x++) {
      if (atlas.image.data[(y * atlas.image.width + x) * 4 + 3] < 255) {
        translucent = true;
        break;
      }
    }
  }
  return new Material({
    translucent,
    minificationFilter: TextureMinificationFilter.LINEAR,
    magnificationFilter: TextureMagnificationFilter.LINEAR,
    fabric: {
      uniforms: {
        image: source,
        // Normalized against the SHARED canvas (which the material samples),
        // not the tile's own atlas: tiles sharing a pattern layout may pack
        // different canvas dims, and patternUVs are repeat-unit based so only
        // this uniform ties rects to pixels.
        atlasSize: new Cartesian2(source.width, source.height),
        patternRect: new Cartesian4(...rect.tlbr),
        opacity,
      },
      source: PATTERN_MATERIAL_SOURCE,
    },
  });
}

function patternMaterialKey(rect: PatternAtlasRect, opacity: number): string {
  return `${rect.tlbr.join(',')}/${rect.pixelRatio}/${opacity}`;
}

function detachPatternMaterial(atlasState: PatternAtlasEntry, key: string): Material | undefined {
  const entry = atlasState.materials.get(key);
  if (!entry || --entry.refs > 0) {
    return undefined;
  }
  atlasState.materials.delete(key);
  return entry.material;
}

/** Cancel the material ownership of groups that have not sealed a primitive. */
function destroyPendingPatternGroups(atlasState: PatternAtlasEntry, resume: PatternFillResume | undefined): void {
  if (!resume) {
    return;
  }
  for (const key of resume.groups.keys()) {
    const material = detachPatternMaterial(atlasState, key);
    if (material) {
      material.destroy();
    }
  }
}

function surfaceGeometry(
  positions: Float64Array,
  tilePositions: Float64Array,
  triangles: Uint32Array,
  rect: PatternAtlasRect,
  tileID: TileID,
): Geometry {
  return new Geometry({
    attributes: {
      position: new GeometryAttribute({
        componentDatatype: ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      }),
      st: new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: patternUVs(tilePositions, rect, tileID),
      }),
      normal: undefined,
      bitangent: undefined,
      tangent: undefined,
      color: undefined,
    },
    indices: triangles,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(positions),
  });
}

function patternPrimitive(
  group: PatternGeometryGroup,
  line: boolean,
  extrusion3D: boolean,
): Primitive {
  const primitive = new Primitive({
    geometryInstances: group.geometryInstances,
    appearance: line
      ? new PolylineMaterialAppearance({
          material: group.material,
          translucent: true,
        })
      : new EllipsoidSurfaceAppearance({
          aboveGround: true,
          faceForward: true,
          flat: true,
          material: group.material,
          translucent: true,
          renderState: extrusion3D ? { cull: { enabled: true } } : undefined,
        }),
    allowPicking: true,
    asynchronous: false,
    // Global repeat counts exceed the normalized range of Cesium's UV packer.
    compressVertices: false,
    releaseGeometryInstances: true,
  });
  primitive.show = group.opacity > 0;
  return primitive;
}

function lineRepeatX(tilePositions: Float64Array, rect: PatternAtlasRect, tileID: TileID): number {
  let length = 0;
  for (let index = 2; index < tilePositions.length; index += 2) {
    length += Math.hypot(tilePositions[index] - tilePositions[index - 2], tilePositions[index + 1] - tilePositions[index - 1]);
  }
  const patternWidth = (rect.tlbr[2] - rect.tlbr[0]) / rect.pixelRatio;
  const overscale = 'overscaledZ' in tileID
    ? 2 ** (tileID.overscaledZ - tileID.canonical.z)
    : 1;
  return patternWidth > 0
    ? Math.max(length * TILE_SIZE_PX / EXTENT * overscale / patternWidth, 0.0001)
    : 1;
}

function linePositions(positions: Float64Array): Cartesian3[] {
  const result: Cartesian3[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    result.push(Cartesian3.fromElements(positions[i], positions[i + 1], positions[i + 2]));
  }
  return result;
}

/** Bake the feature's pattern repeat into its ST coordinates before merging. */
export function patternLineGeometry(
  positions: Float64Array,
  width: number,
  repeatX: number,
): Geometry | undefined {
  const geometry = PolylineGeometry.createGeometry(new PolylineGeometry({
    arcType: ArcType.NONE,
    positions: linePositions(positions),
    vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT,
    width,
  }));
  const st = geometry?.attributes.st?.values;
  if (st) {
    for (let i = 0; i < st.length; i += 2) {
      st[i] *= repeatX;
    }
  }
  return geometry;
}

/**
 * Owns pattern primitives and their shared atlas textures. Tiles whose
 * atlases pack the same sprite set share one atlas entry (keyed by content,
 * see patternAtlasKey) and one GPU texture, so a sprite atlas costs one
 * upload no matter how many tiles x layers sample it - matching MapLibre's
 * global image atlas instead of one texture per material.
 */
export class PatternTileRenderer {
  private _layerCollections = new Map<string, PrimitiveCollection>();

  private _tiles = new Map<string, PatternPrimitiveEntry[]>();

  private _hiddenTiles = new Set<string>();

  private _tileIdsCache?: string[];

  private _tileStates = new Map<string, PatternTileState>();

  private _atlases = new Map<string, PatternAtlasEntry>();

  private _shared = new SharedAtlasTextures();
  /**
   * Device-pixel scale applied to line widths, refreshed by the tileset before
   * every frame. Cesium's polyline shader multiplies by scene.pixelRatio, so
   * this only compensates for the tileset's devicePixelRatio (see
   * CesiumVectorTileset._pixelRatioCompensation).
   */
  pixelRatio = 1;

  get collections(): ReadonlyMap<string, PrimitiveCollection> {
    return this._layerCollections;
  }

  get tileIds(): ReadonlyArray<string> {
    return this._tileIdsCache ??= [...this._tiles.keys()];
  }

  /** Toggle only this tile's live primitives without changing their paint visibility. */
  setTileVisible(tileId: string, visible: boolean): void {
    if (visible) {
      this._hiddenTiles.delete(tileId);
    }
    const entries = this._tiles.get(tileId);
    if (!entries) {
      return;
    }
    if (!visible) {
      this._hiddenTiles.add(tileId);
    }
    for (const entry of entries) {
      entry.primitive.show = visible && entry.paintVisible;
    }
  }

  /** Live/retired tile and layer-collection counts for diagnostics. */
  get stats(): { tiles: number; retiredTiles: number; layerCollections: number } {
    return {
      tiles: this._tiles.size,
      retiredTiles: this._retired.size,
      layerCollections: this._layerCollections.size,
    };
  }

  /**
   * Per-tile byte estimates for the memory budget, live then retired
   * oldest-first (the budget's LRU order). Shared atlas textures are owned
   * once and excluded; only entry geometry counts. Live tiles are pinned
   * (attached to the scene); only pooled retired tiles are evictable.
   */
  visitMemoryEntries(visit: MemoryBudgetVisitor): void {
    const bytesOf = (tileEntries: PatternPrimitiveEntry[]): number => {
      let bytes = 0;
      const seen = new Set<Primitive>();
      for (const entry of tileEntries) {
        if (seen.has(entry.primitive)) {
          continue;
        }
        seen.add(entry.primitive);
        bytes += entry.bytes ?? 0;
      }
      return bytes;
    };
    for (const [tileId, tileEntries] of this._tiles) {
      visit(tileId, bytesOf(tileEntries), true);
    }
    for (const [tileId, tileEntries] of this._retired.entries()) {
      visit(tileId, bytesOf(tileEntries));
    }
  }

  setLayers(layers: readonly PatternStyleLayer[], layerOrder?: ReadonlyMap<string, number>): PatternTileUpdate {
    const update: PatternTileUpdate = { removed: [], added: [], removedMaterials: [] };
    for (const layer of layers) {
      if (!this._layerCollections.has(layer.id)) {
        this._layerCollections.set(layer.id, new PrimitiveCollection({ destroyPrimitives: false }));
      }
    }
    // Deleted layers have no successor. Layers changing render track keep
    // their current primitives until the tile's new vector stage is ready.
    if (layerOrder) {
      for (const [tileId, entries] of this._tiles) {
        const deleted = entries.filter(entry => !layerOrder.has(entry.id.layerId));
        if (deleted.length === 0) {
          continue;
        }
        const removed = this._retireEntries(deleted);
        update.removed.push(...removed.removed);
        update.removedMaterials.push(...removed.removedMaterials);
        this._tiles.set(tileId, entries.filter(entry => layerOrder.has(entry.id.layerId)));
        this._tileStates.delete(tileId);
      }
    }
    // Keep the map materialized even when a caller does not need offsets; the
    // offset is evaluated while building primitives so async tile arrival does
    // not reorder coplanar Cesium surfaces.
    return update;
  }

  /**
   * Transfer replaced entries to the scene handoff without detaching them.
   * @internal
   */
  private _retainEntries(entries: PatternPrimitiveEntry[]): NonNullable<PatternTileUpdate['retained']> | undefined {
    if (entries.length === 0) {
      return undefined;
    }
    return {
      parents: new Map(entries.map(entry => [entry.primitive, entry.collection])),
      release: () => {
        const removed = this._retireEntries(entries);
        destroyPatternResources({ ...removed, added: [] });
      },
    };
  }

  takeDisplacedTile(tileId: string, layers: readonly PatternStyleLayer[]): PatternTileUpdate['retained'] {
    const entries = this._tiles.get(tileId);
    if (!entries) {
      return undefined;
    }
    const ids = new Set(layers.map(layer => layer.id));
    const displaced = entries.filter(entry => !ids.has(entry.id.layerId));
    this._tiles.set(tileId, entries.filter(entry => ids.has(entry.id.layerId)));
    return this._retainEntries(displaced);
  }

  getTilePrimitives(tileId: string): readonly Primitive[] {
    return [...new Set(this._tiles.get(tileId)?.map(entry => entry.primitive) ?? [])];
  }

  /** Read-only query; shared primitives may be visited more than once. */
  someTilePrimitive(tileId: string, predicate: (primitive: Primitive) => boolean): boolean {
    const entries = this._tiles.get(tileId);
    if (entries) {
      for (const entry of entries) {
        if (predicate(entry.primitive))
          return true;
      }
    }
    return false;
  }

  /**
   * @internal
   */
  private _createTileState(
    tileFeatureIndex: FeatureIndex | undefined,
    buckets: { [layerId: string]: Bucket },
    layers: readonly PatternStyleLayer[],
    atlas: ImageAtlas | undefined,
    mode: SceneMode | undefined,
    layerKey: string,
    atlasVersion: string,
    styleRevision: number,
    styleMutationRevision: number,
    styleZoom: number | undefined,
    patternGeometry: Map<string, string>,
  ): PatternTileState {
    const layerIds: string[] = [];
    const bucketByLayer = new Map<string, Bucket>();
    const paintRevisions = new Map<string, number>();
    let zoomDependentPaint = false;
    for (const layer of layers) {
      const bucket = buckets[layer.id];
      if (!isPatternBucket(bucket)) {
        continue;
      }
      layerIds.push(layer.id);
      bucketByLayer.set(layer.id, bucket);
      paintRevisions.set(layer.id, bucket.programConfigurations.paintRevision);
      zoomDependentPaint = zoomDependentPaint || bucket.programConfigurations.hasCompositeProperties();
    }
    return {
      patternGeometry,
      tileFeatureIndex,
      atlas,
      mode,
      layerKey,
      atlasVersion,
      layerIds,
      buckets: bucketByLayer,
      paintRevisions,
      zoomDependentPaint,
      styleRevision,
      styleMutationRevision,
      styleZoom,
    };
  }

  /**
   * @internal
   */
  private _patternGeometryInputs(buckets: { [layerId: string]: Bucket }, layers: readonly PatternStyleLayer[], zoom: number | undefined): Map<string, string> {
    const inputs = new Map<string, string>();
    for (const layer of layers) {
      const bucket = buckets[layer.id];
      if (!isPatternBucket(bucket))
        continue;
      const properties = bucket instanceof FillBucket
        ? ['fill-pattern', 'fill-opacity', 'fill-layer-opacity']
        : bucket instanceof LineBucket
          ? ['line-pattern', 'line-width', 'line-opacity', 'line-layer-opacity']
          : ['fill-extrusion-pattern', 'fill-extrusion-height', 'fill-extrusion-base', 'fill-extrusion-opacity'];
      // Constant geometry paint is held by the layer, including omitted
      // transparent features. Source/composite paint changes are represented
      // by the binder revision; composite interpolation also depends on zoom.
      inputs.set(layer.id, JSON.stringify([
        bucket.programConfigurations.paintRevision,
        bucket.programConfigurations.hasCompositeProperties() ? zoom : undefined,
        ...properties.map(property => constantValue(layer as Parameters<typeof constantValue>[0], property)),
      ]));
    }
    return inputs;
  }

  /**
   * @internal
   */
  private _sameTileInputs(
    state: PatternTileState,
    tileFeatureIndex: FeatureIndex | undefined,
    buckets: { [layerId: string]: Bucket },
    layers: readonly PatternStyleLayer[],
    atlas: ImageAtlas | undefined,
    mode: SceneMode | undefined,
    layerKey: string,
    atlasVersion: string,
  ): boolean {
    if (state.tileFeatureIndex !== tileFeatureIndex
      || state.atlas !== atlas
      || state.mode !== mode
      || state.layerKey !== layerKey
      || state.atlasVersion !== atlasVersion) {
      return false;
    }
    let layerCount = 0;
    let zoomDependentPaint = false;
    for (const layer of layers) {
      const bucket = buckets[layer.id];
      if (!isPatternBucket(bucket)) {
        continue;
      }
      layerCount++;
      if (state.buckets.get(layer.id) !== bucket) {
        return false;
      }
      if (state.paintRevisions.get(layer.id) !== bucket.programConfigurations.paintRevision) {
        return false;
      }
      zoomDependentPaint = zoomDependentPaint || bucket.programConfigurations.hasCompositeProperties();
    }
    return layerCount === state.layerIds.length
      && zoomDependentPaint === state.zoomDependentPaint;
  }

  /**
   * @internal
   */
  private _updateTileState(
    state: PatternTileState | undefined,
    styleRevision: number,
    styleMutationRevision: number,
    styleZoom: number | undefined,
  ): void {
    if (!state) {
      return;
    }
    state.styleRevision = styleRevision;
    state.styleMutationRevision = styleMutationRevision;
    state.styleZoom = styleZoom;
  }

  /**
   * Start a budgeted pattern build. Cache checks (which return completed
   * updates without touching the scene) run here, atomically and cheaply;
   * real builds assemble detached and commit whole via step/commit below.
   */
  beginPatternBuild({
    tileId,
    tileID,
    tileFeatureIndex,
    buckets,
    atlas,
    layers,
    layerOrder,
    sourceId,
    styleZoom,
    mode,
    styleRevision = 0,
    styleMutationRevision = styleRevision,
    transitions = false,
  }: PatternBuildInput): PatternBuildBegun {
    // Image patterns bake width, opacity and extrusion dimensions.
    styleZoom = styleZoom === undefined ? undefined : Math.floor(styleZoom);
    const layerKey = layers.map(layer => layer.id).join('|');
    const atlasVersion = atlas ? String(atlas.revision ?? 0) : '';
    const existing = this._tiles.get(tileId);
    const tileState = this._tileStates.get(tileId);
    const patternGeometry = this._patternGeometryInputs(buckets, layers, styleZoom);
    if (tileState
      && this._sameTileInputs(tileState, tileFeatureIndex, buckets, layers, atlas, mode, layerKey, atlasVersion)
      && samePatternGeometry(tileState.patternGeometry, patternGeometry)
      && tileState.styleMutationRevision === styleMutationRevision
      && !transitions
      && (!tileState.zoomDependentPaint || tileState.styleZoom === styleZoom)) {
      this._updateTileState(tileState, styleRevision, styleMutationRevision, styleZoom);
      return { status: 'complete', update: { removed: [], added: [], removedMaterials: [] } };
    }
    // Hashed on demand below (see the content-keyed reuse comment): steady
    // frames leave through the fast path above without paying for it.
    let atlasKey: string | undefined;
    if (existing && existing.length > 0 && tileState
      && tileState.tileFeatureIndex === tileFeatureIndex
      && samePatternGeometry(tileState.patternGeometry, patternGeometry)
      && layers.every(layer => tileState.buckets.get(layer.id) === buckets[layer.id])
      && existing.every((entry) => {
      // Reuse geometry only for the same source buckets. Equal atlas bytes
      // and paint signatures do not imply equal feature positions after a
      // worker reload. Hash the atlas lazily after the fast path above.
        atlasKey ??= atlas ? patternAtlasKey(atlas) : '';
        if (entry.atlasKey !== atlasKey) {
          return false;
        }
        if (entry.mode !== mode || entry.layerKey !== layerKey) {
          return false;
        }
        const bucket = buckets[entry.id.layerId];
        const layer = entry.styleRevision === styleRevision
          ? entry.layer
          : layers.find(candidate => candidate.id === entry.id.layerId);
        if (!bucket || !layer || !isPatternBucket(bucket)) {
          return false;
        }
        const paintRevision = bucket.programConfigurations.paintRevision;
        if (entry.atlasVersion === atlasVersion
          && entry.paintRevision === paintRevision) {
          if (entry.styleMutationRevision === styleMutationRevision
            && !transitions
            && (!entry.zoomDependentPaint || entry.styleZoom === styleZoom)) {
            return true;
          }
        }
        return entry.styleSignature === patternStyleSignature(bucket, layer, entry.id.featureIndex, atlas, styleZoom);
      })) {
      for (const entry of existing) {
        entry.styleRevision = styleRevision;
        entry.styleMutationRevision = styleMutationRevision;
        entry.styleZoom = styleZoom;
        entry.layer = layers.find(candidate => candidate.id === entry.id.layerId) ?? entry.layer;
        const bucket = buckets[entry.id.layerId] as FillBucket | LineBucket | FillExtrusionBucket;
        entry.paintRevision = bucket.programConfigurations.paintRevision;
      }
      this._tileStates.set(tileId, this._createTileState(tileFeatureIndex, buckets, layers, atlas, mode, layerKey, atlasVersion, styleRevision, styleMutationRevision, styleZoom, patternGeometry));
      return { status: 'complete', update: { removed: [], added: [], removedMaterials: [] } };
    }

    // A build owns only staged resources. The live tile stays registered and
    // visible until commit, including the empty-atlas replacement case.
    let atlasState: PatternAtlasEntry | undefined;
    if (atlas && layers.length > 0) {
      atlasKey ??= patternAtlasKey(atlas);
      atlasState = this._atlases.get(atlasKey);
      if (!atlasState) {
        atlasState = {
          key: atlasKey,
          source: this._shared.canvas(atlasKey, atlas.image.width, atlas.image.height, () => createAtlasSource(atlas)) as PatternImageSource,
          materials: new Map(),
        };
        this._atlases.set(atlasKey, atlasState);
      }
      this._shared.retain(atlasKey);
    }
    const entries: PatternPrimitiveEntry[] = [];
    const addedPrimitives = new Set<Primitive>();
    const staged: PatternStagedLayer[] = [];
    return {
      status: 'resumable',
      state: {
        radialOffsetCache: new WeakMap(),
        patternGeometry: new Map(),
        tileId,
        tileID,
        tileFeatureIndex,
        buckets,
        atlas,
        layers: [...layers],
        layerOrder,
        sourceId,
        styleZoom,
        mode,
        layerKey,
        atlasVersion,
        styleRevision,
        styleMutationRevision,
        atlasState,
        layerIndex: 0,
        layerResume: undefined,
        entries,
        staged,
        addedPrimitives,
      },
    };
  }

  /**
   * Advance a pattern build while budget allows; true when every layer is
   * built and committed. Layers assemble into per-layer staging collections
   * that move to the shared layer collections only at commit, so an
   * unfinished or abandoned build never pops half a tile into the scene.
   */
  stepPatternBuild(state: PatternBuildState, budget: Budget): boolean {
    if (!state.atlas || !state.atlasState) {
      state.radialOffsetCache = undefined;
      return true;
    }
    // Always finish at least one layer per call to prevent livelock.
    let first = true;
    while (state.layerIndex < state.layers.length) {
      if (!first && budget.exhausted) {
        return false;
      }
      first = false;
      const layer = state.layers[state.layerIndex];
      const bucket = state.buckets[layer.id];
      const collection = this._layerCollections.get(layer.id);
      if (!isPatternBucket(bucket) || !collection) {
        destroyPendingPatternGroups(state.atlasState, state.layerResume);
        state.layerIndex++;
        state.layerResume = undefined;
        continue;
      }
      let staged = state.staged.find(candidate => candidate.layerId === layer.id);
      if (!staged) {
        // Staging collections must not destroy their primitives: commit
        // moves them into the shared layer collections (PrimitiveCollection
        // removes destroy the primitive when destroyPrimitives is set, and
        // the default differs per construction site, so state it).
        staged = { layerId: layer.id, staging: new PrimitiveCollection({ destroyPrimitives: false }) };
        state.staged.push(staged);
      }
      const offset = patternLayerOffset(layer.id, state.layerOrder);
      if (!state.patternGeometry.has(layer.id)) {
        const inputs = this._patternGeometryInputs(state.buckets, [layer], state.styleZoom);
        state.patternGeometry.set(layer.id, inputs.get(layer.id)!);
      }
      const rendered = this._renderLayer(
        state.tileId,
        state.sourceId,
        state.tileID,
        state.tileFeatureIndex,
        bucket,
        layer,
        state.atlas,
        state.atlasState,
        staged.staging,
        offset,
        state.styleZoom,
        state.mode,
        state.layerKey,
        state.atlasVersion,
        state.styleRevision,
        state.styleMutationRevision,
        state.radialOffsetCache,
        state.layerResume,
        budget,
      );
      state.entries.push(...rendered.entries);
      for (const entry of rendered.entries) {
        state.addedPrimitives.add(entry.primitive);
      }
      if (rendered.resume) {
        state.layerResume = rendered.resume;
        return false;
      }
      state.layerResume = undefined;
      state.layerIndex++;
    }
    state.radialOffsetCache = undefined;
    return true;
  }

  /**
   * Move a finished build's staged primitives into the shared layer
   * collections and register the tile. Runs exactly once per build, on the
   * frame the build completes.
   */
  commitPatternBuild(state: PatternBuildState): PatternTileUpdate {
    const wasHidden = this._hiddenTiles.has(state.tileId);
    const update: PatternTileUpdate = {
      tileId: state.tileId,
      removed: [],
      added: [],
      removedMaterials: this._evictRetiredEntry(state.tileId),
      retained: this._retainEntries(this._tiles.get(state.tileId) ?? []),
    };
    if (wasHidden) {
      this._hiddenTiles.add(state.tileId);
    }
    for (const staged of state.staged) {
      const collection = this._layerCollections.get(staged.layerId);
      if (!collection) {
        // The layer left the style mid-build: release its staged primitives.
        for (let i = 0; i < staged.staging.length; i++) {
          (staged.staging.get(i) as Primitive).destroy();
        }
        staged.staging.destroy();
        continue;
      }
      // Drain from the head: removing by index while iterating would skip
      // every other primitive as the remainder shifts down.
      while (staged.staging.length > 0) {
        const primitive = staged.staging.get(0) as Primitive;
        staged.staging.remove(primitive);
        collection.add(primitive);
      }
      staged.staging.destroy();
      for (const entry of state.entries) {
        if (entry.collection === (staged.staging as unknown as PrimitiveCollection)) {
          entry.collection = collection;
        }
      }
    }
    state.staged = [];
    // Convert the build hold (taken in beginPatternBuild) into per-primitive
    // refs; a zero-primitive build releases its hold and drops an entry no
    // live tile uses. Refs live in the shared texture registry so tiles with
    // byte-identical atlases share one entry and one GPU texture.
    if (state.atlasState) {
      for (let i = 0; i < state.addedPrimitives.size; i++) {
        this._shared.retain(state.atlasState.key);
      }
      this._shared.release(state.atlasState.key);
      if (!this._shared.has(state.atlasState.key)) {
        this._atlases.delete(state.atlasState.key);
      }
    }
    // Retain an empty state as well. A fully transparent pattern layer should
    // not re-run geometry extraction on every frame, but it must remain visible
    // to the tileset's tile cleanup when the layer leaves the style.
    this._tiles.set(state.tileId, state.entries);
    if (this._hiddenTiles.has(state.tileId)) {
      this.setTileVisible(state.tileId, false);
    }
    this._tileIdsCache = undefined;
    this._tileStates.set(state.tileId, this._createTileState(
      state.tileFeatureIndex,
      state.buckets,
      state.layers,
      state.atlas,
      state.mode,
      state.layerKey,
      state.atlasVersion,
      state.styleRevision,
      state.styleMutationRevision,
      state.styleZoom,
      state.patternGeometry,
    ));
    update.added.push(...state.addedPrimitives);
    update.parents = new Map(state.entries.map(entry => [entry.primitive, entry.collection]));
    // The live tile owns the original entries array. Disconnect the build
    // handle without truncating that array or any Native geometry input.
    state.entries = [];
    state.addedPrimitives = new Set();
    state.layerResume = undefined;
    state.radialOffsetCache = undefined;
    state.atlasState = undefined;
    return update;
  }

  /**
   * Drop an unfinished staged build: detach staged primitives (never shown)
   * and release their shared material references plus the build hold taken
   * in beginPatternBuild. Abandoned builds hold no tile-map state, so
   * nothing else needs unwinding.
   */
  abandonPatternBuild(state: PatternBuildState): void {
    const retired = this._retireEntries(state.entries, false);
    for (const primitive of retired.removed) {
      primitive.destroy();
    }
    if (state.atlasState) {
      destroyPendingPatternGroups(state.atlasState, state.layerResume);
      this._shared.release(state.atlasState.key);
      if (!this._shared.has(state.atlasState.key)) {
        this._atlases.delete(state.atlasState.key);
      }
    }
    for (const material of retired.removedMaterials) {
      if (!material.isDestroyed()) {
        material.destroy();
      }
    }
    for (const staged of state.staged) {
      if (!staged.staging.isDestroyed()) {
        staged.staging.destroy();
      }
    }
    state.entries = [];
    state.staged = [];
    state.addedPrimitives = new Set();
    state.layerResume = undefined;
    state.radialOffsetCache = undefined;
    state.atlasState = undefined;
  }

  /**
   * @internal
   */
  private _renderLayer(
    tileId: string,
    sourceId: string | undefined,
    tileID: TileID,
    tileFeatureIndex: FeatureIndex | undefined,
    bucket: FillBucket | LineBucket | FillExtrusionBucket,
    layer: PatternStyleLayer,
    atlas: ImageAtlas,
    atlasState: PatternAtlasEntry,
    collection: PrimitiveCollection,
    offset: number,
    styleZoom: number | undefined,
    mode: SceneMode | undefined,
    layerKey: string,
    atlasVersion: string,
    styleRevision: number,
    styleMutationRevision: number,
    radialOffsetCache: RadialOffsetCache,
    resume?: PatternFillResume,
    budget?: Budget,
  ): { entries: PatternPrimitiveEntry[]; resume?: PatternFillResume } {
    const entries: PatternPrimitiveEntry[] = [];
    const planar = mode !== undefined && mode !== SceneMode.SCENE3D;
    const materialFor = (rect: PatternAtlasRect, opacity: number): { material: Material; key: string } => {
      const key = patternMaterialKey(rect, opacity);
      let entry = atlasState.materials.get(key);
      if (!entry) {
        entry = { material: patternMaterial(atlasState.source, rect, opacity, atlas), refs: 0 };
        atlasState.materials.set(key, entry);
        // One GPU texture per atlas content: every material sampling this
        // canvas adopts the shared texture (which Cesium uses verbatim)
        // instead of minting its own full-atlas upload on first render.
        this._shared.track(atlasState.key, entry.material, 'image');
      }
      return { material: entry.material, key };
    };
    const groups = resume?.groups ?? new Map<string, PatternGeometryGroup>();
    const addToGroup = (entry: PendingPatternEntry): void => {
      let group = groups.get(entry.materialKey);
      if (!group) {
        group = {
          material: entry.material,
          materialKey: entry.materialKey,
          opacity: entry.opacity,
          geometryInstances: [],
          entries: [],
        };
        groups.set(entry.materialKey, group);
        // A suspended group already uses this material. Sealing transfers
        // this one reference to its primitive rather than acquiring another.
        atlasState.materials.get(entry.materialKey)!.refs++;
      }
      group.geometryInstances.push(entry.geometryInstance);
      group.entries.push(entry);
    };
    const pickTileId = sourceId ? `${sourceId}/${tileID.key}` : tileID.key;
    const makeId = (featureIndex: number): PatternPrimitiveID => ({
      type: 'pattern',
      tileId: pickTileId,
      layerId: layer.id,
      featureIndex,
      tileFeatureIndex,
    });

    if (bucket instanceof FillBucket) {
      // The fill branch dominates pattern build time (pattern-space UV
      // mapping plus a radial walk per feature), so only it suspends
      // mid-layer; the line/extrusion branches below stay atomic.
      // Groups accumulate across suspends and finalize once, at layer end.
      const geometries = fillBucketPrimitives(bucket, tileID, mode, 'pattern');
      const startIndex = resume?.fillIndex ?? 0;
      let first = resume === undefined;
      for (let gi = startIndex; gi < geometries.length; gi++) {
        if (!first && budget?.exhausted) {
          return { entries, resume: { fillIndex: gi, groups } };
        }
        first = false;
        const geometry = geometries[gi];
        const rect = rectForFeature(bucket, layer, geometry.featureIndex, atlas);
        if (!rect) {
          continue;
        }
        const opacity = fillPatternOpacityForFeature(bucket, geometry.featureIndex, layer.id, styleZoom);
        if (opacity <= 0) {
          continue;
        }
        const id = makeId(geometry.featureIndex);
        const material = materialFor(rect, opacity);
        addToGroup({
          geometryInstance: new GeometryInstance({
            geometry: surfaceGeometry(
              radialOffsetPositions(geometry.positions, offset, radialOffsetCache),
              geometry.tilePositions,
              geometry.triangles,
              rect,
              tileID,
            ),
            id,
          }),
          material: material.material,
          materialKey: material.key,
          opacity,
          id,
          styleSignature: patternStyleSignature(bucket, layer, geometry.featureIndex, atlas, styleZoom) ?? '',
        });
      }
    }
    else if (bucket instanceof LineBucket) {
      for (const geometry of lineBucketPrimitives(bucket, tileID, mode)) {
        const style = lineStyleForFeature(bucket, geometry.featureIndex, layer.id, styleZoom);
        const opacity = linePatternOpacityForFeature(bucket, geometry.featureIndex, layer.id, styleZoom);
        if (geometry.positions.length < 6 || style.widthPx <= 0 || opacity <= 0) {
          continue;
        }
        const id = makeId(geometry.featureIndex);
        const rect = rectForFeature(bucket, layer, geometry.featureIndex, atlas);
        if (!rect) {
          continue;
        }
        const lineGeometry = patternLineGeometry(
          radialOffsetPositions(geometry.positions, offset, radialOffsetCache),
          Math.max(1, Math.min(255, style.widthPx * this.pixelRatio)),
          lineRepeatX(geometry.tilePositions, rect, tileID),
        );
        if (!lineGeometry) {
          continue;
        }
        const material = materialFor(rect, opacity);
        addToGroup({
          geometryInstance: new GeometryInstance({
            geometry: lineGeometry,
            id,
          }),
          material: material.material,
          materialKey: material.key,
          opacity,
          id,
          styleSignature: patternStyleSignature(bucket, layer, geometry.featureIndex, atlas, styleZoom) ?? '',
        });
      }
    }
    else {
      for (const geometry of extrusionBucketPrimitives(bucket, tileID, layer.id, mode, styleZoom)) {
        const rect = rectForFeature(bucket, layer, geometry.featureIndex, atlas);
        if (!rect || geometry.triangles.length === 0) {
          continue;
        }
        const opacity = extrusionPatternOpacityForFeature(bucket, geometry.featureIndex, layer.id, styleZoom);
        if (opacity <= 0) {
          continue;
        }
        const id = makeId(geometry.featureIndex);
        const material = materialFor(rect, opacity);
        addToGroup({
          geometryInstance: new GeometryInstance({
            geometry: surfaceGeometry(
              radialOffsetPositions(geometry.positions, offset, radialOffsetCache),
              geometry.tilePositions,
              geometry.triangles,
              rect,
              tileID,
            ),
            id,
          }),
          material: material.material,
          materialKey: material.key,
          opacity,
          id,
          styleSignature: patternStyleSignature(bucket, layer, geometry.featureIndex, atlas, styleZoom) ?? '',
        });
      }
    }

    const paintRevision = bucket.programConfigurations.paintRevision;
    const zoomDependentPaint = bucket.programConfigurations.hasCompositeProperties();
    for (const group of groups.values()) {
      const primitive = patternPrimitive(group, bucket instanceof LineBucket, bucket instanceof FillExtrusionBucket && !planar);
      registerDrawBatch(primitive, {
        layerId: layer.id,
        tileId,
        kind: bucket instanceof FillExtrusionBucket ? 'extrusion' : 'pattern',
      });
      collection.add(primitive);
      // One byte count per group: every entry of the group shares the same
      // primitive and geometries.
      let groupBytes = 0;
      for (const instance of group.geometryInstances) {
        if (instance.geometry) {
          groupBytes += geometryBytes(instance.geometry);
        }
      }
      for (const pending of group.entries) {
        entries.push({
          primitive,
          paintVisible: primitive.show,
          material: group.material,
          materialKey: group.materialKey,
          atlasKey: atlasState.key,
          atlasVersion,
          tileId,
          collection,
          id: pending.id,
          layer,
          styleZoom,
          styleRevision,
          styleMutationRevision,
          paintRevision,
          zoomDependentPaint,
          mode,
          layerKey,
          styleSignature: pending.styleSignature,
          bytes: groupBytes,
        });
      }
    }
    return { entries };
  }

  removeTile(tileId: string): PatternTileUpdate {
    this._hiddenTiles.delete(tileId);
    const entries = this._tiles.get(tileId);
    // A retired tile dropped by direct removal (style teardown paths) must
    // release and destroy like an eviction, not leak.
    const evictedMaterials = this._evictRetiredEntry(tileId);
    if (!entries) {
      return { removed: [], added: [], removedMaterials: evictedMaterials };
    }
    const released = this._retireEntries(entries);
    this._tiles.delete(tileId);
    this._tileIdsCache = undefined;
    this._tileStates.delete(tileId);
    return {
      removed: released.removed,
      added: [],
      removedMaterials: [...released.removedMaterials, ...evictedMaterials],
    };
  }

  /**
   * Maximum retired (out-of-view) tiles, mirroring
   * VectorTileRenderer.MAX_RETIRED_TILES. Retired entries keep their primitives
   * (detached from the layer collections) and shared atlas refs, so a
   * pan-back re-attaches without rebuilding or re-uploading.
   */
  static readonly MAX_RETIRED_TILES = 64;

  private _retired = new RetiredPool<PatternPrimitiveEntry[]>(PatternTileRenderer.MAX_RETIRED_TILES);

  /**
   * Take a retired entry, releasing and destroying it like an eviction.
   * @internal
   */
  private _evictRetiredEntry(tileId: string): Material[] {
    const retired = this._retired.take(tileId);
    return retired ? this._evictRetiredEntries(tileId, retired) : [];
  }

  /**
   * @internal
   */
  private _evictRetiredEntries(tileId: string, entries: PatternPrimitiveEntry[]): Material[] {
    // A completed state is owned by its live or pooled entries, including
    // legitimate empty tiles. Replacing a pooled owner must preserve the
    // state of a newer live/pooled owner with the same key.
    if (!this._tiles.has(tileId) && !this._retired.get(tileId)) {
      this._tileStates.delete(tileId);
    }
    return this._evictEntries(entries);
  }

  /**
   * Cache a live tile's entries out of the scene. Primitives detach from
   * their layer collections but stay alive under the entry's retained atlas
   * refs; returns only LRU-evicted materials for destruction (the detached
   * primitives are pooled, never destroyed - routing them through the
   * removal queue would destroy the pool).
   */
  retireTile(tileId: string): PatternTileUpdate {
    const entries = this._tiles.get(tileId);
    if (!entries) {
      // No live entries: a leftover retired entry is gone for good, release
      // it instead of dropping its refs silently.
      return { removed: [], added: [], removedMaterials: this._evictRetiredEntry(tileId) };
    }
    this.setTileVisible(tileId, true);
    const seen = new Set<Primitive>();
    for (const entry of entries) {
      if (seen.has(entry.primitive)) {
        continue;
      }
      seen.add(entry.primitive);
      entry.collection.remove(entry.primitive);
    }
    this._tiles.delete(tileId);
    this._tileIdsCache = undefined;
    // The pooled entries keep their completed state for a cheap restore.
    const removedMaterials: Material[] = [];
    for (const gone of this._retired.retire(tileId, entries)) {
      removedMaterials.push(...this._evictRetiredEntries(gone.key, gone.value));
    }
    return { removed: [], added: [], removedMaterials };
  }

  /**
   * Re-attach a retired tile's primitives to their layer collections.
   * Returns false when nothing was retired (caller falls through to a full
   * build). No rebuild, no re-upload: refs never left.
   */
  restoreTile(tileId: string): boolean {
    const entries = this._retired.take(tileId);
    if (!entries) {
      return false;
    }
    const seen = new Set<Primitive>();
    for (const entry of entries) {
      if (seen.has(entry.primitive)) {
        continue;
      }
      seen.add(entry.primitive);
      if (!entry.primitive.isDestroyed()) {
        entry.collection.add(entry.primitive);
      }
    }
    this._tiles.set(tileId, entries);
    this._tileIdsCache = undefined;
    return true;
  }

  /** Drop retired entries (style/layer change invalidates pooled paints). */
  clearRetired(): PatternTileUpdate {
    const removedMaterials: Material[] = [];
    for (const [tileId] of this._retired.entries()) {
      removedMaterials.push(...this._evictRetiredEntry(tileId));
    }
    return { removed: [], added: [], removedMaterials };
  }

  /**
   * Rescale the retired pool from the renderable footprint (see
   * retiredPoolCapacity); shrinking past the new capacity evicts
   * oldest-first for destruction.
   */
  setRetiredCapacity(capacity: number): PatternTileUpdate {
    const removedMaterials: Material[] = [];
    for (const gone of this._retired.setCapacity(capacity)) {
      removedMaterials.push(...this._evictRetiredEntries(gone.key, gone.value));
    }
    return { removed: [], added: [], removedMaterials };
  }

  /**
   * Release a retired entry for good: detach (no-op when already detached),
   * release shared refs, destroy the orphaned primitives, and return
   * orphaned materials for tileset destruction.
   * @internal
   */
  private _evictEntries(entries: PatternPrimitiveEntry[]): Material[] {
    const released = this._retireEntries(entries);
    for (const primitive of released.removed) {
      if (!primitive.isDestroyed()) {
        primitive.destroy();
      }
    }
    return released.removedMaterials;
  }

  /**
   * Detach entries' primitives from their collections and release their
   * material references. Shared by removeTile and by abandoning a staged
   * build (whose entries were assembled detached and must never reach the
   * tile maps). Atlas refs are released only for committed tiles: an
   * abandoned build never converted its build hold into per-primitive refs,
   * so releasing per entry would drive the shared count negative.
   * @internal
   */
  private _retireEntries(entries: PatternPrimitiveEntry[], releaseAtlasRefs = true): { removed: Primitive[]; removedMaterials: Material[] } {
    const removed: Primitive[] = [];
    const removedPrimitives = new Set<Primitive>();
    for (const entry of entries) {
      if (removedPrimitives.has(entry.primitive)) {
        continue;
      }
      removedPrimitives.add(entry.primitive);
      removed.push(entry.primitive);
      entry.collection.remove(entry.primitive);
    }

    const removedMaterials: Material[] = [];
    const atlasCounts = new Map<string, number>();
    const releasedPrimitives = new Set<Primitive>();
    for (const entry of entries) {
      if (releasedPrimitives.has(entry.primitive)) {
        continue;
      }
      releasedPrimitives.add(entry.primitive);
      if (releaseAtlasRefs) {
        atlasCounts.set(entry.atlasKey, (atlasCounts.get(entry.atlasKey) ?? 0) + 1);
      }
      const state = this._atlases.get(entry.atlasKey);
      const material = state && detachPatternMaterial(state, entry.materialKey);
      if (material) {
        removedMaterials.push(material);
      }
    }
    for (const [atlasKey, count] of atlasCounts) {
      const state = this._atlases.get(atlasKey);
      if (!state) {
        continue;
      }
      for (let i = 0; i < count; i++) {
        this._shared.release(atlasKey);
      }
      if (!this._shared.has(atlasKey)) {
        for (const material of state.materials.values()) {
          removedMaterials.push(material.material);
        }
        state.materials.clear();
        this._atlases.delete(atlasKey);
      }
    }
    return {
      removed,
      removedMaterials: [...new Set(removedMaterials)],
    };
  }

  hasPickObject(id: PatternPrimitiveID): boolean {
    return this._tiles.get(id.tileId)?.some(entry => entry.id === id) ?? false;
  }

  /** Adopt shared atlas textures before Native creates each material's texture. */
  update(context: unknown): void {
    this._shared.adopt(context as { [key: string]: unknown } | undefined);
  }

  clear(): PatternTileUpdate {
    const result: PatternTileUpdate = { removed: [], added: [], removedMaterials: [] };
    for (const tileId of [...this._tiles.keys()]) {
      const update = this.removeTile(tileId);
      result.removed.push(...update.removed);
      result.removedMaterials.push(...update.removedMaterials);
    }
    const retired = this.clearRetired();
    result.removedMaterials.push(...retired.removedMaterials);
    return result;
  }
}

export function destroyPatternResources(update: PatternTileUpdate): void {
  for (const primitive of update.removed) {
    if (!primitive.isDestroyed()) {
      primitive.destroy();
    }
  }
  for (const material of new Set(update.removedMaterials)) {
    if (!material.isDestroyed()) {
      material.destroy();
    }
  }
}
