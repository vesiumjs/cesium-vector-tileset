import type { SceneMode } from 'cesium';
import type { FeatureIndex } from '../../data/feature-index';
import type { Tile } from '../../tile/tile';
import type { OverscaledTileID } from '../../tile/tile-id';
import type { PatternTileRenderer } from '../pattern/pattern-renderer';
import type { RasterTileRenderer } from '../raster/raster-renderer';
import type { SymbolTileRenderer } from '../symbol/symbol-renderer';
import type { VectorPaintFrame } from '../vector/vector-paint-updater';
import type { VectorTileRenderer } from '../vector/vector-tile-renderer';
import type { SceneCollection, SceneCollections } from './scene-collections';
import type { TilePublishQueue, TilePublishResult } from './tile-publish-queue';
import { compareTileId } from '../../tile/tile-id';
import { allDrawLayersHidden, drawLayersForOwner } from './draw-batch';
import { GpuMemoryBudget } from './gpu-memory-budget';

interface TileLookup {
  getTileByID: (id: string) => Tile | undefined;
  loaded: () => boolean;
}

interface SourceResidency {
  readonly pyramid: TileLookup;
  readonly renderableIds: readonly string[];
  readonly mode: SceneMode;
  held: Set<string>;
  readonly hydrated: Set<string>;
}

interface SceneTile {
  sourceId: string;
  tileID: OverscaledTileID;
  live: boolean;
  generationId?: number;
  featureIndex?: FeatureIndex;
  previousGenerationId?: number;
  previousFeatureIndex?: FeatureIndex;
  publicationStage?: TilePublishResult['stage'];
  /** A completed generation actually published drawable symbol resources. */
  hasSymbols?: boolean;
}

interface SourceReplacement {
  retained: Set<string>;
  staged: Set<string>;
  hiddenTiles: Set<string>;
  layerOrder: ReadonlyMap<string, number>;
}

const EMPTY_TILES: ReadonlySet<string> = new Set();

export interface TileResidencyOptions {
  vector: VectorTileRenderer;
  raster: RasterTileRenderer;
  pattern: PatternTileRenderer;
  symbol: SymbolTileRenderer;
  publishQueue: TilePublishQueue;
  scene: SceneCollections;
  fadeDuration: () => number;
  paintFrame: () => VectorPaintFrame;
}

function renderTileId(sourceId: string, tileKey: string): string {
  return `${sourceId}/${tileKey}`;
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size)
    return false;
  for (const value of a) {
    if (!b.has(value))
      return false;
  }
  return true;
}

/** Owns the scene residency and replacement hold of tiles across all render tracks. */
export class TileResidency {
  private readonly _paintFrame: () => VectorPaintFrame;
  private readonly _sources = new Map<string, SourceResidency>();
  private readonly _requiredSurfaceParents = new WeakMap<SourceResidency, readonly string[]>();
  private readonly _replacingSources = new Set<string>();
  private _sourceReplacement?: SourceReplacement;
  private readonly _tiles = new Map<string, SceneTile>();
  private readonly _pendingFeatureIndexRelease = new Set<string>();
  private _drawRanks?: ReadonlyMap<string, number>;
  private _visibility = {
    hiddenLayers: new Map<string, ReadonlySet<string>>(),
    hiddenSymbols: new Set<string>(),
  };

  private _lastRetiredCapacity = -1;
  private _gpuMemoryBudget = new GpuMemoryBudget();
  private readonly _vectorRenderer: VectorTileRenderer;
  private readonly _rasterRenderer: RasterTileRenderer;
  private readonly _patternRenderer: PatternTileRenderer;
  private readonly _symbolRenderer: SymbolTileRenderer;
  private readonly _tilePublishQueue: TilePublishQueue;
  private readonly _sceneCollections: SceneCollections;
  private readonly _fadeDuration: () => number;

  constructor(options: TileResidencyOptions) {
    this._paintFrame = options.paintFrame;
    this._vectorRenderer = options.vector;
    this._rasterRenderer = options.raster;
    this._patternRenderer = options.pattern;
    this._symbolRenderer = options.symbol;
    this._tilePublishQueue = options.publishQueue;
    this._sceneCollections = options.scene;
    this._fadeDuration = options.fadeDuration;
  }

  clear(): void {
    this.resetSourceState();
    this._replacingSources.clear();
    this._sourceReplacement = undefined;
    this._tiles.clear();
    this._pendingFeatureIndexRelease.clear();
    this._drawRanks = undefined;
  }

