import type { GeoJSONVTOptions } from '@maplibre/geojson-vt';
import type { GeoJSONSourceSpecification, PromoteIdSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LngLatBounds } from '../geo/lng-lat-bounds';
import type { Style } from '../style/style';
import type { Tile } from '../tile/tile';
import type { SourceEventType } from '../util/events';
import type { ExactlyOne } from '../util/objects';
import type { WorkerDispatcher } from '../worker/dispatcher';
import type { GeoJSONWorkerSourceLoadDataResult } from '../worker/messages';
import type { WorkerChannel } from '../worker/worker-channel';
import type { GeoJSONFeatureId, GeoJSONSourceDiff } from './geojson-source-diff';
import type { GeoJSONWorkerOptions, LoadGeoJSONParameters } from './geojson-worker-source';

import type { Source } from './source';
import type { WorkerTileParameters } from './worker-source';
import { EXTENT } from '../data/extent';
import { TileLoadRequest } from '../tile/tile';
import { tileIdToLngLatBounds } from '../tile/tile-id-to-lng-lat-bounds';
import { isAbortError } from '../util/abort-error';
import { browser } from '../util/browser';
import { ensureError, warnOnce } from '../util/errors';
import { ErrorEvent, Evented } from '../util/evented';
import { SourceDataEvent } from '../util/events';
import { ResourceType, transformRequest } from '../util/request';
import { MessageType } from '../worker/messages';
import { getGeoJSONBounds } from './geojson-bounds';
import { applySourceDiff, mergeSourceDiffs, toUpdateable } from './geojson-source-diff';

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

/**
 * @internal
 */
export interface GeoJSONSourceShouldReloadTileOptions {
  /**
   * Refresh all tiles that WILL contain these bounds.
   */
  affectedBounds: LngLatBounds[];
}

/**
 * The cluster options to set
 */
export interface SetClusterOptions {
  /**
   * Whether or not to cluster
   */
  cluster?: boolean;
  /**
   * The cluster's max zoom.
   * Non-integer values are rounded to the closest integer due to supercluster integer value requirements.
   */
  clusterMaxZoom?: number;
  /**
   * The cluster's radius
   */
  clusterRadius?: number;
}

/**
 * The cluster options currently configured on a source, as returned by `getClusterOptions`
 */
