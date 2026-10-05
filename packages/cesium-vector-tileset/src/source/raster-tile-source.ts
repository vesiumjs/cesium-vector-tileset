import type {
  RasterDEMSourceSpecification,
  RasterSourceSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import type { Style } from '../style/style';

import type { Tile } from '../tile/tile';

import type { OverscaledTileID } from '../tile/tile-id';
import type { SourceEventType } from '../util/events';
import type { WorkerDispatcher } from '../worker/dispatcher';
import type { Source } from './source';
import { TileBounds } from '../tile/tile-bounds';
import { isAbortError } from '../util/abort-error';
import { ensureError } from '../util/errors';

import { ErrorEvent, Evented } from '../util/evented';
import { SourceDataEvent } from '../util/events';
import { ImageRequest } from '../util/image-request';
import { pick } from '../util/objects';
import { ResourceType, transformRequest } from '../util/request';
import { loadTileJson } from './load-tilejson';

/**
 * A source containing raster tiles (See the [raster source documentation](https://maplibre.org/maplibre-style-spec/sources/#raster) for detailed documentation of options.)
 *
 * @group Sources
 *
 * \> ℹ️ **Note:** The default `tileSize` is `512`. If your tile provider (such as OpenStreetMap or Stadia Maps) serves 256px tiles, set `tileSize: 256` manually to avoid blurry rendering due to upscaling.
 *
 * @example
 * ```ts
 * map.addSource('raster-source', {
 *     'type': 'raster',
 *     'tiles': ['https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg'],
 *     'tileSize': 256, // Set this to match tile server output to avoid blurry rendering
 * });
 * ```
 *
 * @example
 * ```ts
 * map.addSource('wms-test-source', {
 *      'type': 'raster',
 * // use the tiles option to specify a WMS tile source URL
 *      'tiles': [
 *          'https://img.nj.gov/imagerywms/Natural2015?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&layers=Natural2015'
 *      ],
 *      'tileSize': 256 // Important for WMS if tiles are 256px
 * });
 * ```
 * @see [Add a raster tile source](https://maplibre.org/maplibre-gl-js/docs/examples/map-tiles/)
 * @see [Add a WMS source](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-wms-source/)
 * @see [Display a satellite map](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-satellite-map/)
 */
export class RasterTileSource extends Evented<SourceEventType> implements Source {
  type: 'raster' | 'raster-dem';
  id: string;
  minzoom: number;
  maxzoom: number;
  url?: string;
  scheme: string;
  tileSize: number;

  bounds?: [number, number, number, number];
  tileBounds?: TileBounds;
  roundZoom: boolean;
  dispatcher: WorkerDispatcher;
  style?: Style;
  tiles: string[];

  _loaded: boolean;
  _options: RasterSourceSpecification | RasterDEMSourceSpecification;
  _premultiplyAlpha: boolean;
  _tileJSONRequest?: AbortController;

  constructor(id: string, options: RasterSourceSpecification | RasterDEMSourceSpecification, dispatcher: WorkerDispatcher, eventedParent: Evented) {
    super();
    this.id = id;
    this.dispatcher = dispatcher;
    this.setEventedParent(eventedParent);

    this.type = options.type;
    this.minzoom = 0;
    this.maxzoom = 22;
    this.roundZoom = true;
    this.scheme = 'xyz';
    this.tileSize = 512;
    this._loaded = false;
    this._premultiplyAlpha = true;
    this.tiles = options.tiles ?? [];
    this.url = options.url;
    this.bounds = options.bounds;

    this._options = Object.assign({ type: 'raster' }, options);
    Object.assign(this, pick(options, ['url', 'scheme', 'tileSize']));
  }

  async load(sourceDataChanged: boolean = false): Promise<void> {
    this._loaded = false;
    this.fire(new SourceDataEvent('dataloading'));
    const tileJSONRequest = new AbortController();
    this._tileJSONRequest = tileJSONRequest;
    try {
      const tileJSON = await loadTileJson(this._options, this.style?.transformRequest, tileJSONRequest);
      if (this._tileJSONRequest !== tileJSONRequest || tileJSONRequest.signal.aborted) {
        return;
      }
      this._tileJSONRequest = undefined;
      this._loaded = true;
      if (tileJSON) {
        Object.assign(this, tileJSON);
        this.tileBounds = tileJSON.bounds
          ? new TileBounds(tileJSON.bounds, this.minzoom, this.maxzoom)
          : undefined;

        // `content` is included here to prevent a race condition where `Style._updateSources` is called
        // before the TileJSON arrives. this makes sure the tiles needed are loaded once TileJSON arrives
        this.fire(new SourceDataEvent('data', { sourceDataType: 'metadata' }));
        this.fire(new SourceDataEvent('data', { sourceDataType: 'content', sourceDataChanged }));
      }
    }
    catch (err) {
      if (this._tileJSONRequest !== tileJSONRequest) {
        return;
      }
      this._tileJSONRequest = undefined;
      if (tileJSONRequest.signal.aborted) {
        return;
      }
      this._loaded = true; // let's pretend it's loaded so the source will be ignored

      // only fire error event if it is not due to aborting the request
      if (!isAbortError(err)) {
        this.fire(new ErrorEvent(ensureError(err)));
      }
    }
  }

  loaded(): boolean {
    return this._loaded;
  }

  onAdd(): void {
    this.load();
  }

  onRemove(): void {
    if (this._tileJSONRequest) {
      this._tileJSONRequest.abort();
      this._tileJSONRequest = undefined;
    }
  }

  setSourceProperty(callback: () => void): void {
    if (this._tileJSONRequest) {
      this._tileJSONRequest.abort();
      this._tileJSONRequest = undefined;
    }

    callback();

    this.load(true);
  }

  /**
   * Sets the source `tiles` property and re-renders the map.
   *
   * @param tiles - An array of one or more tile source URLs, as in the raster tiles spec (See the [Style Specification](https://maplibre.org/maplibre-style-spec/)
   */
  setTiles(tiles: string[]): this {
    this.setSourceProperty(() => {
      this._options.tiles = tiles;
    });

    return this;
  }

  /**
   * Sets the source `url` property and re-renders the map.
   *
   * @param url - A URL to a TileJSON resource. Supported protocols are `http:` and `https:`.
   */
  setUrl(url: string): this {
    this.setSourceProperty(() => {
      this.url = url;
      this._options.url = url;
    });

    return this;
  }

  serialize(): RasterSourceSpecification | RasterDEMSourceSpecification {
    return Object.assign({}, this._options);
  }

  /**
   * Sets whether alpha premultiplication is applied to raster tile images.
   * Set to `false` to preserve exact RGBA byte values when alpha carries data instead of opacity.
   *
   * @param premultiplyAlpha - If `false`, disables alpha premultiplication for raster tile image decode and texture upload.
   * @example
   * ```ts
   * map.getSource<RasterTileSource>('raster-source').setPremultiplyAlpha(false);
   * ```
   */
  setPremultiplyAlpha(premultiplyAlpha: boolean): this {
    if (this._premultiplyAlpha === premultiplyAlpha)
      return this;

    this.setSourceProperty(() => {
      this._premultiplyAlpha = premultiplyAlpha;
    });

    return this;
  }

  hasTile(tileID: OverscaledTileID): boolean {
    return !this.tileBounds || this.tileBounds.contains(tileID.canonical);
  }

  loadTile(tile: Tile): Promise<void> {
    tile.reloadPromises ||= [];

    if (tile.aborted) {
      return Promise.resolve();
    }

    // A source-data/style update can request a tile again before its previous
    // image request has completed. Keep one network request per Tile and
    // serialize the reloads, otherwise the older response can overwrite the
    // newer texture and the two calls race over tile.abortController.
    if (tile.loadPromise) {
      return new Promise<void>((resolve, reject) => {
        tile.reloadPromises.push({ resolve: () => resolve(), reject });
      });
    }

    const loadPromise = this._loadTile(tile);
    tile.loadPromise = loadPromise;
    loadPromise.then(
      () => this._finishTileLoad(tile, loadPromise),
      error => this._finishTileLoad(tile, loadPromise, error, true),
    );
    return loadPromise;
  }

  private async _loadTile(tile: Tile): Promise<void> {
    const url = tile.tileID.canonical.url(this.tiles, this.style?.pixelRatio ?? 1, this.scheme);
    const premultiply = this._premultiplyAlpha;
    const imageBitmapOptions = premultiply ? undefined : { premultiplyAlpha: 'none' } as const;
    const abortController = new AbortController();
    tile.abortController = abortController;
    try {
      if (tile.aborted) {
        return;
      }
      const request = await transformRequest(url, ResourceType.Tile, this.style?.transformRequest);
      // Keep passing the controller through even if abortTile() raced with
      // transformRequest(). ImageRequest owns the abort-aware fetch path; a
      // mocked/custom request must still receive the same live controller.
      if (tile.aborted) {
        return;
      }
      const response = await ImageRequest.getImage(
        request,
        abortController,
        this.style?.refreshExpiredTiles ?? false,
        imageBitmapOptions,
      );
      if (tile.abortController === abortController) {
        delete tile.abortController;
      }
      if (tile.aborted) {
        closeImageBitmap(response?.data);
        tile.state = 'unloaded';
        return;
      }
      if (response?.data) {
        if ((this.style?.refreshExpiredTiles ?? false) && (response.cacheControl || response.expires)) {
          tile.setExpiryData({ cacheControl: response.cacheControl, expires: response.expires });
        }
        closeImageBitmap(tile.textureData);
        tile.textureData = response.data;
        tile.state = 'loaded';
      }
    }
    catch (err) {
      if (tile.abortController === abortController) {
        delete tile.abortController;
      }
      if (tile.aborted) {
        tile.state = 'unloaded';
      }
      else if (err) {
        tile.state = 'errored';
        throw err;
      }
    }
  }

  private _finishTileLoad(tile: Tile, loadPromise: Promise<void>, error?: unknown, rejected = false): void {
    if (tile.loadPromise !== loadPromise) {
      return;
    }
    tile.loadPromise = undefined;

    const reloadPromises = tile.reloadPromises.splice(0);
    if (reloadPromises.length === 0) {
      return;
    }

    if (rejected) {
      for (const reloadPromise of reloadPromises) {
        reloadPromise.reject(error);
      }
      return;
    }

    if (tile.aborted) {
      for (const reloadPromise of reloadPromises) {
        reloadPromise.resolve();
      }
      return;
    }

    this.loadTile(tile).then(
      () => reloadPromises.forEach(reloadPromise => reloadPromise.resolve()),
      reloadError => reloadPromises.forEach(reloadPromise => reloadPromise.reject(reloadError)),
    );
  }

  async abortTile(tile: Tile): Promise<void> {
    if (tile.abortController) {
      tile.abortController.abort();
    }
    tile.reloadPromises ||= [];
    for (const reloadPromise of tile.reloadPromises.splice(0)) {
      reloadPromise.resolve();
    }
  }

  async unloadTile(tile: Tile): Promise<void> {
    closeImageBitmap(tile.textureData);
    tile.textureData = undefined;
    tile.unloadVectorData();
  }

  hasTransition(): boolean {
    return false;
  }
}

function closeImageBitmap(image: unknown): void {
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    image.close();
  }
}
