import type { GeoJSONVTOptions } from '@maplibre/geojson-vt';
import type { GeoJSONSourceSpecification, PromoteIdSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Style } from '../style/style';
import type { Tile } from '../tile/tile';
import type { SourceEventType } from '../util/events';
import type { WorkerDispatcher } from '../worker/dispatcher';
import type { GeoJSONWorkerSourceLoadDataResult } from '../worker/messages';
import type { WorkerChannel } from '../worker/worker-channel';
import type { GeoJSONWorkerOptions, LoadGeoJSONParameters } from './geojson-worker-source';

import type { Source } from './source';
import type { WorkerTileParameters } from './worker-source';
import { EXTENT } from '../data/extent';
import { TileLoadRequest } from '../tile/tile';
import { isAbortError } from '../util/abort-error';
import { ensureError, warnOnce } from '../util/errors';
import { ErrorEvent, Evented } from '../util/evented';
import { SourceDataEvent } from '../util/events';
import { ResourceType, transformRequest } from '../util/request';
import { MessageType } from '../worker/messages';

/**
 * Options object for GeoJSONSource.
 */
export type GeoJSONSourceOptions = GeoJSONSourceSpecification & {
  workerOptions?: GeoJSONWorkerOptions;
  collectResourceTiming?: boolean;
  data: GeoJSON.GeoJSON | string;
};

export interface GeoJSONSourceInternalOptions {
  data?: GeoJSON.GeoJSON | string | undefined;
  cluster?: boolean;
  clusterMaxZoom?: number;
  clusterRadius?: number;
  clusterMinPoints?: number;
  generateId?: boolean;
}

type PreparedGeoJSONVTOptions = GeoJSONVTOptions & {
  buffer: number;
  extent: number;
  cluster: boolean;
  clusterOptions: NonNullable<GeoJSONVTOptions['clusterOptions']> & {
    maxZoom: number;
    radius: number;
  };
};

type PreparedGeoJSONWorkerOptions = Omit<GeoJSONWorkerOptions, 'geojsonVtOptions'> & {
  geojsonVtOptions: PreparedGeoJSONVTOptions;
};

/**
 * Builds worker tiles from inline GeoJSON or a URL, following GeoJSONSourceSpecification.
 * Configure the source in StyleSpecification.sources and apply changes with CesiumVectorTileset.setStyle.
 *
 * @internal
 */
export class GeoJSONSource extends Evented<SourceEventType> implements Source {
  private readonly _tileLoads = new Map<Tile, TileLoadRequest<void>>();
  type: 'geojson';
  id: string;
  minzoom: number;
  maxzoom: number;
  tileSize: number;
  attribution?: string;
  promoteId?: PromoteIdSpecification;

  reparseOverscaled: boolean;
  _data: { url: string } | { geojson: GeoJSON.GeoJSON };

  _options: GeoJSONSourceInternalOptions;
  workerOptions: PreparedGeoJSONWorkerOptions;
  style?: Style;
  channelPromise: Promise<WorkerChannel>;
  _isUpdatingWorker: boolean;
  _updatePromise: Promise<void> = Promise.resolve();
  _pendingWorkerUpdate: {
    data?: GeoJSON.GeoJSON | string;
  };

  _collectResourceTiming: boolean;
  _removed: boolean;

  /**
   * @internal
   */
  constructor(id: string, options: GeoJSONSourceOptions, dispatcher: WorkerDispatcher, eventedParent: Evented) {
    super();

    this.id = id;

    // `type` is a property rather than a constant to make it easy for 3rd
    // parties to use GeoJSONSource to build their own source types.
    this.type = 'geojson';

    this.minzoom = 0;
    this.maxzoom = 18;
    this.tileSize = 512;
    this.reparseOverscaled = true;
    this._removed = false;
    this._isUpdatingWorker = false;
    this._pendingWorkerUpdate = { data: options.data };

    this.channelPromise = dispatcher.getChannel();
    this.setEventedParent(eventedParent);

    this._data = typeof options.data === 'string' ? { url: options.data } : { geojson: options.data };
    this._options = Object.assign({}, options);

    this._collectResourceTiming = options.collectResourceTiming ?? false;

    if (options.maxzoom !== undefined)
      this.maxzoom = options.maxzoom;
    if (options.type)
      this.type = options.type;
    if (options.attribution !== undefined)
      this.attribution = options.attribution;
    this.promoteId = options.promoteId;

    if (options.clusterMaxZoom !== undefined && this.maxzoom <= options.clusterMaxZoom) {
      warnOnce(`The maxzoom value "${this.maxzoom}" is expected to be greater than the clusterMaxZoom value "${options.clusterMaxZoom}".`);
    }

    // sent to the worker, along with `url: ...` or `data: literal geojson`,
    // so that it can load/parse/index the geojson data
    // extending with `options.workerOptions` helps to make it easy for
    // third-party sources to hack/reuse GeoJSONSource.
    const defaultGeoJSONVTOptions: PreparedGeoJSONVTOptions = {
      buffer: this._pixelsToTileUnits(options.buffer !== undefined ? options.buffer : 128),
      tolerance: this._pixelsToTileUnits(options.tolerance !== undefined ? options.tolerance : 0.375),
      extent: EXTENT,
      maxZoom: this.maxzoom,
      lineMetrics: options.lineMetrics ?? false,
      generateId: options.generateId ?? false,
      promoteId: typeof options.promoteId === 'string' ? options.promoteId : undefined,
      cluster: options.cluster ?? false,
      clusterOptions: {
        maxZoom: this._getClusterMaxZoom(options.clusterMaxZoom),
        minPoints: Math.max(2, options.clusterMinPoints ?? 2),
        extent: EXTENT,
        radius: this._pixelsToTileUnits(options.clusterRadius ?? 50),
        log: false,
        generateId: options.generateId ?? false,
      },
    };

    const suppliedGeoJSONVTOptions = options.workerOptions?.geojsonVtOptions;
    const geojsonVtOptions: PreparedGeoJSONVTOptions = {
      ...defaultGeoJSONVTOptions,
      ...suppliedGeoJSONVTOptions,
      clusterOptions: {
        ...defaultGeoJSONVTOptions.clusterOptions,
        ...suppliedGeoJSONVTOptions?.clusterOptions,
      },
    };

    this.workerOptions = {
      ...options.workerOptions,
      source: this.id,
      geojsonVtOptions,
      clusterProperties: options.clusterProperties as Record<string, [unknown, unknown]> | undefined,
      filter: options.filter,
      collectResourceTiming: options.workerOptions?.collectResourceTiming,
    };
  }

