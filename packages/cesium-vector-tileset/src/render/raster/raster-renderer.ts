import type {
  PrimitiveCollection,

  SceneMode,
} from 'cesium';
import type { RasterStyleLayer } from '../../style/style-layer/raster-style-layer';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { MemoryBudgetVisitor } from '../scene/gpu-memory-budget';
import type { RetainedSurface } from '../scene/scene-collections';
import type { RasterPrimitiveGeometry, RasterStyle, RasterTileCoordinate } from './raster-geometry';
import * as cesium from 'cesium';
import {
  BoundingSphere,
  Cartesian3,
  ComponentDatatype,
  EllipsoidSurfaceAppearance,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  Material,
  Primitive,
  PrimitiveType,
  ShowGeometryInstanceAttribute,
  TextureMagnificationFilter,
  TextureMinificationFilter,
} from 'cesium';
import { registerDrawBatch } from '../scene/draw-batch';
import { LayerCollections } from '../scene/layer-collections';
import { collectionGpuBytes } from '../scene/resource-memory';
import {
  RASTER_SURFACE_OFFSET_M,
  rasterGeometryKey,
  rasterPrimitiveGeometry,
  rasterStyle,
} from './raster-geometry';

type TileID = CanonicalTileID | OverscaledTileID;

export type RasterTextureData = HTMLImageElement | ImageBitmap | HTMLCanvasElement | HTMLVideoElement | ImageData;
type RasterMaterialImage = RasterTextureData | OffscreenCanvas;
type TextureSource = HTMLImageElement | ImageBitmap | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas;

export interface RasterPrimitiveID {
  type: 'raster';
  tileId: string;
  layerId: string;
}

export type RasterPrimitivePickObject = RasterPrimitiveID;

interface RasterTileGeometry {
  tileId: string;
  tileID: TileID;
  layerId: string;
  geometryKey: string;
  tileCoordinates?: readonly RasterTileCoordinate[];
  flippedWindingOrder: boolean;
  mode?: SceneMode;
}

interface StaticRasterEntry extends RasterTileGeometry {
  type: 'static';
  primitive: Primitive;
  collection: PrimitiveCollection;
  layer: RasterStyleLayer;
  sourceIdentity: RasterMaterialImage;
  material: Material;
  width: number;
  height: number;
  resampling: RasterStyle['resampling'];
  styleKey: string;
}

interface DynamicRasterEntry extends RasterTileGeometry {
  type: 'dynamic';
  batch: DynamicRasterBatch;
  instanceId: RasterPrimitiveID;
  show: ShowGeometryInstanceAttribute;
}

type RasterPrimitiveEntry = StaticRasterEntry | DynamicRasterEntry;

interface DynamicRasterBatch {
  key: string;
  sealed: boolean;
  sourceIdentity: RasterMaterialImage;
  image: TextureSource;
  layer: RasterStyleLayer;
  collection: PrimitiveCollection;
  entries: Map<string, DynamicRasterEntry>;
  primitive?: Primitive;
  material?: RasterImageMaterial;
  width: number;
  height: number;
  resampling: RasterStyle['resampling'];
  styleKey: string;
}

interface TextureHandle {
  width: number;
  height: number;
  sampler: object;
  copyFrom: (options: { source: TextureSource }) => void;
}

type MaterialOptions = NonNullable<ConstructorParameters<typeof Material>[0]>;
type RasterSamplerOptions = Pick<MaterialOptions, 'minificationFilter' | 'magnificationFilter'>;

// Native exports Texture and Sampler, and implements Material.update, without
// declaring them in Cesium.d.ts. Keep this integration contract local.
interface CesiumRuntime {
  Texture: new (options: { context: object; source: TextureSource; sampler: object }) => TextureHandle;
  Sampler: new (options: RasterSamplerOptions) => object;
}

const Texture = (cesium as unknown as CesiumRuntime).Texture;
const Sampler = (cesium as unknown as CesiumRuntime).Sampler;
declare class _NativeMaterial extends Material {
  protected _textures: Record<string, TextureHandle>;
  protected _defaultTexture?: TextureHandle;
  update(context: object): void;
}
const RuntimeMaterial = Material as typeof _NativeMaterial;

/** Decoded raster pixels must be available during the material's first update. */
class RasterImageMaterial extends RuntimeMaterial {
  private _pendingSource?: TextureSource;

  private _texture?: TextureHandle;

  constructor(image: TextureSource, options: MaterialOptions) {
    super(options);
    // Native videos upload synchronously and gate frames on readyState.
    if (!(typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement))
      this._pendingSource = image;
    this.uniforms.image = image;
  }

  override update(context: object): void {
    if (this._pendingSource) {
      // Native queues decoded images after consuming its upload queue. Upload
      // directly so this same update adopts real pixels before any draw. Use
      // the same Texture defaults (flipY and straight alpha) as Material.
      this._texture = new Texture({
        context,
        source: this._pendingSource,
        sampler: new Sampler({
          minificationFilter: this.minificationFilter,
          magnificationFilter: this.magnificationFilter,
        }),
      });
      this.uniforms.image = this._texture;
      this._pendingSource = undefined;
    }
    super.update(context);
  }

