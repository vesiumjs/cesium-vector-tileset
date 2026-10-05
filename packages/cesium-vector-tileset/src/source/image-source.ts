import type Point from '@mapbox/point-geometry';
import type {
  ImageSourceSpecification,
  VideoSourceSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import type { Style } from '../style/style';
import type { Tile } from '../tile/tile';
import type { SourceEventType } from '../util/events';
import type { WorkerDispatcher } from '../worker/dispatcher';
import type { CanvasSourceSpecification } from './canvas-source';

import type { Source } from './source';
import { Bounds } from '../geo/bounds';
import { MercatorCoordinate } from '../geo/mercator-coordinate';
import { MAX_TILE_ZOOM } from '../geo/world-bounds';
import { CanonicalTileID } from '../tile/tile-id';
import { isAbortError } from '../util/abort-error';
import { ensureError } from '../util/errors';
import { ErrorEvent, Evented } from '../util/evented';
import { SourceDataEvent } from '../util/events';
import { isImageBitmap } from '../util/image';
import { ImageRequest } from '../util/image-request';
import { ResourceType, transformRequest } from '../util/request';

/**
 * Four geographical coordinates,
 * represented as arrays of longitude and latitude numbers, which define the corners of the image.
 * The coordinates start at the top left corner of the image and proceed in clockwise order.
 * They do not have to represent a rectangle.
 */
export type Coordinates = [[number, number], [number, number], [number, number], [number, number]];

/**
 * An already-decoded image that can be handed to an {@link ImageSource} directly,
 * without a network request.
 */
export type ImageSourceImage = HTMLImageElement | HTMLCanvasElement | ImageBitmap | ImageData;

type ImageSourceOptions = ImageSourceSpecification | VideoSourceSpecification | CanvasSourceSpecification;

/**
 * The options object for the {@link ImageSource.updateImage} method.
 *
 * Provide exactly one of `url` (to load an image over the network) or `image`
 * (an already-decoded image to display directly, without a network request).
 */
export type UpdateImageOptions = {
  /**
   * The image coordinates
   */
  coordinates?: Coordinates;
} & ({
  /**
   * The image URL to load.
   */
  url: string;
} | {
  /**
   * An already-decoded image (`HTMLImageElement`, `HTMLCanvasElement`, `ImageBitmap` or `ImageData`)
   * to display directly, without a network request.
   */
  image: ImageSourceImage;
});

export interface CanonicalTileRange {
  minTileY: number;
  maxTileY: number;

  /**
   * Image can exceed the boundary of a single "world" (tile 0/0/0),
   * so we need to know the tile range for wrapping.
   */
  minTileXWrapped: number;
  maxTileXWrapped: number;
  minWrap: number;
  maxWrap: number;
}

/**
 * A data source containing an image.
 * (See the [Style Specification](https://maplibre.org/maplibre-style-spec/#sources-image) for detailed documentation of options.)
 *
 * @group Sources
 *
 * @example
 * ```ts
 * // add to map
 * map.addSource('some id', {
 *    type: 'image',
 *    url: 'https://www.maplibre.org/images/foo.png',
 *    coordinates: [
 *        [-76.54, 39.18],
 *        [-76.52, 39.18],
 *        [-76.52, 39.17],
 *        [-76.54, 39.17]
 *    ]
 * });
 *
 * // update coordinates
 * let mySource = map.getSource('some id');
 * mySource.setCoordinates([
 *     [-76.54335737228394, 39.18579907229748],
 *     [-76.52803659439087, 39.1838364847587],
 *     [-76.5295386314392, 39.17683392507606],
 *     [-76.54520273208618, 39.17876344106642]
 * ]);
 *
 * // update url and coordinates simultaneously
 * mySource.updateImage({
 *    url: 'https://www.maplibre.org/images/bar.png',
 *    coordinates: [
 *        [-76.54335737228394, 39.18579907229748],
 *        [-76.52803659439087, 39.1838364847587],
 *        [-76.5295386314392, 39.17683392507606],
 *        [-76.54520273208618, 39.17876344106642]
 *    ]
 * })
 *
 * // update with an already-decoded image (no network request)
 * const bitmap = await createImageBitmap(myCanvas);
 * mySource.updateImage({image: bitmap});
 *
 * map.removeSource('some id');  // remove
 * ```
 */
export class ImageSource extends Evented<SourceEventType> implements Source {
  type: string;
  id: string;
  minzoom: number;
  maxzoom: number;
  tileSize: number;
  url?: string;
  /**
   * This object is used to store the range of terrain tiles that overlap with this tile.
   * It is relevant for image tiles, as the image exceeds single tile boundaries.
   */
  terrainTileRanges: Record<string, CanonicalTileRange>;

  coordinates: Coordinates;
  tiles: Record<string, Tile>;
  options: ImageSourceOptions;
  dispatcher: WorkerDispatcher;
  style?: Style;
  image?: ImageSourceImage;
  tileID?: CanonicalTileID;
  tileCoords: Point[] = [];
  flippedWindingOrder = false;
  _loaded = false;
  _request?: AbortController;

  /** @internal */
  constructor(id: string, options: ImageSourceSpecification | VideoSourceSpecification | CanvasSourceSpecification, dispatcher: WorkerDispatcher, eventedParent: Evented) {
    super();
    this.id = id;
    this.dispatcher = dispatcher;
    this.coordinates = options.coordinates;

    this.type = 'image';
    this.minzoom = 0;
    this.maxzoom = 22;
    this.tileSize = 512;
    this.tiles = {};
    this.terrainTileRanges = {};

    this.setEventedParent(eventedParent);

    this.options = options;
    this.url = getImageUrl(options);
  }

  async load(newCoordinates?: Coordinates): Promise<void> {
    this._loaded = false;
    this.fire(new SourceDataEvent('dataloading'));

    const url = this.url;
    if (url === undefined) {
      throw new Error(`Source "${this.id}" does not load an image URL.`);
    }

    const requestController = new AbortController();
    this._request = requestController;
    try {
      const request = await transformRequest(url, ResourceType.Image, this.style?.transformRequest);
      if (this._request !== requestController || requestController.signal.aborted) {
        return;
      }
      const image = await ImageRequest.getImage(request, requestController);
      if (this._request !== requestController || requestController.signal.aborted) {
        closeImageBitmap(image?.data);
        return;
      }
      this._request = undefined;
      this._loaded = true;

      if (image?.data) {
        this.image = image.data;
        if (newCoordinates) {
          this.coordinates = newCoordinates;
        }
        this._finishLoading();
      }
    }
    catch (err) {
      if (this._request !== requestController) {
        return;
      }
      this._request = undefined;
      if (requestController.signal.aborted) {
        return;
      }
      this._loaded = true;
      if (!isAbortError(err)) {
        this.fire(new ErrorEvent(ensureError(err)));
      }
    }
  }

  loaded(): boolean {
    return this._loaded;
  }

  /**
   * Updates the image and, optionally, the coordinates. To avoid having the image flash after changing,
   * set the `raster-fade-duration` paint property on the raster layer to 0.
   *
   * Provide exactly one of `url` (to fetch a new image over the network) or `image` (an
   * already-decoded `HTMLImageElement`, `HTMLCanvasElement`, `ImageBitmap` or `ImageData` to
   * display directly, without a network request).
   *
   * @param options - The options object.
   */
  updateImage(options: UpdateImageOptions): this {
    if (this._request) {
      this._request.abort();
      this._request = undefined;
    }

    if ('image' in options) {
      // Use the already-decoded image directly, skipping the network request.
      this._loaded = true;
      this.image = options.image;
      if (options.coordinates) {
        this.coordinates = options.coordinates;
      }

      this._finishLoading();
      return this;
    }

    if (!options.url) {
      return this;
    }

    this.url = options.url;
    this.load(options.coordinates);
    return this;
  }

  _finishLoading(): void {
    this.setCoordinates(this.coordinates);
    this.fire(new SourceDataEvent('data', { sourceDataType: 'metadata' }));
  }

  onAdd(): void {
    this.load();
  }

  onRemove(): void {
    if (this._request) {
      this._request.abort();
      this._request = undefined;
    }
  }

  /**
   * Sets the image's coordinates and re-renders the map.
   *
   * @param coordinates - Four geographical coordinates,
   * represented as arrays of longitude and latitude numbers, which define the corners of the image.
   * The coordinates start at the top left corner of the image and proceed in clockwise order.
   * They do not have to represent a rectangle.
   */
  setCoordinates(coordinates: Coordinates): this {
    this.coordinates = coordinates;

    // Calculate which mercator tile is suitable for rendering the video in
    // and create a buffer with the corner coordinates. These coordinates
    // may be outside the tile, because raster tiles aren't clipped when rendering.

    // transform the geo coordinates into (zoom 0) tile space coordinates
    const cornerCoords = coordinates.map(MercatorCoordinate.fromLngLat);

    // Compute the coordinates of the tile we'll use to hold this image's
    // render data
    this.tileID = getCoordinatesCenterTileID(cornerCoords);

    // Compute tiles overlapping with the image. We need to know for which
    // terrain tiles we have to render the image.
    this.terrainTileRanges = this._getOverlappingTileRanges(cornerCoords);

    // Constrain min/max zoom to our tile's zoom level in order to force
    // TilePyramid to request this tile (no matter what the map's zoom
    // level)
    this.minzoom = this.maxzoom = this.tileID.z;

    // Transform the corner coordinates into the coordinate space of our
    // tile.
    this.tileCoords = cornerCoords.map(coord => this.tileID.getTilePoint(coord)._round());
    this.flippedWindingOrder = hasWrongWindingOrder(this.tileCoords);

    this.fire(new SourceDataEvent('data', { sourceDataType: 'content' }));
    return this;
  }

  prepare(): void {
    if (Object.keys(this.tiles).length === 0 || !this.image) {
      return;
    }

    let newTilesLoaded = false;
    for (const w in this.tiles) {
      const tile = this.tiles[w];
      if (tile.state !== 'loaded') {
        tile.state = 'loaded';
        tile.textureData = this.image;
        newTilesLoaded = true;
      }
    }

    if (newTilesLoaded) {
      this.fire(new SourceDataEvent('data', { sourceDataType: 'idle', sourceId: this.id }));
    }
  }

  async loadTile(tile: Tile): Promise<void> {
    // We have a single tile -- whose coordinates are this.tileID -- that
    // covers the image we want to render.  If that's the one being
    // requested, set it up with the image; otherwise, mark the tile as
    // `errored` to indicate that we have no data for it.
    // If the world wraps, we may have multiple "wrapped" copies of the
    // single tile.
    if (this.tileID?.equals(tile.tileID.canonical)) {
      this.tiles[String(tile.tileID.wrap)] = tile;
      tile.buckets = {};
    }
    else {
      tile.state = 'errored';
    }
  }

  serialize(): ImageSourceOptions {
    if (this.url === undefined) {
      throw new Error(`Source "${this.id}" does not serialize as an image source.`);
    }
    return {
      type: 'image',
      url: this.url,
      coordinates: this.coordinates,
    };
  }

  hasTransition() {
    return false;
  }

  /**
   * Given a list of coordinates, determine overlapping tile ranges for all zoom levels.
   *
   * @returns Overlapping tile ranges for all zoom levels.
   * @internal
   */
  private _getOverlappingTileRanges(
    coords: MercatorCoordinate[],
  ): { [zoom: string]: CanonicalTileRange } {
    const { minX, minY, maxX, maxY } = Bounds.fromPoints(coords);

    const ranges: { [zoom: string]: CanonicalTileRange } = {};

    for (let z = 0; z <= MAX_TILE_ZOOM; z++) {
      const tilesAtZoom = 2 ** z;
      const minTileX = Math.floor(minX * tilesAtZoom);
      const minTileY = Math.floor(minY * tilesAtZoom);
      const maxTileX = Math.floor(maxX * tilesAtZoom);
      const maxTileY = Math.floor(maxY * tilesAtZoom);

      const minTileXWrapped = ((minTileX % tilesAtZoom) + tilesAtZoom) % tilesAtZoom;
      const maxTileXWrapped = maxTileX % tilesAtZoom;
      const minWrap = Math.floor(minTileX / tilesAtZoom);
      const maxWrap = Math.floor(maxTileX / tilesAtZoom);

      ranges[z] = {
        minWrap,
        maxWrap,
        minTileXWrapped,
        maxTileXWrapped,
        minTileY,
        maxTileY,
      };
    }

    return ranges;
  }
}

function getImageUrl(options: ImageSourceOptions): string | undefined {
  if ('url' in options && typeof options.url === 'string') {
    return options.url;
  }
  return undefined;
}

/**
 * Given a list of coordinates, get their center as a coordinate.
 *
 * @returns centerpoint
 * @internal
 */
export function getCoordinatesCenterTileID(coords: MercatorCoordinate[]): CanonicalTileID {
  const bounds = Bounds.fromPoints(coords);

  const dx = bounds.width();
  const dy = bounds.height();
  const dMax = Math.max(dx, dy);
  const zoom = Math.max(0, Math.floor(-Math.log(dMax) / Math.LN2));
  const tilesAtZoom = 2 ** zoom;

  return new CanonicalTileID(
    zoom,
    Math.floor((bounds.minX + bounds.maxX) / 2 * tilesAtZoom),
    Math.floor((bounds.minY + bounds.maxY) / 2 * tilesAtZoom),
  );
}

function hasWrongWindingOrder(coords: Point[]) {
  const e0x = coords[1].x - coords[0].x;
  const e0y = coords[1].y - coords[0].y;
  const e1x = coords[2].x - coords[0].x;
  const e1y = coords[2].y - coords[0].y;

  const crossProduct = e0x * e1y - e0y * e1x;

  return crossProduct < 0;
}

function closeImageBitmap(image: unknown): void {
  if (isImageBitmap(image)) {
    image.close();
  }
}