  /**
   * @internal
   */
  private _hasPendingWorkerUpdate(): boolean {
    return this._pendingWorkerUpdate.data !== undefined;
  }

  /**
   * @internal
   */
  private _pixelsToTileUnits(pixelValue: number): number {
    return pixelValue * (EXTENT / this.tileSize);
  }

  /**
   * @internal
   */
  private _getClusterMaxZoom(clusterMaxZoom?: number): number {
    const effectiveClusterMaxZoom = clusterMaxZoom !== undefined ? Math.round(clusterMaxZoom) : this.maxzoom - 1;
    if (!(Number.isInteger(clusterMaxZoom) || clusterMaxZoom === undefined)) {
      warnOnce(`Integer expected for option 'clusterMaxZoom': provided value "${clusterMaxZoom}" rounded to "${effectiveClusterMaxZoom}"`);
    }
    return effectiveClusterMaxZoom;
  }

  async load(): Promise<void> {
    await this._updateWorkerData();
  }

  onAdd(): void {
    this.load();
  }

  /**
   * Replaces the GeoJSON data and updates its worker tiles.
   *
   * @param data - A GeoJSON data object or a URL to one. The latter is preferable in the case of large GeoJSON files.
   */
  setData(data: GeoJSON.GeoJSON | string): Promise<void> {
    this._data = typeof data === 'string' ? { url: data } : { geojson: data };
    this._pendingWorkerUpdate = { data };
    return this._updateWorkerData();
  }

  /**
   * Responsible for invoking WorkerSource's geojson.loadData target, which
   * handles loading the geojson data and preparing to serve it up as tiles,
   * using geojson-vt or supercluster as appropriate.
   * @internal
   */
  private async _updateWorkerData(): Promise<void> {
    if (this._isUpdatingWorker)
      return this._updatePromise;

    if (!this._hasPendingWorkerUpdate()) {
      warnOnce(`No pending worker updates for GeoJSONSource ${this.id}.`);
      return;
    }

    const { data } = this._pendingWorkerUpdate;
    // delay awaiting params until _isUpdatingWorker is set, otherwise, a race condition could happen
    const params = this._getLoadGeoJSONParameters(data);
    this._pendingWorkerUpdate.data = undefined;

    this._updatePromise = this._dispatchWorkerUpdate(params);
    await this._updatePromise;
  }

  /**
   * Create the parameters object that will be sent to the worker and used to load GeoJSON.
   * @internal
   */
  private async _getLoadGeoJSONParameters(data?: string | GeoJSON.GeoJSON<GeoJSON.Geometry>): Promise<LoadGeoJSONParameters> {
    const params: LoadGeoJSONParameters = Object.assign({ type: this.type, source: this.id }, this.workerOptions);

    // Data comes from a remote url
    if (typeof data === 'string') {
      const request = await transformRequest(new URL(data, document.baseURI).href, ResourceType.Source, this.style?.transformRequest);
      if (this._collectResourceTiming) {
        request.collectResourceTiming = true;
      }
      params.request = request;
      return params;
    }

    // Data is a geojson object
    if (data !== undefined) {
      params.data = data;
      return params;
    }

    throw new Error(`GeoJSONSource "${this.id}" has no pending worker update.`);
  }

