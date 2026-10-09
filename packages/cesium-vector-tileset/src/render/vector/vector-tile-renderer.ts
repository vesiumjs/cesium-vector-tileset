import type {
  BufferPointCollection,
  PrimitiveCollection,

  SceneMode,
} from 'cesium';
import type { DashAtlas } from '../../assets/dash-atlas';
import type { DashRow } from '../../source/worker-source';
import type { MemoryBudgetVisitor } from '../scene/gpu-memory-budget';
import type { ExtrusionLighting } from './extrusion-geometry';
import type { TileRenderResult } from './tile-conversion';
import type { VectorCameraPaintSnapshot, VectorCollectionReplacement, VectorPaintFrame, VectorPaintPreparation, VectorPaintState } from './vector-paint-updater';
import type { BucketMap, StandardRenderEntries, TileID, VectorTileBuildInput, VectorTileBuildState } from './vector-tile-builder';
import {
  BufferPolygonCollection,
  PrimitiveCollection as CesiumPrimitiveCollection,
  HeightReference,
} from 'cesium';
import { DashMaterial } from '../line/dash-material';
import { discardLineBuild } from '../line/line-renderer';
import { drawLayersForOwner, registerDrawLayers } from '../scene/draw-batch';
import { collectionGpuBytes } from '../scene/resource-memory';
import { RetiredPool } from '../scene/retired-pool';
import { createVectorPaintState, VectorPaintUpdater } from './vector-paint-updater';
import { VectorTileBuilder } from './vector-tile-builder';

export type BufferCollection = BufferPolygonCollection | BufferPointCollection;

/**
 * Minimal structural surface of Cesium's VectorProvider consumed for terrain
 * / 3D-Tile draping. VectorProvider is exported at runtime but has no
 * Cesium.d.ts declarations, so the renderer depends on this shape instead of
 * an untyped import. Only BufferPolygonCollection is ever marked: Cesium's
 * vector pipeline packs polygons and polylines, and this renderer's lines
 * are custom primitives, so points stay unclamped by design.
 */
export interface VectorDrapingProvider {
  markForFrame: (collection: BufferPolygonCollection, frameNumber: number, heightReference: HeightReference) => void;
  remove: (collection: BufferPolygonCollection) => void;
}

/** HeightReference values the scene vector provider accepts for draping. */
export function isClampHeightReference(heightReference: HeightReference): boolean {
  return heightReference === HeightReference.CLAMP_TO_TERRAIN
    || heightReference === HeightReference.CLAMP_TO_3D_TILE
    || heightReference === HeightReference.CLAMP_TO_GROUND;
}
/**
 * Standard Cesium primitives are required outside SCENE3D. Buffer collections
 * intentionally have a narrower contract and warn/skip mode conversion in
 * 2D and Columbus View. Each primitive kind has its own tile collection, so
 * scene residency can attach and replace it independently.
 */
export type VectorCollection = BufferCollection | PrimitiveCollection;
export interface VectorTileRecord {
  generationId: number;
  complete: boolean;
  buckets: BucketMap;
  layerIds: readonly string[];
  paint: VectorPaintState;
  tileID: TileID;
  skipLayerIds?: ReadonlySet<string>;
  linePrimitives: TileRenderResult['linePrimitives'];
  dashRows?: Record<string, DashRow>;
  collections: Map<string, VectorCollection>;
  standard?: StandardRenderEntries;
  mode: SceneMode;
}

/**
 * Native fill and point buffers belong to one tile generation and style layer.
 * A tile can contain fill, line, circle, and extrusion buckets at the same
 * time, so keeping one collection for the whole tile would silently discard
 * every kind after the first non-empty one.
 */
export class VectorTileRenderer {
  private _records: Map<string, VectorTileRecord> = new Map();
  private readonly _tileForCollection = new WeakMap<object, string>();
  private _pixelRatio: number;
  private _vectorProvider?: VectorDrapingProvider;
  private _heightReference: HeightReference = HeightReference.NONE;
  private readonly _drapeHolds = new Set<BufferPolygonCollection>();
  private _drapeOrder: BufferPolygonCollection[] = [];
  private _drapeOrderDirty = false;
  readonly dashMaterial?: DashMaterial;
  private readonly _builder: VectorTileBuilder;
  private readonly _paint: VectorPaintUpdater;