  /** Copy changing pixels into the texture created and adopted by this material. */
  copyImage(source: TextureSource): void {
    if (!this._texture)
      return;
    const dimensions = sourceDimensions(source);
    if (dimensions.width !== this._texture.width || dimensions.height !== this._texture.height) {
      // Native adopts the new uniform Texture and destroys the previous one
      // in the same material update, before submitting commands.
      this._pendingSource = source;
      return;
    }
    this._pendingSource = undefined;
    this._texture.copyFrom({ source });
  }

  setResampling(resampling: RasterStyle['resampling']): void {
    const nearest = resampling === 'nearest';
    this.minificationFilter = nearest ? TextureMinificationFilter.NEAREST : TextureMinificationFilter.LINEAR;
    this.magnificationFilter = nearest ? TextureMagnificationFilter.NEAREST : TextureMagnificationFilter.LINEAR;
    const texture = this._textures.image;
    if (texture && texture !== this._defaultTexture) {
      texture.sampler = new Sampler({
        minificationFilter: this.minificationFilter,
        magnificationFilter: this.magnificationFilter,
      });
    }
  }

  override destroy(): void {
    this._pendingSource = undefined;
    this._texture = undefined;
    this.uniforms.image = Material.DefaultImageId;
    // Native Material owns and destroys the adopted texture.
    super.destroy();
  }
}

export interface RasterTileUpdate {
  /** Resources detached from the collection and safe to destroy after the frame. */
  removed: Primitive[];
  /** Resources created for the tile. */
  added: Primitive[];
  /** Materials own the Cesium textures and must be destroyed with the primitive. */
  removedMaterials: Material[];
  /** At least one tile is mid-crossfade: keep frames coming until it completes. */
  fading?: boolean;
  tileId?: string;
  parents?: ReadonlyMap<Primitive, PrimitiveCollection>;
  retained?: RetainedSurface;
  /** A rebuilt batch replaces the physical owner for all its logical tiles. */
  replacedOwners?: Array<{ previous: Primitive; next: Primitive; parent: PrimitiveCollection; tileIds: ReadonlySet<string> }>;
  /** A ready owner kept its geometry while adopting a resized texture. */
  textureChanged?: boolean;
}

/**
 * Cesium material source matching MapLibre's raster fragment shader.
 * The image is sampled once and the paint operations are kept in the shader so
 * changing a layer does not require a CPU readback or an image copy. Cesium's
 * Material creates its image texture with preMultiplyAlpha=false, so the
 * sampled RGB is already straight-alpha and must not go through MapLibre's
 * unpremultiplication step. EllipsoidSurfaceAppearance then uses straight
 * alpha in the material and ALPHA_BLEND, which produces the same premultiplied
 * framebuffer contribution as MapLibre's PRE_MULTIPLIED_ALPHA_BLEND pass.
 */
