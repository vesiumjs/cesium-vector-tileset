import type { DashEntry } from '../assets/dash-atlas';
import type { ImageAtlas } from '../assets/image-atlas';
import type { StyleImages } from '../assets/style-images';
import type { Bucket } from '../data/bucket';
import type { FeatureIndex } from '../data/feature-index';
import type { FeatureLookup } from '../data/program-configuration';

import type { LayerFeatureStates } from '../source/source-state';
import type { WorkerTileResult } from '../source/worker-source';
import type { Style } from '../style/style';
import type { StyleLayer } from '../style/style-layer';
import type { ExpiryData } from '../util/ajax';
import type { AlphaImage } from '../util/image';
import type { WorkerChannel } from '../worker/worker-channel';
import type { OverscaledTileID } from './tile-id';
import { CollisionBoxArray } from '../data/array-types.g';
import { deserialize as deserializeBucket } from '../data/bucket';
import { SymbolBucket } from '../data/bucket-runtime';
import { GEOJSON_TILE_LAYER_NAME } from '../data/feature-index';
import { rtlMainThreadPluginFactory } from '../source/rtl-text-plugin-main-thread';
import { parseCacheControl } from '../util/ajax';

const CLOCK_SKEW_RETRY_TIMEOUT = 30000;

/**
 * The tile's state, can be:
 *
 * - `loading` Tile data is in the process of loading.
 * - `loaded` Tile data has been loaded. Tile can be rendered.
 * - `reloading` Tile data has been loaded and is being updated. Tile can be rendered.
 * - `unloaded` Tile data has been deleted.
 * - `errored` Tile data was not loaded because of an error.
 * - `expired` Tile data was previously loaded, but has expired per its HTTP headers and is in the process of refreshing.
 */
export type TileState = 'loading' | 'loaded' | 'reloading' | 'unloaded' | 'errored' | 'expired';

/** @internal */
interface CrossFadeArgs {
  fadingRole: FadingRoles;
  fadingDirection: FadingDirections;
  fadingParentID?: OverscaledTileID;
  fadeEndTime: number;
}

export const FadingRoles = { Base: 0, Parent: 1 } as const;
export type FadingRoles = typeof FadingRoles[keyof typeof FadingRoles];
export const FadingDirections = { Departing: 0, Incoming: 1 } as const;
export type FadingDirections = typeof FadingDirections[keyof typeof FadingDirections];

/**
 * A tile object is the combination of a Coordinate, which defines
 * its place, as well as a unique ID and data tracking for its content
 */
let nextTileUid = 1;

export class Tile {
  tileID: OverscaledTileID;
  uid: number;
  uses: number;
  tileSize: number;
  buckets: { [_: string]: Bucket };
  latestFeatureIndex?: FeatureIndex;
  imageAtlas?: ImageAtlas;
  dashPositions?: Record<string, DashEntry>;
  dashRows?: Record<string, import('../source/worker-source').DashRow>;
  glyphAtlasImage?: AlphaImage;
  etag?: string;
  expirationTime?: number;
  expiredRequestCount: number;
  state: TileState;
  fadingRole?: FadingRoles;
  fadingDirection?: FadingDirections;
  fadingParentID?: OverscaledTileID;
  selfFading = false;
  timeAdded: number = 0;
  fadeEndTime: number = 0;
  fadeOpacity: number = 1;
  collisionBoxArray: CollisionBoxArray;
  channel?: WorkerChannel;

  aborted: boolean;
  abortController?: AbortController;
  textureData?: HTMLImageElement | ImageBitmap | HTMLCanvasElement | HTMLVideoElement | ImageData;
  refreshedUponExpiration: boolean;
  /** The active source request, used to serialize reloads for one tile. */
  loadPromise?: Promise<unknown>;
  /** Reload callers waiting for the active source request to finish. */
  reloadPromises: Array<{
    resolve: (value?: unknown) => void;
    reject: (reason?: unknown) => void;
  }>;

  resourceTiming: PerformanceResourceTiming[];
  queryPadding: number;

  symbolFadeHoldUntil?: number;
  hasSymbolBuckets: boolean;
  hasRTLText: boolean;
  dependencies: Record<string, Record<string, true>>;

  featureStateRevision: number;

  /**
   * @param tileID - the tile ID
   * @param size - The tile size
   */
  constructor(tileID: OverscaledTileID, size: number) {
    this.tileID = tileID;
    this.uid = nextTileUid++;
    this.uses = 0;
    this.tileSize = size;
    this.buckets = {};
    this.queryPadding = 0;
    this.hasSymbolBuckets = false;
    this.hasRTLText = false;
    this.dependencies = {};
    this.collisionBoxArray = new CollisionBoxArray();
    this.aborted = false;
    this.refreshedUponExpiration = false;
    this.reloadPromises = [];
    this.resourceTiming = [];

    // Counts the number of times a response was already expired when
    // received. We're using this to add a delay when making a new request
    // so we don't have to keep retrying immediately in case of a server
    // serving expired tiles.
    this.expiredRequestCount = 0;

    this.state = 'loading';
    this.featureStateRevision = -1;
  }

