import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LoadGeoJSONParameters } from '../source/geojson-worker-source';
import type { PluginState } from '../source/rtl-text-plugin-status';
import type { RTLTextPlugin } from '../source/rtl-text-plugin-worker';
import type {
  TileParameters,
  WorkerSource,
  WorkerTileParameters,
  WorkerTileResult,
  WorkerTileWithData,
} from '../source/worker-source';
import type { OverscaledTileID } from '../tile/tile-id';
import type { ClusterIDAndSource, GetClusterLeavesParams, RemoveSourceParams, UpdateLayersParameters } from './messages';
import type { TileWorkerScope } from './scope';
import type { WorkerEndpoint, WorkerMessageSender } from './worker-channel';
import { GeoJSONWorkerSource } from '../source/geojson-worker-source';
import { addProtocol, removeProtocol } from '../source/protocol-crud';
import { rtlWorkerPlugin } from '../source/rtl-text-plugin-worker';
import { VectorTileWorkerSource } from '../source/vector-tile-worker-source';

import { StyleLayerIndex } from '../style/style-layer-index';
import { makeRequest } from '../util/ajax';
import {
  MessageType,

} from './messages';
import { WorkerChannel } from './worker-channel';

/**
 * Loads an external script into worker (global) scope. The loader picks a
 * strategy based on what the script actually is:
 *
 * - `.mjs` URLs: dynamic `import()` directly, no fetch/sniff overhead. Worker
 *   CSP needs `script-src` to permit the URL.
 *
 * - Other URLs: fetch the source and sniff for ESM syntax (top-level `import`
 *   or `export`). If ESM is detected, run it through a blob-URL dynamic
 *   `import()` so the browser parses it as a module; this requires
 *   `script-src blob:` in the worker CSP. Otherwise treat it as UMD/IIFE and
 *   run it via `globalThis.eval`, which requires `script-src 'unsafe-eval'`.
 */
async function loadScript(url: string): Promise<void> {
  if (url.endsWith('.mjs')) {
    await import(/* @vite-ignore */ url);
    return;
  }
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  const code = await response.text();
  // Top-level `import`/`export` keywords are unique to ESM. UMD scripts
  // assign to `module.exports` / `exports.foo` — those don't match.
  if (/^[ \t]*(?:import|export)\s/m.test(code)) {
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      await import(/* @vite-ignore */ blobUrl);
    }
    finally {
      URL.revokeObjectURL(blobUrl);
    }
    return;
  }
  // Run the code in the worker's global scope (not inside this function),
  // so UMD/IIFE plugin scripts can assign to globals like
  // `self.registerRTLTextPlugin`. Calling eval as a property access
  // (rather than the bare `eval` identifier) is what makes it global-scope.
  // eslint-disable-next-line no-eval -- required to execute UMD/IIFE plugin scripts in the worker's global scope
  globalThis.eval(code);
}

/**
 * Handles tile sources, style updates and protocol requests inside the worker.
 */
export class TileWorker {
  self: TileWorkerScope & WorkerEndpoint;
  channel: WorkerChannel;
  layerIndexes: { [_: string]: StyleLayerIndex };
  availableImages: { [_: string]: string[] };
  /**
   * This holds a cache for the already created worker source instances.
   * The cache is build with the following hierarchy:
   * [mapId][sourceType][sourceName]: worker source instance
   * sourceType can be 'vector' for example
   */
  workerSources: {
    [_: string]: {
      [_: string]: {
        [_: string]: WorkerSource;
      };
    };
  };

  referrer: string;
  globalStates: Map<string | number, Record<string, any>>;
  private readonly _prepareTile: (tile: WorkerTileWithData, tileID: OverscaledTileID) => void;

