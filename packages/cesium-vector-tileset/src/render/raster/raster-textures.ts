import * as cesium from 'cesium';

type TextureSource = HTMLImageElement | ImageBitmap | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas;
type Resampling = 'linear' | 'nearest';

export type RasterTextureSource = {
  type: 'image';
  image: TextureSource;
} | {
  type: 'bytes';
  data: Uint8Array;
  width: number;
  height: number;
  pixelFormat: cesium.PixelFormat;
};

/** Native Texture identity and GPU fields are inherited; destruction is borrowed. */
export interface RasterTextureSampler {
  readonly width: number;
  readonly height: number;
  isDestroyed: () => boolean;
  destroy: () => void;
}

interface NativeTexture extends RasterTextureSampler {
  copyFrom: (options: { source: TextureSource | { arrayBufferView: Uint8Array; width: number; height: number } }) => void;
}

interface NativeTextureOptions {
  context: object;
  width: number;
  height: number;
  source: TextureSource | { arrayBufferView: Uint8Array; width: number; height: number };
  pixelFormat: cesium.PixelFormat;
  sampler: object;
}

// Texture and Sampler are exported by Native but omitted from Cesium.d.ts.
interface CesiumRuntime {
  Texture: new (options: NativeTextureOptions) => NativeTexture;
  Sampler: new (options: {
    minificationFilter: cesium.TextureMinificationFilter;
    magnificationFilter: cesium.TextureMagnificationFilter;
  }) => object;
}

const { Texture, Sampler } = cesium as unknown as CesiumRuntime;

interface RasterTextureRecord {
  source: RasterTextureSource;
  pending: boolean;
  refs: number;
  context?: object;
  texture?: NativeTexture;
  sampler?: RasterTextureSampler;
  pixelFormat?: cesium.PixelFormat;
}

export interface RasterTextureLease {
  readonly sampler: RasterTextureSampler | undefined;
  /** A video with no decoded frame has no sampler yet, matching Native. */
  update: (context: object) => RasterTextureSampler | undefined;
  /** The producing generation schedules a pixel update for all its consumers. */
  copyImage: (source: RasterTextureSource) => void;
  release: () => void;
}

/** One owned texture per published generation and filter, borrowed by its materials. */
export class RasterTextures {
  private readonly _records = new WeakMap<object, Map<Resampling, RasterTextureRecord>>();

  retain(generationToken: object, source: RasterTextureSource, resampling: Resampling): RasterTextureLease {
    let filters = this._records.get(generationToken);
    if (!filters) {
      filters = new Map();
      this._records.set(generationToken, filters);
    }
    let record = filters.get(resampling);
    if (record) {
      const current = record.source;
      const same = source.type === 'image'
        ? current.type === 'image' && current.image === source.image
        : current.type === 'bytes' && current.data === source.data && current.width === source.width
          && current.height === source.height && current.pixelFormat === source.pixelFormat;
      if (!same)
        throw new TypeError('Raster generation already has a different texture source');
    }
    else {
      record = { source, pending: true, refs: 0 };
      filters.set(resampling, record);
    }
    const retained = record;
    retained.refs++;
    let released = false;
    return {
      get sampler() { return released ? undefined : retained.sampler; },
      update: (context) => {
        if (released)
          throw new Error('Raster texture lease has been released');
        if (retained.context && retained.context !== context)
          throw new Error('Raster texture generation belongs to another Native context');
        if (!retained.pending)
          return retained.sampler;
        const source = retained.source;
        if (source.type === 'image' && typeof HTMLVideoElement !== 'undefined'
          && source.image instanceof HTMLVideoElement && source.image.readyState < 2) {
          return retained.sampler;
        }
        const pixels = source.type === 'bytes'
          ? { arrayBufferView: source.data, width: source.width, height: source.height }
          : source.image;
        const image = pixels as typeof pixels & { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number };
        // Native uses intrinsic image/video dimensions. Read them only for an
        // explicit upload; a sealed generation can share a subsequently resized canvas.
        const width = image.videoWidth ?? image.naturalWidth ?? image.width;
        const height = image.videoHeight ?? image.naturalHeight ?? image.height;
        const pixelFormat = source.type === 'bytes' ? source.pixelFormat : cesium.PixelFormat.RGBA;
        if (!retained.texture || retained.texture.width !== width || retained.texture.height !== height
          || retained.pixelFormat !== pixelFormat) {
          const nearest = resampling === 'nearest';
          const texture = new Texture({
            context,
            width,
            height,
            source: pixels,
            pixelFormat,
            sampler: new Sampler({
              minificationFilter: nearest ? cesium.TextureMinificationFilter.NEAREST : cesium.TextureMinificationFilter.LINEAR,
              magnificationFilter: nearest ? cesium.TextureMagnificationFilter.NEAREST : cesium.TextureMagnificationFilter.LINEAR,
            }),
          });
          retained.texture?.destroy();
          retained.texture = texture;
          retained.sampler = Object.create(texture, { destroy: { value: (): void => {} } }) as RasterTextureSampler;
          retained.context = context;
          retained.pixelFormat = pixelFormat;
        }
        else {
          retained.texture.copyFrom({ source: pixels });
        }
        retained.pending = false;
        return retained.sampler;
      },
      copyImage: (source) => {
        if (released)
          throw new Error('Raster texture lease has been released');
        retained.source = source;
        retained.pending = true;
      },
      release: () => {
        if (released)
          return;
        released = true;
        retained.refs--;
        if (retained.refs > 0)
          return;
        if (retained.texture && !retained.texture.isDestroyed())
          retained.texture.destroy();
        retained.texture = undefined;
        retained.sampler = undefined;
        filters.delete(resampling);
        if (filters.size === 0)
          this._records.delete(generationToken);
      },
    };
  }
}
