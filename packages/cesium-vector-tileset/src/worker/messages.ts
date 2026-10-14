import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { DashEntry } from '../assets/dash-atlas';
import type { LoadGeoJSONParameters } from '../source/geojson-worker-source';
import type { TileParameters, WorkerTileParameters, WorkerTileResult } from '../source/worker-source';
import type { StyleGlyph } from '../style/style-glyph';
import type { MaterializedStyleImage } from '../style/style-image';
import type { OverscaledTileID } from '../tile/tile-id';
import type { GetResourceResponse, RequestParameters } from '../util/ajax';

/**
 * The result of the call to load a geojson source
 */
export interface GeoJSONWorkerSourceLoadDataResult {
  resourceTiming?: { [_: string]: PerformanceEntryList };
  abandoned?: boolean;
  data?: GeoJSON.GeoJSON;
}

/**
 * Parameters needed to remove a source
 */
export interface RemoveSourceParams {
  source: string;
  type: string;
}

/**
 * Parameters needed to update the layers
 */
export interface UpdateLayersParameters {
  layers: LayerSpecification[];
  removedIds: string[];
}

/**
 * Parameters needed to get the images
 */
export interface GetImagesParameters {
  icons: string[];
  source: string;
  tileID: OverscaledTileID;
  type: string;
}

/**
 * Parameters needed to get the glyphs
 */
export interface GetGlyphsParameters {
  type: string;
  stacks: { [_: string]: string[] };
  source: string;
  tileID: OverscaledTileID;
}

/**
 * A response object returned when requesting glyphs
 */
export interface GetGlyphsResponse {
  [stack: string]: {
    [id: string]: StyleGlyph;
  };
}

/**
 * A response object returned when requesting images
 */
export interface GetImagesResponse { [_: string]: MaterializedStyleImage }

/**
 * Parameters needed to get the line dashes
 */
export interface GetDashesParameters {
  dashes: { [key: string]: {
    dasharray: number[];
    round: boolean;
  }; };
}

/**
 * A response object returned when requesting line dashes
 */
export interface GetDashesResponse { [dashId: string]: DashEntry | null }

/**
 * All the possible message types that can be sent to and from the worker
 */
export const MessageType = {
  loadData: 'LD',
  loadTile: 'LT',
  reloadTile: 'RT',
  getGlyphs: 'GG',
  getDashes: 'GDA',
  getImages: 'GI',
  setImages: 'SI',
  updateGlobalState: 'UGS',
  setLayers: 'SL',
  updateLayers: 'UL',
  setReferrer: 'SR',
  removeSource: 'RS',
  removeMap: 'RM',
  removeTile: 'RMT',
  abortTile: 'AT',
  getResource: 'GR',
} as const;

export type MessageType = typeof MessageType[keyof typeof MessageType];

/**
 * This is basically a mapping between all the calls that are made to and from the workers.
 * The key is the event name, the first parameter is the event input type, and the last parameter is the output type.
 */
export interface RequestResponseMessageMap {
  [MessageType.loadData]: [LoadGeoJSONParameters, GeoJSONWorkerSourceLoadDataResult];
  [MessageType.loadTile]: [WorkerTileParameters, WorkerTileResult];
  [MessageType.reloadTile]: [WorkerTileParameters, WorkerTileResult];
  [MessageType.getGlyphs]: [GetGlyphsParameters, GetGlyphsResponse];
  [MessageType.getImages]: [GetImagesParameters, GetImagesResponse];
  [MessageType.setImages]: [string[], void];
  [MessageType.updateGlobalState]: [Record<string, unknown>, void];
  [MessageType.setLayers]: [LayerSpecification[], void];
  [MessageType.updateLayers]: [UpdateLayersParameters, void];
  [MessageType.setReferrer]: [string, void];
  [MessageType.removeSource]: [RemoveSourceParams, void];
  [MessageType.removeMap]: [undefined, void];
  [MessageType.removeTile]: [TileParameters, void];
  [MessageType.abortTile]: [TileParameters, void];
  [MessageType.getResource]: [RequestParameters, GetResourceResponse<unknown>];
  [MessageType.getDashes]: [GetDashesParameters, GetDashesResponse];
}

/**
 * The message to be sent by the channel
 */
export interface WorkerMessage<T extends MessageType> {
  type: T;
  data: RequestResponseMessageMap[T][0];
  targetMapId?: string | number;
  mustQueue?: boolean;
  sourceMapId?: string | number;
}