  constructor(
    self: TileWorkerScope & WorkerEndpoint,
    prepareTile: (tile: WorkerTileWithData, tileID: OverscaledTileID) => void,
  ) {
    this.self = self;
    this._prepareTile = prepareTile;
    this.channel = new WorkerChannel(self);

    this.layerIndexes = {};
    this.availableImages = {};

    this.workerSources = {};

    this.globalStates = new Map<string | number, Record<string, any>>();

    this.self.addProtocol = addProtocol;
    this.self.removeProtocol = removeProtocol;

    // Invoked by the RTL text plugin once it has fetched and parsed.
    this.self.registerRTLTextPlugin = (rtlTextPlugin: RTLTextPlugin) => {
      rtlWorkerPlugin.setMethods(rtlTextPlugin);
    };

    this.self.makeRequest = makeRequest;

    this.channel.registerMessageHandler(MessageType.getClusterExpansionZoom, async (mapId, params: ClusterIDAndSource) => {
      return (this._getWorkerSource(mapId, params.type, params.source) as GeoJSONWorkerSource).getClusterExpansionZoom(params);
    });

    this.channel.registerMessageHandler(MessageType.getClusterChildren, async (mapId, params: ClusterIDAndSource) => {
      return (this._getWorkerSource(mapId, params.type, params.source) as GeoJSONWorkerSource).getClusterChildren(params);
    });

    this.channel.registerMessageHandler(MessageType.getClusterLeaves, async (mapId, params: GetClusterLeavesParams) => {
      return (this._getWorkerSource(mapId, params.type, params.source) as GeoJSONWorkerSource).getClusterLeaves(params);
    });

    this.channel.registerMessageHandler(MessageType.loadData, (mapId, params: LoadGeoJSONParameters) => {
      return (this._getWorkerSource(mapId, params.type, params.source) as GeoJSONWorkerSource).loadData(params);
    });

    this.channel.registerMessageHandler(MessageType.loadTile, (mapId, params: WorkerTileParameters) => {
      return this._loadSourceTile(mapId, params, 'loadTile');
    });

    this.channel.registerMessageHandler(MessageType.reloadTile, (mapId, params: WorkerTileParameters) => {
      return this._loadSourceTile(mapId, params, 'reloadTile');
    });

    this.channel.registerMessageHandler(MessageType.abortTile, (mapId, params: TileParameters) => {
      return this._getWorkerSource(mapId, params.type, params.source).abortTile(params);
    });

    this.channel.registerMessageHandler(MessageType.removeTile, (mapId, params: TileParameters) => {
      return this._getWorkerSource(mapId, params.type, params.source).removeTile(params);
    });

    this.channel.registerMessageHandler(MessageType.removeSource, async (mapId, params: RemoveSourceParams) => {
      if (!this.workerSources[mapId]?.[params.type]?.[params.source]) {
        return;
      }

      const worker = this.workerSources[mapId][params.type][params.source];
      delete this.workerSources[mapId][params.type][params.source];

      if (worker.removeSource !== undefined) {
        worker.removeSource(params);
      }
    });

    this.channel.registerMessageHandler(MessageType.removeMap, async (mapId) => {
      const removals: Promise<void>[] = [];
      for (const [type, sources] of Object.entries(this.workerSources[mapId] ?? {})) {
        for (const [source, workerSource] of Object.entries(sources)) {
          if (workerSource.removeSource) {
            removals.push(workerSource.removeSource({ type, source }));
          }
        }
      }
      delete this.layerIndexes[mapId];
      delete this.availableImages[mapId];
      delete this.workerSources[mapId];
      this.globalStates.delete(mapId);
      await Promise.all(removals);
    });

    this.channel.registerMessageHandler(MessageType.setReferrer, async (_mapId: string | number, params: string) => {
      this.referrer = params;
    });

    this.channel.registerMessageHandler(MessageType.syncRTLPluginState, (mapId, params: PluginState) => {
      return this._syncRTLPluginState(mapId, params);
    });

    this.channel.registerMessageHandler(MessageType.setImages, (mapId, params: string[]) => {
      return this._setImages(mapId, params);
    });

    this.channel.registerMessageHandler(MessageType.updateLayers, async (mapId, params: UpdateLayersParameters) => {
      this._getLayerIndex(mapId).update(params.layers, params.removedIds, this._getGlobalState(mapId));
    });

    this.channel.registerMessageHandler(MessageType.updateGlobalState, async (mapId, params: Record<string, any>) => {
      const globalState = this._getGlobalState(mapId);
      for (const key in params) {
        globalState[key] = params[key];
      }
    });

    this.channel.registerMessageHandler(MessageType.setLayers, async (mapId, params: LayerSpecification[]) => {
      this._getLayerIndex(mapId).replace(params, this._getGlobalState(mapId));
    });
  }

