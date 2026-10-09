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
    destroy: { value: () => undefined },
  }) as SharedTexture;
}

/**
 * Shared atlas textures. By default every Material mints its own GPU texture
 * from its canvas uniform (Cesium Material creates one texture per material on first render
 * and never re-uploads a mutated canvas), so one sprite atlas costs
 * tiles x layers full-size uploads. This registry collapses that to one GPU
 * texture per atlas key: materials keep their canvas uniform until
 * a GL context is available, then adopt the shared texture (which Cesium's
 * Material uses verbatim, no upload).
 */

export interface AtlasRectLike {
  tlbr: readonly [number, number, number, number];
  pixelRatio: number;
  version?: number;
}

/**
 * Hash the packed layout (name + rect + pixelRatio + sprite version). The
 * sprite version must change when an image's pixels change; this key does
 * not hash the image bytes.
 */
export function atlasLayoutHash(positions: Record<string, AtlasRectLike>): string {
  const names = Object.keys(positions).sort();
  let hash = 0x811C9DC5;
  const mix = (value: string): void => {
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const name of names) {
    const position = positions[name];
    mix(name);
    mix(`:${position.tlbr.join(',')}/${position.pixelRatio}/${position.version ?? 0};`);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

interface SharedAtlasRecord {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
  /**
   * Typed-array upload source preferred over the canvas on adopt (zero
   * canvas readback: single-channel glyph bytes upload as R8 instead of an
   * expanded RGBA canvas). The canvas stays authoritative for tests and
   * pre-adopt sampling.
   */
  direct?: { view: ArrayBufferView; pixelFormat: PixelFormat; width: number; height: number };
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

/**
 * One GPU texture per unique atlas content, shared by every material that
 * samples it. Canvas-first (no GL context needed at publish), texture
 * adoption happens in {@link SharedAtlasTextures.adopt} once the tileset hands
 * down its frame context - strictly before the first render of the frame, so
 * a shared material never pays the per-material upload it was created with.
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
      record = { canvas: create(), width, height, refs: 0, pending: new Set() };
      this._records.set(key, record);
    }
    return record.canvas;
  }

  has(key: string): boolean {
    return this._records.has(key);
  }

  /**
   * Prefer a typed-array upload for `key` on adopt (see SharedAtlasRecord.direct).
   * The canvas remains for tests and pre-adopt sampling; the GPU texture
   * comes straight from bytes (no expansion, no readback, smaller upload).
   */
  setDirectUpload(
    key: string,
    view: ArrayBufferView,
    pixelFormat: PixelFormat,
    width: number,
    height: number,
  ): void {
    const record = this._records.get(key);
    if (record) {
      record.direct = { view, pixelFormat, width, height };
    }
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
   * the canvas uniform for the shared texture on the next adopt() call.
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
   * record or material traversal. Runs in the tileset update with the frame context, which
   * precedes command execution - so the per-material canvas texture Cesium
   * would otherwise mint is never created. Records with zero refs (in-flight
   * builds not yet committed) are skipped: their textures materialize once
   * an entry retains them. Context-free environments (unit tests) skip
   * adoption and keep rendering through the canvas uniforms.
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
        record.texture = record.direct
          ? new Texture({
              context: context as never,
              source: {
                arrayBufferView: record.direct.view,
                width: record.direct.width,
                height: record.direct.height,
              } as never,
              pixelFormat: record.direct.pixelFormat,
            })
          : new Texture({
              context: context as never,
              source: record.canvas as never,
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
