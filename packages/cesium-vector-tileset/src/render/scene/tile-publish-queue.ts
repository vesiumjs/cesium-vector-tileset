import type { Cartographic, PrimitiveCollection, SceneMode } from 'cesium';
import type { Style } from '../../style/style';
import type { RasterStyleLayer } from '../../style/style-layer/raster-style-layer';
import type { SymbolStyleLayer } from '../../style/style-layer/symbol-style-layer';
import type { Tile } from '../../tile/tile';
import type { PatternStyleLayer } from '../pattern/pattern-layer';
import type { PatternBuildBegun, PatternBuildState, PatternTileRenderer, PatternTileUpdate } from '../pattern/pattern-renderer';
import type { RasterTileCoordinate } from '../raster/raster-geometry';
import type { RasterTileRenderer, RasterTileUpdate } from '../raster/raster-renderer';
import type { SymbolBuildState, SymbolTileRenderer } from '../symbol/symbol-renderer';
import type { VectorTileBuildState } from '../vector/vector-tile-builder';
import type { VectorCollection, VectorTileRenderer } from '../vector/vector-tile-renderer';
import type { Budget } from './frame-budget';
import { Math as CesiumMath } from 'cesium';
import { MercatorCoordinate } from '../../geo/mercator-coordinate';
import { isPatternStyleLayer } from '../pattern/pattern-layer';
import { tileZoomOf } from '../vector/vector-tile-builder';
import { MAX_LATITUDE } from './globe-covering';

type PublishPhase = 'surface' | 'surface-ready' | 'vector' | 'vector-ready' | 'pattern' | 'symbol' | 'commit';
type PublishStep = 'pending' | 'partial' | 'committed';

type TileData = Pick<Tile, 'tileID' | 'buckets' | 'textureData' | 'collisionBoxArray'
  | 'glyphAtlasImage' | 'imageAtlas' | 'dashRows' | 'latestFeatureIndex'>;

function snapshot(tile: Tile): TileData {
  return {
    tileID: tile.tileID,
    buckets: tile.buckets,
    textureData: tile.textureData,
    collisionBoxArray: tile.collisionBoxArray,
    glyphAtlasImage: tile.glyphAtlasImage,
    imageAtlas: tile.imageAtlas,
    dashRows: tile.dashRows,
    latestFeatureIndex: tile.latestFeatureIndex,
  };
}

function prioritize<T>(jobs: Iterable<T>, tileID: (job: T) => Tile['tileID'], viewpoint?: MercatorCoordinate): T[] {
  const ordered = [...jobs];
  if (!viewpoint || ordered.length < 2) {
    return ordered;
  }
  return ordered.map((job) => {
    const { canonical } = tileID(job);
    const scale = 2 ** canonical.z;
    // Choose the nearest world copy before measuring point-to-rectangle
    // distance; camera longitudes and tile wraps meet across the date line.
    const x = viewpoint.x + Math.round((canonical.x + 0.5) / scale - viewpoint.x);
    const dx = Math.max(canonical.x / scale - x, 0, x - (canonical.x + 1) / scale);
    const dy = Math.max(canonical.y / scale - viewpoint.y, 0, viewpoint.y - (canonical.y + 1) / scale);
    return { job, distance: dx * dx + dy * dy, zoom: canonical.z };
  }).sort((a, b) => a.distance - b.distance || b.zoom - a.zoom).map(entry => entry.job);
}

interface PublishJob {
  sourceId: string;
  tile: Tile;
  data: TileData;
  tileId: string;
  phase: PublishPhase;
  generationId?: number;
  excludedLayerIds?: Set<string>;
  patternLayers?: readonly PatternStyleLayer[];
  vectorBuild?: VectorTileBuildState;
  surfacePublished?: boolean;
  symbolBuild?: SymbolBuildState;
  restoreSymbol?: boolean;
  patternBuild?: PatternBuildBegun;
}

interface PatternRefreshJob {
  sourceId: string;
  tileID: Tile['tileID'];
  state: PatternBuildState;
}

export interface TilePublishResult {
  sourceId: string;
  tileId: string;
  tileID: Tile['tileID'];
  generationId: number;
  stage: 'surface' | 'vector' | 'complete';
  /** Keep picks from the still-visible old symbols until the detail stage swaps them. */
  retainPreviousGeneration: boolean;
  previousVector: readonly VectorCollection[];
  retiredVector: readonly VectorCollection[];
  addedVector: readonly VectorCollection[];
  raster: RasterTileUpdate;
  removedSymbols: readonly PrimitiveCollection[];
  addedSymbols: readonly PrimitiveCollection[];
  firstUpdateSymbols: readonly PrimitiveCollection[];
  retainedSymbols?: { collections: readonly PrimitiveCollection[]; release: () => void };
  retainedSurfaces?: Array<NonNullable<PatternTileUpdate['retained']>>;
  featureIndex: Tile['latestFeatureIndex'];
}