export interface GetClusterOptions {
  /**
   * Whether or not the source is clustered
   */
  cluster: boolean;
  /**
   * The cluster's max zoom
   */
  clusterMaxZoom: number;
  /**
   * The cluster's radius, in pixels
   */
  clusterRadius: number;
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
 * A source containing GeoJSON.
 * (See the [Style Specification](https://maplibre.org/maplibre-style-spec/#sources-geojson) for detailed documentation of options.)
 *
 * @group Sources
 *
 * @example
 * ```ts
 * map.addSource('some id', {
 *     type: 'geojson',
 *     data: 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_ports.geojson'
 * });
 * ```
 *
 * @example
 * ```ts
 * map.addSource('some id', {
 *    type: 'geojson',
 *    data: {
 *        "type": "FeatureCollection",
 *        "features": [{
 *            "type": "Feature",
 *            "properties": {},
 *            "geometry": {
 *                "type": "Point",
 *                "coordinates": [
 *                    -76.53063297271729,
 *                    39.18174077994108
 *                ]
 *            }
 *        }]
 *    }
 * });
 * ```
 *
 * @example
 * ```ts
 * map.getSource('some id').setData({
 *   "type": "FeatureCollection",
 *   "features": [{
 *       "type": "Feature",
 *       "properties": { "name": "Null Island" },
 *       "geometry": {
 *           "type": "Point",
 *           "coordinates": [ 0, 0 ]
 *       }
 *   }]
 * });
 * ```
 * @see [Draw GeoJSON points](https://maplibre.org/maplibre-gl-js/docs/examples/draw-geojson-points/)
 * @see [Add a GeoJSON line](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-geojson-line/)
 * @see [Create a heatmap from points](https://maplibre.org/maplibre-gl-js/docs/examples/create-a-heatmap-layer/)
 * @see [Create and style clusters](https://maplibre.org/maplibre-gl-js/docs/examples/create-and-style-clusters/)
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

  isTileClipped: boolean;
  reparseOverscaled: boolean;
  _data: ExactlyOne<{
    url: string;
    geojson: GeoJSON.GeoJSON;
    updateable: globalThis.Map<GeoJSONFeatureId, GeoJSON.Feature>;
  }>;

  _options: GeoJSONSourceInternalOptions;
  workerOptions: PreparedGeoJSONWorkerOptions;
  style?: Style;
  channelPromise: Promise<WorkerChannel>;
  _isUpdatingWorker: boolean;
  _updatePromise: Promise<void> = Promise.resolve();
  _pendingWorkerUpdate: {
    data?: GeoJSON.GeoJSON | string;
    diff?: GeoJSONSourceDiff;
    updateCluster?: boolean;
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
    this.isTileClipped = true;
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
    return this._pendingWorkerUpdate.data !== undefined || this._pendingWorkerUpdate.diff !== undefined || this._pendingWorkerUpdate.updateCluster;
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
  private _tileUnitsToPixels(tileUnitValue: number): number {
    return tileUnitValue / (EXTENT / this.tileSize);
  }

  /**
   * @internal
   */
  private _getClusterMaxZoom(clusterMaxZoom: number): number {
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
   * Sets the GeoJSON data and re-renders the map.
   *
   * @param data - A GeoJSON data object or a URL to one. The latter is preferable in the case of large GeoJSON files.
   */
  setData(data: GeoJSON.GeoJSON | string): Promise<void> {
    this._data = typeof data === 'string' ? { url: data } : { geojson: data };
    this._pendingWorkerUpdate = { data };
    return this._updateWorkerData();
  }

  /**
   * Updates the source's GeoJSON, and re-renders the map.
   *
   * For sources with lots of features, this method can be used to make updates more quickly.
   *
   * This approach requires unique IDs for every feature in the source. The IDs can either be specified on the feature,
   * or by using the promoteId option to specify which property should be used as the ID.
   *
   * It is an error to call updateData on a source that did not have unique IDs for each of its features already.
   *
   * Updates are applied on a best-effort basis, updating an ID that does not exist will not result in an error.
   *
   * @param diff - The changes that need to be applied.
   */
  updateData(diff: GeoJSONSourceDiff): Promise<void> {
    this._pendingWorkerUpdate.diff = mergeSourceDiffs(this._pendingWorkerUpdate.diff, diff);
    return this._updateWorkerData();
  }

  /**
   * Allows to get the source's actual GeoJSON data.
   *
   * @returns a promise which resolves to the source's actual GeoJSON data
   */
  async getData(): Promise<GeoJSON.GeoJSON> {
    if (this._data.url) {
      await this.once('data'); // wait for loading to complete
    }
    if ('geojson' in this._data) {
      return this._data.geojson;
    }
    if ('updateable' in this._data) {
      return {
        type: 'FeatureCollection',
        features: Array.from(this._data.updateable.values()),
      };
    }
    return {
      type: 'FeatureCollection',
      features: [],
    };
  }

  /**
   * Allows getting the source's boundaries.
   * If there's a problem with the source's data, it will return an empty {@link LngLatBounds}.
   * @returns a promise which resolves to the source's boundaries
   */
  async getBounds(): Promise<LngLatBounds> {
    return getGeoJSONBounds(await this.getData());
  }

  /**
   * To disable/enable clustering on the source options
   * @param options - The options to set
   * @example
   * ```ts
   * map.getSource('some id').setClusterOptions({cluster: false});
   * map.getSource('some id').setClusterOptions({cluster: false, clusterRadius: 50, clusterMaxZoom: 14});
   * ```
   */
  setClusterOptions(options: SetClusterOptions): Promise<void> {
    this.workerOptions.geojsonVtOptions.cluster = options.cluster ?? this.workerOptions.geojsonVtOptions.cluster;
    if (options.clusterRadius !== undefined) {
      this.workerOptions.geojsonVtOptions.clusterOptions.radius = this._pixelsToTileUnits(options.clusterRadius);
    }
    if (options.clusterMaxZoom !== undefined) {
      this.workerOptions.geojsonVtOptions.clusterOptions.maxZoom = this._getClusterMaxZoom(options.clusterMaxZoom);
    }
    this._pendingWorkerUpdate.updateCluster = true;
    return this._updateWorkerData();
  }

  /**
   * Gets the cluster options currently configured on the source.
   * The returned values mirror the options accepted by `setClusterOptions`.
   *
   * @returns the source's current cluster options
   * @example
   * ```ts
   * const {cluster, clusterMaxZoom, clusterRadius} = map.getSource('some id').getClusterOptions();
   * ```
   */
  getClusterOptions(): GetClusterOptions {
    const { cluster, clusterOptions } = this.workerOptions.geojsonVtOptions;
    return {
      cluster,
      clusterMaxZoom: clusterOptions.maxZoom,
      clusterRadius: this._tileUnitsToPixels(clusterOptions.radius),
    };
  }

  /**
   * For clustered sources, fetches the zoom at which the given cluster expands.
   *
   * @param clusterId - The value of the cluster's `cluster_id` property.
   * @returns a promise that is resolved with the zoom number
   */
  async getClusterExpansionZoom(clusterId: number): Promise<number> {
    return (await this.channelPromise).sendAsync({ type: MessageType.getClusterExpansionZoom, data: { type: this.type, clusterId, source: this.id } });
  }

  /**
   * For clustered sources, fetches the children of the given cluster on the next zoom level (as an array of GeoJSON features).
   *
   * @param clusterId - The value of the cluster's `cluster_id` property.
   * @returns a promise that is resolved when the features are retrieved
   */
  async getClusterChildren(clusterId: number): Promise<GeoJSON.Feature[]> {
    return (await this.channelPromise).sendAsync({ type: MessageType.getClusterChildren, data: { type: this.type, clusterId, source: this.id } });
  }

  /**
   * For clustered sources, fetches the original points that belong to the cluster (as an array of GeoJSON features).
   *
   * @param clusterId - The value of the cluster's `cluster_id` property.
   * @param limit - The maximum number of features to return.
   * @param offset - The number of features to skip (e.g. for pagination).
   * @returns a promise that is resolved when the features are retrieved
   * @example
   * Retrieve cluster leaves on click
   * ```ts
   * map.on('click', 'clusters', (e) => {
   *   let features = map.queryRenderedFeatures(e.point, {
   *     layers: ['clusters']
   *   });
   *
   *   let clusterId = features[0].properties.cluster_id;
   *   let pointCount = features[0].properties.point_count;
   *   let clusterSource = map.getSource('clusters');
   *
   *   const features = await clusterSource.getClusterLeaves(clusterId, pointCount);
   *   // Print cluster leaves in the console
   *   console.log('Cluster leaves:', features);
   * });
   * ```
   */
  async getClusterLeaves(clusterId: number, limit: number, offset: number): Promise<GeoJSON.Feature[]> {
    return (await this.channelPromise).sendAsync({ type: MessageType.getClusterLeaves, data: {
      type: this.type,
      source: this.id,
      clusterId,
      limit,
      offset,
    } });
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

    const { data, diff, updateCluster } = this._pendingWorkerUpdate;
    // delay awaiting params until _isUpdatingWorker is set, otherwise, a race condition could happen
    const params = this._getLoadGeoJSONParameters(data, diff, updateCluster);

    if (data !== undefined) {
      this._pendingWorkerUpdate.data = undefined;
    }
    else if (diff) {
      this._pendingWorkerUpdate.diff = undefined;
    }
    else if (updateCluster) {
      this._pendingWorkerUpdate.updateCluster = undefined;
    }

    this._updatePromise = this._dispatchWorkerUpdate(params);
    await this._updatePromise;
  }

  /**
   * Create the parameters object that will be sent to the worker and used to load GeoJSON.
   * @internal
   */
  private async _getLoadGeoJSONParameters(data?: string | GeoJSON.GeoJSON<GeoJSON.Geometry>, diff?: GeoJSONSourceDiff, updateCluster?: boolean): Promise<LoadGeoJSONParameters> {
    const params: LoadGeoJSONParameters = Object.assign({ type: this.type, source: this.id }, this.workerOptions);

    // Data comes from a remote url
    if (typeof data === 'string') {
      const request = await transformRequest(browser.resolveURL(data), ResourceType.Source, this.style?.transformRequest);
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

    // Data is a differential update
    if (diff) {
      params.dataDiff = diff;
      return params;
    }

    // Update supercluster with the latest worker cluster options
    if (updateCluster) {
      params.updateCluster = true;
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

      const affectedGeometries = this._applyDiffToSource(options.dataDiff);
      const shouldReloadTileOptions = this._getShouldReloadTileOptions(affectedGeometries);

      const eventData: { resourceTiming?: PerformanceResourceTiming[] } = {};
      this._applyResourceTiming(eventData, result);

      // Fire the metadata event to let the TilePyramid know it's ok to start requesting tiles.
      this.fire(new SourceDataEvent('data', { ...eventData, sourceDataType: 'metadata' }));
      this.fire(new SourceDataEvent('data', { ...eventData, sourceDataType: 'content', shouldReloadTileOptions }));
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
  private _applyResourceTiming(eventData: { resourceTiming?: PerformanceResourceTiming[] }, result: GeoJSONWorkerSourceLoadDataResult) {
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

  /**
   * Apply a diff to this source's data and return the affected feature geometries.
   * @param diff - The {@link GeoJSONSourceDiff} to apply.
   * @returns The affected geometries, or undefined if the diff is not applicable or all geometries are affected.
   * @internal
   */
  private _applyDiffToSource(diff?: GeoJSONSourceDiff): GeoJSON.Geometry[] | undefined {
    if (!diff) {
      return undefined;
    }

    const promoteId = typeof this.promoteId === 'string' ? this.promoteId : undefined;

    // Lazily convert `this._data` to updateable if it's not already
    if (!this._data.url && !this._data.updateable) {
      const updateable = toUpdateable(this._data.geojson, promoteId);
      if (!updateable)
        throw new Error(`GeoJSONSource "${this.id}": GeoJSON data is not compatible with updateData`);
      this._data = { updateable };
    }

    if (!this._data.updateable) {
      return undefined;
    }
    const affectedGeometries = applySourceDiff(this._data.updateable, diff, promoteId);

    if (diff.removeAll || this._options.cluster) {
      return undefined;
    }

    return affectedGeometries;
  }

  /**
   * Get options for use in determining whether to reload a tile based on the modified features.
   * @param affectedGeometries - The feature geometries affected by the update.
   * @returns A {@link GeoJSONSourceShouldReloadTileOptions} object which contains an array of affected bounds caused by the update.
   * @internal
   */
  private _getShouldReloadTileOptions(affectedGeometries?: GeoJSON.Geometry[]): GeoJSONSourceShouldReloadTileOptions | undefined {
    if (!affectedGeometries)
      return undefined;

    const affectedBounds = affectedGeometries
      .filter(Boolean)
      .map(g => getGeoJSONBounds(g));

    return { affectedBounds };
  }

  /**
   * Determine whether a tile should be reloaded based on a set of options associated with a {@link MapSourceDataChangedEvent}.
   * @internal
   */
  shouldReloadTile(tile: Tile, { affectedBounds }: GeoJSONSourceShouldReloadTileOptions): boolean {
    if (tile.state === 'loading') {
      return true;
    }
    if (tile.state === 'unloaded') {
      return false;
    }

    // Update the tile if contained or will contain an updated feature.
    const { buffer, extent } = this.workerOptions.geojsonVtOptions;
    const tileBounds = tileIdToLngLatBounds(
      tile.tileID.canonical,
      buffer / extent,
    );
    for (const bounds of affectedBounds) {
      if (tileBounds.intersects(bounds)) {
        return true;
      }
    }

    return false;
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
          tileSize: this.tileSize,
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
      data: 'updateable' in this._data
        ? {
            type: 'FeatureCollection',
            features: Array.from(this._data.updateable.values()),
          }
        : 'url' in this._data ? this._data.url : this._data.geojson,
    });
  }

  hasTransition() {
    return false;
  }
}