  resetSourceState(): void {
    for (const tileId of this._visibility.hiddenLayers.keys()) {
      this._setHiddenSurfaceLayers(tileId, undefined);
    }
    for (const tileId of this._visibility.hiddenSymbols) {
      this._setTileSymbolVisible(tileId, true);
    }
    const visible = { hiddenLayers: new Map<string, ReadonlySet<string>>(), hiddenSymbols: new Set<string>() };
    this._sceneCollections.syncTileVisibility(visible, this._visibility);
    this._visibility = visible;
    this._sources.clear();
  }

  /** Preserve the old source coverage while its replacement loads and uploads. */
  beginSourceReplacement(sourceId: string): void {
    this._replacingSources.add(sourceId);
  }

  /** Keep the visible style while newly named sources load their replacements. */
  reconcileSources(sourceIds: ReadonlySet<string>, addedSourceIds: ReadonlySet<string> = EMPTY_TILES, layerOrder: ReadonlyMap<string, number> = new Map()): void {
    let replacement = this._sourceReplacement;
    if (sourceIds.size === 0) {
      replacement = undefined;
    }
    else if (!replacement && addedSourceIds.size > 0) {
      replacement = { retained: new Set(), staged: new Set(), hiddenTiles: new Set(), layerOrder };
    }
    const revived = new Set<string>();
    if (replacement) {
      for (const sourceId of replacement.retained) {
        if (sourceIds.has(sourceId)) {
          revived.add(sourceId);
          replacement.retained.delete(sourceId);
          this.beginSourceReplacement(sourceId);
        }
      }
    }
    for (const [tileId, tile] of this._tiles) {
      if (sourceIds.has(tile.sourceId)) {
        continue;
      }
      if (replacement && tile.live && !replacement.staged.has(tile.sourceId)) {
        replacement.retained.add(tile.sourceId);
        continue;
      }
      this._removeSourceTile(tileId, tile.sourceId);
    }
    if (replacement?.retained.size) {
      for (const sourceId of addedSourceIds) {
        if (!revived.has(sourceId))
          replacement.staged.add(sourceId);
      }
      for (const sourceId of replacement.staged) {
        if (!sourceIds.has(sourceId))
          replacement.staged.delete(sourceId);
      }
      replacement.hiddenTiles = new Set([...this._tiles].filter(([, tile]) => replacement.staged.has(tile.sourceId)).map(([tileId]) => tileId));
      this._sourceReplacement = replacement;
    }
    else {
      this._sourceReplacement = undefined;
    }
    this._drawRanks = undefined;
  }

  get hiddenStyleTiles(): ReadonlySet<string> {
    return this._sourceReplacement?.hiddenTiles ?? EMPTY_TILES;
  }

  get retainedLayerOrder(): ReadonlyMap<string, number> | undefined {
    return this._sourceReplacement?.layerOrder;
  }

  /** Called after rendering the last old-style frame once all current uploads settle. */
  completeSourceReplacement(): boolean {
    const replacement = this._sourceReplacement;
    if (!replacement)
      return false;
    this._sourceReplacement = undefined;
    for (const [tileId, tile] of this._tiles) {
      if (replacement.retained.has(tile.sourceId))
        this._removeSourceTile(tileId, tile.sourceId);
    }
    this._drawRanks = undefined;
    return true;
  }

  private _removeSourceTile(tileId: string, sourceId: string): void {
    for (const collection of this._vectorRenderer.getTileCollections(tileId)) {
      this._sceneCollections.detachForDestruction(collection);
    }
    this._vectorRenderer.removeTile(tileId);
    this._sceneCollections.queueSymbolRemoval(this._symbolRenderer.removeTile(tileId));
    this._sceneCollections.applyPatternUpdate(this._patternRenderer.removeTile(tileId));
    this._sceneCollections.applyRasterUpdate(this._rasterRenderer.removeTile(tileId));
    this._tiles.delete(tileId);
    this._pendingFeatureIndexRelease.delete(tileId);
    this._visibility.hiddenSymbols.delete(tileId);
    this._visibility.hiddenLayers.delete(tileId);
    this._sources.delete(sourceId);
    this._replacingSources.delete(sourceId);
  }

