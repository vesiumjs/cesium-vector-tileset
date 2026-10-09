import type { PromoteIdSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { DashEntry } from '../assets/dash-atlas';
import type { GlyphPositions } from '../assets/glyph-atlas';
import type { ImageAtlas } from '../assets/image-atlas';
import type { CollisionBoxArray } from '../data/array-types.g';
import type { Bucket } from '../data/bucket';
import type { FeatureIndex } from '../data/feature-index';
import type { StyleGlyph } from '../style/style-glyph';
import type { StyleImage } from '../style/style-image';
import type { CanonicalTileID, OverscaledTileID } from '../tile/tile-id';
import type { ExpiryData, RequestParameters } from '../util/ajax';
import type { AlphaImage } from '../util/image';
import type { RemoveSourceParams } from '../worker/messages';

export type TileEncoding = 'mlt' | 'mvt';

/**
 * Parameters to identify a tile
 */
export interface TileParameters {
  type: string;
  source: string;
  uid: string | number;
}

/**
 * Parameters that are send when requesting to load a tile to the worker
 */
export type WorkerTileParameters = TileParameters & {
  tileID: OverscaledTileID;
  request?: RequestParameters;
  zoom: number;
  maxZoom?: number;
  tileSize: number;
  promoteId: PromoteIdSpecification;
  pixelRatio: number;
  collectResourceTiming?: boolean;
  returnDependencies?: boolean;
  encoding?: TileEncoding;
  /**
   * Provide this property when the requested tile has a higher canonical Z than source maxzoom.
   * This allows the worker to know that it needs to overzoom from a source tile.
   */
  overzoomParameters?: OverzoomParameters;
  etag?: string;
};

/**
 * Parameters needed in order to load a tile that is overzoomed from a source tile
 */
export interface OverzoomParameters {
  maxZoomTileID: CanonicalTileID;
  overzoomRequest: RequestParameters;
}

/**
 * The numeric dash pattern a data-driven `line-dasharray` resolves to, plus
 * whether the feature's line cap is round. Keyed by the dash atlas row
 * (`y:height`) so the renderer can resolve the Cesium dash mask per feature.
 */
export interface DashRow {
  dasharray: number[];
  round: boolean;
}

export type WorkerTileWithData = ExpiryData & {
  buckets: Bucket[];
  imageAtlas: ImageAtlas;
  glyphAtlasImage: AlphaImage;
  featureIndex: FeatureIndex;
  collisionBoxArray: CollisionBoxArray;
  dashPositions: Record<string, DashEntry>;
  dashRows?: Record<string, DashRow>;
  resourceTiming?: PerformanceResourceTiming[];
  glyphMap?: {
    [_: string]: {
      [_: number]: StyleGlyph;
    };
  } | null;
  iconMap?: {
    [_: string]: StyleImage;
  } | null;
  glyphPositions?: GlyphPositions | null;
  etagUnmodified?: false;
};

export type WorkerTileWithoutData = ExpiryData & {
  etagUnmodified: true; // Strict for type narrowing
  resourceTiming?: PerformanceResourceTiming[];
};

/**
 * A worker may have no payload for an empty tile (for example an empty
 * GeoJSON tile). `undefined` represents that state; it is distinct from an
 * etag-unmodified response, which still carries expiry metadata.
 */
export type WorkerTileResult = WorkerTileWithData | WorkerTileWithoutData | undefined;

/**
 * Tile source parsing runs behind this worker interface.
 * Each of the methods has a relevant event that triggers it from the main thread with the relevant parameters.
 */
export interface WorkerSource {
  availableImages: string[];

  /**
   * Loads a tile from the given params and parse it into buckets ready to send
   * back to the main thread for rendering, including buckets, feature metadata,
   * atlases and collision boxes.
   */
  loadTile: (params: WorkerTileParameters, controller?: AbortController) => Promise<WorkerTileResult>;
  /**
   * Re-parses a tile that has already been loaded.  Yields the same data as
   * {@link WorkerSource.loadTile}.
   */
  reloadTile: (params: WorkerTileParameters, controller?: AbortController) => Promise<WorkerTileResult>;
  /**
   * Aborts loading a tile that is in progress.
   */
  abortTile: (params: TileParameters) => Promise<void>;
  /**
   * Removes this tile from any local caches.
   */
  removeTile: (params: TileParameters) => Promise<void>;
  /**
   * Cancels pending downloads and parse dependencies, then releases tile data.
   * Source or map removal owns this cleanup; per-tile cancellation need not
   * finish before it. This must be the last control message for the source.
   */
  removeSource?: (params: RemoveSourceParams) => Promise<void>;
}
