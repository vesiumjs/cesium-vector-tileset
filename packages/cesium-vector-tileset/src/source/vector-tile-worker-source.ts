import type {
  TileParameters,
  WorkerSource,
  WorkerTileParameters,
  WorkerTileResult,
} from '../source/worker-source';
import type { StyleLayer } from '../style/style-layer';
import type { StyleLayerIndex } from '../style/style-layer-index';
import type { ExpiryData } from '../util/ajax';
import type { RemoveSourceParams } from '../worker/messages';
import type { WorkerMessageSender } from '../worker/worker-channel';
import type { VectorTileData, VectorTileLayer } from './vector-tile-data';
import type { ParsingState } from './worker-tile-state';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { BoundedLRUCache } from '../tile/tile-cache';
import { throwIfAborted } from '../util/abort-error';
import { getArrayBuffer, parseCacheControl } from '../util/ajax';
import { ensureError } from '../util/errors';
import { RequestPerformance } from '../util/request-performance';
import { MLTVectorTile } from './vector-tile-mlt';
import { sliceVectorTileLayer, VectorTileOverzoomed } from './vector-tile-overzoomed';
import { WorkerTile } from './worker-tile';
import { WorkerTileState } from './worker-tile-state';

export interface LoadVectorTileResult {
  vectorTile: VectorTileData;
}

interface ParentTile {
  response: { data: ArrayBuffer } & ExpiryData;
  decoded?: LoadVectorTileResult;
  expiresAt?: number;
}

interface PendingParentTile {
  response: Promise<ParentTile['response']>;
  abort: AbortController;
  consumers: Set<AbortController>;
  decoded?: LoadVectorTileResult;
}

/**
 * The {@link WorkerSource} implementation that supports {@link VectorTileSource}. This class is
 * used by vector tile sources to perform tile processing operations in a separate worker thread.
 */
export class VectorTileWorkerSource implements WorkerSource {
  channel: WorkerMessageSender;
  layerIndex: StyleLayerIndex;
  availableImages: string[];
  tileState: WorkerTileState;
  overzoomedTileResultCache: BoundedLRUCache<string, LoadVectorTileResult>;

  private parentTileCache: BoundedLRUCache<string, ParentTile>;

  private pendingParentTiles: Map<string, PendingParentTile>;

  private parentTileIds: WeakMap<VectorTileData, number>;

  private overzoomParents: WeakMap<WorkerTile, LoadVectorTileResult>;

  private tileEtags: WeakMap<WorkerTile, string>;

  private nextParentTileId = 0;

  constructor(channel: WorkerMessageSender, layerIndex: StyleLayerIndex, availableImages: string[]) {
    this.channel = channel;
    this.layerIndex = layerIndex;
    this.availableImages = availableImages;
    this.tileState = new WorkerTileState();
    this.overzoomedTileResultCache = new BoundedLRUCache<string, LoadVectorTileResult>(1000);
    this.parentTileCache = new BoundedLRUCache<string, ParentTile>(16);
    this.pendingParentTiles = new Map();
    this.parentTileIds = new WeakMap();
    this.overzoomParents = new WeakMap();
    this.tileEtags = new WeakMap();
  }