  /**
   * Style light inputs for the extrusion track, refreshed by the tileset when
   * the style changes (extrusionCache keys on the style revision, so stale
   * values are always rebuilt before they are used).
   */
  lighting?: ExtrusionLighting;

  /**
   * The device pixel ratio baked into line geometry. The tileset refreshes it
   * every frame so newly published tiles bake the current ratio and a ratio
   * change (e.g. moving a window across displays) invalidates the line track
   * even on an otherwise steady frame.
   */
  get pixelRatio(): number {
    return this._pixelRatio;
  }

  set pixelRatio(pixelRatio: number) {
    this._pixelRatio = pixelRatio;
  }

  constructor(pixelRatio = 1, dashAtlas?: DashAtlas) {
    this._pixelRatio = pixelRatio;
    this.dashMaterial = dashAtlas ? new DashMaterial(dashAtlas) : undefined;
    this._builder = new VectorTileBuilder(() => ({
      pixelRatio: this._pixelRatio,
      heightReference: this._heightReference,
      lighting: this.lighting,
      dashMaterial: this.dashMaterial,
    }));
    this._paint = new VectorPaintUpdater({
      records: () => this._records,
      pixelRatio: () => this._pixelRatio,
      lighting: () => this.lighting,
      dashMaterial: this.dashMaterial,
      replace: (tileId, kind, old, replacement, replacements) =>
        this._replaceCollection(tileId, kind, old, replacement, replacements),
    });
  }

  beginTileBuild(input: VectorTileBuildInput): VectorTileBuildState {
    return this._builder.begin(input);
  }

  advanceTileBuild(state: VectorTileBuildState, budget: import('../scene/frame-budget').Budget): boolean {
    return this._builder.step(state, budget);
  }

  discardTileBuild(state: VectorTileBuildState): void {
    this._builder.discard(state);
  }

  invalidatePaint(): void {
    this._paint.invalidate();
  }

  captureLivePaint(): VectorCameraPaintSnapshot {
    return this._paint.captureLivePaint();
  }

  freezePaint(snapshot?: VectorCameraPaintSnapshot): void {
    this._paint.freezeExisting(snapshot);
  }

  updateLivePaint(frame: VectorPaintFrame): void {
    this._paint.updateLivePaint(frame);
  }

  updatePaint(frame: VectorPaintFrame): VectorCollectionReplacement[] {
    return this._paint.update(frame);
  }

  get needsPaintUpdate(): boolean {
    return this._paint.needsContinuation;
  }

  /**
   * Enable draping of fill polygons onto terrain / 3D Tiles through the
   * scene's vector provider (Cesium 1.144+). Call once before tiles publish:
   * the height reference is baked into each polygon collection at
   * construction, so a later change only affects newly built tiles.
   * Only fill polygons drape; circle points, lines, symbols, extrusions and
   * patterns keep their ellipsoid heights.
   */
  setDraping(vectorProvider: VectorDrapingProvider | undefined, heightReference: HeightReference): void {
    if (this._vectorProvider === vectorProvider && this._heightReference === heightReference) {
      return;
    }
    this._undrapeAll(this._vectorProvider);
    this._vectorProvider = vectorProvider;
    this._heightReference = heightReference;
  }

  private _isDraping(): boolean {
    return this._vectorProvider !== undefined && isClampHeightReference(this._heightReference);
  }

  /**
   * Mark every active polygon collection for this frame's drape pass. A
   * draped collection is not drawn as geometry of its own, so the tileset must
   * call this every update — steady frames included — or the provider prunes
   * the fills and they vanish. Call after all publishes and replacements so
   * same-frame collections are marked without a one-frame gap.
   */
  markDrapedCollections(frameNumber: number, layerOrder: ReadonlyMap<string, number>): boolean {
    if (!this._isDraping()) {
      return false;
    }
    const provider = this._vectorProvider;
    if (!provider) {
      return false;
    }
    const owned = new Set<BufferPolygonCollection>();
    for (const record of this._records.values()) {
      for (const collection of record.collections.values()) {
        if (collection instanceof BufferPolygonCollection)
          owned.add(collection);
      }
    }
    for (const collection of this._drapeHolds)
      owned.add(collection);
    const ordered = [...owned].filter(collection => collection.show).map((collection) => {
      let rank = Infinity;
      for (const layerId of drawLayersForOwner(collection)) {
        rank = Math.min(rank, layerOrder.get(layerId) ?? Infinity);
      }
      return { collection, rank };
    }).sort((a, b) => a.rank - b.rank).map(entry => entry.collection);
    const changed = this._drapeOrderDirty || ordered.length !== this._drapeOrder.length
      || ordered.some((collection, index) => collection !== this._drapeOrder[index]);
    if (changed) {
      // Native discovers collections before our update. Its persistent Map
      // keeps first-insertion order, so marking existing keys cannot repair
      // order after a hidden layer or a replacement becomes visible again.
      for (const collection of new Set([...this._drapeOrder, ...owned])) {
        provider.remove(collection);
      }
      this._drapeOrder = ordered;
      this._drapeOrderDirty = false;
    }
    for (const collection of ordered) {
      provider.markForFrame(collection, frameNumber, this._heightReference);
    }
    return changed;
  }