  /**
   * Send the worker update data from the main thread to the worker
   * @internal
   */
  private async _dispatchWorkerUpdate(optionsPromise: Promise<LoadGeoJSONParameters>) {
    this._isUpdatingWorker = true;
    this.fire(new SourceDataEvent('dataloading'));

    try {
      const options = await optionsPromise;
      const result = await (await this.channelPromise).sendAsync({ type: MessageType.loadData, data: options });
      this._isUpdatingWorker = false;

      if (this._removed || result.abandoned) {
        this.fire(new SourceDataEvent('dataabort'));
        return;
      }

      // Update the copy of the data in this source with the worker result. (only sent for url based geojson data)
      if (result.data) {
        this._data = { geojson: result.data };
      }

      const eventData: { resourceTiming?: PerformanceEntryList } = {};
      this._applyResourceTiming(eventData, result);

      // Fire the metadata event to let the TilePyramid know it's ok to start requesting tiles.
      this.fire(new SourceDataEvent('data', { ...eventData, sourceDataType: 'metadata' }));
      this.fire(new SourceDataEvent('data', { ...eventData, sourceDataType: 'content' }));
    }
    catch (err) {
      this._isUpdatingWorker = false;

      if (this._removed) {
        this.fire(new SourceDataEvent('dataabort'));
        return;
      }

      this.fire(new ErrorEvent(ensureError(err)));
    }
    finally {
      // If there is more pending data, update the worker again.
      if (this._hasPendingWorkerUpdate()) {
        await this._updateWorkerData();
      }
    }
  }

  /**
   * Apply resource timing data to the event object.
   * @internal
   */
  private _applyResourceTiming(eventData: { resourceTiming?: PerformanceEntryList }, result: GeoJSONWorkerSourceLoadDataResult) {
    if (!this._collectResourceTiming)
      return;

    const timingData = result.resourceTiming?.[this.id];
    if (!timingData)
      return;

    const resourceTiming = timingData.slice(0);
    if (!resourceTiming?.length)
      return;

    Object.assign(eventData, { resourceTiming });
  }

  loaded(): boolean {
    return !this._isUpdatingWorker && !this._hasPendingWorkerUpdate();
  }

  loadTile(tile: Tile): Promise<void> {
    if (this._removed || tile.aborted) {
      return Promise.resolve();
    }
    const active = this._tileLoads.get(tile);
    if (active) {
      active.version++;
      return active.promise;
    }
    const request = new TileLoadRequest<void>(current => this._loadTile(tile, current));
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
  private async _loadTile(tile: Tile, request: TileLoadRequest<void>): Promise<void> {
    while (!this._removed && !tile.aborted && !request.controller.signal.aborted) {
      const version = request.version;
      const style = this.style;
      if (!style)
        throw new Error('GeoJSON tile data cannot be loaded before the source is attached to a Style.');
      const parseState = style.getSourceParseState(this.id);
      const superseded = () => version !== request.version || parseState !== style.getSourceParseState(this.id);
      try {
        await request.wait(parseState.ready);
        if (superseded())
          continue;
        const message = !tile.channel ? MessageType.loadTile : MessageType.reloadTile;
        const channel = await request.wait(this.channelPromise);
        if (this._removed || tile.aborted || request.controller.signal.aborted) {
          return;
        }
        if (superseded())
          continue;
        tile.channel = channel;
        const params: WorkerTileParameters = {
          type: this.type,
          uid: tile.uid,
          tileID: tile.tileID,
          zoom: tile.tileID.overscaledZ,
          maxZoom: this.maxzoom,
          source: this.id,
          pixelRatio: this.style?.pixelRatio ?? 1,
          promoteId: this.promoteId,
        };

        const data = await request.wait(channel.sendAsync({ type: message, data: params }, request.controller));
        if (this._removed || tile.aborted || request.controller.signal.aborted) {
          return;
        }
        if (superseded())
          continue;
        tile.loadVectorData(data, style, message === MessageType.reloadTile);
        return;
      }
      catch (err) {
        if (this._removed || tile.aborted || request.controller.signal.aborted || isAbortError(err)) {
          return;
        }
        if (superseded())
          continue;
        throw err;
      }
    }
  }

  async abortTile(tile: Tile): Promise<void> {
    if (tile.abortController) {
      tile.abortController.abort();
      delete tile.abortController;
    }
    tile.aborted = true;
  }

  async unloadTile(tile: Tile): Promise<void> {
    tile.unloadVectorData();
    await (await this.channelPromise).sendAsync({ type: MessageType.removeTile, data: { uid: tile.uid, type: this.type, source: this.id } });
  }

  onRemove(): void {
    this._removed = true;
    for (const request of this._tileLoads.values())
      request.controller.abort();
    void this.channelPromise
      .then(channel => channel.sendAsync({ type: MessageType.removeSource, data: { type: this.type, source: this.id } }))
      .catch(() => {});
  }

  serialize(): GeoJSONSourceSpecification {
    return Object.assign({}, this._options, {
      type: this.type,
      data: 'url' in this._data ? this._data.url : this._data.geojson,
    });
  }

  hasTransition() {
    return false;
  }
}