  published(sourceId: string, tileID: OverscaledTileID): void {
    const tileId = renderTileId(sourceId, tileID.key);
    if (this._sourceReplacement?.staged.has(sourceId))
      this._sourceReplacement.hiddenTiles.add(tileId);
    const previous = this._tiles.get(tileId);
    if (!previous?.live || previous.tileID.key !== tileID.key) {
      this._drawRanks = undefined;
    }
    this._tiles.set(tileId, {
      sourceId,
      tileID,
      live: true,
      generationId: previous?.generationId,
      featureIndex: previous?.featureIndex,
      previousGenerationId: previous?.previousGenerationId,
      previousFeatureIndex: previous?.previousFeatureIndex,
      publicationStage: previous?.publicationStage,
      hasSymbols: previous?.hasSymbols,
    });
  }

  get drawRanks(): ReadonlyMap<string, number> {
    if (!this._drawRanks) {
      const tiles = [...this._tiles].filter(([, tile]) => tile.live);
      tiles.sort((a, b) => a[1].sourceId.localeCompare(b[1].sourceId)
        || compareTileId(a[1].tileID, b[1].tileID));
      this._drawRanks = new Map(tiles.map(([tileId], rank) => [tileId, rank]));
    }
    return this._drawRanks;
  }

  commit(result: TilePublishResult): void {
    this.published(result.sourceId, result.tileID);
    this._sources.get(result.sourceId)?.hydrated.add(result.tileID.key);
    this._sceneCollections.applyPublication(result);
    this._setFeatureIndex(result);
  }

  private _setFeatureIndex(result: TilePublishResult): void {
    const tile = this._tiles.get(result.tileId);
    if (tile) {
      tile.publicationStage = result.stage;
      if (result.stage === 'complete') {
        tile.hasSymbols = this._symbolRenderer.getTileCollections(result.tileId).length > 0;
      }
      if (result.retainPreviousGeneration || this._sceneCollections.hasPendingReplacement(result.tileId)) {
        // A vector stage may be superseded before symbols finish. Keep the
        // oldest generation, which is the one still visible in the scene.
        if (tile.previousGenerationId === undefined) {
          tile.previousGenerationId = tile.generationId;
          tile.previousFeatureIndex = tile.featureIndex;
        }
      }
      else {
        tile.previousGenerationId = undefined;
        tile.previousFeatureIndex = undefined;
      }
      tile.generationId = result.generationId;
      tile.featureIndex = result.featureIndex;
      if (tile.previousGenerationId === undefined) {
        this._pendingFeatureIndexRelease.delete(result.tileId);
      }
      else {
        this._pendingFeatureIndexRelease.add(result.tileId);
      }
    }
  }

  private _clearFeatureIndex(tileId: string): void {
    const tile = this._tiles.get(tileId);
    if (tile) {
      tile.generationId = undefined;
      tile.featureIndex = undefined;
      tile.previousGenerationId = undefined;
      tile.previousFeatureIndex = undefined;
      this._pendingFeatureIndexRelease.delete(tileId);
    }
  }

  featureIndex(tileId: string, generationId: number): FeatureIndex | undefined {
    const tile = this._tiles.get(tileId);
    if (tile?.generationId === generationId) {
      return tile.featureIndex;
    }
    return tile?.previousGenerationId === generationId ? tile.previousFeatureIndex : undefined;
  }

  releaseReplacedFeatureIndices(): void {
    for (const tileId of this._pendingFeatureIndexRelease) {
      if (this._tilePublishQueue.has(tileId) || this._sceneCollections.hasPendingReplacement(tileId)) {
        continue;
      }
      const tile = this._tiles.get(tileId);
      if (tile) {
        tile.previousGenerationId = undefined;
        tile.previousFeatureIndex = undefined;
      }
      this._pendingFeatureIndexRelease.delete(tileId);
    }
  }

  private _hasDrawable(tileId: string): boolean {
    return this._sceneCollections.someDrawableCollection(tileId, 'vector', predicate => this._someSurfaces(tileId, predicate), () => true)
      || this._sceneCollections.someDrawableCollection(tileId, 'symbol', predicate => this._symbolRenderer.getTileCollections(tileId).some(predicate), () => true);
  }

  private _someSurfaces(tileId: string, predicate: (collection: SceneCollection) => boolean): boolean {
    return this._vectorRenderer.someTileCollection(tileId, predicate)
      || this._patternRenderer.someTilePrimitive(tileId, predicate)
      || this._rasterRenderer.someTilePrimitive(tileId, predicate);
  }

