import type { FeatureState, ICanonicalTileID, SourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { CanvasSourceSpecification } from '../source/canvas-source';
import type { GeoJSONSourceShouldReloadTileOptions } from '../source/geojson-source';
import type { Source } from '../source/source';
import type { LoadTileResult } from '../source/vector-tile-source';
import type { Style } from '../style/style';
import type { SourceEventType } from '../util/events';
import type { WorkerDispatcher } from '../worker/dispatcher';
import type { TileState } from './tile';
import { GEOJSON_TILE_LAYER_NAME } from '../data/feature-index';

import { createSource } from '../source/source';
import { SourceFeatureState } from '../source/source-state';
import { config } from '../util/config';
import { ensureError, hasHttpStatus } from '../util/errors';
import { ErrorEvent, Evented } from '../util/evented';
import { SourceDataEvent } from '../util/events';
import { ActiveTiles } from './active-tiles';
import { FadingDirections, Tile } from './tile';
import { TileCache } from './tile-cache';
import { hasRasterTransition, updateFadingTiles } from './tile-fade';
import { OverscaledTileID } from './tile-id';

/**
 * The tile-covering input computed from the Cesium camera by the tileset. Replaces
 * the MapLibre transform as the driver of which tiles to load and retain.
 */
export interface TileCovering {
  idealTileIDs: OverscaledTileID[];
  /**
   * The zoom level used for retaining parent tiles as substitutes.
   */
  zoom: number;
  /**
   * The longitude of the view center, used for world-wrap handling.
   */
  centerLng: number;
  /**
   * The viewport size in CSS pixels.
   */
  width: number;
  height: number;
}

/**
 * Owns one source's loaded tile pyramid, requests, cache and feature state.
 * Ready parents or children cover requested tiles until their data is loaded.
 */
export class TilePyramid extends Evented<SourceEventType> {
  id: string;
  dispatcher: WorkerDispatcher;
  style?: Style;

  _source: Source;

  /**
   * signifies that the TileJSON is loaded if applicable.
   * if the source type does not come with a TileJSON, the flag signifies the
   * source data has loaded (i.e geojson has been tiled on the worker and is ready)
   * @internal
   */
  _sourceLoaded = false;

  _sourceErrored = false;
  _activeTiles: ActiveTiles;
  _prevLng?: number;
  /**
   * Continuous longitude used to choose a world copy. Cesium normally
   * reports Cartographic longitude in [-180, 180], so this may differ from
   * the raw value at the antimeridian.
   */
  _worldCenterLng?: number;
  _tileCache: TileCache;
  _timers: Record<string, ReturnType<typeof setTimeout>>;
  _rasterFadeDuration = 0;
  _maxFadingAncestorLevels = 5;
  _maxTileCacheSize?: number;
  _maxTileCacheZoomLevels?: number;
  _paused = false;
  _shouldReloadOnResume = false;
  _covering?: TileCovering;
  used?: boolean;
  _state: SourceFeatureState;
  _didEmitContent: boolean;
  _updated: boolean;
  private _tileSetRevision = 0;
  private _lastUpdate?: {
    used: boolean | undefined;
    sourceLoaded: boolean;
    paused: boolean;
    tileSetRevision: number;
    covering: TileCovering;
  };

  private _removed = false;

  static maxUnderzooming: number = 10;
  static maxOverzooming: number = 3;
  /**
   * Maximum in-flight tile loads before fresh ideal requests defer.
   * Mirrors Cesium's `loadingDescendantLimit` (20): past the cap, ideals
   * already covered by a loaded substitute wait for a slot instead of
   * flooding the network, while uncovered ideals still dispatch immediately
   * (no holes). MapLibre has no equivalent and requests everything at once.
   */
  static readonly MAX_CONCURRENT_LOADS = 20;

  /**
   * Tile keys with a dispatched `source.loadTile` promise in flight (fresh
   * loads and reloads alike). Deferred ideals are in view with state
   * 'loading' but absent here; the next pyramid walk dispatches them once a
   * slot frees (completions bump the revision, forcing a re-walk).
   */
  private _dispatchedLoads = new Set<string>();
  /**
   * Deferral probe for the current ideal loop: ideals with complete loaded-
   * child coverage. Set around the ideal loop only, so parent-ascent requests
   * (the rendering fallback) never defer.
   */
  private _deferProbe: { idealTileIDs: readonly OverscaledTileID[]; covered?: Set<string> } | undefined;

  constructor(id: string, options: SourceSpecification | CanvasSourceSpecification, dispatcher: WorkerDispatcher) {
    super();
    this.id = id;
    this.dispatcher = dispatcher;

    this.on('data', (e: SourceDataEvent) => {
      this._dataHandler(e);
    });

    this.on('dataloading', () => {
      this._sourceErrored = false;
    });

    this.on('error', () => {
      // Only set _sourceErrored if the source does not have pending loads.
      this._sourceErrored = this._source.loaded();
    });

    this._source = createSource(id, options, dispatcher, this);

    this._activeTiles = new ActiveTiles();
    this._tileCache = new TileCache(0, tile => this._unloadTile(tile));
    this._timers = {};
    this._state = new SourceFeatureState();
    this._didEmitContent = false;
    this._updated = false;
  }

  onAdd(): void {
    this._removed = false;
    this._lastUpdate = undefined;
    this._maxTileCacheSize = this.style?.maxTileCacheSize;
    this._maxTileCacheZoomLevels = this.style?.maxTileCacheZoomLevels;
    if (this._source.onAdd) {
      if (this.style) {
        this._source.style = this.style;
      }
      this._source.onAdd();
    }
  }

  onRemove(): void {
    this._removed = true;
    for (const tile of this._activeTiles.getAllTiles()) {
      tile.unloadVectorData();
    }
    this.clearTiles();
    if (this._source.onRemove) {
      this._source.onRemove();
    }
    for (const id in this._timers) {
      clearTimeout(this._timers[id]);
      delete this._timers[id];
    }
    this._sourceLoaded = false;
    this._covering = undefined;
    this._prevLng = undefined;
    this._worldCenterLng = undefined;
    this._updated = false;
    this._didEmitContent = false;
    this._lastUpdate = undefined;
    this._activeTiles = new ActiveTiles();
  }

  /**
   * Return true if no tile data is pending, tiles will not change unless
   * an additional API call is received.
   */
  loaded(): boolean {
    if (this._sourceErrored) {
      return true;
    }
    if (!this._sourceLoaded) {
      return false;
    }
    if (!this._source.loaded()) {
      return false;
    }
    if (this.used !== undefined && !this.used) {
      return true;
    }
    // do not consider as loaded if the update hasn't been called yet (we do not know if we will have any tiles to fetch)
    if (!this._updated) {
      return false;
    }

    for (const tile of this._activeTiles.getAllTiles()) {
      if (tile.state !== 'loaded' && tile.state !== 'errored')
        return false;
    }
    return true;
  }

  getSource(): Source {
    return this._source;
  }

  getState(): SourceFeatureState {
    return this._state;
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    if (!this._paused)
      return;
    const shouldReload = this._shouldReloadOnResume;
    this._paused = false;
    this._shouldReloadOnResume = false;
    if (shouldReload)
      this.reload();
    if (this._covering)
      this.update(this._covering);
  }

  async _loadTile(tile: Tile, _id: string, state: TileState): Promise<void> {
    const dispatchKey = tile.tileID.key;
    this._dispatchedLoads.add(dispatchKey);
    try {
      const result = await this._source.loadTile(tile);
      // A source may finish an aborted request after the tile left the
      // active set. Ignore that late completion. The tile key can also
      // change during a world-wrap jump, so use its current key below.
      if (!this._isTileActive(tile)) {
        // Still bump: the freed slot may unblock deferred ideals, and no
        // other path schedules the re-walk for an ignored completion.
        this._tileSetRevision++;
        return;
      }
      this._tileLoaded(tile, tile.tileID.key, state, result ?? {});
    }
    catch (err) {
      if (!this._isTileActive(tile)) {
        this._tileSetRevision++;
        return;
      }
      tile.state = 'errored';

      // The tileset reuses one covering object across frames, so update() short-
      // circuits on identity. Bump the revision so the next pyramid walk
      // actually runs and can retain/substitute a loaded parent tile; without
      // this an errored tile stays a permanent hole while the camera is still.
      this._tileSetRevision++;

      if (!hasHttpStatus(err) || err.status !== 404) {
        this._source.fire(new ErrorEvent(ensureError(err), { tile }));
      }
      else {
        // continue to try loading parent/children tiles if a tile doesn't exist (404)
        if (this._covering) {
          this.update(this._covering);
        }
      }
    }
    finally {
      // Keys can change on wrap jumps; drop both the dispatch key and current.
      this._dispatchedLoads.delete(dispatchKey);
      this._dispatchedLoads.delete(tile.tileID.key);
    }
  }

  _unloadTile(tile: Tile): void {
    if (this._source.unloadTile) {
      // Tile removal is not awaited by the pyramid. Consume teardown errors
      // so a destroyed worker cannot create an unhandled rejection.
      try {
        void Promise.resolve(this._source.unloadTile(tile)).catch(() => {});
      }
      catch {
        // A custom source may throw before returning its teardown promise.
      }
    }
  }

  _abortTile(tile: Tile): void {
    if (this._source.abortTile) {
      try {
        void Promise.resolve(this._source.abortTile(tile)).catch(() => {});
      }
      catch {
        // A custom source may throw before returning its abort promise.
      }
    }

    this._source.fire(new SourceDataEvent('dataabort', { tile, coord: tile.tileID }));
  }

  serialize(): SourceSpecification | CanvasSourceSpecification {
    return this._source.serialize();
  }

  prepare(): boolean {
    const featureStateRevision = this._state.revision;
    if (this._source.prepare) {
      this._source.prepare();
    }

    const style = this.style;
    if (style) {
      if (this._state.hasPendingChanges())
        this._state.coalesceChanges(this._activeTiles, style);
      for (const tile of this._activeTiles.getAllTiles()) {
        tile.prepare(style.images);
      }
    }
    return this._state.revision !== featureStateRevision;
  }

  /**
   * Return all tile ids ordered with z-order, and cast to numbers
   */
  getIds(): string[] {
    return this._activeTiles.getAllIds(true);
  }

  getRenderableIds(symbolLayer?: boolean): string[] {
    return this._activeTiles.getRenderableIds(0, symbolLayer);
  }

  /**
   * Check one tile without materializing or scanning the renderable-id list.
   * Render data events are already keyed by tile id, so this is the hot path
   * used by the Cesium adapter when a worker result arrives.
   */
  isRenderableId(id: string, symbolLayer = false): boolean {
    return this._activeTiles.isIdRenderable(id, symbolLayer);
  }

  hasRenderableParent(tileID: OverscaledTileID): boolean {
    const parentZ = tileID.overscaledZ - 1;
    if (parentZ >= this._source.minzoom) {
      const parentTile = this.getLoadedTile(tileID.scaledTo(parentZ));
      if (parentTile) {
        return this._activeTiles.isIdRenderable(parentTile.tileID.key);
      }
    }
    return false;
  }

  /**
   * Reload tiles based on the current state of the source.
   * @param sourceDataChanged - If `true`, reload all tiles using a state of 'expired' (errored tiles use 'loading' since they have nothing to show yet), otherwise reload only non-errored tiles using state of 'reloading'.
   * @param shouldReloadTileOptions - Set of options associated with a `MapSourceDataChangedEvent` that can be passed back to the associated `Source` determine whether a tile should be reloaded.
   */
  reload(
    sourceDataChanged?: boolean,
    shouldReloadTileOptions?: GeoJSONSourceShouldReloadTileOptions,
  ): void {
    if (this._paused) {
      this._shouldReloadOnResume = true;
      return;
    }

    this._tileCache.reset();

    for (const id of this._activeTiles.getAllIds()) {
      const tile = this._activeTiles.getTileById(id);
      if (!tile) {
        continue;
      }
      if (shouldReloadTileOptions && this._source.shouldReloadTile
        && !this._source.shouldReloadTile(tile, shouldReloadTileOptions)) {
        continue;
      }
      else if (sourceDataChanged) {
        this._reloadTile(id, tile.state === 'errored' ? 'loading' : 'expired');
      }
      else if (tile.state !== 'errored') {
        this._reloadTile(id, 'reloading');
      }
    }
  }

  async _reloadTile(id: string, state: TileState): Promise<void> {
    const tile = this._activeTiles.getTileById(id);

    // this potentially does not address all underlying
    // issues https://github.com/mapbox/mapbox-gl-js/issues/4252
    // - hard to tell without repro steps
    if (!tile)
      return;

    // The difference between "loading" tiles and "reloading" or "expired"
    // tiles is that "reloading"/"expired" tiles are "renderable".
    // Therefore, a "loading" tile cannot become a "reloading" tile without
    // first becoming a "loaded" tile.
    if (tile.state !== 'loading') {
      tile.state = state;
    }
    await this._loadTile(tile, id, state);
  }

  _tileLoaded(tile: Tile, id: string, previousState: TileState, result: LoadTileResult | void): void {
    if (!this._isTileActive(tile)) {
      return;
    }

    // A wrap jump may have changed the key while the source was loading.
    id = tile.tileID.key;
    tile.timeAdded = performance.now();

    if (previousState === 'expired')
      tile.refreshedUponExpiration = true;
    this._setTileReloadTimer(id, tile);

    if (result && result.unmodified)
      return;

    // Reset feature state revision so initializeTileState re-applies
    // feature state to the tile's new bucket data after a reload.
    tile.featureStateRevision = -1;
    this._state.initializeTileState(tile, this.style as Style);

    // A load completion changes which tiles are renderable, and with it the
    // retained parent/substitute set. The revision is compared before the
    // covering-identity shortcut, so the next update() re-walks the pyramid
    // and drops retained parents once their children are ready. Without the
    // bump, a settled camera would keep the stale coarse tiles in the render
    // set indefinitely (the covering stays identical while the camera rests).
    this._tileSetRevision++;

    if (!tile.aborted) {
      this._source.fire(new SourceDataEvent('data', { tile, coord: tile.tileID }));
    }
  }

  /**
   * Get a specific tile by TileID
   */
  getTile(tileID: OverscaledTileID): Tile | undefined {
    return this.getTileByID(tileID.key);
  }

  /**
   * Get a specific tile by id
   */
  getTileByID(id: string): Tile | undefined {
    return this._activeTiles.getTileById(id);
  }

  /** Loaded data that can reenter the current pyramid without a tile request. */
  getLoadedTileIDs(zoom: number): OverscaledTileID[] {
    const tiles = new Map<string, OverscaledTileID>();
    const add = (tile: Tile): void => {
      if (tile.state === 'loaded' && tile.tileID.overscaledZ === zoom) {
        const id = tile.tileID.wrapped();
        tiles.set(id.key, id);
      }
    };
    for (const tile of this._activeTiles.getAllTiles()) {
      add(tile);
    }
    // getAndRemove restores the first entry for each wrapped key. Inspect
    // that same version without consuming it or changing its LRU position.
    for (const entries of Object.values(this._tileCache.data)) {
      if (entries[0]) {
        add(entries[0].value);
      }
    }
    return [...tiles.values()];
  }

  /**
   * Retain the uppermost loaded children of each provided target tile, within a variable covering zoom range.
   *
   * On pitched maps, different parts of the screen show different zoom levels simultaneously.
   * Ideal tiles are generated using coveringTiles() above, which returns the ideal tile set for
   * the current pitched plane, which can carry tiles of varying zooms (overscaledZ).
   * See: https://maplibre.org/maplibre-gl-js/docs/examples/level-of-detail-control/
   *
   * A fixed `maxCoveringZoom` on a pitched map would incorrectly intersect with some
   * ideal tiles and cause distant high-pitch tiles to skip their uppermost children.
   *
   * To solve this, we calculate the max covering zoom for each ideal tile separately using its
   * `overscaledZ`. This effectively makes the "max covering zoom plane" parallel to the
   * "ideal tile plane," ensuring that we correctly capture the uppermost children
   * of each ideal tile across the pitched view.
   *
   * Analogy: imagine two sheets of paper in 3D space:
   *   - one sheet = ideal tiles at varying overscaledZ
   *   - the second sheet = maxCoveringZoom
   *
   * @param retainTileMap - this parameters will be updated with the child tiles to keep
   * @param idealTilesWithoutData - which of the ideal tiles currently does not have loaded data
   * @return a set of tiles that need to be loaded
   */
  _retainLoadedChildren(retainTileMap: Record<string, OverscaledTileID>, idealTilesWithoutData: Set<OverscaledTileID>): Set<OverscaledTileID> {
    const loadedDescendents: Record<string, Tile[]> = this._getLoadedDescendents(idealTilesWithoutData);
    const incomplete = new Set<OverscaledTileID>();

    // retain the uppermost descendents of target tiles
    for (const targetID of idealTilesWithoutData) {
      const descendents = loadedDescendents[targetID.key];
      if (!descendents?.length) {
        incomplete.add(targetID);
        continue;
      }

      // find descendents within the max covering zoom range
      const maxCoveringZoom = targetID.overscaledZ + TilePyramid.maxOverzooming;
      const candidates = descendents.filter(t => t.tileID.overscaledZ <= maxCoveringZoom);
      if (!candidates.length) {
        incomplete.add(targetID);
        continue;
      }

      // retain the uppermost descendents in the topmost zoom below the target tile
      let topZoom = Infinity;
      const topIDs: OverscaledTileID[] = [];
      for (const tile of candidates) {
        const zoom = tile.tileID.overscaledZ;
        if (zoom < topZoom) {
          topZoom = zoom;
          topIDs.length = 0;
          topIDs.push(tile.tileID);
        }
        else if (zoom === topZoom) {
          topIDs.push(tile.tileID);
        }
      }
      for (const tileID of topIDs) {
        retainTileMap[tileID.key] = tileID;
      }

      // determine if the retained generation is fully covered
      if (!this._areDescendentsComplete(topIDs, topZoom, targetID.overscaledZ)) {
        incomplete.add(targetID);
      }
    }

    return incomplete;
  }

  /**
   * Return dictionary of qualified loaded descendents for each provided target tile id
   */
  _getLoadedDescendents(targetTileIDs: Set<OverscaledTileID>): Record<string, Tile[]> {
    const loadedDescendents: Record<string, Tile[]> = {};

    // enumerate current tiles and find the loaded descendents of each target tile
    for (const tile of this._activeTiles.getAllTiles().filter(tile => tile.hasData())) {
      // determine if the loaded tile (hasData) is a qualified descendent of any target tile
      for (const targetID of targetTileIDs) {
        if (tile.tileID.isChildOf(targetID)) {
          loadedDescendents[targetID.key] ||= [];
          loadedDescendents[targetID.key].push(tile);
        }
      }
    }

    return loadedDescendents;
  }

  /**
   * Determine if tile ids fully cover the current generation.
   * - 1st generation: need 4 children or 1 overscaled child
   * - 2nd generation: need 16 children or 1 overscaled child
   */
  _areDescendentsComplete(generationIDs: OverscaledTileID[], generationZ: number, ancestorZ: number): boolean {
    // if overscaled, seeking 1 tile at generationZ, otherwise seeking a power of 4 for each descending Z
    const firstGenerationID = generationIDs[0];
    if (generationIDs.length === 1 && firstGenerationID?.isOverscaled()) {
      return firstGenerationID.overscaledZ === generationZ;
    }
    else {
      const expectedTiles = 4 ** (generationZ - ancestorZ); // 4, 16, 64 (for first 3 gens)
      return expectedTiles === generationIDs.length;
    }
  }

  /**
   * Get an active tile with data; cached tiles are excluded.
   * @returns the active tile if it has data, undefined otherwise.
   */
  getLoadedTile(tileID: OverscaledTileID): Tile | undefined {
    return this._activeTiles.getLoadedTile(tileID);
  }

  /**
   * Resizes the tile cache based on the current viewport's size
   * or the maxTileCacheSize option passed during map creation
   *
   * Larger viewports use more tiles and need larger caches. Larger viewports
   * are more likely to be found on devices with more memory and on pages where
   * the map is more important.
   */
  updateCacheSize(width: number, height: number): void {
    const widthInTiles = Math.ceil(width / this._source.tileSize) + 1;
    const heightInTiles = Math.ceil(height / this._source.tileSize) + 1;
    const approxTilesInView = widthInTiles * heightInTiles;
    const commonZoomRange = this._maxTileCacheZoomLevels ?? config.MAX_TILE_CACHE_ZOOM_LEVELS;
    const viewDependentMaxSize = Math.floor(approxTilesInView * commonZoomRange);
    const maxSize = typeof this._maxTileCacheSize === 'number'
      ? Math.min(this._maxTileCacheSize, viewDependentMaxSize)
      : viewDependentMaxSize;

    this._tileCache.setMaxSize(maxSize);
  }

  handleWrapJump(lng: number): void {
    // On top of the regular z/x/y values, TileIDs have a `wrap` value that specify
    // which copy of the world the tile belongs to. For example, at `lng: 10` you
    // might render z/x/y/0 while at `lng: 370` you would render z/x/y/1.
    //
    // When lng values get wrapped (going from `lng: 370` to `long: 10`) you expect
    // to see the same thing on the screen (370 degrees and 10 degrees is the same
    // place in the world) but all the TileIDs will have different wrap values.
    //
    // In order to make this transition seamless, we calculate the rounded difference of
    // "worlds" between the last frame and the current frame. If the map panned by
    // a world, then we can assign all the tiles new TileIDs with updated wrap values.
    // For example, assign z/x/y/1 a new id: z/x/y/0. It is the same tile, just rendered
    // in a different position.
    //
    // This enables us to reuse the tiles at more ideal locations and prevent flickering.
    if (!Number.isFinite(lng)) {
      this._prevLng = undefined;
      this._worldCenterLng = undefined;
      return;
    }

    const prevLng = this._prevLng;
    // A normalized +179 -> -179 transition is a two-degree camera movement,
    // not a request to re-key every active tile. Only an explicitly
    // unwrapped longitude opts into MapLibre's world-jump behavior.
    const hasExplicitWorldCopy = Math.abs(lng) > 180 || (prevLng !== undefined && Math.abs(prevLng) > 180);
    const wrapDelta = prevLng !== undefined && hasExplicitWorldCopy
      ? Math.round((lng - prevLng) / 360)
      : 0;
    this._prevLng = lng;

    if (wrapDelta) {
      this._activeTiles.handleWrapJump(wrapDelta);
      this._resetTileReloadTimers();
    }
  }

  /**
   * Removes tiles that are outside the viewport and adds new tiles that
   * are inside the viewport. The ideal tile set is computed by the tileset
   * from the Cesium camera and passed in as the covering.
   */
  update(covering: TileCovering): void {
    if (this._removed || !this._sourceLoaded || this._paused) {
      return;
    }
    if (this._sameUpdate(covering)) {
      return;
    }
    this._covering = covering;

    this.updateCacheSize(covering.width, covering.height);
    const worldCenterLng = this._continuousCenterLng(covering.centerLng);
    this.handleWrapJump(covering.centerLng);

    let idealTileIDs: OverscaledTileID[];

    if (!this.used) {
      idealTileIDs = [];
    }
    else if (this._source.tileID) { // image source
      const { z, x, y } = this._source.tileID;
      idealTileIDs = [new OverscaledTileID(z, 0, z, x, y)];
    }
    else {
      idealTileIDs = covering.idealTileIDs;
      if (this._source.hasTile) { // tile should be in bounds
        idealTileIDs = idealTileIDs.filter(coord => this._source.hasTile!(coord));
      }
    }

    idealTileIDs = this._assignWorldCopies(idealTileIDs, worldCenterLng);

    const noPendingDataEmissions = idealTileIDs.length === 0 && !this._updated && this._didEmitContent;
    this._updated = true;
    // if we won't have any tiles to fetch and content is already emitted
    // there will be no more data emissions, so we need to emit the event with isSourceLoaded = true
    if (noPendingDataEmissions) {
      this.fire(new SourceDataEvent('data', { sourceDataType: 'idle', sourceId: this.id }));
    }

    // Retain is a list of tiles that we shouldn't delete, even if they are not
    // the most ideal tile for the current viewport. This may include tiles like
    // parent or child tiles that are *already* loaded.
    const retain: Record<string, OverscaledTileID> = this._updateRetainedTiles(idealTileIDs);

    // Raster crossfade: pair the ideal tiles with fading ancestors or
    // descendents and retain the counterparts for the transition duration.
    if (this._rasterFadeDuration > 0 && this._source.type !== 'vector' && this._source.type !== 'geojson') {
      updateFadingTiles(
        this._activeTiles,
        idealTileIDs,
        retain,
        this._maxFadingAncestorLevels,
        this._source.minzoom ?? 0,
        this._source.maxzoom ?? 22,
        this._rasterFadeDuration,
      );
    }

    // clean up non-retained tiles that are no longer needed
    this._cleanUpVectorTiles(retain);
    // Dispatch ideals deferred by the pressure valve while slots are free
    // (an abort during cleanup may have freed one this very pass).
    this._drainDeferredLoads();
    // _addTile/_removeTile may change the revision while retaining tiles. Save
    // the post-update state so a static frame does not perform one redundant
    // pyramid walk on the next Cesium render.
    this._lastUpdate = {
      used: this.used,
      sourceLoaded: this._sourceLoaded,
      paused: this._paused,
      tileSetRevision: this._tileSetRevision,
      covering,
    };
  }

  private _sameUpdate(covering: TileCovering): boolean {
    const previous = this._lastUpdate;
    if (!previous
      || previous.used !== this.used
      || previous.sourceLoaded !== this._sourceLoaded
      || previous.paused !== this._paused
      || previous.tileSetRevision !== this._tileSetRevision) {
      return false;
    }
    // The CesiumVectorTileset keeps a source covering object stable while the camera
    // and source inputs are unchanged. This is the common steady-frame path;
    // avoid walking every ideal tile just to rediscover object identity.
    if (previous.covering === covering) {
      return true;
    }
    const priorCovering = previous.covering;
    if (priorCovering.zoom !== covering.zoom
      || priorCovering.width !== covering.width
      || priorCovering.height !== covering.height
      || priorCovering.idealTileIDs.length !== covering.idealTileIDs.length) {
      return false;
    }
    const centerChanged = priorCovering.centerLng !== covering.centerLng;
    const priorWorldCenter = this._worldCenterLng;
    const priorInput = this._prevLng;
    let worldCenter: number | undefined;
    if (centerChanged) {
      if (priorWorldCenter === undefined || priorInput === undefined
        || !Number.isFinite(covering.centerLng) || !Number.isFinite(priorWorldCenter)) {
        return false;
      }
      const explicitWorldCopy = Math.abs(covering.centerLng) > 180 || Math.abs(priorInput) > 180;
      if (explicitWorldCopy && Math.round((covering.centerLng - priorInput) / 360) !== 0) {
        return false;
      }
      worldCenter = explicitWorldCopy
        ? covering.centerLng
        : covering.centerLng + 360 * Math.round((priorWorldCenter - covering.centerLng) / 360);
    }
    for (let i = 0; i < covering.idealTileIDs.length; i++) {
      const tile = covering.idealTileIDs[i];
      if (priorCovering.idealTileIDs[i].key !== tile.key) {
        return false;
      }
      if (centerChanged) {
        const tileCenterLng = (tile.canonical.x + 0.5) / 2 ** tile.canonical.z * 360 - 180;
        if (Math.round((priorWorldCenter! - tileCenterLng) / 360)
          !== Math.round((worldCenter! - tileCenterLng) / 360)) {
          return false;
        }
      }
    }
    if (centerChanged) {
      this._continuousCenterLng(covering.centerLng);
      this.handleWrapJump(covering.centerLng);
    }
    this._covering = covering;
    previous.covering = covering;
    return true;
  }

  /**
   * Remove vector tiles that are no longer retained and also not needed for symbol fading
   */
  _cleanUpVectorTiles(retain: Record<string, OverscaledTileID>): void {
    for (const id of this._activeTiles.getAllIds()) {
      const tile = this._activeTiles.getTileById(id);
      if (!tile) {
        continue;
      }

      // retained - clear fade hold so if it's removed again fade timer starts fresh.
      if (retain[id]) {
        tile.clearSymbolFadeHold();
        continue;
      }

      // remove non-retained tiles without symbols
      if (!tile.hasSymbolBuckets) {
        this._removeTile(id);
        continue;
      }

      // for tile with symbols - hold for fade - then remove
      if (!tile.holdingForSymbolFade()) {
        tile.setSymbolHoldDuration(this.style?.fadeDuration ?? 300);
      }
      else if (tile.symbolFadeFinished()) {
        this._removeTile(id);
      }
    }
  }

  releaseSymbolFadeTiles(): void {
    for (const id of this._activeTiles.getAllIds()) {
      const tile = this._activeTiles.getTileById(id);
      if (tile?.holdingForSymbolFade()) {
        this._removeTile(id);
      }
    }
  }

  /**
   * Set tiles to be retained on update of the source. For ideal tiles that do not have data, retain their loaded
   * children so they can be displayed as substitutes pending load of each ideal tile (to reduce flickering).
   * If no loaded children are available, fallback to seeking loaded parents as an alternative substitute.
   */
  _updateRetainedTiles(idealTileIDs: OverscaledTileID[]): Record<string, OverscaledTileID> {
    this._deferProbe = { idealTileIDs };
    const idealTilesWithoutData = new Set<OverscaledTileID>();
    for (const idealID of idealTileIDs) {
      const idealTile = this._addTile(idealID);

      if (!idealTile.hasData()) {
        idealTilesWithoutData.add(idealID);
      }
    }
    this._deferProbe = undefined;

    // retain the tile even if it's not loaded because it's an ideal tile.
    const retainTileMap: Record<string, OverscaledTileID> = {};
    for (const tileID of idealTileIDs) {
      retainTileMap[tileID.key] = tileID;
    }
    const tileIdsWithoutData = this._retainLoadedChildren(retainTileMap, idealTilesWithoutData);

    // for remaining missing tiles with incomplete child coverage, seek a loaded parent tile
    const checked: Record<string, boolean> = {};
    for (const tileID of tileIdsWithoutData) {
      const minCoveringZoom = Math.max(tileID.overscaledZ - TilePyramid.maxUnderzooming, this._source.minzoom);
      let tile = this._activeTiles.getTileById(tileID.key);

      // As we ascend up the tile pyramid of the ideal tile, we check whether the parent
      // tile has been previously requested (and errored because we only loop over tiles with no data)
      // in order to determine if we need to request its parent.
      let parentWasRequested = tile?.wasRequested();

      for (let overscaledZ = tileID.overscaledZ - 1; overscaledZ >= minCoveringZoom; --overscaledZ) {
        const parentId = tileID.scaledTo(overscaledZ);

        // Break parent tile ascent if this route has been previously checked by another child.
        if (checked[parentId.key])
          break;
        checked[parentId.key] = true;

        tile = this.getTile(parentId);
        if (!tile && (parentWasRequested || this._tileCache.get(parentId)?.hasData())) {
          tile = this._addTile(parentId);
        }
        if (tile) {
          const hasData = tile.hasData();
          if (hasData || !this.style?.cancelPendingTileRequestsWhileZooming || parentWasRequested) {
            retainTileMap[parentId.key] = parentId;
          }
          // Save the current values, since they're the parent of the next iteration
          // of the parent tile ascent loop.
          parentWasRequested = tile.wasRequested();
          if (hasData)
            break;
        }
      }
    }

    return retainTileMap;
  }

  /**
   * Whether a fresh ideal should skip dispatch this pass: only when the
   * valve is pressured AND a loaded substitute already renders in its place
   * (complete child coverage, or a loaded active parent retention ascends
   * to). Uncovered ideals always dispatch - no holes, ever. Consulted only
   * inside the ideal loop (see _deferProbe); parent-ascent requests are the
   * rendering fallback and never defer.
   */
  private _shouldDeferIdealLoad(idealID: OverscaledTileID): boolean {
    const probe = this._deferProbe;
    if (!probe || this._dispatchedLoads.size < TilePyramid.MAX_CONCURRENT_LOADS) {
      return false;
    }
    if (!probe.covered) {
      const incomplete = this._retainLoadedChildren({}, new Set(probe.idealTileIDs));
      const incompleteKeys = new Set([...incomplete].map(id => id.key));
      probe.covered = new Set(probe.idealTileIDs.map(id => id.key).filter(key => !incompleteKeys.has(key)));
    }
    if (probe.covered.has(idealID.key)) {
      return true;
    }
    const minCoveringZoom = Math.max(idealID.overscaledZ - TilePyramid.maxUnderzooming, this._source.minzoom);
    for (let z = idealID.overscaledZ - 1; z >= minCoveringZoom; --z) {
      if (this._activeTiles.getLoadedTile(idealID.scaledTo(z))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Dispatch deferred ideals while slots are free. Deferred tiles sit in
   * view with state 'loading' but no dispatched promise; completions bump
   * the revision so the next walk reaches here with a free slot.
   */
  private _drainDeferredLoads(): void {
    if (this._dispatchedLoads.size >= TilePyramid.MAX_CONCURRENT_LOADS) {
      return;
    }
    for (const id of this._activeTiles.getAllIds()) {
      if (this._dispatchedLoads.size >= TilePyramid.MAX_CONCURRENT_LOADS) {
        break;
      }
      const tile = this._activeTiles.getTileById(id);
      if (tile && !tile.aborted && tile.state === 'loading' && !tile.hasData() && !this._dispatchedLoads.has(id)) {
        this._loadTile(tile, id, tile.state);
      }
    }
  }

  /**
   * Add a tile, given its coordinate, to the pyramid.
   */
  _addTile(tileID: OverscaledTileID): Tile {
    let tile = this._activeTiles.getTileById(tileID.key);
    if (tile)
      return tile;

    tile = this._tileCache.getAndRemove(tileID);
    if (tile) {
      // reset fading logic to remove stale fading data from cache
      tile.resetFadeLogic();

      // set timer for the reloading of the tile upon expiration
      this._setTileReloadTimer(tileID.key, tile);

      // set the tileID because the cached tile could have had a different wrap value
      tile.tileID = tileID;
      tile.aborted = false;
      this._state.initializeTileState(tile, this.style as Style);
    }

    const cached = tile;

    if (!tile) {
      tile = new Tile(tileID, this._source.tileSize * tileID.overscaleFactor());
      // Pressure valve: a covered ideal skips dispatch while too many loads
      // are in flight. It stays in view with state 'loading'; a completion
      // frees a slot and bumps the revision, so the next pyramid walk (or
      // the drain below) dispatches it - progress without a queue.
      if (!this._shouldDeferIdealLoad(tileID)) {
        this._loadTile(tile, tileID.key, tile.state);
      }
    }

    tile.uses++;
    this._activeTiles.setTile(tileID.key, tile);
    this._tileSetRevision++;
    if (!cached) {
      this._source.fire(new SourceDataEvent('dataloading', { tile, coord: tile.tileID }));
    }

    return tile;
  }

  /**
   * Set a timeout to reload the tile after it expires
   */
  _setTileReloadTimer(id: string, tile: Tile): void {
    this._clearTileReloadTimer(id);

    const expiryTimeout = tile.getExpiryTimeout();
    if (expiryTimeout) {
      const reload = () => {
        this._reloadTile(id, 'expired');
        delete this._timers[id];
      };
      this._timers[id] = setTimeout(reload, expiryTimeout);
    }
  }

  _clearTileReloadTimer(id: string): void {
    const timeout = this._timers[id];
    if (timeout) {
      clearTimeout(timeout);
      delete this._timers[id];
    }
  }

  _resetTileReloadTimers(): void {
    for (const id in this._timers) {
      clearTimeout(this._timers[id]);
      delete this._timers[id];
    }
    for (const id of this._activeTiles.getAllIds()) {
      const tile = this._activeTiles.getTileById(id);
      if (tile) {
        this._setTileReloadTimer(id, tile);
      }
    }
  }

  /**
   * Reload any currently renderable tiles that are match one of the incoming `tileId` x/y/z
   */
  refreshTiles(tileIds: ICanonicalTileID[]): void {
    for (const id of this._activeTiles.getAllIds()) {
      const tile = this._activeTiles.getTileById(id);
      if (!tile) {
        continue;
      }
      if (!this._activeTiles.isIdRenderable(id) && tile.state !== 'errored') {
        continue;
      }
      if (tileIds.some(tid => tid.equals(tile.tileID.canonical))) {
        this._reloadTile(id, 'expired');
      }
    }
  }

  /**
   * Remove a tile, given its id, from the pyramid
   */
  _removeTile(id: string): void {
    const tile = this._activeTiles.getTileById(id);
    if (!tile)
      return;

    tile.uses--;
    this._activeTiles.deleteTileById(id);
    this._tileSetRevision++;
    this._clearTileReloadTimer(id);

    if (tile.uses > 0)
      return;

    if (tile.hasData() && tile.state !== 'reloading') {
      this._tileCache.add(tile.tileID, tile, tile.getExpiryTimeout());
    }
    else {
      tile.aborted = true;
      this._abortTile(tile);
      this._unloadTile(tile);
    }
  }

  private _isTileActive(tile: Tile): boolean {
    return !this._removed && !tile.aborted && this._activeTiles.getTileById(tile.tileID.key) === tile;
  }

  /**
   * Cesium's Cartographic longitude is normally normalized at every frame.
   * Unwrap only that normalized input so a small physical movement from
   * +179° to -179° keeps the same world copy. If a caller supplies an
   * explicitly unwrapped longitude, preserve it and let handleWrapJump apply
   * the corresponding world-copy key change.
   */
  private _continuousCenterLng(lng: number): number {
    if (!Number.isFinite(lng)) {
      this._worldCenterLng = undefined;
      return lng;
    }

    const previous = this._worldCenterLng;
    const previousInput = this._prevLng;
    if (previous === undefined || !Number.isFinite(previous)) {
      this._worldCenterLng = lng;
      return lng;
    }

    const inputIsNormalized = Math.abs(lng) <= 180
      && (previousInput === undefined || Math.abs(previousInput) <= 180);
    this._worldCenterLng = inputIsNormalized
      ? lng + 360 * Math.round((previous - lng) / 360)
      : lng;
    return this._worldCenterLng;
  }

  /**
   * The Cesium covering uses canonical coordinates, while TileIDs also carry
   * the world copy in `wrap`. Assign the copy whose tile centre is closest to
   * the camera so dateline tiles are not rendered in the opposite world.
   */
  private _assignWorldCopies(tiles: OverscaledTileID[], centerLng: number): OverscaledTileID[] {
    if (!Number.isFinite(centerLng)) {
      return tiles;
    }

    return tiles.map((tileID) => {
      const worldSize = 2 ** tileID.canonical.z;
      const tileCenterLng = (tileID.canonical.x + 0.5) / worldSize * 360 - 180;
      const wrap = Math.round((centerLng - tileCenterLng) / 360);
      return tileID.unwrapTo(wrap);
    });
  }

  /**
   * Handles incoming source data messages (i.e. after the source has been updated via a worker that has fired
   * to map.ts data event). For sources with mutable data, the 'content' event fires when the underlying data
   * to a source has changed. (i.e. GeoJSONSource.setData and ImageSource.setCoordinates)
   * @internal
   */
  private _dataHandler(e: SourceDataEvent): void {
    if (this._removed || e.dataType !== 'source')
      return;

    if (e.sourceDataType === 'metadata') {
      this._sourceLoaded = true;
      return;
    }

    if (e.sourceDataType !== 'content' || !this._sourceLoaded || this._paused) {
      return;
    }

    this.reload(e.sourceDataChanged, e.shouldReloadTileOptions);
    if (this._covering) {
      this.update(this._covering);
    }
    this._didEmitContent = true;
  }

  /**
   * The `raster-fade-duration` of the raster layers using this source: drives
   * the crossfade when the ideal zoom set changes. Zero disables fading.
   */
  setRasterFadeDuration(fadeDuration: number): void {
    this._rasterFadeDuration = Math.max(0, fadeDuration);
  }

  /**
   * Whether any active raster tile is mid-fade: the tileset must keep frames
   * coming until every fade completes.
   */
  hasRasterTransition(): boolean {
    return hasRasterTransition(this._activeTiles, this._rasterFadeDuration);
  }

  /**
   * The animated fade opacity of an active raster tile (0..1), or undefined
   * when the tile is not fading. Incoming tiles fade in, departing tiles
   * fade out, over `raster-fade-duration` from the moment their role was
   * assigned (the role assignment resets timeAdded).
   */
  getRasterFadeOpacity(tileKey: string): number | undefined {
    if (this._rasterFadeDuration <= 0) {
      return undefined;
    }
    const tile = this._activeTiles.getTileById(tileKey);
    if (!tile || (!tile.fadingDirection && !tile.selfFading) || !tile.fadeEndTime) {
      return undefined;
    }
    const elapsed = (performance.now() - tile.timeAdded) / this._rasterFadeDuration;
    const clamped = Math.max(0, Math.min(1, elapsed));
    if (tile.fadingDirection === FadingDirections.Incoming) {
      return clamped;
    }
    if (tile.fadingDirection === FadingDirections.Departing) {
      return 1 - clamped;
    }
    if (tile.selfFading) {
      return clamped;
    }
    return undefined;
  }

  /**
   * Remove all tiles from this pyramid
   */
  clearTiles(): void {
    this._shouldReloadOnResume = false;
    this._paused = false;

    for (const id of this._activeTiles.getAllIds()) {
      this._removeTile(id);
    }

    this._tileCache.reset();
    this._lastUpdate = undefined;
  }

  /**
   * Search through our current tiles and attempt to find the tiles that
   * cover the given bounds.
   * @returns the visible tile coordinates in ascending zoom order.
   */
  getVisibleCoordinates(): OverscaledTileID[] {
    return this.getRenderableIds()
      .map(id => this._activeTiles.getTileById(id)?.tileID)
      .filter((tileID): tileID is OverscaledTileID => tileID !== undefined);
  }

  hasTransition(): boolean {
    return this._source.hasTransition();
  }

  /**
   * Set the value of a particular state for a feature
   */
  setFeatureState(sourceLayer: string, featureId: number | string, state: FeatureState): void {
    sourceLayer ||= GEOJSON_TILE_LAYER_NAME;
    this._state.updateState(sourceLayer, featureId, state);
  }

  /**
   * Resets the value of a particular state key for a feature
   */
  removeFeatureState(sourceLayer?: string, featureId?: number | string, key?: string): void {
    sourceLayer ||= GEOJSON_TILE_LAYER_NAME;
    this._state.removeFeatureState(sourceLayer, featureId, key);
  }

  /**
   * Get the entire state object for a feature
   */
  getFeatureState(sourceLayer: string, featureId: number | string): FeatureState {
    sourceLayer ||= GEOJSON_TILE_LAYER_NAME;
    return this._state.getState(sourceLayer, featureId);
  }

  /**
   * Sets the set of keys that the tile depends on. This allows tiles to
   * be reloaded when their dependencies change.
   */
  setDependencies(tileKey: string, namespace: string, dependencies: string[]): void {
    const tile = this._activeTiles.getTileById(tileKey);
    if (tile) {
      tile.setDependencies(namespace, dependencies);
    }
  }

  /**
   * Reloads all tiles that depend on the given keys.
   */
  reloadTilesForDependencies(namespaces: string[], keys: string[]): void {
    for (const id of this._activeTiles.getAllIds()) {
      const tile = this._activeTiles.getTileById(id);
      if (tile?.hasDependency(namespaces, keys)) {
        this._reloadTile(id, 'reloading');
      }
    }
    this._tileCache.filter(tile => !tile.hasDependency(namespaces, keys));
  }

  areTilesLoaded(): boolean {
    for (const tile of this._activeTiles.getAllTiles()) {
      if (!(tile.state === 'loaded' || tile.state === 'errored')) {
        return false;
      }
    }
    return true;
  }
}
