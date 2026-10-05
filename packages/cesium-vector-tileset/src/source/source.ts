import type { SourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { CanvasSourceSpecification } from '../source/canvas-source';
import type { GeoJSONSourceShouldReloadTileOptions } from '../source/geojson-source';
import type { LoadTileResult } from '../source/vector-tile-source';
import type { Style } from '../style/style';
import type { Tile } from '../tile/tile';

import type { CanonicalTileID, OverscaledTileID } from '../tile/tile-id';
import type { Event, Evented } from '../util/evented';
import type { WorkerDispatcher } from '../worker/dispatcher';
import { CanvasSource } from '../source/canvas-source';
import { GeoJSONSource } from '../source/geojson-source';
import { ImageSource } from '../source/image-source';

import { RasterTileSource } from '../source/raster-tile-source';
import { VectorTileSource } from '../source/vector-tile-source';
import { VideoSource } from '../source/video-source';

/**
 * The union of all specifications accepted by the built-in source constructors.
 */
export type AnySourceSpecification = SourceSpecification | CanvasSourceSpecification;

/**
 * The `Source` interface must be implemented by each source type, including "core" types (`vector`, `raster`,
 * `video`, etc.) and all custom, third-party types.
 *
 * **Event** `data` - Fired with `{dataType: 'source', sourceDataType: 'metadata'}` to indicate that any necessary metadata
 * has been loaded so that it's okay to call `loadTile`; and with `{dataType: 'source', sourceDataType: 'content'}`
 * to indicate that the source data has changed, so that any current caches should be flushed.
 *
 * @group Sources
 */
export interface Source {
  readonly type: string;
  /**
   * The id for the source. Must not be used by any existing source.
   */
  id: string;
  /**
   * The minimum zoom level for the source.
   */
  minzoom: number;
  /**
   * The maximum zoom level for the source.
   */
  maxzoom: number;
  /**
   * The tile size for the source.
   */
  tileSize: number;
  /**
   * The attribution for the source.
   */
  attribution?: string;
  /**
   * `true` if zoom levels are rounded to the nearest integer in the source data, `false` if they are floor-ed to the nearest integer.
   */
  roundZoom?: boolean;
  /**
   * `false` if tiles can be drawn outside their boundaries, `true` if they cannot.
   */
  isTileClipped?: boolean;
  tileID?: CanonicalTileID;
  /**
   * `true` if tiles should be sent back to the worker for each overzoomed zoom level, `false` if not.
   */
  reparseOverscaled?: boolean;
  vectorLayerIds?: string[];
  /**
   * True if the source has transition, false otherwise.
   */
  hasTransition: () => boolean;
  /**
   * True if the source is loaded, false otherwise.
   */
  loaded: () => boolean;
  /**
   * An ability to fire an event to all the listeners, see {@link Evented}
   * @param event - The event to fire
   */
  fire: (event: Event) => unknown;
  /**
   * The style this source belongs to, set by the owning {@link TilePyramid}.
   */
  style?: Style;
  /**
   * This method is called when the source is added to the renderer.
   */
  onAdd?: () => void;
  /**
   * This method is called when the source is removed from the renderer.
   */
  onRemove?: () => void;
  /**
   * This method does the heavy lifting of loading a tile.
   * In most cases it will defer the work to the relevant worker source.
   * @param tile - The tile to load
   */
  loadTile: (tile: Tile) => Promise<LoadTileResult | void>;
  /**
   * True is the tile is part of the source, false otherwise.
   * @param tileID - The tile ID
   */
  hasTile?: (tileID: OverscaledTileID) => boolean;
  /**
   * Allows to abort a tile loading.
   * @param tile - The tile to abort
   */
  abortTile?: (tile: Tile) => Promise<void>;
  /**
   * Allows to unload a tile.
   * @param tile - The tile to unload
   */
  unloadTile?: (tile: Tile) => Promise<void>;
  /**
   * @returns A plain (stringifiable) JS object representing the current state of the source.
   * Creating a source using the returned object as the `options` should result in a Source that is
   * equivalent to this one.
   */
  serialize: () => AnySourceSpecification;
  /**
   * Allows to execute a prepare step before the source is used.
   */
  prepare?: () => void;
  /**
   * Optional function to determine whether a tile should be reloaded, given a
   * set of options associated with a `MapSourceDataChangedEvent`.
   * @internal
   */
  shouldReloadTile?: (tile: Tile, options: GeoJSONSourceShouldReloadTileOptions) => boolean;
}

/**
 * Creates a tiled data source instance given an options object.
 *
 * @param id - The id for the source. Must not be used by any existing source.
 * @param specification - Source options, specific to the source type (except for `options.type`, which is always required).
 * @param dispatcher - A {@link WorkerDispatcher} instance, which can be used to send messages to the workers.
 * @param eventedParent - The evented parent of the source.
 * @returns a newly created source
 */
export function createSource(id: string, specification: AnySourceSpecification, dispatcher: WorkerDispatcher, eventedParent: Evented): Source {
  switch (specification.type) {
    case 'geojson':
      return new GeoJSONSource(id, specification, dispatcher, eventedParent);
    case 'image':
      return new ImageSource(id, specification, dispatcher, eventedParent);
    case 'raster':
      return new RasterTileSource(id, specification, dispatcher, eventedParent);
    case 'vector':
      return new VectorTileSource(id, specification, dispatcher, eventedParent);
    case 'video':
      return new VideoSource(id, specification, dispatcher, eventedParent);
    case 'canvas':
      return new CanvasSource(id, specification, dispatcher, eventedParent);
    default:
      throw new Error(`Unknown source type "${specification.type}".`);
  }
}