/** Scene and style inputs that a publication needs, supplied by the tileset. */
export interface TilePublishOptions {
  vector: VectorTileRenderer;
  raster: RasterTileRenderer;
  symbol: SymbolTileRenderer;
  pattern: PatternTileRenderer;
  style: () => Style;
  styleZoom: () => number;
  lightRevision: () => number;
  sceneMode: () => SceneMode;
  layerOrder: () => ReadonlyMap<string, number>;
  symbolLayers: (sourceId: string) => readonly SymbolStyleLayer[];
  patternLayers: (sourceId: string) => readonly PatternStyleLayer[];
  rasterLayers: (sourceId: string) => readonly RasterStyleLayer[];
  rasterSource: (sourceId: string) => {
    dynamic: boolean;
    tileCoords?: readonly RasterTileCoordinate[];
    flippedWindingOrder?: boolean;
  };
  isRenderable: (sourceId: string, tileKey: string) => boolean;
  publish: (result: TilePublishResult) => void;
  publishPattern: (sourceId: string, tileID: Tile['tileID'], update?: PatternTileUpdate) => void;
  requestRender: () => void;
}

/**
 * Owns each in-flight tile and all detached renderer builds. A tile can be
 * discarded at any phase without disturbing published resources. Fills
 * publish first; lines and points append after their build completes.
 */
export class TilePublishQueue {
  private readonly _jobs = new Map<string, PublishJob>();
  private readonly _patternRefreshes = new Map<string, PatternRefreshJob>();
  private readonly _options: TilePublishOptions;

  constructor(options: TilePublishOptions) {
    this._options = options;
  }

  get size(): number {
    return this._jobs.size + this._patternRefreshes.size;
  }

  has(tileId: string): boolean {
    return this._jobs.has(tileId);
  }

  /** Vector detail and patterns finish before the independent symbol stage. */
  hasPendingSurfaces(tileId: string): boolean {
    const phase = this._jobs.get(tileId)?.phase;
    return phase !== undefined && phase !== 'symbol' && phase !== 'commit';
  }

  enqueue(sourceId: string, tile: Tile): void {
    this._enqueue(sourceId, tile);
  }

  /** Resume the unpublished detail of an already committed vector generation. */
  enqueueDetails(sourceId: string, tile: Tile, generationId: number): void {
    this._enqueue(sourceId, tile, generationId);
  }

  private _enqueue(sourceId: string, tile: Tile, generationId?: number): void {
    // A structural style change reparses the worker payload. Its old buckets
    // and atlas still cover the scene, but must not publish as the new style.
    if (tile.state === 'reloading') {
      return;
    }
    const tileId = `${sourceId}/${tile.tileID.key}`;
    const existing = this._jobs.get(tileId);
    if (existing?.tile === tile
      && existing.data.buckets === tile.buckets
      && existing.data.textureData === tile.textureData) {
      return;
    }
    if (existing) {
      this._discard(existing);
    }
    this.cancelPatternRefresh(tileId);
    this._jobs.set(tileId, {
      sourceId,
      tile,
      data: snapshot(tile),
      tileId,
      phase: generationId === undefined ? 'surface' : 'pattern',
      generationId,
    });
    this._options.requestRender();
  }

  clear(): void {
    for (const job of this._jobs.values()) {
      this._discard(job);
    }
    this._jobs.clear();
    this.clearPatternRefreshes();
  }

  clearPatternRefreshes(): void {
    for (const tileId of this._patternRefreshes.keys()) {
      this.cancelPatternRefresh(tileId);
    }
  }

  cancelPatternRefresh(tileId: string): void {
    const refresh = this._patternRefreshes.get(tileId);
    if (refresh) {
      this._patternRefreshes.delete(tileId);
      this._options.pattern.abandonPatternBuild(refresh.state);
    }
  }

  cancelPatternRefreshesOutside(sourceId: string, activeTileIds: ReadonlySet<string>): void {
    for (const [tileId, refresh] of this._patternRefreshes) {
      if (refresh.sourceId === sourceId && !activeTileIds.has(tileId)) {
        this.cancelPatternRefresh(tileId);
      }
    }
  }

