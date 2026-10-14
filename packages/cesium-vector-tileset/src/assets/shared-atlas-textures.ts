import * as cesium from 'cesium';

type Material = cesium.Material;
type PixelFormat = cesium.PixelFormat;

/**
 * Cesium exports `Texture` at runtime but omits it from `Cesium.d.ts` (the
 * same declaration gap as `Scene.vectorProvider`). Declare the slice this
 * module drives and read the constructor off the module namespace instead of
 * augmenting `cesium` globally: an augmentation would leak into every
 * consumer's type space.
 */
interface SharedTexture {
  readonly width: number;
  readonly height: number;
  isDestroyed: () => boolean;
  destroy: () => void;
}

interface CesiumRuntime {
  Texture: new (options: unknown) => SharedTexture;
  Context: new (...args: never[]) => object;
  ContextLimits: { readonly maximumTextureSize: number };
}

const Texture = (cesium as unknown as CesiumRuntime).Texture;
const Context = (cesium as unknown as CesiumRuntime).Context;
const ContextLimits = (cesium as unknown as CesiumRuntime).ContextLimits;

/**
 * Material.update accepts native Texture instances but Material owns and
 * destroys every sampler it adopts. Give materials a non-owning view of the
 * native texture: instanceof and GPU fields resolve through the owner, while
 * destruction belongs exclusively to the atlas's retained tile entries.
 * Neither the native Texture instance nor its prototype is modified.
 */
function borrowedTexture(texture: SharedTexture): SharedTexture {
  return Object.create(texture, {
    destroy: { value: (): void => {} },
  }) as SharedTexture;
}

export interface AtlasRectLike {
  tlbr: readonly [number, number, number, number];
  pixelRatio: number;
  version?: number;
}

/**
 * Identify the packed layout (name + rect + pixelRatio + sprite version). The
 * sprite version must change when an image's pixels change; this key does
 * not hash the image bytes.
 */
export function atlasLayoutKey(positions: Record<string, AtlasRectLike>): string {
  return JSON.stringify(Object.keys(positions).sort().map((name) => {
    const position = positions[name];
    return [name, position.tlbr, position.pixelRatio, position.version ?? 0];
  }));
}

interface SharedAtlasRecord {
  source: AtlasUploadSource;
  width: number;
  height: number;
  texture?: SharedTexture;
  sampler?: SharedTexture;
  refs: number;
  pending: Set<AtlasBinding>;
}

interface AtlasBinding {
  material: Material;
  uniform: string;
  record: SharedAtlasRecord;
}

type AtlasCanvas = HTMLCanvasElement | OffscreenCanvas;
type AtlasUploadSource = { type: 'canvas'; canvas: AtlasCanvas } | {
  type: 'bytes';
  view: Uint8Array | Uint8ClampedArray;
  pixelFormat: PixelFormat;
};

/**
 * Own one GPU texture per retained atlas and lend it to every sampling material.
 * Source registration needs no GL context; adopt() uploads dirty retained
 * sources when a Native context is available. Canvas suppliers stay lazy,
 * and typed glyph pixels never require a canvas intermediary.
 */
export class SharedAtlasTextures {
  private readonly _options: { premultiplyAlpha: boolean };

  constructor(options: { premultiplyAlpha: boolean } = { premultiplyAlpha: false }) {
    this._options = options;
  }

  private _records = new Map<string, SharedAtlasRecord>();

  private _dirty = new Set<SharedAtlasRecord>();

  private _bindings = new WeakMap<Material, Map<string, AtlasBinding>>();

  get size(): number {
    return this._records.size;
  }

  /**
   * Register (or reuse) the shared canvas for `key`. The supplier runs only
   * on a content miss, so hits skip both the CPU putImageData and every GPU
   * upload.
   */
  canvas(key: string, width: number, height: number, create: () => AtlasCanvas): AtlasCanvas {
    let record = this._records.get(key);
    if (!record) {
      record = { source: { type: 'canvas', canvas: create() }, width, height, refs: 0, pending: new Set() };
      this._records.set(key, record);
    }
    if (record.source.type !== 'canvas')
      throw new TypeError(`Atlas ${key} is registered as bytes`);
    return record.source.canvas;
  }

  has(key: string): boolean {
    return this._records.has(key);
  }

