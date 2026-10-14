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
import type { RetainedSurface } from './scene-collections';
import type { TileGenerationData, TilePublicationProgress } from './tile-generation';
import { Math as CesiumMath } from 'cesium';
import { MercatorCoordinate } from '../../geo/mercator-coordinate';
import { browser } from '../../util/browser';
import { isPatternStyleLayer } from '../pattern/pattern-layer';
import { paintRevision } from '../vector/feature-attributes';
import { tileZoomOf } from '../vector/vector-tile-builder';
import { MAX_LATITUDE } from './globe-covering';
import { TileGeneration } from './tile-generation';

type SurfacePhase = 'surface' | 'surface-ready' | 'vector' | 'lines-ready' | 'vector-ready' | 'pattern' | 'done';
type SymbolPhase = 'pending' | 'ready' | 'done';
type PublishTrack = 'surfaces' | 'symbols';

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
  generation: TileGeneration;
  tileId: string;
  surfaces: SurfacePhase;
  symbols: SymbolPhase;
  excludedLayerIds?: Set<string>;
  patternLayers?: readonly PatternStyleLayer[];
  vectorBuild?: VectorTileBuildState;
  surfacePublished?: boolean;
  symbolBuild?: SymbolBuildState;
  patternBuild?: PatternBuildBegun;
  nextTrack?: PublishTrack;
  vectorInputs?: {
    style: Style;
    renderRevision: number;
    zoom: number;
    lightRevision: number;
    pixelRatio: number;
    layerOrder: ReadonlyMap<string, number>;
  };
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
  stage: 'surface' | 'lines' | 'vector' | 'pattern' | 'symbol' | 'complete';
  /** Immutable observation of this commit; continuing work uses generation instead. */
  progress: Readonly<TilePublicationProgress>;
  generation: TileGeneration;
  pattern?: PatternTileUpdate;
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
  retainedSurfaces?: RetainedSurface[];
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
    identity: object;
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
  /** The host can advance detached CPU preparation without rendering a frame. */
  idlePreparationsEnabled = false;

  private _minimumJob?: string;

  private _idleJob?: string;

  private _nextTrack: PublishTrack = 'surfaces';

  private readonly _jobs = new Map<string, PublishJob>();

  private readonly _patternRefreshes = new Map<string, PatternRefreshJob>();

  private readonly _options: TilePublishOptions;

  constructor(options: TilePublishOptions) {
    this._options = options;
  }

  get size(): number {
    return this._jobs.size + this._patternRefreshes.size;
  }

  /** Inspect once for both admission and render continuation decisions. */
  inspectBuilds(): { runnable: boolean; renderNeeded: boolean } {
    const { jobs, renderNeeded } = this._inspectBuilds();
    return { runnable: jobs.length > 0, renderNeeded };
  }

  /** Advance detached vector CPU work; publication and invalidation need render. */
  advanceBuilds(budget: Budget): { steps: number; ready: number; renderNeeded: boolean } {
    const { jobs, renderNeeded } = this._inspectBuilds();
    let steps = 0;
    let ready = 0;
    if (jobs.length > 0) {
      const previous = jobs.findIndex(job => job.tileId === this._idleJob);
      const minimum = budget.takeMinimumProgress?.() ?? false;
      for (let index = 0; index < jobs.length; index++) {
        if (budget.exhausted && (steps > 0 || !minimum))
          break;
        const job = jobs[(previous + 1 + index) % jobs.length];
        this._idleJob = job.tileId;
        this._begin(job);
        this._buildVector(job, budget);
        steps++;
        if (job.surfaces === 'surface-ready' || job.surfaces === 'lines-ready' || job.surfaces === 'vector-ready') {
          ready++;
          break;
        }
      }
    }
    // A sibling can require render admission while these detached jobs remain
    // safe to advance. Publication still waits for the real render path.
    if (renderNeeded || ready > 0)
      this._options.requestRender();
    return { steps, ready, renderNeeded: renderNeeded || ready > 0 };
  }

  /**
   * @internal
   */
  private _inspectBuilds(): { jobs: PublishJob[]; renderNeeded: boolean } {
    if (this.size === 0)
      return { jobs: [], renderNeeded: false };
    if (!this.idlePreparationsEnabled || this._patternRefreshes.size > 0)
      return { jobs: [], renderNeeded: true };
    const style = this._options.style();
    const mode = this._options.sceneMode();
    const zoom = this._options.styleZoom();
    const lightRevision = this._options.lightRevision();
    const pixelRatio = this._options.vector.pixelRatio;
    const layerOrder = this._options.layerOrder();
    if (style._changed !== false || style.getRenderTransitionFlags().any !== false
      || ![style.styleRevision, style.renderRevision, mode, zoom, lightRevision, pixelRatio].every(Number.isFinite)
      || pixelRatio <= 0) {
      return { jobs: [], renderNeeded: true };
    }
    const revisions = new Map<TileGenerationData['buckets'][string], number>();
    const jobs: PublishJob[] = [];
    let renderNeeded = false;
    for (const job of this._jobs.values()) {
      const inputs = job.vectorInputs;
      const build = job.vectorBuild;
      const data = job.generation.data;
      // Unbegun work, symbols, patterns, commits and cancellation keep their
      // original real-render path. Their siblings retain independent CPU
      // admission when all of their own construction inputs are unchanged.
      if (job.symbols !== 'done' || (job.surfaces !== 'surface' && job.surfaces !== 'vector')
        || !build || !inputs || !this._isCurrent(job)
        || job.generation.styleRevision !== style.styleRevision || job.generation.mode !== mode
        || inputs.style !== style || inputs.renderRevision !== style.renderRevision
        || inputs.zoom !== zoom || inputs.lightRevision !== lightRevision
        || inputs.pixelRatio !== pixelRatio || inputs.layerOrder !== layerOrder
        || data.buckets !== job.tile.buckets || data.textureData !== job.tile.textureData
        || data.collisionBoxArray !== job.tile.collisionBoxArray || data.glyphAtlasImage !== job.tile.glyphAtlasImage
        || data.imageAtlas !== job.tile.imageAtlas || data.dashRows !== job.tile.dashRows
        || job.generation.featureIndex !== job.tile.latestFeatureIndex) {
        renderNeeded = true;
        continue;
      }
      let paintValid = true;
      for (let index = 0; index < build.paintBuckets.length; index++) {
        const bucket = build.paintBuckets[index];
        let revision = revisions.get(bucket);
        if (revision === undefined) {
          revision = paintRevision(bucket);
          revisions.set(bucket, revision);
        }
        if (!Number.isFinite(revision) || revision !== build.paintRevisions[index]) {
          paintValid = false;
          break;
        }
      }
      if (paintValid)
        jobs.push(job);
      else
        renderNeeded = true;
    }
    return { jobs, renderNeeded };
  }

  /**
   * @internal
   */
  private _requestBuildContinuation(): void {
    if (this.size > 0 && (!this.idlePreparationsEnabled || this.inspectBuilds().renderNeeded))
      this._options.requestRender();
  }

  has(tileId: string): boolean {
    return this._jobs.has(tileId);
  }

  hasPendingSurfaces(tileId: string): boolean {
    const job = this._jobs.get(tileId);
    return !!job && job.surfaces !== 'done';
  }

  hasPendingSymbols(tileId: string): boolean {
    const job = this._jobs.get(tileId);
    return !!job && job.symbols !== 'done';
  }

  enqueue(sourceId: string, tile: Tile): void {
    this._enqueue(sourceId, tile);
  }

  /** Resume unpublished tracks of an already reserved, partially committed generation. */
  enqueueDetails(sourceId: string, tile: Tile, generation: TileGeneration): void {
    this._enqueue(sourceId, tile, generation);
  }

  /** Visibility changes only prepare content missing from a resident generation. */
  ensureVisibleLayers(sourceId: string, tile: Tile, newlyVisible: ReadonlySet<string>): void {
    const style = this._options.style();
    const layers = [...newlyVisible].flatMap((id) => {
      const layer = style.getLayer(id);
      // SourceRenderSync refreshes patterns independently, even when this
      // tile has no vector geometry and therefore no vector generation.
      return tile.buckets[id] && layer?.source === sourceId && !isPatternStyleLayer(layer) ? [layer] : [];
    });
    if (layers.length === 0)
      return;
    const tileId = `${sourceId}/${tile.tileID.key}`;
    const pending = this._jobs.get(tileId);
    if (pending) {
      const excluded = layers.filter(layer => pending.excludedLayerIds?.has(layer.id));
      if (excluded.some(layer => layer.type !== 'symbol')) {
        this._discard(pending);
        this._jobs.delete(tileId);
        this.enqueue(sourceId, tile);
      }
      else if (excluded.some(layer => layer.type === 'symbol')) {
        // Update the independent symbol plan while preserving both completed
        // vector geometry and any conversion still progressing before it.
        for (const layer of excluded) {
          if (layer.type === 'symbol')
            pending.excludedLayerIds!.delete(layer.id);
        }
        if (pending.symbolBuild) {
          this._options.symbol.releaseBuild(pending.symbolBuild);
          pending.symbolBuild = undefined;
        }
        pending.symbols = 'pending';
        pending.generation.publication.symbol = false;
        this._options.requestRender();
      }
      return;
    }
    const vector = this._options.vector.tileBuildLayers(tileId);
    const missingVector = layers.some(layer => layer.type !== 'symbol'
      && (!vector?.layerIds.includes(layer.id) || vector.skipLayerIds?.has(layer.id)));
    if (missingVector || !vector?.complete) {
      this.enqueue(sourceId, tile);
    }
    else if (layers.some(layer => layer.type === 'symbol' && !this._options.symbol.hasTileLayer(tileId, layer.id))) {
      // Symbols have an independent publication stage. Reuse the completed
      // vector generation instead of re-converting its fills, lines and points.
      const generation = this._options.vector.tileGeneration(tileId);
      if (generation) {
        generation.publication.pattern = false;
        generation.publication.symbol = false;
        this.enqueueDetails(sourceId, tile, generation);
      }
      else {
        this.enqueue(sourceId, tile);
      }
    }
  }

  /**
   * @internal
   */
  private _enqueue(sourceId: string, tile: Tile, generation?: TileGeneration): void {
    // A structural style change reparses the worker payload. Its old buckets
    // and atlas still cover the scene, but must not publish as the new style.
    if (tile.state === 'reloading') {
      return;
    }
    const tileId = `${sourceId}/${tile.tileID.key}`;
    const existing = this._jobs.get(tileId);
    if (existing?.tile === tile
      && existing.generation.data.buckets === tile.buckets
      && existing.generation.data.textureData === tile.textureData) {
      return;
    }
    if (existing) {
      this._discard(existing);
    }
    this.cancelPatternRefresh(tileId);
    this._jobs.set(tileId, {
      sourceId,
      tile,
      generation: generation ?? new TileGeneration(tile, this._options.style().styleRevision, this._options.sceneMode()),
      tileId,
      surfaces: generation?.publication.vector === 'complete' ? generation.publication.pattern ? 'done' : 'pattern' : 'surface',
      symbols: generation?.publication.symbol ? 'done' : 'pending',
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

  drain(budget: Budget, maxCommits: number, position?: Pick<Cartographic, 'longitude' | 'latitude'>, minimumProgress = false): number {
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
    if (minimumProgress && maxCommits > 0)
      return this._drainMinimum(budget, maxCommits);
    const jobs = prioritize(this._jobs.values(), job => job.generation.data.tileID, viewpoint);
    // Alternate the first eligible track across physical frames. Within the
    // surface track, every newer fill still precedes older road conversion.
    const tracks: PublishTrack[] = this._nextTrack === 'surfaces'
      ? ['surfaces', 'symbols']
      : ['symbols', 'surfaces'];
    this._nextTrack = tracks[1];
    for (const track of tracks) {
      const phases = track === 'surfaces'
        ? ['surface-ready', 'lines-ready', 'vector-ready', 'surface', 'vector', 'pattern', 'done'] as const
        : ['pending', 'ready'] as const;
      for (const phase of phases) {
        for (const job of jobs) {
          if (budget.exhausted || committed >= maxCommits)
            break;
          if (this._jobs.get(job.tileId) !== job || job[track] !== phase)
            continue;
          committed += this._stepTrack(job, track, budget);
        }
      }
      if (track === 'surfaces')
        this._drainPatternRefreshes(budget, viewpoint);
    }
    this._requestBuildContinuation();
    return committed;
  }

  /**
   * Spend one Scene admission quota fairly; only its first unit may start spent.
   * @internal
   */
  private _drainMinimum(budget: Budget, maxCommits: number): number {
    const minimum = budget.takeMinimumProgress?.() ?? false;
    let committed = 0;
    let admitted = false;
    while (this.size > 0 && committed < maxCommits) {
      if (budget.exhausted && (admitted || !minimum))
        break;
      const pending = [
        ...[...this._jobs.keys()].map(tileId => ({ tileId, refresh: false })),
        ...[...this._patternRefreshes.keys()].map(tileId => ({ tileId, refresh: true })),
      ];
      const key = (entry: typeof pending[number]): string => `${entry.refresh ? 'refresh' : 'tile'}/${entry.tileId}`;
      const previous = pending.findIndex(entry => key(entry) === this._minimumJob);
      const selected = pending[(previous + 1) % pending.length];
      this._minimumJob = key(selected);
      admitted = true;
      if (selected.refresh) {
        const refresh = this._patternRefreshes.get(selected.tileId)!;
        if (refresh.state.styleMutationRevision !== this._options.style().styleRevision) {
          this.cancelPatternRefresh(selected.tileId);
        }
        else if (this._options.pattern.stepPatternBuild(refresh.state, budget)) {
          this._patternRefreshes.delete(selected.tileId);
          this._options.publishPattern(refresh.sourceId, refresh.tileID, this._options.pattern.commitPatternBuild(refresh.state));
          committed++;
        }
        continue;
      }
      const job = this._jobs.get(selected.tileId)!;
      this._begin(job);
      const track = job.surfaces === 'done'
        ? 'symbols'
        : job.symbols === 'done' ? 'surfaces' : job.nextTrack ?? 'surfaces';
      job.nextTrack = track === 'surfaces' ? 'symbols' : 'surfaces';
      committed += this._stepTrack(job, track, budget);
    }
    this._requestBuildContinuation();
    return committed;
  }

  /**
   * @internal
   */
  private _stepTrack(job: PublishJob, track: PublishTrack, budget: Budget): number {
    this._begin(job);
    if (track === 'symbols') {
      if (job.symbols === 'done') {
        if (job.surfaces !== 'done')
          return 0;
        this._publish(job, 'complete');
        this._jobs.delete(job.tileId);
        return 1;
      }
      if (!this._stepSymbol(job, budget))
        return 0;
      this._commitSymbol(job);
    }
    else if (job.surfaces === 'pattern') {
      if (!this._stepPattern(job, budget))
        return 0;
    }
    else if (job.surfaces !== 'done') {
      if (job.surfaces === 'surface' || job.surfaces === 'vector')
        this._buildVector(job, budget);
      if (job.surfaces !== 'surface-ready' && job.surfaces !== 'lines-ready' && job.surfaces !== 'vector-ready')
        return 0;
      this._commitVector(job, job.surfaces === 'surface-ready' ? 'surface' : job.surfaces === 'lines-ready' ? 'lines' : 'vector');
    }
    else {
      return 0;
    }
    if (job.surfaces === 'done' && job.symbols === 'done') {
      this._jobs.delete(job.tileId);
    }
    return 1;
  }

  /**
   * @internal
   */
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

  /**
   * @internal
   */
  private _discard(job: PublishJob): void {
    if (job.vectorBuild)
      this._options.vector.discardTileBuild(job.vectorBuild);
    if (job.symbolBuild) {
      this._options.symbol.releaseBuild(job.symbolBuild);
    }
    if (job.patternBuild?.status === 'resumable') {
      this._options.pattern.abandonPatternBuild(job.patternBuild.state);
    }
  }

  /**
   * @internal
   */
  private _excludedLayers(data: TileGenerationData): Set<string> {
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

  /**
   * @internal
   */
  private _isCurrent(job: PublishJob): boolean {
    return job.tile.state !== 'reloading'
      && this._options.isRenderable(job.sourceId, job.generation.data.tileID.key)
      && job.tile.tileID.key === job.generation.data.tileID.key;
  }

  /**
   * Reserve the shared generation without advancing geometry conversion.
   * @internal
   */
  private _begin(job: PublishJob): void {
    if (job.symbols === 'pending' && !job.symbolBuild && this._options.symbolLayers(job.sourceId).length === 0) {
      job.symbols = 'done';
      job.generation.publication.symbol = true;
    }
    if (job.vectorBuild || job.generation.publication.vector === 'complete')
      return;
    job.excludedLayerIds ??= this._excludedLayers(job.generation.data);
    job.vectorBuild = this._options.vector.beginTileBuild({
      tileId: job.tileId,
      generationId: job.generation.reservedId,
      buckets: job.generation.data.buckets,
      tileID: job.generation.data.tileID,
      sourceId: job.sourceId,
      layerOrder: this._options.layerOrder(),
      skipLayerIds: job.excludedLayerIds,
      styleZoom: this._options.styleZoom(),
      mode: job.generation.mode,
      styleRevision: job.generation.styleRevision,
      lightRevision: this._options.lightRevision(),
      dashRows: job.generation.data.dashRows,
    });
    // Reuse the builder's actual paint stamp instead of rescanning its buckets.
    job.vectorInputs = {
      style: this._options.style(),
      renderRevision: this._options.style().renderRevision,
      zoom: this._options.styleZoom(),
      lightRevision: this._options.lightRevision(),
      pixelRatio: this._options.vector.pixelRatio,
      layerOrder: this._options.layerOrder(),
    };
    job.generation.reserve(job.vectorBuild.generationId);
  }

  /**
   * @internal
   */
  private _buildVector(job: PublishJob, budget: Budget): SurfacePhase {
    if (!this._options.vector.advanceTileBuild(job.vectorBuild!, budget)) {
      if (job.surfaces === 'surface' && job.vectorBuild!.phase === 'details') {
        job.surfaces = job.vectorBuild!.entries.length > 0 && this._options.vector.getTileCollections(job.tileId).length === 0
          ? 'surface-ready'
          : 'vector';
      }
      else if (job.vectorBuild!.phase === 'extrusions' && job.vectorBuild!.entries.some(([kind]) => kind === 'lines')) {
        job.surfaces = 'lines-ready';
      }
      return job.surfaces;
    }
    job.surfaces = 'vector-ready';
    return job.surfaces;
  }

  /**
   * @internal
   */
  private _commitVector(job: PublishJob, stage: 'surface' | 'lines' | 'vector'): void {
    const { vector } = this._options;
    const { sourceId, tileId } = job;
    const complete = stage === 'vector';
    const previousVector = job.surfacePublished ? [] : [...vector.getTileCollections(tileId)];
    const retiredVector = job.surfacePublished ? [] : vector.takeRetired(tileId);
    const addedVector = job.surfacePublished
      ? vector.appendTileBuild(job.vectorBuild!)
      : (vector.commitTileBuild(job.vectorBuild!, job.generation) ? [...vector.getTileCollections(tileId)] : []);
    job.surfaces = complete ? 'pattern' : 'vector';
    job.generation.publication.vector = complete ? 'complete' : 'surface';
    if (complete && (job.generation.publication.pattern || this._options.patternLayers(sourceId).length === 0)) {
      job.surfaces = 'done';
      job.generation.publication.pattern = true;
    }
    this._publish(job, stage, {
      previousVector,
      retiredVector,
      addedVector,
      raster: job.surfacePublished ? { removed: [], added: [], removedMaterials: [] } : this._addRaster(job),
      retainedSurfaces: job.surfacePublished
        ? undefined
        : [
            this._options.pattern.takeDisplacedTile(tileId, this._options.patternLayers(sourceId)),
            this._options.raster.takeDisplacedTile(tileId, this._options.rasterLayers(sourceId)),
          ].filter((retained): retained is NonNullable<typeof retained> => !!retained),
    });
    job.surfacePublished = true;
    if (complete)
      job.vectorBuild = undefined;
  }

  /**
   * @internal
   */
  private _addRaster(job: PublishJob): RasterTileUpdate {
    const layers = this._options.rasterLayers(job.sourceId);
    if (layers.length === 0)
      return { removed: [], added: [], removedMaterials: [] };
    const source = this._options.rasterSource(job.sourceId);
    return this._options.raster.addTile(
      job.tileId,
      job.generation.data.tileID,
      job.generation.data.textureData,
      layers,
      source.identity,
      source.dynamic,
      source.tileCoords,
      source.flippedWindingOrder,
      this._options.sceneMode(),
    );
  }

  /**
   * @internal
   */
  private _stepPattern(job: PublishJob, budget: Budget): boolean {
    const { pattern } = this._options;
    const style = this._options.style();
    job.patternLayers ??= this._options.patternLayers(job.sourceId);
    let update: PatternTileUpdate | undefined;
    if (job.patternLayers.length > 0) {
      job.patternBuild ??= pattern.beginPatternBuild({
        tileId: job.tileId,
        tileID: job.generation.data.tileID,
        tileFeatureIndex: job.generation.featureIndex,
        buckets: job.generation.data.buckets,
        atlas: job.generation.data.imageAtlas,
        layers: job.patternLayers,
        sourceId: job.sourceId,
        styleZoom: tileZoomOf(job.generation.data.tileID),
        mode: this._options.sceneMode(),
        styleRevision: style.renderRevision,
        styleMutationRevision: style.styleRevision,
        transitions: job.patternLayers.some(layer => layer.hasTransition()),
      });
      if (job.patternBuild.status === 'resumable'
        && !pattern.stepPatternBuild(job.patternBuild.state, budget)) {
        return false;
      }
      update = job.patternBuild.status === 'complete'
        ? job.patternBuild.update
        : pattern.commitPatternBuild(job.patternBuild.state);
      job.patternBuild = undefined;
    }
    job.surfaces = 'done';
    job.generation.publication.pattern = true;
    this._publish(job, 'pattern', { pattern: update });
    return true;
  }

  /**
   * @internal
   */
  private _stepSymbol(job: PublishJob, budget: Budget): boolean {
    if (job.symbols === 'ready')
      return true;
    const { symbol } = this._options;
    job.excludedLayerIds ??= this._excludedLayers(job.generation.data);
    const layers = this._options.symbolLayers(job.sourceId);
    if (layers.length > 0) {
      job.symbolBuild ??= symbol.beginBuild({
        tileId: job.tileId,
        tileKey: job.generation.data.tileID.key,
        tileID: job.generation.data.tileID,
        buckets: job.generation.data.buckets,
        collisionBoxArray: job.generation.data.collisionBoxArray,
        layers: [...layers],
        glyphAtlasImage: job.generation.data.glyphAtlasImage,
        iconAtlas: job.generation.data.imageAtlas,
        pixelRatio: browser.devicePixelRatio,
        layerOrder: this._options.layerOrder(),
        skipLayerIds: job.excludedLayerIds,
      });
      if (!symbol.stepBuild(job.symbolBuild, budget))
        return false;
    }
    job.symbols = 'ready';
    return true;
  }

  /**
   * @internal
   */
  private _commitSymbol(job: PublishJob): void {
    const { symbol } = this._options;
    const built = job.symbolBuild ? symbol.commitBuild(job.symbolBuild) : undefined;
    // Atlas holds have transferred to the committed renderer entry.
    job.symbolBuild = undefined;
    job.symbols = 'done';
    job.generation.publication.symbol = true;
    this._publish(job, 'symbol', {
      removedSymbols: built?.removed ?? this._removeUnusedSymbols(job.sourceId, job.tileId),
      addedSymbols: built?.added ?? [],
      firstUpdateSymbols: built?.added ?? [],
      retainedSymbols: built?.retained,
    });
  }

  /**
   * @internal
   */
  private _publish(job: PublishJob, stage: TilePublishResult['stage'], resources: Partial<TilePublishResult> = {}): void {
    if (job.surfaces === 'done' && job.symbols === 'done')
      stage = 'complete';
    this._options.publish({
      sourceId: job.sourceId,
      tileId: job.tileId,
      tileID: job.generation.data.tileID,
      generationId: job.generation.id,
      stage,
      progress: { ...job.generation.publication },
      generation: job.generation,
      retainPreviousGeneration: stage !== 'complete',
      previousVector: [],
      retiredVector: [],
      addedVector: [],
      raster: { removed: [], added: [], removedMaterials: [] },
      removedSymbols: [],
      addedSymbols: [],
      firstUpdateSymbols: [],
      featureIndex: job.generation.featureIndex,
      ...(stage === 'complete' && this._options.symbolLayers(job.sourceId).length === 0
        ? { removedSymbols: this._removeUnusedSymbols(job.sourceId, job.tileId) }
        : {}),
      ...resources,
    });
  }

  /**
   * @internal
   */
  private _removeUnusedSymbols(sourceId: string, tileId: string): readonly PrimitiveCollection[] {
    const style = this._options.style();
    // The visible-layer plan can be empty solely because of min/maxzoom.
    // Keep those extracted symbols cached; only removal of the source's last
    // declared symbol layer makes its old symbol resources obsolete.
    const declared = style.getLayerOrder().some((id) => {
      const layer = style.getLayer(id);
      return layer?.type === 'symbol' && layer.source === sourceId;
    });
    return declared ? [] : this._options.symbol.removeTile(tileId);
  }
}