  /** Stop draping a predecessor when its scene replacement is ready or cancelled. */
  releaseDrapedCollection(collection: VectorCollection): void {
    if (collection instanceof BufferPolygonCollection && this._drapeHolds.delete(collection)) {
      this._undrape(this._vectorProvider, collection);
    }
  }

  /** Detach every active and retired polygon collection from the provider. */
  undrapeAll(): void {
    this._undrapeAll(this._vectorProvider);
    this._vectorProvider = undefined;
  }

  private _undrapeAll(provider: VectorDrapingProvider | undefined): void {
    this._drapeOrder = [];
    this._drapeOrderDirty = false;
    if (!provider) {
      return;
    }
    for (const record of this._records.values()) {
      for (const collection of record.collections.values()) {
        this._undrape(provider, collection);
      }
    }
    for (const record of this._retired.values()) {
      for (const collection of record.collections.values()) {
        this._undrape(provider, collection);
      }
    }
    for (const collection of this._drapeHolds) {
      this._undrape(provider, collection);
    }
    this._drapeHolds.clear();
  }

  private _undrape(provider: VectorDrapingProvider | undefined, collection: VectorCollection): void {
    if (collection instanceof BufferPolygonCollection && this._drapeOrder.includes(collection)) {
      this._drapeOrder = this._drapeOrder.filter(owned => owned !== collection);
      this._drapeOrderDirty = true;
    }
    if (provider && collection instanceof BufferPolygonCollection) {
      provider.remove(collection);
    }
  }

  get collections(): ReadonlyMap<string, VectorCollection> {
    const collections = new Map<string, VectorCollection>();
    for (const [tileId, record] of this._records) {
      for (const [kind, collection] of record.collections) {
        collections.set(record.collections.size === 1 ? tileId : `${tileId}:${kind}`, collection);
      }
    }
    return collections;
  }

  get tileIds(): ReadonlyArray<string> {
    return [...this._records.keys()];
  }

  /** Live/retired tile and collection counts for diagnostics. */
  get stats(): { tiles: number; collections: number; retiredTiles: number } {
    let collections = 0;
    for (const record of this._records.values()) {
      collections += record.collections.size;
    }
    return {
      tiles: this._records.size,
      collections,
      retiredTiles: this._retired.size,
    };
  }

  /** Every collection cached by {@link retireTile}, for teardown. */
  get retiredCollections(): ReadonlyArray<VectorCollection> {
    return [...this._retired.values()].flatMap(entry => [...entry.collections.values()]);
  }

  /**
   * Per-tile byte estimates for the memory budget: live records first, then
   * retired oldest-first (the budget's LRU order). The live map and retired
   * pool hold disjoint records. Native collection capacity may change after
   * paint updates. Read its public capacity when the budget is dirty; ordinary
   * Primitive geometry was measured before Cesium released the input arrays.
   *
   * Live records are reported `pinned` (attached to the scene, never an
   * eviction target); only pooled retired records are evictable.
   */
  visitMemoryEntries(visit: MemoryBudgetVisitor): void {
    for (const [tileId, record] of this._records) {
      let bytes = 0;
      for (const collection of record.collections.values()) {
        bytes += collectionGpuBytes(collection);
      }
      visit(tileId, bytes, true);
    }
    for (const [tileId, entry] of this._retired.entries()) {
      let bytes = 0;
      for (const collection of entry.collections.values()) {
        bytes += collectionGpuBytes(collection);
      }
      visit(tileId, bytes);
    }
  }