  /** Register immutable pixels without allocating a canvas or a GPU texture. */
  bytes(
    key: string,
    view: Uint8Array | Uint8ClampedArray,
    pixelFormat: PixelFormat,
    width: number,
    height: number,
  ): void {
    const record = this._records.get(key);
    if (record) {
      if (record.source.type !== 'bytes' || record.source.view !== view
        || record.source.pixelFormat !== pixelFormat || record.width !== width || record.height !== height) {
        throw new TypeError(`Atlas ${key} already has a different immutable source`);
      }
      return;
    }
    this._records.set(key, {
      source: { type: 'bytes', view, pixelFormat },
      width,
      height,
      refs: 0,
      pending: new Set(),
    });
  }

  /** Retain the shared atlas for one tile entry (or build). */
  retain(key: string): void {
    const record = this._records.get(key);
    if (record) {
      record.refs++;
      if (record.pending.size > 0) {
        this._dirty.add(record);
      }
    }
  }

  /**
   * Record that `material` samples `key` through `uniform`. Adoption swaps
   * the image sampler uniform for the shared texture on the next adopt() call.
   */
  track(key: string, material: Material, uniform: string): void {
    const record = this._records.get(key);
    if (!record) {
      return;
    }
    let bindings = this._bindings.get(material);
    if (!bindings) {
      bindings = new Map();
      this._bindings.set(material, bindings);
    }
    const previous = bindings.get(uniform);
    if (previous?.record === record) {
      return;
    }
    previous?.record.pending.delete(previous);
    const binding = { material, uniform, record };
    bindings.set(uniform, binding);
    record.pending.add(binding);
    if (record.refs > 0) {
      this._dirty.add(record);
    }
  }

  /**
   * Adopt newly tracked samplers of retained atlases. Idle frames do no
   * record or material traversal. A retained build or entry owns the texture;
   * material destruction only releases its borrowed sampler. Records without
   * a hold do not enter the dirty set. Context-free environments skip adoption
   * and allocate no GPU texture.
   */
  adopt(context: { [key: string]: unknown } | undefined): void {
    if (this._dirty.size === 0 || !(context instanceof Context)) {
      return;
    }
    // Cesium initializes these renderer limits when constructing its Context.
    // Context itself has no maximumTextureSize property.
    const maxSize = ContextLimits.maximumTextureSize;
    for (const record of this._dirty) {
      for (const binding of record.pending) {
        if (binding.material.isDestroyed()) {
          record.pending.delete(binding);
        }
      }
      if (record.pending.size === 0 || record.width <= 0 || record.height <= 0
        || record.width > maxSize || record.height > maxSize) {
        this._dirty.delete(record);
        continue;
      }
      if (!record.texture) {
        record.texture = record.source.type === 'bytes'
          ? new Texture({
              context: context as never,
              source: {
                arrayBufferView: record.source.view,
                width: record.width,
                height: record.height,
              } as never,
              pixelFormat: record.source.pixelFormat,
            })
          : new Texture({
              context: context as never,
              source: record.source.canvas as never,
              preMultiplyAlpha: this._options.premultiplyAlpha,
            });
        record.sampler = borrowedTexture(record.texture);
      }
      for (const { material, uniform } of record.pending) {
        const uniforms = material.uniforms as Record<string, unknown>;
        uniforms[uniform] = record.sampler;
      }
      record.pending.clear();
      this._dirty.delete(record);
    }
  }

  /** Release one tile entry's (or build's) hold; drops the record at zero refs. */
  release(key: string): void {
    const record = this._records.get(key);
    if (!record) {
      return;
    }
    if (record.refs > 0) {
      record.refs--;
    }
    if (record.refs > 0) {
      return;
    }
    // Zero refs also drops never-retained records (empty builds): adopt()
    // must never mint GL textures for atlases no live entry samples.
    record.pending.clear();
    this._dirty.delete(record);
    if (record.texture && !record.texture.isDestroyed()) {
      record.texture.destroy();
    }
    this._records.delete(key);
  }

  /** Destroy everything (style swap / renderer destroy). */
  clear(): void {
    for (const record of this._records.values()) {
      if (record.texture && !record.texture.isDestroyed()) {
        record.texture.destroy();
      }
    }
    this._records.clear();
    this._dirty.clear();
    this._bindings = new WeakMap();
  }
}