  get featureIndexCount(): number {
    let count = 0;
    for (const tile of this._tiles.values()) {
      if (tile.featureIndex) {
        count++;
      }
    }
    return count;
  }

  /** Reconcile one source after TilePyramid chooses its renderable pyramid. */
  syncSource(sourceId: string, tilePyramid: TileLookup, renderableIds: readonly string[], mode: SceneMode): boolean {
    const previous = this._sources.get(sourceId);
    const modeChanged = previous?.mode !== mode;
    const renderableChanged = previous?.pyramid !== tilePyramid || previous?.renderableIds !== renderableIds || modeChanged;
    if (!renderableChanged && previous?.held.size === 0 && this._tilePublishQueue.size === 0 && !this._replacingSources.has(sourceId)) {
      return false;
    }
    // Cache hits may have tile data without scene collections or a publish job.
    // Restore or enqueue new renderables before their old coverage can retire.
    // A mode change keeps the keys but invalidates their hydrated geometry.
    const hydrated = renderableChanged
      ? this._syncHydratedTiles(sourceId, tilePyramid, renderableIds, mode, modeChanged ? undefined : previous?.hydrated)
      : previous!.hydrated;
    const held = this.heldReplacementTiles(sourceId, tilePyramid, renderableIds);
    if (this._replacingSources.has(sourceId)) {
      const ready = tilePyramid.loaded() && renderableIds.every((key) => {
        const id = renderTileId(sourceId, key);
        return !this._tilePublishQueue.has(id) && this._surfacesReady(id) && this._symbolsReady(id);
      });
      if (ready) {
        this._replacingSources.delete(sourceId);
      }
      else {
        const inView = new Set(renderableIds.map(key => renderTileId(sourceId, key)));
        for (const [tileId, tile] of this._tiles) {
          if (tile.sourceId === sourceId && tile.live && !inView.has(tileId)) {
            held.add(tileId);
          }
        }
      }
    }
    const heldChanged = !sameStringSet(previous?.held ?? EMPTY_TILES, held);
    if (renderableChanged || heldChanged) {
      this._syncCollections(sourceId, renderableIds, held, mode);
      if (renderableChanged) {
        this._sources.set(sourceId, { pyramid: tilePyramid, renderableIds, mode, held, hydrated });
      }
      else {
        previous!.held = held;
      }
    }
    return renderableChanged || heldChanged;
  }

  setMemoryBudgetBytes(bytes: number): void {
    this._gpuMemoryBudget.setMaxBytes(bytes);
  }

  memoryStats(): ReturnType<GpuMemoryBudget['stats']> {
    return this._gpuMemoryBudget.stats();
  }

  /** Follow the data caches' viewport capacity, independent of transient LOD selection. */
  syncRetiredCapacity(dataCacheCapacity: number): void {
    const capacity = Math.min(Math.max(dataCacheCapacity, 1), 256);
    if (capacity === this._lastRetiredCapacity) {
      return;
    }
    this._lastRetiredCapacity = capacity;
    for (const { tileId, collections } of this._vectorRenderer.setRetiredCapacity(capacity)) {
      for (const collection of collections) {
        this._sceneCollections.deferDestroy(collection);
      }
      this._clearFeatureIndex(tileId);
    }
    this._sceneCollections.queueSymbolRemoval(this._symbolRenderer.setRetiredCapacity(capacity));
    this._sceneCollections.applyPatternUpdate(this._patternRenderer.setRetiredCapacity(capacity));
  }

  /** Evict retired resources when the resident footprint exceeds the budget. */
  syncMemoryBudget(): void {
    const evictedEntries = this._gpuMemoryBudget.update((visit) => {
      this._vectorRenderer.visitMemoryEntries((key, bytes, pinned) => visit(`vector/${key}`, bytes, pinned));
      this._symbolRenderer.visitMemoryEntries((key, bytes, pinned) => visit(`symbol/${key}`, bytes, pinned));
      this._patternRenderer.visitMemoryEntries((key, bytes, pinned) => visit(`pattern/${key}`, bytes, pinned));
      this._rasterRenderer.visitMemoryEntries((key, bytes, pinned) => visit(`raster/${key}`, bytes, pinned));
    });
    for (const evicted of evictedEntries) {
      const slash = evicted.indexOf('/');
      const track = evicted.slice(0, slash);
      const tileId = evicted.slice(slash + 1);
      if (track === 'vector') {
        const taken = this._vectorRenderer.takeRetired(tileId);
        if (taken.length > 0) {
          for (const collection of taken) {
            this._sceneCollections.deferDestroy(collection);
          }
          this._clearFeatureIndex(tileId);
        }
      }
      else if (track === 'symbol') {
        this._sceneCollections.queueSymbolRemoval(this._symbolRenderer.removeTile(tileId));
      }
      else if (track === 'pattern') {
        this._sceneCollections.applyPatternUpdate(this._patternRenderer.removeTile(tileId));
      }
    }
    // Renderer caches decide which retired resources survive. A scene tile
    // record only survives while at least one track still owns its resources.
    for (const [tileId, tile] of this._tiles) {
      if (!tile.live && !this._gpuMemoryBudget.has(`vector/${tileId}`)
        && !this._gpuMemoryBudget.has(`symbol/${tileId}`)
        && !this._gpuMemoryBudget.has(`pattern/${tileId}`)
        && !this._gpuMemoryBudget.has(`raster/${tileId}`)) {
        this._tiles.delete(tileId);
      }
    }
  }