  /** Refresh pattern paint without rebuilding the other render tracks. */
  refreshPattern(
    sourceId: string,
    tile: Tile,
    layers: readonly PatternStyleLayer[],
    transitions: boolean,
    budget: Budget,
  ): void {
    if (tile.state === 'reloading') {
      return;
    }
    const tileId = `${sourceId}/${tile.tileID.key}`;
    if (this._jobs.has(tileId)) {
      return;
    }
    const pending = this._patternRefreshes.get(tileId);
    if (pending) {
      if (pending.state.styleMutationRevision === this._options.style().styleRevision
        && pending.state.buckets === tile.buckets) {
        return;
      }
      this.cancelPatternRefresh(tileId);
    }
    if (this._options.pattern.restoreTile(tileId)) {
      this._options.publishPattern(sourceId, tile.tileID);
      return;
    }
    const style = this._options.style();
    const begun = this._options.pattern.beginPatternBuild({
      tileId,
      tileID: tile.tileID,
      tileFeatureIndex: tile.latestFeatureIndex,
      buckets: tile.buckets,
      atlas: tile.imageAtlas,
      layers,
      layerOrder: this._options.layerOrder(),
      sourceId,
      styleZoom: tileZoomOf(tile.tileID),
      mode: this._options.sceneMode(),
      styleRevision: style.renderRevision,
      styleMutationRevision: style.styleRevision,
      transitions,

    });
    if (begun.status === 'complete') {
      this._options.publishPattern(sourceId, tile.tileID, begun.update);
      return;
    }
    if (budget.exhausted || !this._options.pattern.stepPatternBuild(begun.state, budget)) {
      this._patternRefreshes.set(tileId, { sourceId, tileID: tile.tileID, state: begun.state });
      this._options.requestRender();
      return;
    }
    this._options.publishPattern(sourceId, tile.tileID, this._options.pattern.commitPatternBuild(begun.state));
  }

  drain(budget: Budget, maxCommits: number, position?: Pick<Cartographic, 'longitude' | 'latitude'>): number {
    if (this.size === 0) {
      return 0;
    }
    const viewpoint = position && MercatorCoordinate.fromLngLat({
      lng: CesiumMath.toDegrees(position.longitude),
      lat: CesiumMath.clamp(CesiumMath.toDegrees(position.latitude), -MAX_LATITUDE, MAX_LATITUDE),
    });
    let committed = 0;
    for (const [tileId, job] of this._jobs) {
      if (!this._isCurrent(job)) {
        this._discard(job);
        this._jobs.delete(tileId);
      }
    }
    const jobs = prioritize(this._jobs.values(), job => job.data.tileID, viewpoint);
    // Finished collections need no geometry work; don't strand their commit
    // behind a different tile's conversion in the current frame.
    for (const ready of ['surface-ready', 'vector-ready'] as const) {
      for (const job of jobs) {
        if (budget.exhausted || committed >= maxCommits) {
          break;
        }
        if (this._jobs.get(job.tileId) === job && job.phase === ready) {
          if (!this._commitVector(job, ready === 'surface-ready')) {
            this._jobs.delete(job.tileId);
          }
          committed++;
        }
      }
    }
    // Run each stage across the whole queue. An older tile's road conversion
    // or symbols must never consume the budget before newer tiles' surfaces.
    for (const stage of ['surface', 'vector', 'pattern', 'symbol'] as const) {
      for (const job of jobs) {
        if (budget.exhausted) {
          break;
        }
        if (this._jobs.get(job.tileId) !== job || (job.phase !== stage && !(stage === 'symbol' && job.phase === 'commit'))) {
          continue;
        }
        if (stage === 'surface' || stage === 'vector') {
          const phase = this._buildVector(job, budget);
          if (committed < maxCommits && (phase === 'surface-ready' || phase === 'vector-ready')) {
            if (!this._commitVector(job, phase === 'surface-ready')) {
              this._jobs.delete(job.tileId);
            }
            committed++;
          }
        }
        else {
          const result = this._stepDetail(job, budget, committed >= maxCommits, stage);
          if (result === 'committed') {
            this._jobs.delete(job.tileId);
          }
          if (result !== 'pending') {
            committed++;
          }
        }
      }
      if (stage === 'pattern') {
        this._drainPatternRefreshes(budget, viewpoint);
      }
    }
    if (this._jobs.size > 0) {
      this._options.requestRender();
    }
    return committed;
  }

