import type { PromoteIdSpecification, VectorSourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Style } from '../style/style';
import type { Tile } from '../tile/tile';

import type { OverscaledTileID } from '../tile/tile-id';
import type { SourceEventType } from '../util/events';
import type { WorkerDispatcher } from '../worker/dispatcher';
import type { Source } from './source';
import type { OverzoomParameters, TileEncoding, WorkerTileParameters, WorkerTileResult } from './worker-source';

import { TileLoadRequest } from '../tile/tile';
import { TileBounds } from '../tile/tile-bounds';
import { isAbortError } from '../util/abort-error';
import { ensureError, hasHttpStatus } from '../util/errors';
import { ErrorEvent, Evented } from '../util/evented';
import { SourceDataEvent } from '../util/events';
import { pick } from '../util/objects';
import { ResourceType, transformRequest } from '../util/request';
import { MessageType } from '../worker/messages';
import { loadTileJson } from './load-tilejson';

export type VectorTileSourceOptions = VectorSourceSpecification & {
  collectResourceTiming?: boolean;
  tileSize?: number;
};

export interface LoadTileResult {
  /**
   * Indicates that the tile requested was not modified.
   */
  unmodified?: boolean;
}

/**
 * A source containing vector tiles in [Maplibre Vector Tile format](https://maplibre.org/maplibre-tile-spec/) or [Mapbox Vector Tile format](https://docs.mapbox.com/vector-tiles/reference/).
 * (See the [Style Specification](https://maplibre.org/maplibre-style-spec/) for detailed documentation of options.)
 *
 * @group Sources
 *
 * @example
 * ```ts
 * map.addSource('some id', {
 *     type: 'vector',
 *     url: 'https://demotiles.maplibre.org/tiles/tiles.json'
 * });
 * ```
 *
 * @example
 * ```ts
 * map.addSource('some id', {
 *     type: 'vector',
 *     tiles: ['https://d25uarhxywzl1j.cloudfront.net/v0.1/{z}/{x}/{y}.mvt'],
 *     minzoom: 6,
 *     maxzoom: 14
 * });
 * ```
 *
 * @example
 * ```ts
 * map.getSource('some id').setUrl("https://demotiles.maplibre.org/tiles/tiles.json");
 * ```
 *
 * @example
 * ```ts
 * map.getSource('some id').setTiles(['https://d25uarhxywzl1j.cloudfront.net/v0.1/{z}/{x}/{y}.mvt']);
 * ```
 * @see [Add a vector tile source](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-vector-tile-source/)
 */
export class VectorTileSource extends Evented<SourceEventType> implements Source {
  type: 'vector';
  id: string;
  minzoom: number;
  maxzoom: number;
  url?: string;
  scheme: string;
  encoding: TileEncoding = 'mvt';
  tileSize: number;
  promoteId?: PromoteIdSpecification;

  _options: VectorSourceSpecification;
  _collectResourceTiming: boolean;
  dispatcher: WorkerDispatcher;
  style?: Style;
  bounds?: [number, number, number, number];
  tiles: string[];
  tileBounds?: TileBounds;
  reparseOverscaled: boolean;
  isTileClipped: boolean;
  _tileJSONRequest?: AbortController;
  _loaded: boolean;

  private _removed = false;

  private readonly _tileLoads = new Map<Tile, TileLoadRequest<LoadTileResult | void>>();

  constructor(id: string, options: VectorTileSourceOptions, dispatcher: WorkerDispatcher, eventedParent: Evented) {
    super();
    this.id = id;
    this.dispatcher = dispatcher;

    this.type = 'vector';
    this.minzoom = 0;
    this.maxzoom = 22;
    this.scheme = 'xyz';
    this.tileSize = 512;
    this.reparseOverscaled = true;
    this.isTileClipped = true;
    this._loaded = false;
    this.tiles = options.tiles ?? [];
    this.url = options.url;

    Object.assign(this, pick(options, ['url', 'scheme', 'tileSize', 'promoteId', 'encoding']));
    this._options = Object.assign({ type: 'vector' }, options);

    this._collectResourceTiming = options.collectResourceTiming ?? false;

    if (this.tileSize !== 512) {
      throw new Error('vector tile sources must have a tileSize of 512');
    }

    this.setEventedParent(eventedParent);
  }

