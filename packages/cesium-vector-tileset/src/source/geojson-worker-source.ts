import type { GeoJSONVTOptions, SuperclusterOptions } from '@maplibre/geojson-vt';
import type { FilterSpecification, GlobalProperties, StyleExpression } from '@maplibre/maplibre-gl-style-spec';
import type { StyleLayerIndex } from '../style/style-layer-index';
import type { RequestParameters } from '../util/ajax';
import type { GeoJSONWorkerSourceLoadDataResult, RemoveSourceParams } from '../worker/messages';
import type { WorkerMessageSender } from '../worker/worker-channel';
import type { LoadVectorTileResult } from './vector-tile-worker-source';
import type { TileParameters, WorkerSource, WorkerTileParameters, WorkerTileResult } from './worker-source';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';

import { GeoJSONWrapper } from '@maplibre/vt-pbf';
import { EXTENT } from '../data/extent';
import { isAbortError, throwIfAborted } from '../util/abort-error';
import { getJSON } from '../util/ajax';
import { RequestPerformance } from '../util/request-performance';
import { WorkerTile } from './worker-tile';
import { WorkerTileState } from './worker-tile-state';

/**
 * The geojson worker options that can be passed to the worker
 */
export interface GeoJSONWorkerOptions {
  source?: string;
  geojsonVtOptions?: GeoJSONVTOptions;
  clusterProperties?: Record<string, [unknown, unknown]>;
  filter?: FilterSpecification;
  collectResourceTiming?: boolean;
}

/**
 * Parameters needed to load GeoJSON to the worker from a request or literal data.
 */
export type LoadGeoJSONParameters = GeoJSONWorkerOptions & {
  type: 'geojson';
  /** The geojson source ID. */
  source: string;
  /**
   * Request parameters including a URL to fetch GeoJSON data.
   */
  request?: RequestParameters;
  /**
   * GeoJSON data to set as the source's data.
   */
  data?: GeoJSON.GeoJSON;
};

/**
 * The {@link WorkerSource} implementation that supports {@link GeoJSONSource}.
 * Adapted from MapLibre GL JS's GeoJSON worker source.
 */
export class GeoJSONWorkerSource implements WorkerSource {
  channel: WorkerMessageSender;
  layerIndex: StyleLayerIndex;
  availableImages: string[];
  tileState: WorkerTileState;

  _pendingRequest?: AbortController;
  _geoJSONIndex?: GeoJSONVT;

  constructor(channel: WorkerMessageSender, layerIndex: StyleLayerIndex, availableImages: string[]) {
    this.channel = channel;
    this.layerIndex = layerIndex;
    this.availableImages = availableImages;
    this.tileState = new WorkerTileState();
  }

  /**
   * Retrieves and sends loaded vector tiles to the main thread.
   */
  loadVectorTile(params: WorkerTileParameters): LoadVectorTileResult | null {
    if (!this._geoJSONIndex)
      throw new Error('Unable to parse the data into a cluster or geojson');

    const { z, x, y } = params.tileID.canonical;
    const geoJSONTile = this._geoJSONIndex.getTile(z, x, y);
    if (!geoJSONTile)
      return null;

    const geojsonWrapper = new GeoJSONWrapper(geoJSONTile.features, { version: 2, extent: EXTENT });
    return {
      vectorTile: geojsonWrapper,
    };
  }