export const RASTER_MATERIAL_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    vec4 rasterColor = texture(image, materialInput.st);

    vec3 rgb = rasterColor.rgb;
    rgb = vec3(
        dot(rgb, spinWeights.xyz),
        dot(rgb, spinWeights.zxy),
        dot(rgb, spinWeights.yzx));

    float average = (rasterColor.r + rasterColor.g + rasterColor.b) / 3.0;
    rgb += (average - rgb) * saturationFactor;
    rgb = (rgb - 0.5) * contrastFactor + 0.5;

    vec3 brightnessLow = vec3(brightnessMin);
    vec3 brightnessHigh = vec3(brightnessMax);
    material.diffuse = mix(brightnessLow, brightnessHigh, rgb);
    material.alpha = rasterColor.a * opacity * u_fade;
    return material;
}
`;

function spinWeights(angle: number): Cartesian3 {
  const radians = angle * Math.PI / 180;
  const sine = Math.sin(radians);
  const cosine = Math.cos(radians);
  return new Cartesian3(
    (2 * cosine + 1) / 3,
    (-Math.sqrt(3) * sine - cosine + 1) / 3,
    (Math.sqrt(3) * sine - cosine + 1) / 3,
  );
}

function saturationFactor(saturation: number): number {
  return saturation > 0 ? 1 - 1 / (1.001 - saturation) : -saturation;
}

const imageDataCanvasCache = new WeakMap<ImageData, HTMLCanvasElement | OffscreenCanvas>();

function contrastFactor(contrast: number): number {
  return contrast > 0 ? 1 / (1 - contrast) : 1 + contrast;
}

function imageDataToCanvas(image: ImageData): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('A 2D canvas context is required to upload ImageData raster tiles');
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('A 2D canvas context is required to upload ImageData raster tiles');
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }
  throw new Error('ImageData raster tiles require OffscreenCanvas or a document');
}

function normalizeTextureData(image: RasterTextureData): TextureSource {
  if (typeof ImageData !== 'undefined' && image instanceof ImageData) {
    const cached = imageDataCanvasCache.get(image);
    if (cached) {
      return cached;
    }
    const canvas = imageDataToCanvas(image);
    imageDataCanvasCache.set(image, canvas);
    return canvas;
  }
  return image as TextureSource;
}

function sourceDimensions(image: TextureSource): { width: number; height: number } {
  const source = image as TextureSource & {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
  };
  return {
    width: source.videoWidth || source.naturalWidth || source.width,
    height: source.videoHeight || source.naturalHeight || source.height,
  };
}

function setRasterUniforms(material: Material, style: RasterStyle): void {
  material.uniforms.opacity = style.opacity;
  material.uniforms.brightnessMin = style.brightnessMin;
  material.uniforms.brightnessMax = style.brightnessMax;
  material.uniforms.saturationFactor = saturationFactor(style.saturation);
  material.uniforms.contrastFactor = contrastFactor(style.contrast);
  material.uniforms.spinWeights = spinWeights(style.hueRotate);
}

function rasterStyleKey(style: RasterStyle): string {
  return `${style.opacity}|${style.brightnessMin}|${style.brightnessMax}|${style.contrast}|${style.saturation}|${style.hueRotate}|${style.resampling}`;
}

export function rasterMaterial(image: RasterMaterialImage, style: RasterStyle): RasterImageMaterial {
  const filter = style.resampling === 'nearest';
  const options: MaterialOptions = {
    translucent: true,
    minificationFilter: filter ? TextureMinificationFilter.NEAREST : TextureMinificationFilter.LINEAR,
    magnificationFilter: filter ? TextureMagnificationFilter.NEAREST : TextureMagnificationFilter.LINEAR,
    fabric: {
      uniforms: {
        image: Material.DefaultImageId,
        opacity: style.opacity,
        u_fade: 1,
        brightnessMin: style.brightnessMin,
        brightnessMax: style.brightnessMax,
        saturationFactor: saturationFactor(style.saturation),
        contrastFactor: contrastFactor(style.contrast),
        spinWeights: spinWeights(style.hueRotate),
      },
      source: RASTER_MATERIAL_SOURCE,
    },
  };
  const normalizedImage = normalizeTextureData(image as RasterTextureData);
  return new RasterImageMaterial(normalizedImage, options);
}

export function rasterGeometry(
  tileID: TileID,
  surfaceOffset = RASTER_SURFACE_OFFSET_M,
  tileCoordinates?: readonly RasterTileCoordinate[],
  flippedWindingOrder = false,
  mode?: SceneMode,
): Geometry {
  const geometryData: RasterPrimitiveGeometry = rasterPrimitiveGeometry(
    tileID,
    undefined,
    surfaceOffset,
    tileCoordinates,
    flippedWindingOrder,
    mode,
  );
  const attributes: Geometry['attributes'] = {
    position: new GeometryAttribute({
      componentDatatype: ComponentDatatype.DOUBLE,
      componentsPerAttribute: 3,
      values: geometryData.positions,
    }),
    st: new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 2,
      values: geometryData.st,
    }),
    normal: undefined,
    bitangent: undefined,
    tangent: undefined,
    color: undefined,
  };
  return new Geometry({
    attributes,
    indices: geometryData.indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(geometryData.positions),
  });
}

interface BuiltRasterPrimitive {
  primitive: Primitive;
  material: Material;
  image: TextureSource;
}

function rasterAppearance(material: Material): EllipsoidSurfaceAppearance {
  return new EllipsoidSurfaceAppearance({
    material,
    flat: true,
    faceForward: true,
    translucent: true,
    aboveGround: false,
  });
}

function buildRasterPrimitive(
  tileID: TileID,
  image: RasterMaterialImage,
  layer: RasterStyleLayer,
  tileId = tileID.key,
  surfaceOffset = RASTER_SURFACE_OFFSET_M,
  tileCoordinates?: readonly RasterTileCoordinate[],
  flippedWindingOrder = false,
  mode?: SceneMode,
): BuiltRasterPrimitive | undefined {
  const style = rasterStyle(layer);
  if (style.opacity <= 0) {
    return undefined;
  }

  const normalizedImage = normalizeTextureData(image as RasterTextureData);
  const material = rasterMaterial(normalizedImage, style);
  const primitive = new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: rasterGeometry(tileID, surfaceOffset, tileCoordinates, flippedWindingOrder, mode),
      id: { type: 'raster', tileId, layerId: layer.id } satisfies RasterPrimitiveID,
    }),
    appearance: rasterAppearance(material),
    allowPicking: true,
    asynchronous: false,
    compressVertices: true,
  });
  registerDrawBatch(primitive, { layerId: layer.id, tileId, kind: 'raster' });
  return { primitive, material, image: normalizedImage };
}

/**
 * Owns raster primitives separately from vector Buffer*Collections. A layer
 * collection is inserted in style order by the tileset, while tile primitives
 * can arrive asynchronously without changing that order.
 */
export interface RasterSourceGeometry {
  type?: string;
  animate?: boolean;
  tileCoords?: readonly RasterTileCoordinate[];
  flippedWindingOrder?: boolean;
}

export function rasterSourceInfo(source: unknown): {
  dynamic: boolean;
  tileCoords?: readonly RasterTileCoordinate[];
  flippedWindingOrder?: boolean;
} {
  const raster = source as RasterSourceGeometry | undefined;
  return {
    dynamic: raster?.type === 'canvas' && raster.animate !== false,
    tileCoords: raster?.tileCoords,
    flippedWindingOrder: raster?.flippedWindingOrder,
  };
}

export class RasterTileRenderer {
  private readonly _layerCollections = new LayerCollections();

  private _layerOffsets = new Map<string, number>();

  private _tiles = new Map<string, RasterPrimitiveEntry[]>();

  private _tileIdsCache?: string[];

  private readonly _retained = new Set<RetainedSurface & { tileId: string; entries: RasterPrimitiveEntry[] }>();

  private _dynamicBatches = new Map<string, Set<DynamicRasterBatch>>();

  private _dynamicImageIds = new WeakMap<object, number>();

  private _nextDynamicImageId = 0;

  private _lastStyleRevision?: number;

  get collections(): ReadonlyMap<string, PrimitiveCollection> {
    return this._layerCollections.collections;
  }

  get tileIds(): ReadonlyArray<string> {
    return this._tileIdsCache ??= [...this._tiles.keys()];
  }

  /** Collect deleted empty parents after scene handoff releases have finished. */
  collectUnusedLayerCollections(): PrimitiveCollection[] {
    return this._layerCollections.collectUnused();
  }

  /** Live tile and layer-collection counts for diagnostics. */
  get stats(): { tiles: number; layerCollections: number } {
    return {
      tiles: this._tiles.size,
      layerCollections: this._layerCollections.collections.size,
    };
  }

  /**
   * Per-tile geometry and RGBA texture estimates. Dynamic batches share their
   * geometry and texture, attributed once to the first live tile using them.
   * Raster tiles are destroyed on leave, so every entry is live and
   * can never be an eviction target - reported pinned, which lets the tileset
   * skip the protected-set copy it used to build for raster keys.
   */
  visitMemoryEntries(visit: MemoryBudgetVisitor): void {
    const countedBatches = new Set<DynamicRasterBatch>();
    const totals = new Map<string, number>();
    const count = (tileId: string, entries: readonly RasterPrimitiveEntry[]): void => {
      let bytes = totals.get(tileId) ?? 0;
      for (const entry of entries) {
        if (entry.type === 'static') {
          bytes += entry.width * entry.height * 4 + collectionGpuBytes(entry.primitive);
        }
        else if (!countedBatches.has(entry.batch)) {
          countedBatches.add(entry.batch);
          bytes += entry.batch.width * entry.batch.height * 4;
          if (entry.batch.primitive)
            bytes += collectionGpuBytes(entry.batch.primitive);
        }
      }
      totals.set(tileId, bytes);
    };
    for (const [tileId, entries] of this._tiles)
      count(tileId, entries);
    for (const retained of this._retained)
      count(retained.tileId, retained.entries);
    for (const [tileId, bytes] of totals)
      visit(tileId, bytes, true);
  }

  setLayers(layers: readonly RasterStyleLayer[], layerOrder?: ReadonlyMap<string, number>): RasterTileUpdate {
    this._lastStyleRevision = undefined;
    this._layerCollections.setLayers(layers.map(layer => layer.id));
    const update: RasterTileUpdate = { removed: [], added: [], removedMaterials: [] };
    if (layerOrder) {
      for (const [tileId, entries] of this._tiles) {
        const deleted = entries.filter(entry => !layerOrder.has(entry.layerId));
        if (deleted.length > 0) {
          this._tiles.set(tileId, deleted);
          const removed = this.removeTile(tileId);
          update.removed.push(...removed.removed);
          update.added.push(...removed.added);
          update.removedMaterials.push(...removed.removedMaterials);
          (update.replacedOwners ??= []).push(...removed.replacedOwners ?? []);
          const kept = entries.filter(entry => layerOrder.has(entry.layerId));
          if (kept.length > 0) {
            this._tiles.set(tileId, kept);
          }
        }
      }
    }
    this._layerOffsets = new Map(layers.map((layer, index) => [
      layer.id,
      RASTER_SURFACE_OFFSET_M + (layerOrder?.get(layer.id) ?? index) * 0.01,
    ]));
    return update;
  }

  /** Read-only query; shared primitives may be visited more than once. */
  someTilePrimitive(tileId: string, predicate: (primitive: Primitive) => boolean): boolean {
    const entries = this._tiles.get(tileId);
    if (entries) {
      for (const entry of entries) {
        const primitive = entry.type === 'static' ? entry.primitive : entry.batch.primitive;
        if (primitive && predicate(primitive))
          return true;
      }
    }
    return false;
  }

  /**
   * @internal
   */
  private _retainTile(tileId: string): RasterTileUpdate['retained'] {
    const entries = this._tiles.get(tileId);
    if (!entries)
      return undefined;
    this._tiles.delete(tileId);
    this._tileIdsCache = undefined;
    const parents = new Map<Primitive, PrimitiveCollection>();
    const painted = new Set<RasterPrimitiveEntry>();
    for (const entry of entries) {
      const owner = entry.type === 'static' ? entry : entry.batch;
      if (owner.primitive) {
        parents.set(owner.primitive, owner.collection);
        if (owner.primitive.show && (entry.type === 'static' || entry.show.value[0] !== 0))
          painted.add(entry);
      }
      if (entry.type === 'dynamic')
        entry.batch.sealed = true;
    }
    const retained: RetainedSurface & { tileId: string; entries: RasterPrimitiveEntry[] } = {
      tileId,
      entries,
      parents,
      get visible() {
        return entries.some((entry) => {
          const primitive = entry.type === 'static' ? entry.primitive : entry.batch.primitive;
          return primitive && !primitive.isDestroyed() && primitive.show
            && (entry.type === 'static' || entry.show.value[0] !== 0);
        });
      },
      setVisible: (visible, hiddenLayers) => {
        if (!this._retained.has(retained))
          return;
        for (const entry of entries) {
          const show = visible && painted.has(entry) && !hiddenLayers?.has(entry.layerId);
          if (entry.type === 'static')
            entry.primitive.show = show;
          else
            this._setDynamicVisibility(entry, show);
        }
      },
      release: () => {
        if (!this._retained.delete(retained))
          return;
        for (const entry of entries) {
          if (entry.type === 'dynamic') {
            destroyRasterResources(this._removeDynamicEntry(entry));
          }
          else {
            entry.collection.remove(entry.primitive);
            destroyRasterResources({ removed: [entry.primitive], added: [], removedMaterials: [entry.material] });
          }
        }
      },
    };
    this._retained.add(retained);
    return retained;
  }

  /** Native show attributes hide one tile without changing the shared mesh owner. */
  private _setDynamicVisibility(entry: DynamicRasterEntry, visible: boolean): void {
    entry.show.value = ShowGeometryInstanceAttribute.toValue(visible, entry.show.value);
    const primitive = entry.batch.primitive;
    // Native creates the batch table on its first update, before public ready.
    // Before then the construction attribute itself is the authoritative input.
    if (primitive && !primitive.isDestroyed() && (primitive as Primitive & { _batchTable?: object })._batchTable) {
      primitive.getGeometryInstanceAttributes(entry.instanceId).show = entry.show.value;
    }
  }

  private _removeDynamicEntry(entry: DynamicRasterEntry): RasterTileUpdate {
    const batch = entry.batch;
    this._setDynamicVisibility(entry, false);
    batch.entries.delete(entry.tileId);
    if ((batch.sealed || batch.primitive?.ready) && batch.entries.size > 0)
      return { removed: [], added: [], removedMaterials: [] };
    return this._rebuildDynamicBatch(batch);
  }

  takeDisplacedTile(tileId: string, layers: readonly RasterStyleLayer[]): RasterTileUpdate['retained'] {
    const entries = this._tiles.get(tileId);
    if (!entries || entries.every(entry => layers.some(layer => layer.id === entry.layerId))) {
      return undefined;
    }
    return this._retainTile(tileId);
  }

  /**
   * @internal
   */
  private _dynamicBatchKey(image: RasterMaterialImage, layerId: string, mode?: SceneMode): string {
    let imageId = this._dynamicImageIds.get(image);
    if (imageId === undefined) {
      imageId = this._nextDynamicImageId++;
      this._dynamicImageIds.set(image, imageId);
    }
    return `${imageId}/${layerId}/${mode ?? 'legacy'}`;
  }

  addTile(
    tileId: string,
    tileID: TileID,
    image: RasterMaterialImage | undefined,
    layers: readonly RasterStyleLayer[],
    dynamic = false,
    tileCoordinates?: readonly RasterTileCoordinate[],
    flippedWindingOrder = false,
    mode?: SceneMode,
  ): RasterTileUpdate {
    const added: Primitive[] = [];
    if (!image) {
      // ImageSource and CanvasSource publish the tile event before prepare()
      // fills textureData. Keep an existing image until the tileset's post-
      // prepare hydrate pass supplies the actual source.
      return { removed: [], added, removedMaterials: [] };
    }

    const geometryKey = rasterGeometryKey(tileCoordinates, flippedWindingOrder, mode);
    const existing = this._tiles.get(tileId);
    const sameTile = existing
      && existing.length === layers.length
      && existing.every((entry, index) => entry.layerId === layers[index]?.id
        && (entry.type === 'dynamic' ? dynamic && entry.batch.sourceIdentity === image : !dynamic && entry.sourceIdentity === image)
        && entry.geometryKey === geometryKey);
    if (sameTile) {
      return { removed: [], added, removedMaterials: [] };
    }

    const retained = this._retainTile(tileId);
    const removed = this.removeTile(tileId);
    if (dynamic) {
      const update = this._addDynamicTile(
        tileId,
        tileID,
        image,
        layers,
        tileCoordinates,
        flippedWindingOrder,
        mode,
        removed,
      );
      const parents = new Map<Primitive, PrimitiveCollection>();
      for (const entry of this._tiles.get(tileId) ?? []) {
        if (entry.type === 'dynamic' && entry.batch.primitive)
          parents.set(entry.batch.primitive, entry.batch.collection);
      }
      return { ...update, tileId, retained, parents };
    }
    // ImageData is converted once per tile and shared by every raster layer.
    // Converting it inside buildRasterPrimitive would allocate one canvas per
    // layer and multiply both CPU and GPU upload work.
    const normalizedImage = normalizeTextureData(image as RasterTextureData);

    const entries: StaticRasterEntry[] = [];
    for (const layer of layers) {
      const collection = this._layerCollections.collections.get(layer.id);
      if (!collection) {
        continue;
      }
      const built = buildRasterPrimitive(
        tileID,
        normalizedImage,
        layer,
        tileId,
        this._layerOffsets.get(layer.id) ?? RASTER_SURFACE_OFFSET_M,
        tileCoordinates,
        flippedWindingOrder,
        mode,
      );
      if (!built) {
        continue;
      }
      const dimensions = sourceDimensions(built.image);
      const primitive = built.primitive;
      collection.add(primitive);
      const style = rasterStyle(layer);
      entries.push({
        type: 'static',
        layerId: layer.id,
        primitive,
        collection,
        tileId,
        tileID,
        layer,
        sourceIdentity: image,
        material: built.material,
        width: dimensions.width,
        height: dimensions.height,
        resampling: style.resampling,
        styleKey: rasterStyleKey(style),
        geometryKey,
        tileCoordinates,
        flippedWindingOrder,
        mode,
      });
      added.push(primitive);
    }
    if (entries.length > 0) {
      this._tiles.set(tileId, entries);
      this._tileIdsCache = undefined;
    }
    return { ...removed, tileId, added, retained, parents: new Map(entries.map(entry => [entry.primitive, entry.collection])) };
  }

  /**
   * @internal
   */
  private _addDynamicTile(
    tileId: string,
    tileID: TileID,
    image: RasterMaterialImage,
    layers: readonly RasterStyleLayer[],
    tileCoordinates: readonly RasterTileCoordinate[] | undefined,
    flippedWindingOrder: boolean,
    mode: SceneMode | undefined,
    removed: RasterTileUpdate,
  ): RasterTileUpdate {
    const update: RasterTileUpdate = {
      removed: [...removed.removed],
      added: [],
      removedMaterials: [...removed.removedMaterials],
    };
    const normalizedImage = normalizeTextureData(image as RasterTextureData);
    const dimensions = sourceDimensions(normalizedImage);
    const geometryKey = rasterGeometryKey(tileCoordinates, flippedWindingOrder, mode);
    const entries: DynamicRasterEntry[] = [];
    const changedBatches = new Set<DynamicRasterBatch>();

    for (const layer of layers) {
      const collection = this._layerCollections.collections.get(layer.id);
      if (!collection) {
        continue;
      }
      const batchKey = this._dynamicBatchKey(image, layer.id, mode);
      let batches = this._dynamicBatches.get(batchKey);
      if (!batches) {
        batches = new Set();
        this._dynamicBatches.set(batchKey, batches);
      }
      let batch = [...batches].find(candidate => !candidate.sealed && !candidate.primitive?.ready);
      if (!batch) {
        const style = rasterStyle(layer);
        batch = {
          key: batchKey,
          sealed: false,
          sourceIdentity: image,
          image: normalizedImage,
          layer,
          collection,
          entries: new Map(),
          width: dimensions.width,
          height: dimensions.height,
          resampling: style.resampling,
          styleKey: rasterStyleKey(style),
        };
        batches.add(batch);
      }
      const entry: DynamicRasterEntry = {
        type: 'dynamic',
        batch,
        instanceId: { type: 'raster', tileId, layerId: layer.id },
        show: new ShowGeometryInstanceAttribute(true),
        layerId: layer.id,
        tileId,
        tileID,
        geometryKey,
        tileCoordinates,
        flippedWindingOrder,
        mode,
      };
      batch.entries.set(tileId, entry);
      entries.push(entry);
      changedBatches.add(batch);
    }

    if (entries.length > 0) {
      this._tiles.set(tileId, entries);
      this._tileIdsCache = undefined;
    }
    for (const batch of changedBatches) {
      const rebuilt = this._rebuildDynamicBatch(batch);
      update.removed.push(...rebuilt.removed);
      update.added.push(...rebuilt.added);
      update.removedMaterials.push(...rebuilt.removedMaterials);
      (update.replacedOwners ??= []).push(...rebuilt.replacedOwners ?? []);
    }
    return update;
  }

  removeTile(tileId: string): RasterTileUpdate {
    const entries = this._tiles.get(tileId);
    const update: RasterTileUpdate = { removed: [], added: [], removedMaterials: [] };
    if (!entries)
      return update;
    for (const entry of entries) {
      if (entry.type === 'dynamic') {
        const removed = this._removeDynamicEntry(entry);
        update.removed.push(...removed.removed);
        update.added.push(...removed.added);
        update.removedMaterials.push(...removed.removedMaterials);
        (update.replacedOwners ??= []).push(...removed.replacedOwners ?? []);
      }
      else {
        entry.collection.remove(entry.primitive);
        update.removed.push(entry.primitive);
        update.removedMaterials.push(entry.material);
      }
    }
    this._tiles.delete(tileId);
    this._tileIdsCache = undefined;
    return update;
  }

  /**
   * @internal
   */
  private _rebuildDynamicBatch(batch: DynamicRasterBatch): RasterTileUpdate {
    const update: RasterTileUpdate = { removed: [], added: [], removedMaterials: [], fading: false };
    const previous = batch.primitive;
    if (batch.primitive) {
      batch.collection.remove(batch.primitive);
      update.removed.push(batch.primitive);
      if (batch.material) {
        update.removedMaterials.push(batch.material);
      }
      batch.primitive = undefined;
      batch.material = undefined;
    }

    if (batch.entries.size === 0) {
      const batches = this._dynamicBatches.get(batch.key)!;
      batches.delete(batch);
      if (batches.size === 0)
        this._dynamicBatches.delete(batch.key);
      return update;
    }

    const entries = [...batch.entries.values()];
    const style = rasterStyle(batch.layer);
    const material = rasterMaterial(batch.image, style);
    const geometryInstances = entries.map(entry => new GeometryInstance({
      geometry: rasterGeometry(
        entry.tileID,
        this._layerOffsets.get(entry.layerId) ?? RASTER_SURFACE_OFFSET_M,
        entry.tileCoordinates,
        entry.flippedWindingOrder,
        entry.mode,
      ),
      id: entry.instanceId,
      attributes: { show: entry.show },
    }));
    const primitive = new Primitive({
      geometryInstances,
      appearance: rasterAppearance(material),
      allowPicking: true,
      asynchronous: false,
      compressVertices: true,
      releaseGeometryInstances: true,
    });
    registerDrawBatch(primitive, { layerId: batch.layer.id, kind: 'raster' });
    primitive.show = style.opacity > 0;
    batch.collection.add(primitive);
    batch.primitive = primitive;
    batch.material = material;
    const dimensions = sourceDimensions(batch.image);
    batch.width = dimensions.width;
    batch.height = dimensions.height;
    batch.resampling = style.resampling;
    batch.styleKey = rasterStyleKey(style);
    update.added.push(primitive);
    if (previous)
      update.replacedOwners = [{ previous, next: primitive, parent: batch.collection, tileIds: new Set(batch.entries.keys()) }];
    return update;
  }

  hasPickObject(pickObject: RasterPrimitiveID): boolean {
    return this._tiles.get(pickObject.tileId)?.some(entry => entry.layerId === pickObject.layerId)
      || [...this._retained].some(retained => retained.tileId === pickObject.tileId
        && retained.entries.some(entry => entry.layerId === pickObject.layerId));
  }

  /**
   * Refreshes style uniforms and copies animated canvas contents into
   * Cesium's already-created texture. The copy is deliberately performed on
   * the underlying texture: Material only queues an image upload when the
   * uniform object identity changes, while CanvasSource keeps one canvas.
   */
  update(
    styleRevision = 0,
    forceStyles = false,
    transitionLayerIds?: ReadonlySet<string>,
    fadeOpacityOf?: (tileId: string) => number | undefined,
  ): RasterTileUpdate {
    const removed: Primitive[] = [];
    const added: Primitive[] = [];
    const removedMaterials: Material[] = [];
    const replacedOwners: NonNullable<RasterTileUpdate['replacedOwners']> = [];
    let textureChanged = false;
    let fading = false;
    const revisionChanged = this._lastStyleRevision !== styleRevision;
    const styleChanged = forceStyles || revisionChanged;
    // During a steady transition frame the style revision is stable. Restrict
    // the expensive rasterStyle() evaluation to layers participating in that
    // transition; when the revision itself changed, all layers still need the
    // normal refresh for a style mutation or zoom expression.
    const transitionOnly = forceStyles && !revisionChanged && transitionLayerIds !== undefined;
    const shouldUpdateLayer = (layerId: string): boolean => {
      return !transitionOnly || transitionLayerIds!.has(layerId);
    };

    // A dynamic CanvasSource uses the same image object for every visible
    // tile. Keep one Cesium primitive/material per raster layer and let its
    // geometry instances cover all tiles. This makes the expensive texture
    // upload proportional to dynamic source layers, rather than tiles ×
    // layers, while retaining one pick id for every tile instance.
    for (const batches of this._dynamicBatches.values()) {
      for (const batch of batches) {
        const style = !batch.sealed && styleChanged && shouldUpdateLayer(batch.layer.id)
          ? rasterStyle(batch.layer)
          : undefined;
        // Only a freshly evaluated style can detect a resampling change. A
        // steady frame leaves `style` undefined, so comparing its optional
        // chain would report a mismatch on every frame and rebuild the batch
        // (geometry + texture upload) continuously.
        if (style !== undefined && style.resampling !== batch.resampling && !batch.primitive?.ready) {
          const replacement = this._rebuildDynamicBatch(batch);
          removed.push(...replacement.removed);
          added.push(...replacement.added);
          removedMaterials.push(...replacement.removedMaterials);
          replacedOwners.push(...replacement.replacedOwners ?? []);
          continue;
        }
        if (style && batch.material && batch.primitive) {
          if (style.resampling !== batch.resampling) {
            batch.material.setResampling(style.resampling);
            batch.resampling = style.resampling;
          }
          const styleKey = rasterStyleKey(style);
          if (batch.styleKey !== styleKey) {
            batch.styleKey = styleKey;
            setRasterUniforms(batch.material, style);
          }
          const show = style.opacity > 0;
          if (batch.primitive.show !== show) {
            batch.primitive.show = show;
          }
        }
        if (!batch.material) {
          continue;
        }
        const dimensions = sourceDimensions(batch.image);
        if (dimensions.width <= 0 || dimensions.height <= 0) {
          continue;
        }
        if (dimensions.width !== batch.width || dimensions.height !== batch.height) {
          // A held generation keeps its existing texture and native instance IDs.
          // Its successor will own any resized canvas allocation.
          if (batch.sealed)
            continue;
          if (!batch.primitive?.ready) {
            const replacement = this._rebuildDynamicBatch(batch);
            removed.push(...replacement.removed);
            added.push(...replacement.added);
            removedMaterials.push(...replacement.removedMaterials);
            replacedOwners.push(...replacement.replacedOwners ?? []);
            continue;
          }
          batch.width = dimensions.width;
          batch.height = dimensions.height;
          textureChanged = true;
        }
        if (batch.material instanceof RasterImageMaterial)
          batch.material.copyImage(batch.image);
      }
    }
    // Iterate the map directly: the per-frame [...this._tiles.keys()] spread
    // allocated one array per frame, and the skip checks are hoisted before
    // the per-entry style evaluation.
    //
    // Rebuilds are deferred to after the loop. _rebuildTile removes and
    // re-adds the key, and a re-added key moves to the end of a Map's
    // insertion order, so an in-flight iterator would visit the freshly
    // built tile a second time in the same frame and re-run its style
    // evaluation.
    const rebuildTiles = new Map<string, StaticRasterEntry[]>();
    for (const [tileId, entries] of this._tiles) {
      const fade = fadeOpacityOf?.(tileId);
      if (fade !== undefined && fade < 1) {
        fading = true;
      }
      for (const entry of entries) {
        const material = entry.type === 'static' ? entry.material : entry.batch.material;
        const target = fade ?? 1;
        if (material && material.uniforms.u_fade !== target) {
          material.uniforms.u_fade = target;
        }
      }
      if (!styleChanged || !entries.every(entry => entry.type === 'static'))
        continue;

      const styles = entries.map(entry => shouldUpdateLayer(entry.layerId) ? rasterStyle(entry.layer) : undefined);
      if (styles.some((style, index) => style !== undefined && style.resampling !== entries[index].resampling)) {
        rebuildTiles.set(tileId, entries);
        continue;
      }

      for (const [index, entry] of entries.entries()) {
        const style = styles[index];
        if (!style)
          continue;
        const styleKey = rasterStyleKey(style);
        if (entry.styleKey !== styleKey) {
          entry.styleKey = styleKey;
          setRasterUniforms(entry.material, style);
        }
        entry.primitive.show = style.opacity > 0;
      }
    }

    for (const [tileId, entries] of rebuildTiles) {
      const replacement = this._rebuildTile(tileId, entries);
      removed.push(...replacement.removed);
      added.push(...replacement.added);
      removedMaterials.push(...replacement.removedMaterials);
    }
    this._lastStyleRevision = styleRevision;
    return { removed, added, removedMaterials, fading, replacedOwners, textureChanged };
  }

  /**
   * @internal
   */
  private _rebuildTile(tileId: string, entries: StaticRasterEntry[]): RasterTileUpdate {
    const first = entries[0];
    const removed = this.removeTile(tileId);
    const replacement = this.addTile(
      tileId,
      first.tileID,
      first.sourceIdentity,
      entries.map(entry => entry.layer),
      false,
      first.tileCoordinates,
      first.flippedWindingOrder,
      first.mode,
    );
    return {
      removed: [...removed.removed, ...replacement.removed],
      added: replacement.added,
      removedMaterials: [...removed.removedMaterials, ...replacement.removedMaterials],
    };
  }

  clear(): RasterTileUpdate {
    for (const retained of this._retained)
      retained.release();
    const result: RasterTileUpdate = { removed: [], added: [], removedMaterials: [] };
    for (const tileId of [...this._tiles.keys()]) {
      const update = this.removeTile(tileId);
      result.removed.push(...update.removed);
      result.removedMaterials.push(...update.removedMaterials);
    }
    return result;
  }
}

export function destroyRasterResources(update: RasterTileUpdate): void {
  for (const primitive of update.removed) {
    if (!primitive.isDestroyed()) {
      primitive.destroy();
    }
  }
  for (const material of update.removedMaterials) {
    if (!material.isDestroyed()) {
      material.destroy();
    }
  }
}