  isRenderable(symbolLayer: boolean): boolean {
    return (
      this.hasData()
      && (!this.fadeEndTime || this.fadeOpacity > 0) // raster fading
      && (symbolLayer || !this.holdingForSymbolFade()) // symbol fading
    );
  }

  /**
   * Many-to-one crossfade between a base tile and parent/ancestor tile (when zooming)
   * @internal
   */
  setCrossFadeLogic({ fadingRole, fadingDirection, fadingParentID, fadeEndTime }: CrossFadeArgs): void {
    this.resetFadeLogic();

    this.fadingRole = fadingRole;
    this.fadingDirection = fadingDirection;
    this.fadingParentID = fadingParentID;
    this.fadeEndTime = fadeEndTime;
  }

  /**
   * Self fading for edge tiles (when panning map)
   */
  setSelfFadeLogic(fadeEndTime: number): void {
    this.resetFadeLogic();
    this.selfFading = true;
    this.fadeEndTime = fadeEndTime;
  }

  resetFadeLogic(): void {
    this.fadingRole = undefined;
    this.fadingDirection = undefined;
    this.fadingParentID = undefined;
    this.selfFading = false;

    this.timeAdded = performance.now();
    this.fadeEndTime = 0;
    this.fadeOpacity = 1;
  }

  wasRequested(): boolean {
    return this.state === 'errored' || this.state === 'loaded' || this.state === 'reloading';
  }

  /**
   * Given a data object with a 'buffers' property, load it into
   * this tile's elementGroups and buffers properties and set loaded
   * to true. If the data is null, like in the case of an empty
   * GeoJSON tile, no-op but still set loaded to true.
   * @param data - The data from the worker
   * @param style - the style
   * @param justReloaded - `true` to just reload
   */
  loadVectorData(data: WorkerTileResult, style: Style, justReloaded?: boolean): void {
    if (data?.etagUnmodified === true) {
      this.state = 'loaded';
      return;
    }

    if (this.hasData()) {
      this.unloadVectorData();
    }

    this.state = 'loaded';
    this.featureStateRevision = -1;

    // Empty GeoJSON tiles have no worker payload.
    if (!data) {
      this.collisionBoxArray = new CollisionBoxArray();
      return;
    }

    this.latestFeatureIndex = data.featureIndex;
    this.collisionBoxArray = data.collisionBoxArray ?? new CollisionBoxArray();
    this.buckets = deserializeBucket(data.buckets, style);

    this.hasSymbolBuckets = false;
    for (const id in this.buckets) {
      const bucket = this.buckets[id];
      if (bucket instanceof SymbolBucket) {
        this.hasSymbolBuckets = true;
        if (justReloaded) {
          bucket.justReloaded = true;
        }
        else {
          break;
        }
      }
    }

    this.hasRTLText = false;
    if (this.hasSymbolBuckets) {
      for (const id in this.buckets) {
        const bucket = this.buckets[id];
        if (bucket instanceof SymbolBucket) {
          if (bucket.hasRTLText) {
            this.hasRTLText = true;
            rtlMainThreadPluginFactory().lazyLoad();
            break;
          }
        }
      }
    }

    if (data.imageAtlas) {
      this.imageAtlas = data.imageAtlas;
    }
    if (data.glyphAtlasImage) {
      this.glyphAtlasImage = data.glyphAtlasImage;
    }
    this.dashPositions = data.dashPositions;
    this.dashRows = data.dashRows;
  }

  /**
   * Release any data referenced by this tile.
   */
  unloadVectorData(): void {
    this.buckets = {};

    this.imageAtlas = undefined;
    this.dashPositions = undefined;
    this.dashRows = undefined;
    this.glyphAtlasImage = undefined;
    this.latestFeatureIndex = undefined;
    this.featureStateRevision = -1;
    this.hasSymbolBuckets = false;
    this.hasRTLText = false;
    this.queryPadding = 0;
    this.collisionBoxArray = new CollisionBoxArray();
    this.state = 'unloaded';
  }

  getBucket(layer: StyleLayer): Bucket | undefined {
    return this.buckets[layer.id];
  }

  prepare(images: StyleImages): void {
    if (this.imageAtlas) {
      this.imageAtlas.patchUpdatedImages(images);
    }
  }

  hasData(): boolean {
    return this.state === 'loaded' || this.state === 'reloading' || this.state === 'expired';
  }