  /** Return every Cesium collection currently owned by a tile. */
  getTileCollections(tileId: string): VectorCollection[] {
    const record = this._records.get(tileId);
    return record ? [...record.collections.values()] : [];
  }

  /** Query live owners without copying the publication/retirement snapshot. */
  someTileCollection(tileId: string, predicate: (collection: VectorCollection) => boolean): boolean {
    const record = this._records.get(tileId);
    if (record) {
      for (const collection of record.collections.values()) {
        if (predicate(collection))
          return true;
      }
    }
    return false;
  }

  /**
   * Replace a tile's registered collections with a build's first stage.
   * The line and point tracks may append after the fills are visible.
   */
  commitTileBuild(state: VectorTileBuildState): VectorCollection | null {
    const { tileId, buckets, tileID, skipLayerIds, result, entries, styleZoom, mode, styleRevision, lightRevision, generationId } = state;
    this.removeTile(tileId, entries.length > 0);
    if (entries.length === 0) {
      if (state.phase === 'done') {
        state.result = undefined;
      }
      state.standard = undefined;
      return null;
    }
    for (const [kind, collection] of entries) {
      this._registerDrawLayers(kind, collection, result!.linePrimitives, tileId);
    }
    this._records.set(tileId, {
      generationId,
      complete: state.phase === 'done',
      buckets,
      layerIds: result!.layerIds,
      paint: createVectorPaintState({
        buckets: state.paintBuckets,
        paintRevisions: state.paintRevisions,
        styleZoom,
        styleRevision,
        lightRevision,
        pixelRatio: this._pixelRatio,
        standard: !!state.standard,
      }),
      tileID,
      skipLayerIds,
      // Partial surfaces do not own unfinished lines. Complete records also
      // retain hidden line sources for later paint changes.
      linePrimitives: state.phase === 'done' || entries.some(([kind]) => kind === 'lines') ? result!.linePrimitives : [],
      dashRows: state.dashRows,
      collections: new Map(entries.map(([kind, collection]) => [kind, collection])),
      standard: state.standard,
      mode,
    });
    state.entries = [];
    if (state.phase === 'done') {
      state.standard = undefined;
      state.result = undefined;
    }
    this._paint.invalidate();
    return entries[0][1];
  }

  /** Transfer completed tracks while preserving the remaining build inputs. */
  appendTileBuild(state: VectorTileBuildState): VectorCollection[] {
    const record = this._records.get(state.tileId)!;
    const added = state.entries.map(([, collection]) => collection);
    for (const [kind, collection] of state.entries) {
      this._registerDrawLayers(kind, collection, state.result!.linePrimitives, state.tileId);
      record.collections.set(kind, collection);
    }
    record.complete = state.phase === 'done';
    if (record.complete || state.entries.some(([kind]) => kind === 'lines'))
      record.linePrimitives = state.result!.linePrimitives;
    // Newly appended owners may still carry construction paint while the
    // surface already received a feature-state or transition update.
    record.paint.styleCache = undefined;
    record.paint.lastStyleRevision = undefined;
    state.entries = [];
    if (record.complete) {
      state.standard = undefined;
      state.result = undefined;
    }
    this._paint.invalidate();
    return added;
  }

  removeTile(tileId: string, retainDrape = false): boolean {
    const record = this._records.get(tileId);
    if (record) {
      if (record.paint.lineBuild)
        discardLineBuild(record.paint.lineBuild);
      record.paint.lineBuild = undefined;
      for (const collection of record.collections.values()) {
        if (retainDrape && collection instanceof BufferPolygonCollection && this._isDraping()) {
          this._drapeHolds.add(collection);
        }
        else {
          this._undrape(this._vectorProvider, collection);
        }
      }
    }
    this._records.delete(tileId);
    for (const collection of this._takeRetiredCollections(tileId)) {
      collection.destroy();
    }
    return !!record;
  }

  /** Take a retired entry's collections, dropping the pool entry. */
  private _takeRetiredCollections(tileId: string): VectorCollection[] {
    const entry = this._retired.take(tileId);
    return entry ? [...entry.collections.values()] : [];
  }

  /**
   * Baked layer info for live and pooled tiles.
   */
  tileBuildLayers(tileId: string): { generationId: number; layerIds: readonly string[]; skipLayerIds: ReadonlySet<string> | undefined; complete: boolean; mode: SceneMode; frozen: boolean } | undefined {
    const record = this._records.get(tileId) ?? this._retired.get(tileId);
    return record ? { generationId: record.generationId, layerIds: record.layerIds, skipLayerIds: record.skipLayerIds, complete: record.complete, mode: record.mode, frozen: record.paint.frozen } : undefined;
  }