  private _syncCollections(sourceId: string, renderableIds: readonly string[], held: Set<string>, mode: SceneMode): void {
    const inView = new Set(renderableIds.map(tileId => renderTileId(sourceId, tileId)));
    for (const [tileId, tile] of this._tiles) {
      if (tile.sourceId !== sourceId) {
        continue;
      }
      this._symbolRenderer.setTilePlacementEligible(tileId, !held.has(tileId));
      if (!tile.live || inView.has(tileId) || held.has(tileId)) {
        continue;
      }
      tile.live = false;
      this._drawRanks = undefined;
      const collections = this._vectorRenderer.getTileCollections(tileId);
      const evictedVector = this._vectorRenderer.retireTile(tileId, mode);
      for (const collection of collections) {
        collection.show = false;
        this._sceneCollections.detach(collection);
      }
      for (const collection of evictedVector) {
        this._sceneCollections.deferDestroy(collection);
      }
      this._sceneCollections.applyRasterUpdate(this._rasterRenderer.removeTile(tileId));
      this._sceneCollections.applyPatternUpdate(this._patternRenderer.retireTile(tileId));
      const { retired, fading, evicted } = this._symbolRenderer.retireTile(tileId, this._fadeDuration());
      for (const collection of retired) {
        collection.show = false;
        this._sceneCollections.detach(collection);
      }
      for (const collection of fading) {
        collection.show = true;
      }
      this._sceneCollections.queueSymbolRemoval(evicted);
    }
    this._tilePublishQueue.cancelPatternRefreshesOutside(sourceId, new Set([...inView, ...held]));
  }

  get hiddenSurfaceLayers(): ReadonlyMap<string, ReadonlySet<string>> {
    return this._visibility.hiddenLayers;
  }

  private _surfaceLayers(tileId: string, hidden: ReadonlySet<string> | undefined): Set<string> {
    const layers = new Set<string>();
    this._sceneCollections.someDrawableCollection(tileId, 'vector', predicate => this._vectorRenderer.someTileCollection(tileId, predicate)
      || this._patternRenderer.someTilePrimitive(tileId, predicate), (collection) => {
      for (const layer of drawLayersForOwner(collection)) {
        if (!hidden?.has(layer))
          layers.add(layer);
      }
      return false;
    });
    return layers;
  }

  private _setHiddenSurfaceLayers(tileId: string, hidden: ReadonlySet<string> | undefined): void {
    this._vectorRenderer.someTileCollection(tileId, (collection) => {
      collection.show = !allDrawLayersHidden(collection, hidden);
      return false;
    });
    let hasPattern = false;
    const visible = this._patternRenderer.someTilePrimitive(tileId, (primitive) => {
      hasPattern = true;
      return !allDrawLayersHidden(primitive, hidden);
    });
    this._patternRenderer.setTileVisible(tileId, !hasPattern || visible);
  }

  private _setTileSymbolVisible(tileId: string, visible: boolean): void {
    for (const collection of this._symbolRenderer.getTileCollections(tileId)) {
      collection.show = visible;
    }
  }

