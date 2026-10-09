import type { SourceSpecification } from '@maplibre/maplibre-gl-style-spec';

import type { GeoJSONSourceShouldReloadTileOptions } from '../source/geojson-source';
import type { OverscaledTileID } from '../tile/tile-id';
import type { ErrorEvent } from './evented';
import { Event } from './evented';

/**
 * The source event data type
 */
export type SourceDataType = 'content' | 'metadata' | 'visibility' | 'idle';

/** Events emitted by the style and its source/image children. */
export interface StyleEventType {
  'error': ErrorEvent;
  'data': SourceDataEvent | StyleDataEvent;
  'dataloading': SourceDataEvent | StyleDataEvent;
  'dataabort': SourceDataEvent;
  'style.load': StyleLoadEvent;
  'styleimagemissing': StyleImageMissingEvent;
}

/**
 * `SourceEventType` - a mapping between the source data event names and their event value.
 * These are the events fired by a {@link Source} as its data loads or changes.
 *
 * @group Event Related
 */
export interface SourceEventType {
  /**
   * Fired when the source's data loads or changes.
   */
  data: SourceDataEvent;
  /**
   * Fired when the source begins loading or changing data.
   */
  dataloading: SourceDataEvent;
  /**
   * Fired when a request for the source's data is aborted.
   */
  dataabort: SourceDataEvent;
  /**
   * Fired when there's an error
   */
  error: ErrorEvent;
}

/**
 * The `style.load` event, fired once the style has fully loaded or changed.
 *
 * @group Event Related
 */
export class StyleLoadEvent extends Event {
  declare type: 'style.load';

  constructor(data: object = {}) {
    super('style.load', data);
  }
}

/**
 * The style data event
 *
 * @group Event Related
 */
export class StyleDataEvent extends Event {
  declare type: 'data' | 'dataloading';
  dataType: 'style';

  constructor(type: StyleDataEvent['type'], data: Omit<Partial<StyleDataEvent>, 'type' | 'dataType' | 'target'> = {}) {
    super(type, data);
    this.dataType = 'style';
  }
}

/**
 * A `SourceDataEvent` is emitted with `data`, `dataloading` and `dataabort`.
 * Its `dataType` is always `'source'`.
 *
 * Possible values for `sourceDataType`s are:
 *
 * - `'metadata'`: indicates that any necessary source metadata has been loaded (such as TileJSON) and it is ok to start loading tiles
 * - `'content'`: indicates the source data has changed (such as when source.setData() has been called on GeoJSONSource)
 * - `'visibility'`: send when the source becomes used when at least one of its layers becomes visible in style sense (inside the layer's zoom range and with layout.visibility set to 'visible')
 * - `'idle'`: indicates that no new source data has been fetched (but the source has done loading)
 *
 * @group Event Related
 */
export class SourceDataEvent extends Event {
  declare type: 'data' | 'dataloading' | 'dataabort';
  dataType: 'source';
  /**
   * True if the event has a `dataType` of `source` and the source has no outstanding network requests.
   */
  declare isSourceLoaded: boolean;
  /**
   * The [style spec representation of the source](https://maplibre.org/maplibre-style-spec/#sources) if the event has a `dataType` of `source`.
   */
  declare source: SourceSpecification;
  declare sourceId: string;
  declare sourceDataType: SourceDataType;
  declare sourceDataChanged?: boolean;
  /**
   * The tile being loaded or changed, if the event has a `dataType` of `source` and
   * the event is related to loading of a tile.
   */
  declare tile: any;
  /**
   * The tile ID of the tile being loaded or changed, if the event is related to loading of a tile.
   */
  declare coord: OverscaledTileID;
  /**
   * Resource timing data, if `collectResourceTiming` is enabled for the source.
   */
  declare resourceTiming?: PerformanceResourceTiming[];

  /**
   * Options to determine whether a tile should be reloaded.
   */
  declare shouldReloadTileOptions: GeoJSONSourceShouldReloadTileOptions;

  constructor(type: SourceDataEvent['type'], data: Omit<Partial<SourceDataEvent>, 'type' | 'dataType' | 'target'> = {}) {
    super(type, data);
    this.dataType = 'source';
  }
}

/**
 * The style image missing event, fired when an image is still missing after the missing style image
 * resolver has been given a chance to supply it.
 * Event listeners cannot resolve the missing image for the current request.
 *
 * @group Event Related
 */
export class StyleImageMissingEvent extends Event {
  declare type: 'styleimagemissing';
  declare id: string;

  constructor(data: { id: string }) {
    super('styleimagemissing', data);
  }
}