  /**
   * Evict retired entries whose baked content intersects a visibility flip:
   * restoring them would show pre-flip layers (the blanket removeAll path
   * destroyed them the same way). Live tiles are untouched — the tileset
   * re-publishes them while the old collections stay attached. `isExcluded`
   * marks layers the bucket track never bakes (image-pattern paints live on
   * the pattern track, so their flips must not evict bucket entries).
   */
  evictRetiredIntersectingLayers(
    flippedLayerIds: ReadonlySet<string>,
    isExcluded: (layerId: string) => boolean,
  ): Array<{ tileId: string; collections: VectorCollection[] }> {
    const evicted: Array<{ tileId: string; collections: VectorCollection[] }> = [];
    for (const [tileId, entry] of [...this._retired.entries()]) {
      const skip = entry.skipLayerIds;
      const stale = entry.layerIds.some(layerId => flippedLayerIds.has(layerId) && !skip?.has(layerId) && !isExcluded(layerId));
      if (!stale) {
        continue;
      }
      const collections = this.takeRetired(tileId);
      for (const collection of collections) {
        this._undrape(this._vectorProvider, collection);
      }
      evicted.push({ tileId, collections });
    }
    return evicted;
  }

  /** Keep Native lines and buildings alive while mode-specific tracks rebuild. */
  removeModeSpecificCollections(): VectorCollection[] {
    const removed: VectorCollection[] = [];
    for (const record of this._records.values()) {
      for (const [kind, collection] of record.collections) {
        if (kind === 'lines' || kind === 'extrusions')
          continue;
        this._undrape(this._vectorProvider, collection);
        record.collections.delete(kind);
        removed.push(collection);
      }
    }
    return removed;
  }

  /**
   * Drop every active and retired collection. Retired collections still own
   * GPU buffers, so they are returned for the caller to destroy (the active
   * ones were already handed over by the caller's own remove pass).
   */
  removeAll(): VectorCollection[] {
    this._paint.clearHeldPaint();
    this._undrapeAll(this._vectorProvider);
    for (const record of this._records.values()) {
      if (record.paint.lineBuild)
        discardLineBuild(record.paint.lineBuild);
      record.paint.lineBuild = undefined;
    }
    this._records.clear();
    const retired: VectorCollection[] = [];
    for (const entry of this._retired.values()) {
      retired.push(...entry.collections.values());
    }
    this._retired.clear();
    return retired;
  }

  /**
   * The maximum number of tiles whose collections are cached outside the
   * scene (see {@link retireTile}) before the least recently used one is
   * evicted. Each retired tile still holds its GPU buffers, so the bound
   * keeps memory in check while retaining enough tiles for pan-back reuse.
   */
  static readonly MAX_RETIRED_TILES = 64;

  private _retired = new RetiredPool<VectorTileRecord>(
    VectorTileRenderer.MAX_RETIRED_TILES,
  );

  /**
   * Move a tile's record from the live map to the retired pool.
   * Its style caches, ECEF results and collections stay alive, so a later
   * {@link restoreTile} re-attaches the same collections and skips the whole
   * publish pipeline. The LRU bound is enforced here; evicted collections are
   * returned for the caller to destroy.
   */
  retireTile(tileId: string, mode: SceneMode): VectorCollection[] {
    const record = this._records.get(tileId);
    if (!record) {
      return [];
    }
    if (record.paint.lineBuild)
      discardLineBuild(record.paint.lineBuild);
    record.paint.lineBuild = undefined;
    for (const collection of record.collections.values()) {
      // Retired collections leave the scene: drop them from the drape set
      // now rather than waiting for the provider's next-frame prune.
      this._undrape(this._vectorProvider, collection);
    }
    this._records.delete(tileId);
    // Held predecessors cannot become current again, even if a cancelled
    // mode change returns to their mode before the replacement commits.
    if (!record.complete || record.mode !== mode || record.paint.frozen) {
      return [...record.collections.values()];
    }
    // A replaced same-key entry is gone for good; the pool returns it for
    // release along with any capacity evictions.
    const evicted: VectorCollection[] = [];
    for (const gone of this._retired.retire(tileId, record)) {
      for (const collection of gone.value.collections.values()) {
        this._undrape(this._vectorProvider, collection);
      }
      evicted.push(...gone.value.collections.values());
    }
    return evicted;
  }