  /**
   * Loads a vector tile
   */
  loadVectorTile(params: WorkerTileParameters, rawData: ArrayBuffer): LoadVectorTileResult {
    try {
      const vectorTile = params.encoding !== 'mlt'
        ? new VectorTile(new PbfReader(rawData))
        : new MLTVectorTile(rawData);

      return { vectorTile };
    }
    catch (ex) {
      const bytes = new Uint8Array(rawData);
      const isGzipped = bytes[0] === 0x1F && bytes[1] === 0x8B;
      let errorMessage = `Unable to parse the tile at ${params.request.url}, `;
      if (isGzipped) {
        errorMessage += 'please make sure the data is not gzipped and that you have configured the relevant header in the server';
      }
      else {
        errorMessage += `got error: ${ensureError(ex).message}`;
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * Implements {@link WorkerSource.loadTile}.
   */
  async loadTile(params: WorkerTileParameters, abortController = new AbortController()): Promise<WorkerTileResult | null> {
    throwIfAborted(abortController.signal);
    const { uid, overzoomParameters } = params;

    if (overzoomParameters) {
      params.request = overzoomParameters.overzoomRequest;
    }

    const timing = params.request?.collectResourceTiming
      ? new RequestPerformance(params.request.url)
      : undefined;
    const workerTile = new WorkerTile(params);

    this.tileState.startLoading(uid, workerTile);
    workerTile.abort = abortController;
    try {
      // Download the tile data from the network.
      const parent = overzoomParameters
        ? await this._loadParentTile(params, abortController)
        : undefined;
      const tileResponse = parent?.response ?? await getArrayBuffer(params.request, abortController);
      throwIfAborted(abortController.signal);

      // Tile data hasn't changed (etag support) - return an unmodified result
      if (params.etag && params.etag === tileResponse.etag) {
        this.tileState.finishLoading(uid, workerTile);
        return this._getEtagUnmodifiedResult(tileResponse, timing);
      }

      const tileResult = parent?.decoded ?? this.loadVectorTile(params, tileResponse.data);
      this.tileState.finishLoading(uid, workerTile);
      if (!tileResult)
        return null;

      let { vectorTile } = tileResult;
      if (overzoomParameters) {
        this.overzoomParents.set(workerTile, tileResult);
        ({ vectorTile } = this._getOverzoomTile(params, vectorTile));
      }

      const cacheControl = this._getExpiryData(tileResponse);
      const resourceTiming = this._finishRequestTiming(timing);

      workerTile.vectorTile = vectorTile;
      if (tileResponse.etag) {
        this.tileEtags.set(workerTile, tileResponse.etag);
      }
      this.tileState.markLoaded(uid, workerTile);

      // Preserve response metadata if reloadTile replaces an in-flight parse.
      const parseState = { cacheControl, resourceTiming };
      this.tileState.setParsing(uid, parseState);
      try {
        return await this._parseWorkerTile(workerTile, parseState, abortController);
      }
      finally {
        this.tileState.removeParsing(uid, parseState);
      }
    }
    catch (err) {
      this.tileState.finishLoading(uid, workerTile);
      if (workerTile.abort === abortController)
        workerTile.status = 'done';
      if (!abortController.signal.aborted) {
        this.tileState.markLoaded(uid, workerTile);
      }
      throw err;
    }
  }

  /**
   * Share the maxzoom response while siblings are loading, then retain a small
   * decoded-parent LRU for children that arrive after the first one. Each child
   * keeps its own abort signal; the network request ends only after the last
   * interested child aborts.
   * @internal
   */
  private async _loadParentTile(params: WorkerTileParameters, childAbort: AbortController): Promise<ParentTile> {
    const request = params.request;
    // getArrayBuffer may set request.type while preparing fetch. Content
    // identity uses only the request fields that can change the response.
    const key = JSON.stringify([
      params.source,
      params.encoding,
      params.overzoomParameters.maxZoomTileID.key,
      request.url,
      request.method,
      request.body,
      request.headers,
      request.credentials,
      request.cache,
      request.referrerPolicy,
    ]);
    const cached = params.etag ? undefined : this.parentTileCache.get(key);
    if (cached && cached.expiresAt && cached.expiresAt > Date.now()) {
      return cached;
    }

    let pending = this.pendingParentTiles.get(key);
    if (pending && [...pending.consumers].every(consumer => consumer.signal.aborted)) {
      // abortTile can be followed by a new load before the rejected child
      // reaches its finally block. Do not attach the new child to that dead
      // request.
      pending.abort.abort();
      this.pendingParentTiles.delete(key);
      pending = undefined;
    }
    if (!pending) {
      const abort = new AbortController();
      pending = {
        response: getArrayBuffer(params.request, abort),
        abort,
        consumers: new Set(),
      };
      this.pendingParentTiles.set(key, pending);
    }
    const shared = pending;
    shared.consumers.add(childAbort);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(childAbort.signal.reason);
      childAbort.signal.addEventListener('abort', onAbort, { once: true });
      if (childAbort.signal.aborted) {
        onAbort();
      }
    });
    try {
      const response = await Promise.race([shared.response, aborted]);
      // A 304 response has no body to decode. The caller handles it using its
      // own etag, preserving each child's independent reload result.
      if (params.etag && params.etag === response.etag) {
        return { response };
      }
      shared.decoded ??= this.loadVectorTile(params, response.data);
      const cacheControl = response.cacheControl && parseCacheControl(response.cacheControl);
      const maxAge = cacheControl?.['max-age'];
      const expiresAt = cacheControl?.['no-cache'] || cacheControl?.['no-store']
        ? 0
        : typeof maxAge === 'number'
          ? Date.now() + maxAge * 1000
          : response.expires ? new Date(response.expires).getTime() : 0;
      const parent = { response, decoded: shared.decoded, expiresAt };
      // Keep decoded bytes between siblings only while the server permits
      // reuse. Without an expiry, a later pan or source refresh must fetch
      // again rather than serving stale parent geometry indefinitely.
      if (!shared.abort.signal.aborted && expiresAt > Date.now()) {
        this.parentTileCache.set(key, parent);
      }
      return parent;
    }
    finally {
      childAbort.signal.removeEventListener('abort', onAbort);
      shared.consumers.delete(childAbort);
      if (shared.consumers.size === 0) {
        if (this.pendingParentTiles.get(key) === shared) {
          this.pendingParentTiles.delete(key);
        }
        // A settled response ignores abort; a pending fetch stops here.
        shared.abort.abort();
      }
    }
  }

  /**
   * @internal
   */
  private _getEtagUnmodifiedResult(response: ExpiryData, timing: RequestPerformance): WorkerTileResult {
    const cacheControl = this._getExpiryData(response);
    const resourceTiming = this._finishRequestTiming(timing);
    return Object.assign({ etagUnmodified: true as const }, cacheControl, resourceTiming);
  }

  /**
   * @internal
   */
  private async _parseWorkerTile(workerTile: WorkerTile, parseState?: ParsingState, controller = new AbortController()): Promise<WorkerTileResult> {
    let result = await workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.channel, controller);

    if (parseState) {
      const { cacheControl, resourceTiming } = parseState;
      result = Object.assign(result, cacheControl, resourceTiming);
    }
    else {
      const etag = this.tileEtags.get(workerTile);
      if (etag) {
        result = Object.assign(result, { etag });
      }
    }

    return result;
  }