  patternsLoaded(): boolean {
    return !!this.imageAtlas && Object.keys(this.imageAtlas.patternPositions).length > 0;
  }

  setExpiryData(data: ExpiryData): void {
    const prior = this.expirationTime;

    if (data.cacheControl) {
      const parsedCC = parseCacheControl(data.cacheControl);
      const maxAge = parsedCC['max-age'];
      if (typeof maxAge === 'number')
        this.expirationTime = Date.now() + maxAge * 1000;
    }
    else if (data.expires) {
      this.expirationTime = new Date(data.expires).getTime();
    }

    if (this.expirationTime) {
      const now = Date.now();
      let isExpired = false;

      if (this.expirationTime > now) {
        isExpired = false;
      }
      else if (!prior) {
        isExpired = true;
      }
      else if (this.expirationTime < prior) {
        // Expiring date is going backwards:
        // fall back to exponential backoff
        isExpired = true;
      }
      else {
        const delta = this.expirationTime - prior;

        if (!delta) {
          // Server is serving the same expired resource over and over: fall
          // back to exponential backoff.
          isExpired = true;
        }
        else {
          // Assume that either the client or the server clock is wrong and
          // try to interpolate a valid expiration date (from the client POV)
          // observing a minimum timeout.
          this.expirationTime = now + Math.max(delta, CLOCK_SKEW_RETRY_TIMEOUT);
        }
      }

      if (isExpired) {
        this.expiredRequestCount++;
        this.state = 'expired';
      }
      else {
        this.expiredRequestCount = 0;
      }
    }
  }

  getExpiryTimeout(): number | undefined {
    if (this.expirationTime) {
      if (this.expiredRequestCount) {
        // `1 << 31` is negative, which would schedule an immediate retry
        // storm; keep the shift inside the signed 32-bit positive range.
        return 1000 * (1 << Math.min(this.expiredRequestCount - 1, 30));
      }
      else {
        // Max value for `setTimeout` implementations is a 32 bit integer; cap this accordingly
        return Math.min(this.expirationTime - Date.now(), 2 ** 31 - 1);
      }
    }
    return undefined;
  }

  setFeatureState(states: LayerFeatureStates, style: Style, revision: number): void {
    const featureIndex = this.latestFeatureIndex;
    if (!featureIndex
      || Object.keys(states).length === 0) {
      return;
    }

    // Skip bucket updates if we already processed this revision
    if (this.featureStateRevision === revision) {
      return;
    }
    const lookups = new Map<string, FeatureLookup>();
    for (const bucket of new Set(Object.values(this.buckets))) {
      if (!bucket.stateDependentLayers.length || !bucket.layerIds.some(id => style.hasLayer(id)))
        continue;
      // Buckets are grouped by common source-layer
      const sourceLayerId = bucket.layers[0].sourceLayer || GEOJSON_TILE_LAYER_NAME;
      const sourceLayerStates = states[sourceLayerId];
      if (!sourceLayerStates?.length)
        continue;
      let lookup = lookups.get(sourceLayerId);
      if (!lookup) {
        const features = new Map<number, ReturnType<FeatureLookup>>();
        lookup = (index) => {
          let feature = features.get(index);
          if (!feature) {
            feature = featureIndex.features.getFeature(sourceLayerId, index);
            if (!feature)
              throw new Error(`Missing feature ${sourceLayerId}:${index} in tile interaction snapshot`);
            features.set(index, feature);
          }
          return feature;
        };
        lookups.set(sourceLayerId, lookup);
      }
      bucket.update(sourceLayerStates, lookup, {
        canonical: this.tileID.canonical,
        availableImages: style._availableImages,
        imagePositions: this.imageAtlas?.patternPositions ?? {},
        dashPositions: this.dashPositions,
      });
    }
    this.featureStateRevision = revision;
  }

  holdingForSymbolFade(): boolean {
    return this.symbolFadeHoldUntil !== undefined;
  }

  symbolFadeFinished(): boolean {
    return !this.symbolFadeHoldUntil || this.symbolFadeHoldUntil < performance.now();
  }

  clearSymbolFadeHold(): void {
    this.symbolFadeHoldUntil = undefined;
  }

  setSymbolHoldDuration(duration: number): void {
    this.symbolFadeHoldUntil = performance.now() + duration;
  }

  setDependencies(namespace: string, dependencies: string[]): void {
    const index: Record<string, true> = {};
    for (const dep of dependencies) {
      index[dep] = true;
    }
    this.dependencies[namespace] = index;
  }

  hasDependency(namespaces: string[], keys: string[]): boolean {
    for (const namespace of namespaces) {
      const dependencies = this.dependencies[namespace];
      if (dependencies) {
        for (const key of keys) {
          if (dependencies[key]) {
            return true;
          }
        }
      }
    }
    return false;
  }
}