  /**
   * Rescale the retired pool from the renderable footprint (see
   * retiredPoolCapacity); shrinking past the new capacity evicts
   * oldest-first for destruction, grouped by tile for feature-index cleanup.
   */
  setRetiredCapacity(capacity: number): Array<{ tileId: string; collections: VectorCollection[] }> {
    const byTile = new Map<string, VectorCollection[]>();
    for (const gone of this._retired.setCapacity(capacity)) {
      const collections: VectorCollection[] = [];
      for (const collection of gone.value.collections.values()) {
        this._undrape(this._vectorProvider, collection);
        collections.push(collection);
      }
      byTile.set(gone.key, collections);
    }
    return [...byTile].map(([tileId, collections]) => ({ tileId, collections }));
  }

  /**
   * Re-attach a retired tile's collections. Returns true when the tile was
   * retired and is now active again; the caller must re-add the collections
   * to the scene. The next paint update refreshes its materials, since the
   * zoom may have moved while the tile was retired. A different mode leaves
   * the entry pooled until fresh publication or eviction releases it.
   */
  restoreTile(tileId: string, mode: SceneMode): boolean {
    const record = this._retired.get(tileId);
    if (record?.mode !== mode || record.paint.frozen) {
      return false;
    }
    const entry = this._retired.take(tileId);
    if (!entry) {
      return false;
    }
    this._records.set(tileId, entry);
    this._paint.invalidate();
    return true;
  }

  /** Restored resources receive current paint before residency shows them. */
  refreshTilePaint(tileId: string, frame: VectorPaintFrame): VectorPaintPreparation {
    return this._paint.refresh(tileId, this._records.get(tileId)!, frame);
  }

  /** Submit current paint for the owner about to upload or become visible. */
  refreshCollectionPaint(collection: object, frame: VectorPaintFrame): VectorPaintPreparation {
    const tileId = this._tileForCollection.get(collection);
    const record = tileId === undefined ? undefined : this._records.get(tileId);
    if (record && tileId !== undefined) {
      for (const current of record.collections.values()) {
        if (current === collection)
          return this._paint.refresh(tileId, record, frame);
      }
    }
    return { replacements: [], ready: true };
  }

  /**
   * Drop a retired tile's collections (e.g. the tile is being re-published
   * with fresh data). Returns the collections for the caller to destroy.
   */
  takeRetired(tileId: string): VectorCollection[] {
    const entry = this._retired.take(tileId);
    if (!entry) {
      return [];
    }
    return [...entry.collections.values()];
  }

  /**
   * Swaps a tile's Buffer collection for a freshly built one with the same
   * contents but a different blend option. The Buffer*Collection classes only
   * accept a blend option at construction, so a material alpha crossing the
   * opaque boundary requires a rebuild.
   */
  private _replaceCollection(
    tileId: string,
    kind: string,
    old: VectorCollection,
    replacement: VectorCollection,
    replacements: Array<{ tileId: string; old: VectorCollection; replacement: VectorCollection }>,
  ): void {
    const record = this._records.get(tileId);
    if (!record) {
      return;
    }
    if (record.collections.get(kind) === old) {
      this._registerDrawLayers(kind, replacement, record.linePrimitives, tileId);
      record.collections.set(kind, replacement);
      // The scene keeps the old collection visible until the replacement's
      // first GPU update. Continue marking its drape until that handoff.
      if (old instanceof BufferPolygonCollection && this._isDraping()) {
        this._drapeHolds.add(old);
      }
      replacements.push({ tileId, old, replacement });
    }
  }

  private _registerDrawLayers(kind: string, collection: VectorCollection, linePrimitives: TileRenderResult['linePrimitives'], tileId: string): void {
    this._tileForCollection.set(collection, tileId);
    if (kind === 'lines') {
      registerDrawLayers(collection, linePrimitives.map(line => line.layerId));
    }
    else if (collection instanceof CesiumPrimitiveCollection) {
      const layers = new Set<string>();
      for (let index = 0; index < collection.length; index++) {
        for (const layer of drawLayersForOwner(collection.get(index))) {
          layers.add(layer);
        }
      }
      registerDrawLayers(collection, layers);
    }
  }
}
