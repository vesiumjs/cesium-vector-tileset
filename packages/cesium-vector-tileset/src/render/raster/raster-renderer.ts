import type {
  SceneMode,
} from 'cesium';
import type { RasterStyleLayer } from '../../style/style-layer/raster-style-layer';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { MemoryBudgetVisitor } from '../scene/gpu-memory-budget';
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
  PrimitiveCollection,
  PrimitiveType,
  TextureMagnificationFilter,
  TextureMinificationFilter,
} from 'cesium';
import { registerDrawBatch } from '../scene/draw-batch';
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

interface RasterPrimitiveEntry {
  primitive: Primitive;
  collection: PrimitiveCollection;
  tileId: string;
  tileID: TileID;
  layer: RasterStyleLayer;
  sourceIdentity: RasterMaterialImage;
  image: TextureSource;
  material: Material;
  dynamic: boolean;
  width: number;
  height: number;
  resampling: RasterStyle['resampling'];
  styleKey: string;
  geometryKey: string;
  tileCoordinates?: readonly RasterTileCoordinate[];
  flippedWindingOrder: boolean;
  mode?: SceneMode;
  dynamicBatch?: DynamicRasterBatch;
}

interface DynamicRasterBatch {
  key: string;
  sourceIdentity: RasterMaterialImage;
  image: TextureSource;
  layer: RasterStyleLayer;
  collection: PrimitiveCollection;
  entries: Map<string, RasterPrimitiveEntry>;
  primitive?: Primitive;
  material?: Material;
  dynamic: boolean;
  width: number;
  height: number;
  resampling: RasterStyle['resampling'];
  styleKey: string;
  mode?: SceneMode;
}

interface TextureHandle {
  width: number;
  height: number;
  copyFrom: (options: { source: TextureSource }) => void;
}

interface MaterialInternals {
  _defaultTexture?: TextureHandle;
  _textures?: Record<string, TextureHandle>;
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
  update(context: object): void;
}
const RuntimeMaterial = Material as typeof _NativeMaterial;

/** Decoded raster pixels must be available during the material's first update. */
class RasterImageMaterial extends RuntimeMaterial {
  private _pendingSource?: TextureSource;

  constructor(image: TextureSource, options: MaterialOptions) {
    super(options);
    this._pendingSource = image;
    this.uniforms.image = image;
  }

  override update(context: object): void {
    if (this._pendingSource) {
      // Native queues decoded images after consuming its upload queue. Upload
      // directly so this same update adopts real pixels before any draw. Use
      // the same Texture defaults (flipY and straight alpha) as Material.
      this.uniforms.image = new Texture({
        context,
        source: this._pendingSource,
        sampler: new Sampler({
          minificationFilter: this.minificationFilter,
          magnificationFilter: this.magnificationFilter,
        }),
      });
      this._pendingSource = undefined;
    }
    super.update(context);
  }