  /**
   * Implements {@link WorkerSource.loadTile}.
   */
  async loadTile(params: WorkerTileParameters, controller = new AbortController()): Promise<WorkerTileResult> {
    throwIfAborted(controller.signal);
    const { uid } = params;

    const workerTile = new WorkerTile(params);
    workerTile.abort = controller;
    try {
      const loadResult = this.loadVectorTile(params);
      if (!loadResult)
        return undefined;

      const { vectorTile } = loadResult;

      workerTile.vectorTile = vectorTile;
      this.tileState.markLoaded(uid, workerTile);

      return await workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.channel, controller);
    }
    catch (err) {
      if (workerTile.abort === controller)
        workerTile.status = 'done';
      if (!controller.signal.aborted) {
        this.tileState.markLoaded(uid, workerTile);
      }
      throw err;
    }
  }

  /**
   * @internal
   */
  private async _reloadLoadedTile(params: WorkerTileParameters, controller: AbortController): Promise<WorkerTileResult> {
    const uid = params.uid;

    const workerTile = this.tileState.getLoaded(uid);
    if (!workerTile)
      throw new Error('Should not be trying to reload a tile that was never loaded or has been removed');

    // If there was no vector tile data on the initial load, don't try and reparse the tile.
    if (workerTile.vectorTile) {
      return await workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.channel, controller);
    }
  }

  /**
   * Implements {@link WorkerSource.abortTile}.
   */
  async abortTile(params: TileParameters): Promise<void> {
    this.tileState.abort(params.uid);
  }

  /**
   * Implements {@link WorkerSource.removeTile}.
   * @internal
   */
  async removeTile(params: TileParameters): Promise<void> {
    this.tileState.removeLoaded(params.uid);
  }

  /**
   * Fetches (if appropriate), parses and indexes geojson data into tiles. This
   * preparatory method must be called before {@link GeoJSONWorkerSource.loadTile}
   * can correctly serve up tiles. The first call to this method must contain a valid
   * {@link params.data} or {@link params.request}.
   *
   * Defers to {@link GeoJSONWorkerSource.loadAndProcessGeoJSON} for the pre-processing.
   *
   * When a `loadData` request comes in while a previous one is being processed,
   * the previous one is aborted.
   *
   * @param params - the parameters
   * @returns a promise that resolves when the data is loaded and parsed into a GeoJSON object
   */
  async loadData(params: LoadGeoJSONParameters): Promise<GeoJSONWorkerSourceLoadDataResult> {
    this._pendingRequest?.abort();

    const timing = params.request?.collectResourceTiming
      ? new RequestPerformance(params.request.url)
      : undefined;
    const controller = this._pendingRequest = new AbortController();
    try {
      await this.loadAndProcessGeoJSON(params, controller);
      this.tileState.clearLoaded();

      // Sending a large GeoJSON payload from the worker to the main thread is slow so only do if necessary.
      // Send data only if it was loaded from a URL, otherwise the main thread already has a copy of this data.
      const result: GeoJSONWorkerSourceLoadDataResult = {};
      if (params.request)
        result.data = params.data;

      this._finishRequestTiming(timing, params, result);
      return result;
    }
    catch (err) {
      if (!isAbortError(err))
        throw err;
      return { abandoned: true };
    }
    finally {
      if (this._pendingRequest === controller)
        delete this._pendingRequest;
    }
  }

  /**
   * @internal
   */
  private _finishRequestTiming(timing: RequestPerformance | undefined, params: LoadGeoJSONParameters, result: GeoJSONWorkerSourceLoadDataResult): void {
    const timingData = timing?.finish();
    if (!timingData)
      return;

    // it's necessary to eval the result of getEntriesByName() here via parse/stringify
    // late evaluation in the main thread causes TypeError: illegal invocation
    result.resourceTiming = { [params.source]: JSON.parse(JSON.stringify(timingData)) };
  }

  /**
   * Implements {@link WorkerSource.reloadTile}.
   * If the tile is loaded, reload by re-parsing the already available tile data.
   * Otherwise, such as after a setData() call, we load the tile fresh.
   * @param params - the parameters
   * @returns A promise that resolves when the tile is reloaded
   * @internal
   */
  reloadTile(params: WorkerTileParameters, controller = new AbortController()): Promise<WorkerTileResult> {
    const tile = this.tileState.getLoaded(params.uid);

    if (tile) {
      return this._reloadLoadedTile(params, controller);
    }

    return this.loadTile(params, controller);
  }

  /**
   * Fetch, parse and process GeoJSON according to the given parameters.
   * Defers to {@link GeoJSONWorkerSource._loadGeoJSONFromString} for the fetching and parsing.
   *
   * @param params - the parameters
   * @param abortController - the abort controller that allows aborting this operation
   * @returns a promise that is resolved with the processes GeoJSON
   */
  async loadAndProcessGeoJSON(params: LoadGeoJSONParameters, abortController: AbortController): Promise<void> {
    if (params.request) {
      params.data = (await getJSON<GeoJSON.GeoJSON>(params.request, abortController)).data;
    }
    throwIfAborted(abortController.signal);

    if (params.data) {
      params.data = this._filterGeoJSON(params.data, params.filter, params.source);
      this._geoJSONIndex = createGeoJSONIndex(params.data, params);
      return;
    }

    throw new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`);
  }

  /**
   * Applies a filter to a GeoJSON object.
   * @internal
   */
  private _filterGeoJSON(data: GeoJSON.GeoJSON, filter: FilterSpecification | undefined, source: string): GeoJSON.GeoJSON {
    if (data.type !== 'FeatureCollection')
      return data;

    const predicate = this._getFilterPredicate(filter, source);
    if (!predicate)
      return data;

    return { type: 'FeatureCollection', features: data.features.filter(feature => predicate(feature)) };
  }

  /**
   * Gets a predicate function that can be used to filter GeoJSON features.
   * @internal
   */
  private _getFilterPredicate(filter: FilterSpecification | undefined, source: string): ((feature: GeoJSON.Feature) => boolean) | undefined {
    if (typeof filter !== 'boolean' && !filter?.length)
      return undefined;

    const compiled = createExpression(filter, `sources.${source}.filter`, { 'type': 'boolean', 'property-type': 'data-driven', 'transition': false });
    if (compiled.result === 'error') {
      throw new Error(compiled.value.map(err => `${err.key}: ${err.message}`).join(', '));
    }

    return (feature: GeoJSON.Feature) => {
      const geometry = feature.geometry?.type;
      const type = geometry === 'Point' || geometry === 'MultiPoint'
        ? 1
        : geometry === 'LineString' || geometry === 'MultiLineString'
          ? 2
          : geometry === 'Polygon' || geometry === 'MultiPolygon' ? 3 : 0;
      return Boolean(compiled.value.evaluate({ zoom: 0 }, { type, id: feature.id, properties: feature.properties ?? {} }));
    };
  }

  async removeSource(_params: RemoveSourceParams): Promise<void> {
    this._pendingRequest?.abort();
    delete this._pendingRequest;
    this.tileState.clear();
    delete this._geoJSONIndex;
  }
}

function createGeoJSONIndex(data: GeoJSON.GeoJSON, params: LoadGeoJSONParameters): GeoJSONVT {
  const options = Object.assign(params.geojsonVtOptions || {}, {
    clusterOptions: getSuperclusterOptions(params),
  });

  return new GeoJSONVT(data, options);
}

function getSuperclusterOptions({ geojsonVtOptions, clusterProperties, source }: LoadGeoJSONParameters): SuperclusterOptions | undefined {
  const options = geojsonVtOptions?.clusterOptions;
  if (!clusterProperties || !options)
    return options;

  const mapExpressions: Record<string, StyleExpression> = {};
  const reduceExpressions: Record<string, StyleExpression> = {};
  const globals: { accumulated: GlobalProperties['accumulated']; zoom: number } = { accumulated: null, zoom: 0 };
  const feature = { type: 'Point' as const, properties: {} as Record<string, unknown> };
  const propertyNames = Object.keys(clusterProperties);

  for (const key of propertyNames) {
    const [operator, mapExpression] = clusterProperties[key];

    const mapExpressionParsed = createExpression(mapExpression, `sources.${source}.clusterProperties.${key}[1]`);
    const reduceExpressionParsed = createExpression(
      typeof operator === 'string' ? [operator, ['accumulated'], ['get', key]] : operator,
      `sources.${source}.clusterProperties.${key}[0]`,
    );
    if (mapExpressionParsed.result === 'error')
      throw new Error(mapExpressionParsed.value.map(error => `${error.key}: ${error.message}`).join(', '));
    if (reduceExpressionParsed.result === 'error')
      throw new Error(reduceExpressionParsed.value.map(error => `${error.key}: ${error.message}`).join(', '));

    mapExpressions[key] = mapExpressionParsed.value;
    reduceExpressions[key] = reduceExpressionParsed.value;
  }

  options.map = (pointProperties) => {
    feature.properties = pointProperties ?? {};
    const properties: Record<string, unknown> = {};
    for (const key of propertyNames) {
      properties[key] = mapExpressions[key].evaluate(globals, feature);
    }
    return properties;
  };
  options.reduce = (accumulated, clusterProperties) => {
    feature.properties = clusterProperties;
    for (const key of propertyNames) {
      // These aggregate values originate in the parsed style expressions above.
      globals.accumulated = accumulated[key] as GlobalProperties['accumulated'];
      accumulated[key] = reduceExpressions[key].evaluate(globals, feature);
    }
  };
  return options;
}
