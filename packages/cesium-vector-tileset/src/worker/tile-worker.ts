import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LoadGeoJSONParameters } from '../source/geojson-worker-source';
import type {
  TileParameters,
  WorkerSource,
  WorkerTileParameters,
  WorkerTileResult,
  WorkerTileWithData,
} from '../source/worker-source';
import type { OverscaledTileID } from '../tile/tile-id';
import type { RemoveSourceParams, UpdateLayersParameters } from './messages';
import type { TileWorkerScope } from './scope';
import type { WorkerEndpoint, WorkerMessageSender } from './worker-channel';
import { GeoJSONWorkerSource } from '../source/geojson-worker-source';
import { addProtocol, removeProtocol } from '../source/protocol-crud';
import { VectorTileWorkerSource } from '../source/vector-tile-worker-source';

import { StyleLayerIndex } from '../style/style-layer-index';
import { throwIfAborted } from '../util/abort-error';
import { makeRequest } from '../util/ajax';
import {
  MessageType,

} from './messages';
import { WorkerChannel } from './worker-channel';

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

  referrer?: string;
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

    this.self.makeRequest = makeRequest;

    this.channel.registerMessageHandler(MessageType.loadData, (mapId, params: LoadGeoJSONParameters) => {
      return (this._getWorkerSource(mapId, params.type, params.source) as GeoJSONWorkerSource).loadData(params);
    });

    this.channel.registerMessageHandler(MessageType.loadTile, (mapId, params: WorkerTileParameters, controller) => {
      if (!controller)
        throw new Error('A tile request abort controller is required.');
      return this._loadSourceTile(mapId, params, 'loadTile', controller);
    });

    this.channel.registerMessageHandler(MessageType.reloadTile, (mapId, params: WorkerTileParameters, controller) => {
      if (!controller)
        throw new Error('A tile request abort controller is required.');
      return this._loadSourceTile(mapId, params, 'reloadTile', controller);
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

    this.channel.registerMessageHandler(MessageType.setImages, (mapId, params: string[]) => {
      return this._setImages(mapId, params);
    });

    this.channel.registerMessageHandler(MessageType.updateLayers, async (mapId, params: UpdateLayersParameters) => {
      this._getLayerIndex(mapId).update(params.layers, params.removedIds, this._getGlobalState(mapId));
    });

    this.channel.registerMessageHandler(MessageType.updateGlobalState, async (mapId, params: Record<string, any>) => {
      const globalState = this._getGlobalState(mapId);
      for (const key of Object.keys(globalState)) {
        if (!Object.hasOwn(params, key))
          delete globalState[key];
      }
      Object.assign(globalState, params);
    });

    this.channel.registerMessageHandler(MessageType.setLayers, async (mapId, params: LayerSpecification[]) => {
      this._getLayerIndex(mapId).replace(params, this._getGlobalState(mapId));
    });
  }

  /**
   * @internal
   */
  private _getGlobalState(mapId: string | number): Record<string, any> {
    let state = this.globalStates.get(mapId);
    if (!state) {
      state = {};
      this.globalStates.set(mapId, state);
    }
    return state;
  }

  /**
   * @internal
   */
  private async _setImages(mapId: string | number, images: string[]): Promise<void> {
    this.availableImages[mapId] = images;
    for (const workerSource in this.workerSources[mapId]) {
      const ws = this.workerSources[mapId][workerSource];
      for (const source in ws) {
        ws[source].availableImages = images;
      }
    }
  }

  /**
   * @internal
   */

  /**
   * @internal
   */
  private _getAvailableImages(mapId: string | number) {
    let availableImages = this.availableImages[mapId];

    availableImages ||= [];

    return availableImages;
  }

  /**
   * @internal
   */
  private async _loadSourceTile(
    mapId: string | number,
    params: WorkerTileParameters,
    operation: 'loadTile' | 'reloadTile',
    controller: AbortController,
  ): Promise<WorkerTileResult> {
    const result = await this._getWorkerSource(mapId, params.type, params.source)[operation](params, controller);
    throwIfAborted(controller.signal);
    if (result && 'buckets' in result) {
      this._prepareTile(result, params.tileID);
    }
    return result;
  }

  /**
   * @internal
   */
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
   * @internal
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