  private _drainPatternRefreshes(budget: Budget, viewpoint?: MercatorCoordinate): void {
    for (const [tileId, refresh] of prioritize(this._patternRefreshes, ([, job]) => job.tileID, viewpoint)) {
      if (budget.exhausted) {
        break;
      }
      if (refresh.state.styleMutationRevision !== this._options.style().styleRevision) {
        this.cancelPatternRefresh(tileId);
        continue;
      }
      if (this._options.pattern.stepPatternBuild(refresh.state, budget)) {
        this._patternRefreshes.delete(tileId);
        this._options.publishPattern(refresh.sourceId, refresh.tileID, this._options.pattern.commitPatternBuild(refresh.state));
      }
    }
    if (this._patternRefreshes.size > 0) {
      this._options.requestRender();
    }
  }

  private _discard(job: PublishJob): void {
    if (job.vectorBuild && (job.phase === 'surface' || job.phase === 'vector' || job.phase === 'surface-ready' || job.phase === 'vector-ready')) {
      this._options.vector.discardTileBuild(job.vectorBuild);
    }
    if (job.symbolBuild) {
      this._options.symbol.releaseBuild(job.symbolBuild);
    }
    if (job.patternBuild?.status === 'resumable') {
      this._options.pattern.abandonPatternBuild(job.patternBuild.state);
    }
  }

  private _excludedLayers(data: TileData): Set<string> {
    const style = this._options.style();
    const excluded = new Set<string>();
    for (const layerId of Object.keys(data.buckets)) {
      const layer = style.getLayer(layerId);
      if (!layer || layer.isHidden(style.z) || isPatternStyleLayer(layer)) {
        excluded.add(layerId);
      }
    }
    return excluded;
  }

  private _isCurrent(job: PublishJob): boolean {
    return job.tile.state !== 'reloading'
      && this._options.isRenderable(job.sourceId, job.data.tileID.key)
      && job.tile.tileID.key === job.data.tileID.key;
  }

  private _buildVector(job: PublishJob, budget: Budget): PublishPhase {
    const style = this._options.style();
    job.excludedLayerIds ??= this._excludedLayers(job.data);
    job.vectorBuild ??= this._options.vector.beginTileBuild({
      tileId: job.tileId,
      buckets: job.data.buckets,
      tileID: job.data.tileID,
      sourceId: job.sourceId,
      layerOrder: this._options.layerOrder(),
      skipLayerIds: job.excludedLayerIds,
      styleZoom: this._options.styleZoom(),
      mode: this._options.sceneMode(),
      styleRevision: style.styleRevision,
      lightRevision: this._options.lightRevision(),
      dashRows: job.data.dashRows,
    });
    job.generationId = job.vectorBuild.generationId;
    if (!this._options.vector.advanceTileBuild(job.vectorBuild, budget)) {
      if (job.phase === 'surface' && job.vectorBuild.phase === 'details') {
        job.phase = job.vectorBuild.entries.length > 0 && this._options.vector.getTileCollections(job.tileId).length === 0
          ? 'surface-ready'
          : 'vector';
      }
      return job.phase;
    }
    job.phase = 'vector-ready';
    return job.phase;
  }

  private _commitVector(job: PublishJob, surface = false): boolean {
    const { vector } = this._options;
    const { sourceId, data, tileId } = job;
    const previousVector = job.surfacePublished ? [] : [...vector.getTileCollections(tileId)];
    const retiredVector = job.surfacePublished ? [] : vector.takeRetired(tileId);
    const addedVector = job.surfacePublished
      ? vector.appendTileBuild(job.vectorBuild!)
      : (vector.commitTileBuild(job.vectorBuild!) ? [...vector.getTileCollections(tileId)] : []);
    const hasDetail = this._options.symbolLayers(sourceId).length > 0 || this._options.patternLayers(sourceId).length > 0;
    job.phase = surface ? 'vector' : 'pattern';
    // Completing conversion also advances residency when the detail stage
    // produced no new vector collections (for example a fill-only tile).
    this._options.publish({
      sourceId,
      tileId,
      tileID: data.tileID,
      generationId: job.generationId!,
      stage: surface ? 'surface' : hasDetail ? 'vector' : 'complete',
      retainPreviousGeneration: hasDetail,
      previousVector,
      retiredVector,
      addedVector,
      raster: job.surfacePublished ? { removed: [], added: [], removedMaterials: [] } : this._addRaster(job),
      removedSymbols: [],
      addedSymbols: [],
      firstUpdateSymbols: [],
      featureIndex: data.latestFeatureIndex,
      retainedSurfaces: job.surfacePublished
        ? undefined
        : [
            this._options.pattern.takeDisplacedTile(tileId, this._options.patternLayers(sourceId)),
            this._options.raster.takeDisplacedTile(tileId, this._options.rasterLayers(sourceId)),
          ].filter((retained): retained is NonNullable<typeof retained> => !!retained),
    });
    if (surface) {
      job.vectorBuild!.entries.length = 0;
      job.surfacePublished = true;
    }
    return surface || hasDetail;
  }