  async load(sourceDataChanged: boolean = false): Promise<void> {
    this._loaded = false;
    this.fire(new SourceDataEvent('dataloading'));
    const tileJSONRequest = new AbortController();
    this._tileJSONRequest = tileJSONRequest;
    try {
      const tileJSON = await loadTileJson(this._options, this.style?.transformRequest, tileJSONRequest);
      // A URL/tile-template update or source removal may replace the request
      // while the old promise is unwinding. Ignore that stale response and do
      // not clear the controller belonging to the newer request.
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

  hasTile(tileID: OverscaledTileID): boolean {
    return !this.tileBounds || this.tileBounds.contains(tileID.canonical);
  }

  onAdd(): void {
    this._removed = false;
    this.load();
  }

  setSourceProperty(callback: () => void): void {
    if (this._tileJSONRequest) {
      this._tileJSONRequest.abort();
    }

    callback();

    this.load(true);
  }

  /**
   * Sets the source `tiles` property and re-renders the map.
   *
   * @param tiles - An array of one or more tile source URLs, as in the TileJSON spec.
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

  onRemove(): void {
    this._removed = true;
    for (const request of this._tileLoads.values())
      request.controller.abort();
    if (this._tileJSONRequest) {
      this._tileJSONRequest.abort();
      this._tileJSONRequest = undefined;
    }
  }

  serialize(): VectorSourceSpecification {
    return Object.assign({}, this._options);
  }

  loadTile(tile: Tile): Promise<LoadTileResult | void> {
    if (this._removed || tile.aborted) {
      return Promise.resolve();
    }
    const active = this._tileLoads.get(tile);
    if (active) {
      active.version++;
      return active.promise;
    }
    const request = new TileLoadRequest<LoadTileResult | void>(current => this._loadTile(tile, current));
    this._tileLoads.set(tile, request);
    tile.abortController = request.controller;
    tile.loadPromise = request.promise;
    const finish = () => {
      if (this._tileLoads.get(tile) === request)
        this._tileLoads.delete(tile);
      if (tile.loadPromise === request.promise)
        tile.loadPromise = undefined;
      if (tile.abortController === request.controller)
        delete tile.abortController;
    };
    void request.promise.then(finish, finish);
    return request.promise;
  }

  /**
   * @internal
   */
  private async _loadTile(tile: Tile, request: TileLoadRequest<LoadTileResult | void>): Promise<LoadTileResult | void> {
    while (!this._removed && !tile.aborted && !request.controller.signal.aborted) {
      const version = request.version;
      const style = this.style;
      if (!style)
        throw new Error('Vector tile data cannot be loaded before the source is attached to a Style.');
      const parseState = style.getSourceParseState(this.id);
      const superseded = () => version !== request.version || parseState !== style.getSourceParseState(this.id);
      try {
        await request.wait(parseState.ready);
        if (superseded())
          continue;
        const url = tile.tileID.canonical.url(this.tiles, this.style?.pixelRatio ?? 1, this.scheme);
        const params: WorkerTileParameters = {
          request: await request.wait(transformRequest(url, ResourceType.Tile, this.style?.transformRequest)),
          uid: tile.uid,
          tileID: tile.tileID,
          zoom: tile.tileID.overscaledZ,
          tileSize: this.tileSize * tile.tileID.overscaleFactor(),
          type: this.type,
          source: this.id,
          pixelRatio: this.style?.pixelRatio ?? 1,
          promoteId: this.promoteId,
          encoding: this.encoding,
          overzoomParameters: await request.wait(this._getOverzoomParameters(tile)),
          etag: tile.etag,
        };
        if (params.request) {
          params.request.collectResourceTiming = this._collectResourceTiming;
        }
        await request.wait(this.dispatcher.waitForInitComplete());
        if (this._removed || tile.aborted || request.controller.signal.aborted) {
          return;
        }
        if (superseded())
          continue;
        let messageType: typeof MessageType.loadTile | typeof MessageType.reloadTile = MessageType.reloadTile;
        if (!tile.channel || tile.state === 'expired') {
          tile.channel = this.dispatcher.getReadyChannel();
          messageType = MessageType.loadTile;
        }
        const channel = tile.channel;
        if (!channel) {
          throw new Error(`No channel is available for tile ${tile.uid}.`);
        }
        const data = await request.wait(channel.sendAsync({ type: messageType, data: params }, request.controller));
        if (this._removed || tile.aborted || request.controller.signal.aborted) {
          return;
        }
        if (superseded())
          continue;
        this._afterTileLoadWorkerResponse(tile, data);

        const result: LoadTileResult = {};
        if (data?.etagUnmodified)
          result.unmodified = true;
        return result;
      }
      catch (err) {
        if (this._removed || tile.aborted || request.controller.signal.aborted || isAbortError(err)) {
          return;
        }
        if (superseded())
          continue;
        if (err && (!hasHttpStatus(err) || err.status !== 404)) {
          throw err;
        }
        this._afterTileLoadWorkerResponse(tile, undefined);
        return;
      }
    }
  }

  /**
   * When the requested tile has a higher canonical Z than source maxzoom, pass overzoom parameters so worker can load the
   * deepest tile at source max zoom to generate sub tiles using geojsonvt for highest performance on vector overscaling
   * @internal
   */
  private async _getOverzoomParameters(tile: Tile): Promise<OverzoomParameters | undefined> {
    if (tile.tileID.canonical.z <= this.maxzoom) {
      return undefined;
    }
    if (this.style?.zoomLevelsToOverscale === undefined) {
      return undefined;
    }
    const maxZoomTileID = tile.tileID.scaledTo(this.maxzoom).canonical;
    const maxZoomTileUrl = maxZoomTileID.url(this.tiles, this.style?.pixelRatio ?? 1, this.scheme);

    return {
      maxZoomTileID,
      overzoomRequest: await transformRequest(maxZoomTileUrl, ResourceType.Tile, this.style?.transformRequest),
    };
  }

  /**
   * @internal
   */
  private _afterTileLoadWorkerResponse(tile: Tile, data: WorkerTileResult) {
    if (data?.resourceTiming) {
      tile.resourceTiming = data.resourceTiming;
    }

    if (data && (this.style?.refreshExpiredTiles ?? false)) {
      tile.setExpiryData(data);
    }
    tile.etag = data?.etag;

    const style = this.style;
    if (!style) {
      throw new Error('Vector tile data cannot be loaded before the source is attached to a Style.');
    }
    tile.loadVectorData(data, style);
  }

  async abortTile(tile: Tile): Promise<void> {
    tile.aborted = true;
    if (tile.abortController) {
      tile.abortController.abort();
      delete tile.abortController;
    }
    if (tile.channel) {
      await tile.channel.sendAsync({
        type: MessageType.abortTile,
        data: { uid: tile.uid, type: this.type, source: this.id },
      });
    }
  }

  async unloadTile(tile: Tile): Promise<void> {
    tile.unloadVectorData();
    if (tile.channel) {
      await tile.channel.sendAsync({
        type: MessageType.removeTile,
        data: {
          uid: tile.uid,
          type: this.type,
          source: this.id,
        },
      });
    }
  }

  hasTransition() {
    return false;
  }
}