  private _getGlobalState(mapId: string | number): Record<string, any> {
    let state = this.globalStates.get(mapId);
    if (!state) {
      state = {};
      this.globalStates.set(mapId, state);
    }
    return state;
  }

  private async _setImages(mapId: string | number, images: string[]): Promise<void> {
    this.availableImages[mapId] = images;
    for (const workerSource in this.workerSources[mapId]) {
      const ws = this.workerSources[mapId][workerSource];
      for (const source in ws) {
        ws[source].availableImages = images;
      }
    }
  }

  private async _syncRTLPluginState(_mapId: string | number, incomingState: PluginState): Promise<PluginState> {
    return await rtlWorkerPlugin.syncState(incomingState, loadScript);
  }

  private _getAvailableImages(mapId: string | number) {
    let availableImages = this.availableImages[mapId];

    availableImages ||= [];

    return availableImages;
  }

  private async _loadSourceTile(
    mapId: string | number,
    params: WorkerTileParameters,
    operation: 'loadTile' | 'reloadTile',
  ): Promise<WorkerTileResult> {
    const result = await this._getWorkerSource(mapId, params.type, params.source)[operation](params);
    if (result && 'buckets' in result) {
      this._prepareTile(result, params.tileID);
    }
    return result;
  }

  private _getLayerIndex(mapId: string | number) {
    let layerIndexes = this.layerIndexes[mapId];
    layerIndexes ||= this.layerIndexes[mapId] = new StyleLayerIndex();
    return layerIndexes;
  }

  /**
   * This is basically a lazy initialization of a worker per mapId and sourceType and sourceName
   * @param mapId - the mapId
   * @param sourceType - the source type - 'vector' for example
   * @param sourceName - the source name - 'osm' for example
   * @returns a new instance or a cached one
   */
  private _getWorkerSource(mapId: string | number, sourceType: string, sourceName: string): WorkerSource {
    this.workerSources[mapId] ||= {};
    this.workerSources[mapId][sourceType] ||= {};

    if (!this.workerSources[mapId][sourceType][sourceName]) {
      // use a wrapped channel so that we can attach a target mapId param
      // to any messages invoked by the WorkerSource, this is very important when there are multiple maps
      const channel: WorkerMessageSender = {
        sendAsync: (message, abortController) => {
          message.targetMapId = mapId;
          return this.channel.sendAsync(message, abortController);
        },
      };
      switch (sourceType) {
        case 'vector':
          this.workerSources[mapId][sourceType][sourceName] = new VectorTileWorkerSource(channel, this._getLayerIndex(mapId), this._getAvailableImages(mapId));
          break;
        case 'geojson':
          this.workerSources[mapId][sourceType][sourceName] = new GeoJSONWorkerSource(channel, this._getLayerIndex(mapId), this._getAvailableImages(mapId));
          break;
        default:
          throw new Error(`Unknown worker source type "${sourceType}".`);
      }
    }

    return this.workerSources[mapId][sourceType][sourceName];
  }

  /**
   * This is basically a lazy initialization of a worker per mapId and source
   * @param mapId - the mapId
   * @param sourceType - the source type - 'raster-dem' for example
   * @returns a new instance or a cached one
   */
}
