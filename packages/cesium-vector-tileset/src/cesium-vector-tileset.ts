import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PatternPrimitiveID } from './render/pattern/pattern-renderer';
import type { RasterPrimitivePickObject } from './render/raster/raster-renderer';
import type { RenderFrameState } from './render/scene/render-frame';
import type { TilePickObject } from './render/vector/tile-conversion';
import type { CesiumVectorTilesetFromUrlOptions, CesiumVectorTilesetOptions } from './tileset-options';
import type { TilesetImage, TilesetImageOptions, TilesetStats } from './tileset-types';
import { Event, PrimitiveCollection } from 'cesium';
import { TilesetRenderer } from './render/scene/tileset-renderer';
import { loadStyle } from './style/load-style';

export type { RenderFrameState } from './render/scene/render-frame';
export type { CesiumVectorTilesetFromUrlOptions, CesiumVectorTilesetOptions } from './tileset-options';

/** A MapLibre style rendered as a Cesium primitive collection. */
export class CesiumVectorTileset extends PrimitiveCollection {
  /** Reports style validation and source loading errors. */
  readonly errorEvent = new Event<(error: Error) => void>();

  private readonly _renderer: TilesetRenderer;

  /** Loads and initializes a style before returning a scene-ready primitive. */
  static async fromUrl(url: string, options?: CesiumVectorTilesetFromUrlOptions): Promise<CesiumVectorTileset> {
    const style = await loadStyle(url, options?.transformRequest, options?.signal);
    options?.signal?.throwIfAborted();
    const tileset = new CesiumVectorTileset({ ...options, style });
    const signal = options?.signal;
    const abort = () => tileset.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      await tileset.whenReady();
      signal?.throwIfAborted();
      return tileset;
    }
    catch (error) {
      if (!tileset.isDestroyed())
        tileset.destroy();
      signal?.throwIfAborted();
      throw error;
    }
    finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  constructor(options: CesiumVectorTilesetOptions) {
    // Renderer-owned children retire after their last frame has finished.
    super({ show: options.show, destroyPrimitives: false });
    this._renderer = new TilesetRenderer(this, options, this.errorEvent);
  }

  get styleSpec(): StyleSpecification {
    return this._renderer.styleSpec;
  }

  get ready(): boolean {
    return this._renderer.ready;
  }

  /** Resolves when the style has loaded. */
  whenReady(): Promise<void> {
    return this._renderer.whenReady();
  }

  /** Whether current source data and geometry uploads have finished. */
  get tilesLoaded(): boolean {
    return this._renderer.tilesLoaded;
  }

  /** Updates the style while preserving unchanged sources and resident geometry. */
  setStyle(style: StyleSpecification): void {
    this._renderer.setStyle(style);
  }

  /** Adds a named RGBA image for icons or patterns. */
  addImage(id: string, image: TilesetImage, options: TilesetImageOptions = {}): void {
    this._renderer.addImage(id, image, options);
  }

  updateImage(id: string, image: TilesetImage, options: Pick<TilesetImageOptions, 'pixelRatio' | 'sdf'> = {}): void {
    this._renderer.updateImage(id, image, options);
  }

  removeImage(id: string): void {
    this._renderer.removeImage(id);
  }

  /** Updates the resident tile GPU cache budget and requests a frame. */
  setGpuMemoryBudgetBytes(bytes: number): void {
    this._renderer.setGpuMemoryBudgetBytes(bytes);
  }

  /** Returns cached loading, rendering and GPU memory statistics. */
  stats(): TilesetStats {
    return this._renderer.stats();
  }

  /** Observes insertion and visibility even when demand rendering skips drawing. */
  prePassesUpdate(frameState: RenderFrameState): void {
    this._renderer.prePassesUpdate(frameState);
  }

  update(frameState: RenderFrameState): void {
    this._renderer.update(frameState);
  }

  /** Advances admitted preparation work after the draw pass. */
  postPassesUpdate(frameState: RenderFrameState): void {
    this._renderer.postPassesUpdate(frameState);
  }

  /** Resolves a picked primitive to its style layer and feature properties. */
  pick(pickObject: TilePickObject | RasterPrimitivePickObject | PatternPrimitiveID): {
    layerId: string;
    properties: Record<string, unknown>;
  } | undefined {
    return this._renderer.pick(pickObject);
  }

  /** Releases owned rendering resources and removes the primitive's children. */
  override destroy(): void {
    this._renderer.destroy();
    super.destroy();
  }
}