  private _renderableSurfaceParents(sourceId: string, sync: SourceResidency): readonly string[] {
    const cached = this._requiredSurfaceParents.get(sync);
    if (cached) {
      return cached;
    }
    const renderable = new Set(sync.renderableIds);
    const parents = new Set<string>();
    for (const key of sync.renderableIds) {
      const id = sync.pyramid.getTileByID(key)?.tileID;
      if (!id) {
        continue;
      }
      for (let zoom = id.overscaledZ - 1; zoom >= 0; zoom--) {
        const parent = id.calculateScaledKey(zoom, true);
        if (renderable.has(parent)) {
          parents.add(renderTileId(sourceId, parent));
        }
      }
    }
    const result = [...parents];
    this._requiredSurfaceParents.set(sync, result);
    return result;
  }

  /** Switch overlapping surfaces together; labels have independent holds. */
  syncHeldTileVisibility(): boolean {
    let changed = false;
    // Placement and first uploads finish after the source's initial sync.
    // Release ready holds before drawing, including the last requested frame.
    for (const [sourceId, sync] of this._sources) {
      if (sync.held.size > 0) {
        changed = this.syncSource(sourceId, sync.pyramid, sync.renderableIds, sync.mode) || changed;
      }
    }
    const hiddenSymbols = new Set<string>();
    const hiddenLayers = new Map<string, Set<string>>();
    const hideLayers = (tileId: string, layers: ReadonlySet<string>): void => {
      let hidden = hiddenLayers.get(tileId);
      if (!hidden) {
        hidden = new Set();
        hiddenLayers.set(tileId, hidden);
      }
      for (const layer of layers) {
        hidden.add(layer);
      }
    };
    for (const [sourceId, sync] of this._sources) {
      const requiredParents = this._renderableSurfaceParents(sourceId, sync);
      if ((sync.held.size === 0 && requiredParents.length === 0) || this._replacingSources.has(sourceId)) {
        continue;
      }
      const tilePyramid = sync.pyramid;
      const renderableIds = new Set(sync.renderableIds);
      const replacements = sync.renderableIds.flatMap((tileKey) => {
        const tile = tilePyramid.getTileByID(tileKey);
        const tileId = renderTileId(sourceId, tileKey);
        if (!tile || Object.keys(tile.buckets).length === 0) {
          return [];
        }
        return [{ tileId, tileID: tile.tileID, surfaceReady: this._surfacesReady(tileId) }];
      });
      const surfaceGates = [...new Set([...sync.held, ...requiredParents])].flatMap((tileId) => {
        const tile = this._tiles.get(tileId);
        return tile?.live ? [{ tileId, tileID: tile.tileID }] : [];
      }).sort((a, b) => a.tileID.overscaledZ - b.tileID.overscaledZ);
      for (const { tileId, tileID: heldID } of surfaceGates) {
        if (!this._hasDrawable(tileId)) {
          continue;
        }
        // A newly required ancestor cannot mask its ready descendants while
        // its own surface is still publishing or uploading. Held predecessors
        // retain their existing coverage until the successor is ready.
        if (!sync.held.has(tileId) && !this._surfacesReady(tileId)) {
          continue;
        }
        const covering = replacements.filter(({ tileID }) => tileID.isChildOf(heldID) || heldID.isChildOf(tileID));
        const surfacesReady = covering.length > 0 && covering.every(replacement => replacement.surfaceReady);
        // An active coarser owner already gates this layer. A masked finer
        // gate cannot hide that owner in return, but can own its new layers.
        const ownedLayers = this._surfaceLayers(tileId, hiddenLayers.get(tileId));
        const hasSurfaces = ownedLayers.size > 0;
        // TilePyramid retains a parent in this set when ready descendants
        // cover only part of it. Those descendants cannot retire its surface.
        const replaceSurfaces = hasSurfaces && surfacesReady && !renderableIds.has(heldID.key);
        if (replaceSurfaces) {
          hideLayers(tileId, ownedLayers);
        }
        for (const { tileId: replacementId } of covering) {
          if (sync.held.has(tileId)) {
            hiddenSymbols.add(replacementId);
          }
          if (hasSurfaces && !replaceSurfaces) {
            hideLayers(replacementId, ownedLayers);
          }
        }
        if (hasSurfaces && !replaceSurfaces) {
          // Held descendants can already be absent from the renderable set.
          // They share this owner's layers and must not mask it in return.
          for (const gate of surfaceGates) {
            if (gate.tileID.isChildOf(heldID)) {
              hideLayers(gate.tileId, ownedLayers);
            }
          }
        }
      }
    }
    for (const tileId of this._visibility.hiddenLayers.keys()) {
      if (!hiddenLayers.has(tileId)) {
        this._setHiddenSurfaceLayers(tileId, undefined);
      }
    }
    for (const tileId of this._visibility.hiddenSymbols) {
      if (!hiddenSymbols.has(tileId)) {
        this._setTileSymbolVisible(tileId, true);
      }
    }
    for (const [tileId, layers] of hiddenLayers) {
      this._setHiddenSurfaceLayers(tileId, layers);
    }
    for (const tileId of hiddenSymbols) {
      this._setTileSymbolVisible(tileId, false);
    }
    const visibility = { hiddenLayers, hiddenSymbols };
    this._sceneCollections.syncTileVisibility(visibility, this._visibility);
    this._visibility = visibility;
    return changed;
  }