  /**
   * @internal
   */
  private _getExpiryData({ expires, cacheControl, etag }: ExpiryData): ExpiryData {
    const data: ExpiryData = {};
    if (expires)
      data.expires = expires;
    if (cacheControl)
      data.cacheControl = cacheControl;
    if (etag)
      data.etag = etag;
    return data;
  }

  /**
   * @internal
   */
  private _finishRequestTiming(timing: RequestPerformance): { resourceTiming?: any } {
    const timingData = timing?.finish();
    if (!timingData)
      return {};

    // it's necessary to eval the result of getEntriesByName() here via parse/stringify
    // late evaluation in the main thread causes TypeError: illegal invocation
    return { resourceTiming: JSON.parse(JSON.stringify(timingData)) };
  }

  /**
   * If we are seeking a tile deeper than the source's max available canonical tile, get the overzoomed tile
   * @param params - the worker tile parameters
   * @param maxZoomVectorTile - the original vector tile at the source's max available canonical zoom
   * @returns the overzoomed tile
   * @internal
   */
  private _getOverzoomTile(params: WorkerTileParameters, maxZoomVectorTile: VectorTileData): LoadVectorTileResult {
    const { tileID, source, overzoomParameters } = params;
    const { maxZoomTileID } = overzoomParameters;
    const layerFamilies: Record<string, StyleLayer[][]> = this.layerIndex.familiesBySource[source] ?? {};
    const sourceLayerIds = Object.keys(layerFamilies).sort();

    let parentId = this.parentTileIds.get(maxZoomVectorTile);
    if (parentId === undefined) {
      parentId = ++this.nextParentTileId;
      this.parentTileIds.set(maxZoomVectorTile, parentId);
    }
    // A conditional refresh can return new bytes at the same URL. The parent
    // object identity changes on decode, so it must not reuse an older slice.
    const cacheKey = `${parentId}_${maxZoomTileID.key}_${tileID.key}_${JSON.stringify(sourceLayerIds)}`;
    const cachedOverzoomTile = this.overzoomedTileResultCache.get(cacheKey);

    if (cachedOverzoomTile) {
      return cachedOverzoomTile;
    }

    const overzoomedVectorTile = new VectorTileOverzoomed();
    for (const sourceLayerId of sourceLayerIds) {
      const sourceLayer: VectorTileLayer = maxZoomVectorTile.layers[sourceLayerId];
      if (!sourceLayer) {
        continue;
      }
      const slicedTileLayer = sliceVectorTileLayer(sourceLayer, maxZoomTileID, tileID.canonical);
      if (slicedTileLayer.length > 0) {
        overzoomedVectorTile.addLayer(slicedTileLayer);
      }
    }
    const overzoomedVectorTileResult = {
      vectorTile: overzoomedVectorTile,
    };
    this.overzoomedTileResultCache.set(cacheKey, overzoomedVectorTileResult);

    return overzoomedVectorTileResult;
  }

  /**
   * Implements {@link WorkerSource.reloadTile}.
   * @internal
   */
  async reloadTile(params: WorkerTileParameters, controller = new AbortController()): Promise<WorkerTileResult> {
    throwIfAborted(controller.signal);
    const uid = params.uid;

    const workerTile = this.tileState.getLoaded(uid);
    if (!workerTile)
      throw new Error('Should not be trying to reload a tile that was never loaded or has been removed');

    const parent = this.overzoomParents.get(workerTile);
    if (parent && params.overzoomParameters) {
      const sliced = this._getOverzoomTile(params, parent.vectorTile);
      workerTile.vectorTile = sliced.vectorTile;
    }

    if (workerTile.status === 'parsing') {
      // Keep the original response metadata when replacing its parse.
      const previous = this.tileState.getParsing(uid);
      const parseState = previous && { ...previous };
      if (parseState)
        this.tileState.setParsing(uid, parseState);
      try {
        return await this._parseWorkerTile(workerTile, parseState, controller);
      }
      finally {
        if (parseState)
          this.tileState.removeParsing(uid, parseState);
      }
    }

    // If there was no vector tile data on the initial load, don't try and reparse the tile.
    // this seems like a missing case where cache control is lost? see #3309
    if (workerTile.status === 'done' && workerTile.vectorTile) {
      return await this._parseWorkerTile(workerTile, undefined, controller);
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

  async removeSource(_params: RemoveSourceParams): Promise<void> {
    this.tileState.clear();
    for (const parent of this.pendingParentTiles.values()) {
      parent.abort.abort();
    }
    this.pendingParentTiles.clear();
    this.parentTileCache.clear();
    this.overzoomedTileResultCache.clear();
    this.parentTileIds = new WeakMap();
    this.overzoomParents = new WeakMap();
    this.tileEtags = new WeakMap();
    this.nextParentTileId = 0;
  }
}