  override destroy(): void {
    this._pendingSource = undefined;
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
  retained?: { parents: ReadonlyMap<Primitive, PrimitiveCollection>; release: () => void };
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

function materialTexture(material: Material): TextureHandle | undefined {
  const internals = material as unknown as MaterialInternals;
  const texture = internals._textures?.image;
  return texture && texture !== internals._defaultTexture ? texture : undefined;
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

export function rasterMaterial(image: RasterMaterialImage, style: RasterStyle): Material {
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
  if (typeof HTMLVideoElement !== 'undefined' && normalizedImage instanceof HTMLVideoElement) {
    // Native already uploads videos synchronously and gates each frame on
    // readyState. Preserve its video refresh and readiness behavior.
    const material = new Material(options);
    material.uniforms.image = normalizedImage;
    return material;
  }
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
  const attributes = {
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
  private _layerCollections = new Map<string, PrimitiveCollection>();

  private _layerOffsets = new Map<string, number>();

  private _tiles = new Map<string, RasterPrimitiveEntry[]>();

  private _tileIdsCache?: string[];

  private _dynamicBatches = new Map<string, DynamicRasterBatch>();

  private _dynamicImageIds = new WeakMap<object, number>();

  private _nextDynamicImageId = 0;

  private _lastStyleRevision?: number;

  get collections(): ReadonlyMap<string, PrimitiveCollection> {
    return this._layerCollections;
  }

  get tileIds(): ReadonlyArray<string> {
    return this._tileIdsCache ??= [...this._tiles.keys()];
  }

  /** Live tile and layer-collection counts for diagnostics. */
  get stats(): { tiles: number; layerCollections: number } {
    return {
      tiles: this._tiles.size,
      layerCollections: this._layerCollections.size,
    };
  }

  /**
   * Per-tile byte estimates for the memory budget: one RGBA texture per
   * entry. Raster tiles are destroyed on leave, so every entry is live and
   * can never be an eviction target - reported pinned, which lets the tileset
   * skip the protected-set copy it used to build for raster keys.
   */
  visitMemoryEntries(visit: MemoryBudgetVisitor): void {
    for (const [tileId, tileEntries] of this._tiles) {
      let bytes = 0;
      for (const entry of tileEntries) {
        bytes += entry.width * entry.height * 4;
      }
      visit(tileId, bytes, true);
    }
  }

  setLayers(layers: readonly RasterStyleLayer[], layerOrder?: ReadonlyMap<string, number>): RasterTileUpdate {
    this._lastStyleRevision = undefined;
    for (const layer of layers) {
      if (!this._layerCollections.has(layer.id)) {
        this._layerCollections.set(layer.id, new PrimitiveCollection({ destroyPrimitives: false }));
      }
    }
    const update: RasterTileUpdate = { removed: [], added: [], removedMaterials: [] };
    if (layerOrder) {
      for (const [tileId, entries] of this._tiles) {
        const deleted = entries.filter(entry => !layerOrder.has(entry.layer.id));
        if (deleted.length > 0) {
          this._tiles.set(tileId, deleted);
          const removed = this.removeTile(tileId);
          update.removed.push(...removed.removed);
          update.added.push(...removed.added);
          update.removedMaterials.push(...removed.removedMaterials);
          const kept = entries.filter(entry => layerOrder.has(entry.layer.id));
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
        if (predicate(entry.primitive))
          return true;
      }
    }
    return false;
  }

  /**
   * @internal
   */
  private _retainStaticTile(tileId: string): RasterTileUpdate['retained'] {
    const entries = this._tiles.get(tileId);
    if (!entries || entries.some(entry => entry.dynamicBatch)) {
      return undefined;
    }
    this._tiles.delete(tileId);
    this._tileIdsCache = undefined;
    return {
      parents: new Map(entries.map(entry => [entry.primitive, entry.collection])),
      release: () => {
        for (const entry of entries) {
          entry.collection.remove(entry.primitive);
        }
        destroyRasterResources({ removed: entries.map(entry => entry.primitive), added: [], removedMaterials: entries.map(entry => entry.material) });
      },
    };
  }

  takeDisplacedTile(tileId: string, layers: readonly RasterStyleLayer[]): RasterTileUpdate['retained'] {
    const entries = this._tiles.get(tileId);
    if (!entries || entries.every(entry => layers.some(layer => layer.id === entry.layer.id))) {
      return undefined;
    }
    return this._retainStaticTile(tileId);
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
      && existing.every((entry, index) => entry.layer.id === layers[index]?.id
        && entry.sourceIdentity === image
        && entry.dynamic === dynamic
        && entry.geometryKey === geometryKey);
    if (sameTile) {
      for (const entry of existing) {
        entry.dynamic = dynamic;
        if (entry.dynamicBatch) {
          entry.dynamicBatch.dynamic = dynamic;
        }
      }
      return { removed: [], added, removedMaterials: [] };
    }

    const retained = this._retainStaticTile(tileId);
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
      return { ...update, tileId, retained, parents: new Map((this._tiles.get(tileId) ?? []).map(entry => [entry.primitive, entry.collection])) };
    }
    // ImageData is converted once per tile and shared by every raster layer.
    // Converting it inside buildRasterPrimitive would allocate one canvas per
    // layer and multiply both CPU and GPU upload work.
    const normalizedImage = normalizeTextureData(image as RasterTextureData);

    const entries: RasterPrimitiveEntry[] = [];
    for (const layer of layers) {
      const collection = this._layerCollections.get(layer.id);
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
      entries.push({
        primitive,
        collection,
        tileId,
        tileID,
        layer,
        sourceIdentity: image,
        image: built.image,
        material: built.material,
        dynamic,
        width: dimensions.width,
        height: dimensions.height,
        resampling: rasterStyle(layer).resampling,
        styleKey: rasterStyleKey(rasterStyle(layer)),
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
    const entries: RasterPrimitiveEntry[] = [];
    const changedBatches = new Set<DynamicRasterBatch>();

    for (const layer of layers) {
      const collection = this._layerCollections.get(layer.id);
      if (!collection) {
        continue;
      }
      const batchKey = this._dynamicBatchKey(image, layer.id, mode);
      let batch = this._dynamicBatches.get(batchKey);
      if (!batch) {
        const style = rasterStyle(layer);
        batch = {
          key: batchKey,
          sourceIdentity: image,
          image: normalizedImage,
          layer,
          collection,
          entries: new Map(),
          dynamic: true,
          width: dimensions.width,
          height: dimensions.height,
          resampling: style.resampling,
          styleKey: rasterStyleKey(style),
          mode,
        };
        this._dynamicBatches.set(batchKey, batch);
      }
      const entry: RasterPrimitiveEntry = {
        primitive: undefined as unknown as Primitive,
        collection,
        tileId,
        tileID,
        layer,
        sourceIdentity: image,
        image: normalizedImage,
        material: undefined as unknown as Material,
        dynamic: true,
        width: dimensions.width,
        height: dimensions.height,
        resampling: batch.resampling,
        styleKey: batch.styleKey,
        geometryKey,
        tileCoordinates,
        flippedWindingOrder,
        mode,
        dynamicBatch: batch,
      };
      batch.entries.set(tileId, entry);
      batch.dynamic = true;
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
    }
    return update;
  }

  removeTile(tileId: string): RasterTileUpdate {
    const entries = this._tiles.get(tileId);
    if (!entries) {
      return { removed: [], added: [], removedMaterials: [] };
    }
    const dynamicBatches = new Set<DynamicRasterBatch>();
    const removed: Primitive[] = [];
    const removedMaterials: Material[] = [];
    for (const entry of entries) {
      if (entry.dynamicBatch) {
        dynamicBatches.add(entry.dynamicBatch);
        entry.dynamicBatch.entries.delete(tileId);
      }
      else {
        entry.collection.remove(entry.primitive);
        removed.push(entry.primitive);
        removedMaterials.push(entry.material);
      }
    }
    this._tiles.delete(tileId);
    this._tileIdsCache = undefined;
    const added: Primitive[] = [];
    for (const batch of dynamicBatches) {
      const replacement = this._rebuildDynamicBatch(batch);
      removed.push(...replacement.removed);
      added.push(...replacement.added);
      removedMaterials.push(...replacement.removedMaterials);
    }
    return { removed, added, removedMaterials };
  }

  /**
   * @internal
   */
  private _rebuildDynamicBatch(batch: DynamicRasterBatch): RasterTileUpdate {
    const update: RasterTileUpdate = { removed: [], added: [], removedMaterials: [], fading: false };
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
      this._dynamicBatches.delete(batch.key);
      return update;
    }

    const entries = [...batch.entries.values()];
    const first = entries[0];
    const style = rasterStyle(batch.layer);
    const material = rasterMaterial(batch.image, style);
    const geometryInstances = entries.map(entry => new GeometryInstance({
      geometry: rasterGeometry(
        entry.tileID,
        this._layerOffsets.get(entry.layer.id) ?? RASTER_SURFACE_OFFSET_M,
        entry.tileCoordinates,
        entry.flippedWindingOrder,
        entry.mode,
      ),
      id: {
        type: 'raster',
        tileId: entry.tileId,
        layerId: entry.layer.id,
      } satisfies RasterPrimitiveID,
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
    batch.image = first.image;
    batch.width = sourceDimensions(first.image).width;
    batch.height = sourceDimensions(first.image).height;
    batch.resampling = style.resampling;
    batch.styleKey = rasterStyleKey(style);
    for (const entry of entries) {
      entry.primitive = primitive;
      entry.material = material;
      entry.width = batch.width;
      entry.height = batch.height;
      entry.resampling = batch.resampling;
      entry.styleKey = batch.styleKey;
    }
    update.added.push(primitive);
    return update;
  }

  hasPickObject(pickObject: RasterPrimitiveID): boolean {
    return this._tiles.get(pickObject.tileId)?.some(entry => entry.layer.id === pickObject.layerId) ?? false;
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
    for (const batch of this._dynamicBatches.values()) {
      const style = styleChanged && shouldUpdateLayer(batch.layer.id)
        ? rasterStyle(batch.layer)
        : undefined;
      // Only a freshly evaluated style can detect a resampling change. A
      // steady frame leaves `style` undefined, so comparing its optional
      // chain would report a mismatch on every frame and rebuild the batch
      // (geometry + texture upload) continuously.
      if (style !== undefined && style.resampling !== batch.resampling) {
        const replacement = this._rebuildDynamicBatch(batch);
        removed.push(...replacement.removed);
        added.push(...replacement.added);
        removedMaterials.push(...replacement.removedMaterials);
        continue;
      }
      if (style && batch.material && batch.primitive) {
        const styleKey = rasterStyleKey(style);
        if (batch.styleKey !== styleKey) {
          batch.styleKey = styleKey;
          setRasterUniforms(batch.material, style);
        }
        const show = style.opacity > 0;
        if (batch.primitive.show !== show) {
          batch.primitive.show = show;
        }
        for (const entry of batch.entries.values()) {
          entry.styleKey = batch.styleKey;
        }
      }
      if (!batch.dynamic || !batch.material) {
        continue;
      }
      const dimensions = sourceDimensions(batch.image);
      if (dimensions.width <= 0 || dimensions.height <= 0) {
        continue;
      }
      if (dimensions.width !== batch.width || dimensions.height !== batch.height) {
        const replacement = this._rebuildDynamicBatch(batch);
        removed.push(...replacement.removed);
        added.push(...replacement.added);
        removedMaterials.push(...replacement.removedMaterials);
        continue;
      }
      const texture = materialTexture(batch.material);
      if (texture) {
        texture.copyFrom({ source: batch.image });
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
    // evaluation and texture copy.
    const rebuildTileIds: string[] = [];
    for (const [tileId, entries] of this._tiles) {
      const fade = fadeOpacityOf?.(tileId);
      if (fade !== undefined && fade < 1) {
        fading = true;
      }
      for (const entry of entries) {
        const target = fade ?? 1;
        if (entry.material.uniforms.u_fade !== target) {
          entry.material.uniforms.u_fade = target;
        }
      }
      if (!entries || entries.length === 0) {
        continue;
      }
      if (entries.some(entry => entry.dynamicBatch)) {
        continue;
      }
      if (!styleChanged && !entries.some(entry => entry.dynamic)) {
        continue;
      }

      const styles = !styleChanged
        ? undefined
        : entries.map(entry => shouldUpdateLayer(entry.layer.id) ? rasterStyle(entry.layer) : undefined);
      if (styles?.some((style, index) => style !== undefined && style.resampling !== entries[index].resampling)) {
        rebuildTileIds.push(tileId);
        continue;
      }

      let resized = false;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const style = styles?.[i];
        if (style) {
          const styleKey = rasterStyleKey(style);
          if (entry.styleKey !== styleKey) {
            entry.styleKey = styleKey;
            setRasterUniforms(entry.material, style);
          }
          const show = style.opacity > 0;
          if (entry.primitive.show !== show) {
            entry.primitive.show = show;
          }
        }

        if (!entry.dynamic) {
          continue;
        }
        const dimensions = sourceDimensions(entry.image);
        if (dimensions.width <= 0 || dimensions.height <= 0) {
          continue;
        }
        const texture = materialTexture(entry.material);
        if (!texture) {
          continue;
        }
        if (dimensions.width !== entry.width || dimensions.height !== entry.height) {
          resized = true;
          break;
        }
        texture.copyFrom({ source: entry.image });
      }
      if (resized) {
        rebuildTileIds.push(tileId);
      }
    }

    for (const tileId of rebuildTileIds) {
      const entries = this._tiles.get(tileId);
      // A tile rebuilt earlier in this pass already re-registered itself; the
      // stored entry list is the current one, so rebuild from it.
      if (!entries || entries.length === 0) {
        continue;
      }
      const replacement = this._rebuildTile(tileId, entries);
      removed.push(...replacement.removed);
      added.push(...replacement.added);
      removedMaterials.push(...replacement.removedMaterials);
    }
    this._lastStyleRevision = styleRevision;
    return { removed, added, removedMaterials, fading };
  }

  /**
   * @internal
   */
  private _rebuildTile(tileId: string, entries: RasterPrimitiveEntry[]): RasterTileUpdate {
    const first = entries[0];
    const removed = this.removeTile(tileId);
    const replacement = this.addTile(
      tileId,
      first.tileID,
      first.sourceIdentity,
      entries.map(entry => entry.layer),
      first.dynamic,
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