  private _surfacesReady(tileId: string): boolean {
    if (this._tilePublishQueue.hasPendingSurfaces(tileId))
      return false;
    let hasSurface = false;
    const pending = this._someSurfaces(tileId, (collection) => {
      hasSurface = true;
      return this._sceneCollections.hasPendingFirstUpdate(collection);
    });
    return !pending && (hasSurface || !this._tilePublishQueue.has(tileId));
  }

  private _symbolsReady(tileId: string): boolean {
    const symbols = this._symbolRenderer.getTileCollections(tileId);
    return symbols.length > 0
      ? this._symbolRenderer.isTilePlaced(tileId)
      && !symbols.some(collection => this._sceneCollections.hasPendingFirstUpdate(collection))
      : !this._tilePublishQueue.has(tileId);
  }

  /**
   * Tiles leaving the renderable set that must stay visible until their
   * replacement is scene-ready. TilePyramid drops a replaced tile as soon as
   * the replacement has *data*, but the replacement's primitives arrive
   * frames later through the publish queue (MapLibre uploads synchronously
   * in the same frame, so it never sees this gap). A leaving tile is held
   * while a renderable tile covering it in either direction (child on
   * zoom-in, parent on zoom-out) carries vector buckets, has no vector
   * collections ready for the scene yet: either its publish job is in flight
   * or its new vector or symbol collections still need their first GPU update.
   * A settled collection-less replacement blocks nothing.
   * The hold re-evaluates from the current renderable set on every sync, so
   * it releases as soon as the replacement commits, the replacement leaves,
   * or nothing covers the tile anymore (pan-away): no timers, no extra
   * state, nothing to leak.
   *
   * The leaving tile is resolved through the scene record, not TilePyramid:
   * `tilePyramid.update()` has already purged its data tile at this point.
   */
  heldReplacementTiles(sourceId: string, tilePyramid: {
    getTileByID: (id: string) => Tile | undefined;
  }, renderableIds: readonly string[]): Set<string> {
    const held = new Set<string>();
    const unready: Array<Tile['tileID']> = [];
    for (const replacementKey of renderableIds) {
      const replacement = tilePyramid.getTileByID(replacementKey);
      if (!replacement || Object.keys(replacement.buckets).length === 0) {
        continue;
      }
      const replacementId = renderTileId(sourceId, replacementKey);
      if (this._surfacesReady(replacementId) && this._symbolsReady(replacementId)) {
        continue;
      }
      unready.push(replacement.tileID);
    }
    if (unready.length === 0) {
      return held;
    }
    for (const [tileId, tile] of this._tiles) {
      if (tile.sourceId !== sourceId || !tile.live) {
        continue;
      }
      const leavingID = tile.tileID;
      for (const replacementID of unready) {
        if (replacementID.isChildOf(leavingID) || leavingID.isChildOf(replacementID)) {
          if (this._hasDrawable(tileId))
            held.add(tileId);
          break;
        }
      }
    }
    return held;
  }