  private _addRaster(job: PublishJob): RasterTileUpdate {
    const source = this._options.rasterSource(job.sourceId);
    return this._options.raster.addTile(
      job.tileId,
      job.data.tileID,
      job.data.textureData,
      this._options.rasterLayers(job.sourceId),
      source.dynamic,
      source.tileCoords,
      source.flippedWindingOrder,
      this._options.sceneMode(),
    );
  }

  private _stepDetail(job: PublishJob, budget: Budget, deferCommit: boolean, stage: 'pattern' | 'symbol'): PublishStep {
    const { symbol, pattern } = this._options;
    const style = this._options.style();
    job.excludedLayerIds ??= this._excludedLayers(job.data);

    if (job.phase === 'pattern') {
      job.patternLayers ??= this._options.patternLayers(job.sourceId);
      if (job.patternLayers.length > 0) {
        job.patternBuild ??= pattern.beginPatternBuild({
          tileId: job.tileId,
          tileID: job.data.tileID,
          tileFeatureIndex: job.data.latestFeatureIndex,
          buckets: job.data.buckets,
          atlas: job.data.imageAtlas,
          layers: job.patternLayers,
          layerOrder: this._options.layerOrder(),
          sourceId: job.sourceId,
          styleZoom: tileZoomOf(job.data.tileID),
          mode: this._options.sceneMode(),
          styleRevision: style.renderRevision,
          styleMutationRevision: style.styleRevision,
          transitions: job.patternLayers.some(layer => layer.hasTransition()),

        });
        if (job.patternBuild.status === 'resumable'
          && !pattern.stepPatternBuild(job.patternBuild.state, budget)) {
          return 'pending';
        }
        if (deferCommit) {
          return 'pending';
        }
        const update = job.patternBuild.status === 'complete'
          ? job.patternBuild.update
          : pattern.commitPatternBuild(job.patternBuild.state);
        job.patternBuild = undefined;
        job.phase = 'symbol';
        if (update.added.length > 0 || update.removed.length > 0 || update.removedMaterials.length > 0) {
          this._options.publishPattern(job.sourceId, job.data.tileID, update);
          return 'partial';
        }
      }
      job.phase = 'symbol';
    }

    if (stage === 'pattern') {
      return 'pending';
    }

    if (job.phase === 'symbol') {
      const layers = this._options.symbolLayers(job.sourceId);
      if (layers.length > 0) {
        job.restoreSymbol ??= symbol.canRestoreTile(job.tileId, job.data.buckets);
        if (!job.restoreSymbol) {
          job.symbolBuild ??= symbol.beginBuild({
            tileId: job.tileId,
            tileKey: job.data.tileID.key,
            tileID: job.data.tileID,
            buckets: job.data.buckets,
            collisionBoxArray: job.data.collisionBoxArray,
            layers: [...layers],
            glyphAtlasImage: job.data.glyphAtlasImage,
            iconAtlas: job.data.imageAtlas,
            pixelRatio: typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
            layerOrder: this._options.layerOrder(),
            skipLayerIds: job.excludedLayerIds,
          });
          if (!symbol.stepBuild(job.symbolBuild, budget)) {
            return 'pending';
          }
        }
      }
      job.phase = 'commit';
    }

    if (job.phase === 'commit') {
      if (deferCommit) {
        return 'pending';
      }
      this._commitDetail(job);
      return 'committed';
    }
    return 'pending';
  }

  private _commitDetail(job: PublishJob): void {
    const { symbol } = this._options;
    const { sourceId, data, tileId } = job;
    const restored = job.restoreSymbol ? symbol.restoreTile(tileId, data.buckets) ?? [] : [];
    const built = job.symbolBuild ? symbol.commitBuild(job.symbolBuild) : undefined;
    this._options.publish({
      sourceId,
      tileId,
      tileID: data.tileID,
      generationId: job.generationId!,
      stage: 'complete',
      retainPreviousGeneration: false,
      previousVector: [],
      retiredVector: [],
      addedVector: [],
      raster: { removed: [], added: [], removedMaterials: [] },
      removedSymbols: built?.removed ?? [],
      addedSymbols: [...restored, ...(built?.added ?? [])],
      firstUpdateSymbols: built?.added ?? [],
      retainedSymbols: built?.retained,
      featureIndex: data.latestFeatureIndex,
    });
  }
}