  /**
   * Publish vector buckets of renderable tiles that have data but no Cesium
   * collections. Tiles returning from the out-of-view cache reuse their Tile
   * object without emitting a data event, so the cache-hit path would
   * otherwise leave them blank until the next reload or style change.
   */
  private _syncHydratedTiles(sourceId: string, tilePyramid: {
    getTileByID: (id: string) => Tile | undefined;
  }, renderableIds: readonly string[], mode: SceneMode, previousHydrated?: Set<string>): Set<string> {
    const hydrated = previousHydrated ?? new Set<string>();
    if (previousHydrated && hydrated.size > 0) {
      const renderable = new Set(renderableIds);
      for (const tileKey of hydrated) {
        if (!renderable.has(tileKey)) {
          hydrated.delete(tileKey);
        }
      }
    }
    for (const tileKey of renderableIds) {
      if (hydrated.has(tileKey)) {
        continue;
      }
      const tile = tilePyramid.getTileByID(tileKey);
      // Raster texture tiles are published by _syncRasterTiles; only buckets
      // need the vector hydration pass.
      if (!tile || Object.keys(tile.buckets).length === 0) {
        continue;
      }
      const tileId = renderTileId(sourceId, tileKey);
      if (this._tilePublishQueue.has(tileId)) {
        hydrated.add(tileKey);
        continue;
      }
      // Symbol and pattern tracks pool retired tiles the same way as the
      // vector track below. A pending publish job covers the tile (it
      // rebuilds through finalize); otherwise restore re-attaches without
      // rebuilding. A tile fading out cancels back to live (its collections
      // never left the scene); stale fading entries go out for destruction
      // and must rebuild instead of hydrating through the vector restore
      // below. Buckets identity gates staleness for symbol (no per-frame
      // revalidation path); pattern revalidates through the begin fast
      // paths on the next _syncPatternTiles.
      let symbolStale = false;
      let restoredOther = false;
      const cancelled = this._symbolRenderer.cancelFade(tileId, tile.buckets);
      restoredOther = cancelled?.live ?? false;
      if (cancelled && !cancelled.live) {
        for (const collection of cancelled.collections) {
          this._sceneCollections.detach(collection);
        }
        this._sceneCollections.queueSymbolRemoval(cancelled.collections);
        symbolStale = true;
      }
      const restoredSymbol = this._symbolRenderer.restoreTile(tileId, tile.buckets);
      if (restoredSymbol) {
        restoredOther = true;
        for (const collection of restoredSymbol) {
          collection.show = true;
          this._sceneCollections.add(collection);
        }
      }
      restoredOther = this._patternRenderer.restoreTile(tileId) || restoredOther;
      // A tile retired by _syncCollections keeps its collections cached; re-
      // attaching them skips the publish pipeline entirely (no ECEF, no style
      // evaluation, no collection build). Old-mode live geometry remains
      // visible during handoff but cannot satisfy the current build.
      const build = this._vectorRenderer.getTileCollections(tileId).length > 0
        ? this._vectorRenderer.tileBuildLayers(tileId)
        : undefined;
      const hasVector = build?.mode === mode && !build.frozen;
      const restoredVector = !symbolStale && (hasVector || this._vectorRenderer.restoreTile(tileId, mode));
      if (restoredVector) {
        const paint = hasVector ? { replacements: [], ready: true } : this._vectorRenderer.refreshTilePaint(tileId, this._paintFrame());
        for (const { old, replacement } of paint.replacements) {
          this._sceneCollections.replaceWhenReady(tileId, old, replacement);
        }
        const collections = this._vectorRenderer.getTileCollections(tileId);
        if (!hasVector && (!paint.ready || paint.replacements.length > 0)) {
          this._sceneCollections.restoreWhenReady(tileId, collections);
        }
        else {
          for (const collection of collections) {
            collection.show = true;
            this._sceneCollections.add(collection);
          }
        }
        hydrated.add(tileKey);
        this.published(sourceId, tile.tileID);
        const record = this._tiles.get(tileId)!;
        // Symbol resources retire independently of vector geometry. A cache
        // miss invalidates only a detail stage that actually drew symbols.
        if (record.publicationStage === 'complete' && record.hasSymbols
          && this._symbolRenderer.getTileCollections(tileId).length === 0) {
          record.publicationStage = 'vector';
        }
        // Cached vector completion says nothing about its later publication
        // stages. Resume cancelled details within the same generation;
        // only an unfinished vector stage needs full conversion again.
        if (record.publicationStage === 'surface') {
          this._tilePublishQueue.enqueue(sourceId, tile);
        }
        else if (record.publicationStage === 'vector') {
          this._tilePublishQueue.enqueueDetails(sourceId, tile, record.generationId!);
        }
        continue;
      }
      // Publishing here would run the ECEF/tessellation pipeline for every
      // newly renderable tile inside one frame (the pan peak). Enqueue
      // instead: TilePublishQueue spreads the builds across frames within
      // its per-frame budget. Marking hydrated now is safe — the diff above
      // re-queues a tile whose key leaves the renderable set before publish.
      this._tilePublishQueue.enqueue(sourceId, tile);
      if (restoredOther) {
        this.published(sourceId, tile.tileID);
      }
      hydrated.add(tileKey);
    }
    return hydrated;
  }
}
