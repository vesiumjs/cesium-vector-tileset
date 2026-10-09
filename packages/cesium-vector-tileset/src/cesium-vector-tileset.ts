import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PatternPrimitiveID } from './render/pattern/pattern-renderer';
import type { RasterPrimitivePickObject } from './render/raster/raster-renderer';
import type { Budget, FrameBudget } from './render/scene/frame-budget';
import type { CoveringCache, RenderFrameState } from './render/scene/render-frame';
import type { RunnableStages, SceneFrameBudgetLease, SceneFrameWork } from './render/scene/scene-frame-budget';
import type { TilePickObject } from './render/vector/tile-conversion';
import type { VectorPaintFrame } from './render/vector/vector-paint-updater';
import type { VectorCollection } from './render/vector/vector-tile-renderer';
import type { Style } from './style/style';
import type { Tile } from './tile/tile';
import type { CesiumVectorTilesetFromUrlOptions, CesiumVectorTilesetOptions } from './tileset-options';
import type { TilesetImage, TilesetImageOptions, TilesetStats } from './tileset-types';
import type { SourceDataEvent, StyleDataEvent } from './util/events';
import type { RequestTransformFunction } from './util/request';
import { diff as diffStyles } from '@maplibre/maplibre-gl-style-spec';
import {
  DeveloperError,
  Event,
  GeographicProjection,
  HeightReference,
  PrimitiveCollection,
  SceneMode,
  WebMercatorProjection,
} from 'cesium';
import { isPatternStyleLayer } from './render/pattern/pattern-layer';
import { destroyPatternResources, PatternTileRenderer } from './render/pattern/pattern-renderer';
import { destroyRasterResources, rasterSourceInfo, RasterTileRenderer } from './render/raster/raster-renderer';
import { BackgroundRenderer } from './render/scene/background-renderer';
import { DrawCommands } from './render/scene/draw-commands';
import { MAX_TILE_COMMITS } from './render/scene/frame-budget';
import { cameraPoseForFrame } from './render/scene/render-frame';
import { RenderLayerIndex } from './render/scene/render-layer-index';
import { SceneCollections } from './render/scene/scene-collections';
import { acquireSceneFrameBudget } from './render/scene/scene-frame-budget';
import { SceneTileCovering } from './render/scene/scene-tile-covering';
import { SourceRenderSync } from './render/scene/source-render-sync';
import { StyleEvaluation } from './render/scene/style-evaluation';
import { TilePublishQueue } from './render/scene/tile-publish-queue';
import { TileResidency } from './render/scene/tile-residency';
import { viewPriority } from './render/scene/view-priority';
import { symbolFrame } from './render/symbol/symbol-frame';
import { sameViewProjection } from './render/symbol/symbol-placement';
import { SymbolTileRenderer } from './render/symbol/symbol-renderer';
import { isClampHeightReference, VectorTileRenderer } from './render/vector/vector-tile-renderer';
import { loadStyle } from './style/load-style';
import { Style as StyleClass } from './style/style';
import { isRasterStyleLayer } from './style/style-layer/raster-style-layer';
import { RGBAImage } from './util/image';

/**
 * The frame state fields the tileset consumes. Structural type so the class
 * does not depend on Cesium's private FrameState declaration.
 */
export type { RenderFrameState } from './render/scene/render-frame';

export type { CesiumVectorTilesetFromUrlOptions, CesiumVectorTilesetOptions } from './tileset-options';

const prePassesUpdateCollection = (PrimitiveCollection.prototype as unknown as {
  prePassesUpdate: (state: RenderFrameState) => void;
}).prePassesUpdate;

const postPassesUpdateCollection = (PrimitiveCollection.prototype as unknown as {
  postPassesUpdate: (state: RenderFrameState) => void;
}).postPassesUpdate;

const requestRemovalFrame = () => true;

function ownerCollections(root: PrimitiveCollection, target: PrimitiveCollection): PrimitiveCollection[] | undefined {
  if (root.contains(target))
    return [root];
  for (let index = 0; index < root.length; index++) {
    const child = root.get(index);
    if (child instanceof PrimitiveCollection) {
      const owners = ownerCollections(child, target);
      if (owners)
        return [root, ...owners];
    }
  }
  return undefined;
}

/**
 * CesiumVectorTileset: renders a MapLibre style into a Cesium scene.
 *
 * The style pipeline (Style -> TilePyramid -> worker -> Tile) produces CPU
 * bucket geometry; the Cesium backend converts buckets into Cesium
 * Buffer*Collections, driven per frame by the camera covering computation.
 */
export class CesiumVectorTileset extends PrimitiveCollection {
  private _styleSpec: StyleSpecification;
  get styleSpec(): StyleSpecification {
    return this._styleSpec;
  }

  /** Reports style validation and source loading errors. */
  readonly errorEvent = new Event<(error: Error) => void>();
  private _style!: Style;
  private _vectorRenderer: VectorTileRenderer;
  private _renderLayerIndex!: RenderLayerIndex;
  private _styleEvaluation!: StyleEvaluation;
  private readonly _drawCommands = new DrawCommands();
  private _currentLightRevision = 0;
  private _tilePublishQueue: TilePublishQueue;
  private _ready = false;
  private _readySettled = false;
  private _readyResolve?: () => void;
  private _readyReject?: (reason?: unknown) => void;
  private _destroyed = false;
  private _sceneMode: SceneMode = SceneMode.SCENE3D;
  private readonly _zoomLevelsToOverscale: number;
  private readonly _localIdeographFontFamily: string | false;
  private _sceneCovering: SceneTileCovering;
  private _readyPromise!: Promise<void>;
  private _afterRender?: RenderFrameState['afterRender'];
  private _renderScene?: RenderFrameState['camera']['_scene'];
  private _removeSceneListeners: Array<() => void> = [];
  private _renderRequested = false;
  private _renderRequestGeneration = 0;
  private _lastShow?: boolean;
  private _symbolPlacementWake?: ReturnType<typeof setTimeout>;
  private _symbolPlacementDeadline?: number;
  private readonly _requestNextFrame = () => {
    this._renderRequested = false;
    const frame = this._tileWorkFrame;
    // postRender runs after Native drains afterRender. A camera render can
    // already service that old request before its callback reaches this tick.
    return !this._destroyed && !(frame?.successfulUpdate
      && frame.requestGeneration === this._renderRequestGeneration);
  };

  private readonly _requestRender = () => {
    if (this._destroyed)
      return;
    // Retain requests made before Cesium first observes the primitive. Idle
    // requestRenderMode scenes run prePassesUpdate but skip update entirely.
    this._renderRequested = true;
    this._renderRequestGeneration++;
    if (this._afterRender && !this._afterRender.includes(this._requestNextFrame)) {
      this._afterRender.push(this._requestNextFrame);
    }
    else if (!this._afterRender) {
      this._renderScene?.requestRender?.();
    }
  };

  private readonly _heightReference: HeightReference;
  private readonly _transformRequest?: RequestTransformFunction;
  private _backgroundRenderer = new BackgroundRenderer();
  private _sceneCollections: SceneCollections;
  /** Renderable tile count from the last update, for {@link stats}. */
  private _lastRenderableTiles = 0;
  /** Publish queue depth observed at the end of the last update. */
  private _lastPendingPublishes = 0;
  /** This tileset's commands in its last frame, before Cesium's render passes. */
  private _lastSubmittedCommands = 0;
  private _memoryBudgetDirty = true;

  private _rasterRenderer: RasterTileRenderer;
  private _patternRenderer: PatternTileRenderer;
  private _symbolRenderer: SymbolTileRenderer;
  private _lastPlacementView?: Float64Array;
  private _lastPlacementFrame?: number;
  private _tileResidency: TileResidency;
  private _sourceRenderSync: SourceRenderSync;
  private _drapeFrameNumber = 0;
  private readonly _fallbackBudgetScene = {};
  private _budgetScene?: object;
  private _sceneBudget?: SceneFrameBudgetLease;
  private readonly _loadingCameraCache: CoveringCache = new WeakMap();
  private _loadingCameraPose?: object;
  private _loadingCameraChangedAt = 0;
  private _loadingContinuationMs = 0;
  private _tileWorkFrame?: {
    frameNumber?: number;
    budget: FrameBudget;
    requestGeneration: number;
    successfulUpdate: boolean;
  };

  /**
   * CSS-pixel widths must land on device pixels. Cesium's polyline shader
   * already multiplies by scene.pixelRatio (frameState.pixelRatio), so geometry
   * compensates with the device pixel ratio divided by the scene pixel ratio.
   * When the scene uses the device pixel ratio, this factor is 1.
   */
  private _pixelRatioCompensation(frameState: RenderFrameState): number {
    const device = devicePixelRatio();
    const ratio = frameState.pixelRatio ?? 0;
    const scene = ratio > 0 ? ratio : 1;
    return device / scene;
  }

  /** Loads and initializes a style before returning a scene-ready primitive. */
  static async fromUrl(url: string, options?: CesiumVectorTilesetFromUrlOptions): Promise<CesiumVectorTileset> {
    const style = await loadStyle(url, options?.transformRequest, options?.signal);
    options?.signal?.throwIfAborted();
    const tileset = new CesiumVectorTileset({ ...options, style });
    const signal = options?.signal;
    const abort = () => tileset.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      await tileset.whenReady();
      signal?.throwIfAborted();
      return tileset;
    }
    catch (error) {
      if (!tileset.isDestroyed())
        tileset.destroy();
      signal?.throwIfAborted();
      throw error;
    }
    finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  constructor(options: CesiumVectorTilesetOptions) {
    // Renderer-owned children are retired at an explicit frame boundary below.
    // Letting PrimitiveCollection destroy them during remove() defeats the
    // pending-removal queue and can release a command buffer still referenced
    // by the previous frame.
    super({ show: options.show, destroyPrimitives: false });
    this._sceneCollections = new SceneCollections(
      this,
      () => this._requestRender(),
      tileId => this._symbolRenderer.isTilePlacementActive(tileId),
      collection => this._vectorRenderer.releaseDrapedCollection(collection),
      (collection, budget) => {
        const paint = this._vectorRenderer.refreshCollectionPaint(collection, this._paintFrame(budget));
        for (const { tileId, old, replacement } of paint.replacements) {
          this._sceneCollections.replaceWhenReady(tileId, old, replacement);
        }
        return paint.ready;
      },
    );
    this._sceneCovering = new SceneTileCovering(() => {
      if (!this._destroyed && this.show && this._ready) {
        this._requestRender();
      }
    });
    this._styleSpec = options.style;
    this._heightReference = options.heightReference ?? HeightReference.NONE;
    this._transformRequest = options.transformRequest;
    this._zoomLevelsToOverscale = Math.max(0, options.zoomLevelsToOverscale ?? 4);
    // MapLibre renders CJK ideographs locally by default; a tileset created
    // without the option must keep that behavior or Chinese/Japanese/Korean
    // labels vanish whenever the glyph server does not carry the range.
    this._localIdeographFontFamily = options.localIdeographFontFamily ?? 'sans-serif';
    this._style = new StyleClass(this._transformRequest, {
      localIdeographFontFamily: this._localIdeographFontFamily,
      // Sprite @2x selection, `{ratio}` tile URLs and worker bucket pixel
      // ratios all read this; leaving it at the default 1 would make every
      // HiDPI tileset fetch and render 1x resources.
      pixelRatio: devicePixelRatio(),
    });
    this._vectorRenderer = new VectorTileRenderer(1, this._style.dashAtlas);
    this._rasterRenderer = new RasterTileRenderer();
    this._patternRenderer = new PatternTileRenderer();
    this._symbolRenderer = new SymbolTileRenderer();
    this._tilePublishQueue = new TilePublishQueue({
      vector: this._vectorRenderer,
      raster: this._rasterRenderer,
      pattern: this._patternRenderer,
      symbol: this._symbolRenderer,
      style: () => this._style,
      styleZoom: () => this._styleEvaluation.zoom,
      lightRevision: () => this._currentLightRevision,
      sceneMode: () => this._sceneMode,
      layerOrder: () => this._renderLayerIndex.order,
      symbolLayers: sourceId => this._renderLayerIndex.symbolForSource(sourceId),
      patternLayers: sourceId => this._renderLayerIndex.patternForSource(sourceId),
      rasterLayers: sourceId => this._renderLayerIndex.rasterForSource(sourceId),
      rasterSource: sourceId => rasterSourceInfo(this._style.tilePyramids[sourceId]?.getSource()),
      isRenderable: (sourceId, tileKey) => this._style.tilePyramids[sourceId]?.isRenderableId(tileKey) ?? false,
      publish: result => this._tileResidency.commit(result),
      publishPattern: (sourceId, tileID, update) => {
        this._tileResidency.published(sourceId, tileID);
        if (update) {
          this._sceneCollections.applyPatternUpdate(update);
        }
        this._memoryBudgetDirty = true;
      },
      requestRender: () => this._requestRender(),
    });
    this._tileResidency = new TileResidency({
      vector: this._vectorRenderer,
      raster: this._rasterRenderer,
      pattern: this._patternRenderer,
      symbol: this._symbolRenderer,
      publishQueue: this._tilePublishQueue,
      scene: this._sceneCollections,
      fadeDuration: () => this._style.fadeDuration,
      paintFrame: () => this._paintFrame(),
    });
    this._sourceRenderSync = new SourceRenderSync({
      raster: this._rasterRenderer,
      publishQueue: this._tilePublishQueue,
      residency: this._tileResidency,
      scene: this._sceneCollections,
    });
    this._vectorRenderer.setDraping(undefined, this._heightReference);
    if (options.gpuMemoryBudgetBytes !== undefined)
      this._tileResidency.setMemoryBudgetBytes(options.gpuMemoryBudgetBytes);

    this._initStyle(options.style);
  }

  private _paintFrame(budget?: Budget): VectorPaintFrame {
    const transitions = this._style.getRenderTransitionFlags();
    return {
      zoom: this._styleEvaluation.zoom,
      evaluationId: this._styleEvaluation.evaluationId,
      styleRevision: this._style.styleRevision,
      force: transitions.vector,
      transitionLayerIds: transitions.vectorLayerIds,
      pixelRatio: this._vectorRenderer.pixelRatio,
      lightRevision: this._currentLightRevision,
      budget,
    };
  }

  private _initStyle(styleSpec: StyleSpecification): void {
    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    const resolveReady = this._readyResolve!;
    const rejectReady = this._readyReject;
    this._renderLayerIndex = new RenderLayerIndex(this._style);
    this._styleEvaluation = new StyleEvaluation(this._style, this._renderLayerIndex);
    this._style.triggerRepaint = () => this._requestRender();
    this._style.zoomLevelsToOverscale = this._zoomLevelsToOverscale;
    this._style.on('data', this._onStyleData);
    this._style.on('style.load', () => {
      if (this._readySettled || this._destroyed) {
        return;
      }
      this._readySettled = true;
      this._readyReject = undefined;
      this._ready = true;
      this._renderLayerIndex.rebuildIndex();
      this._buildRasterLayers();
      this._buildPatternLayers();
      this._backgroundRenderer.reset();
      this._styleEvaluation.acceptVisibility();
      this._requestRender();
      resolveReady();
    });
    this._style.on('error', (event) => {
      if (this._destroyed) {
        return;
      }
      this.errorEvent.raiseEvent(event.error);
      // Validation errors can prevent Style.loadJSON from ever emitting
      // style.load. Reject the public readiness promise instead of leaving
      // callers waiting forever. Source errors after style.load remain
      // ordinary source events and do not affect readiness.
      if (!this._readySettled && !this._destroyed) {
        this._readySettled = true;
        rejectReady?.(event.error);
      }
    });
    this._style.loadJSON(styleSpec);
  }

  private _onStyleData = (event: SourceDataEvent | StyleDataEvent): void => {
    if (this._destroyed) {
      return;
    }
    if (event.dataType === 'source' && event.tile) {
      this._onTileData(event);
    }
    if (event.dataType === 'style'
      || (event.dataType === 'source' && (event.tile || event.sourceDataType === 'content' || event.sourceDataType === 'metadata' || event.sourceDataType === 'idle'))) {
      this._requestRender();
    }
  };

  get ready(): boolean {
    return this._ready;
  }

  private _assertNotDestroyed(): void {
    // Cesium's destroyObject replaces enumerable functions. Native class
    // methods are non-enumerable, so public operations need this guard too.
    if (this._destroyed)
      throw new DeveloperError('This object was destroyed, i.e., destroy() was called.');
  }

  /** Resolves when the style has loaded. */
  whenReady(): Promise<void> {
    this._assertNotDestroyed();
    return this._readyPromise;
  }

  /** Adds a named RGBA image for icons or patterns and refreshes affected tiles. */
  addImage(
    id: string,
    image: TilesetImage,
    options: TilesetImageOptions = {},
  ): void {
    this._assertNotDestroyed();
    this._style.addImage(id, {
      data: new RGBAImage({ width: image.width, height: image.height }, image.data),
      pixelRatio: options.pixelRatio ?? 1,
      sdf: options.sdf ?? false,
      stretchX: options.stretchX,
      stretchY: options.stretchY,
      content: options.content,
      version: 0,
    });
  }

  updateImage(
    id: string,
    image: TilesetImage,
    options: Pick<TilesetImageOptions, 'pixelRatio' | 'sdf'> = {},
  ): void {
    this._assertNotDestroyed();
    const previous = this._style.getImage(id);
    this._style.updateImage(id, {
      ...previous,
      data: new RGBAImage({ width: image.width, height: image.height }, image.data),
      pixelRatio: options.pixelRatio ?? previous.pixelRatio,
      sdf: options.sdf ?? previous.sdf,
    });
  }

  removeImage(id: string): void {
    this._assertNotDestroyed();
    this._style.removeImage(id);
  }

  /**
   * Rescale the global GPU memory budget (see GpuMemoryBudget). Overflow
   * evicts retired tiles oldest-first; live tiles are never evicted.
   *
   * A shrink requests a frame so it also takes effect under requestRenderMode.
   */
  setGpuMemoryBudgetBytes(bytes: number): void {
    this._assertNotDestroyed();
    this._tileResidency.setMemoryBudgetBytes(bytes);
    this._memoryBudgetDirty = true;
    this._requestRender();
  }

  /**
   * Snapshot of the internal render state, for diagnosing cost without a
   * profiler. Reads only cached counters, so calling it per frame is cheap.
   *
   * `submittedCommands` counts commands added in this tileset's last update,
   * before Cesium's visibility, frustum, and OIT processing.
   * `gpuMemory` covers tile residency; `renderPassGpuBytes` reports this
   * tileset's offscreen attachments separately from the tile cache budget.
   */
  stats(): TilesetStats {
    this._assertNotDestroyed();
    const bucket = this._vectorRenderer.stats;
    const symbol = this._symbolRenderer.stats;
    const pattern = this._patternRenderer.stats;
    const raster = this._rasterRenderer.stats;
    return {
      renderableTiles: this._lastRenderableTiles,
      pendingPublishes: this._lastPendingPublishes,
      bucket,
      symbol,
      pattern,
      raster,
      featureIndexes: this._tileResidency.featureIndexCount,
      gpuMemory: this._tileResidency.memoryStats(),
      renderPassGpuBytes: this._drawCommands.extrusionGpuBytes,
      submittedCommands: this._lastSubmittedCommands,
    };
  }

  /** Whether the current source data and geometry uploads have finished. */
  get tilesLoaded(): boolean {
    return this._ready && !this._destroyed && this._style.loaded()
      && this._tilePublishQueue.size === 0
      && this._sceneCollections.pendingFirstUpdateCount === 0
      && !this._vectorRenderer.needsPaintUpdate
      && !(this._symbolRenderer.hasDrawableSymbols && this._symbolRenderer.hasPendingWork);
  }

  /**
   * Hot-swap the style. Runs the style diff (unchanged sources keep their
   * tile cache) and rebuilds only the affected layer collections.
   */
  setStyle(nextStyle: StyleSpecification): void {
    this._assertNotDestroyed();
    const previousStyle = this._style.serialize()!;
    const cameraPaint = this._vectorRenderer.captureLivePaint();
    // Style preflights unsupported operations before applying the diff.
    // Failures reach the caller without silently discarding a working scene.
    if (!this._style.setState(nextStyle)) {
      return;
    }
    this._styleSpec = nextStyle;
    const changes = diffStyles(previousStyle, nextStyle);
    const paintOnly = changes.every((change) => {
      if (change.command === 'setLight' || change.command === 'setTransition' || change.command === 'setProjection') {
        return true;
      }
      if (change.command !== 'setPaintProperty') {
        return false;
      }
      const layerId = change.args[0] as string;
      const layer = this._style.getLayer(layerId);
      // MapLibre marks paint changes that need new worker attributes as
      // layer updates. Their old buckets must keep their committed paint.
      if (!layer || layer.type === 'symbol' || this._style._updatedLayers[layerId]) {
        return false;
      }
      const previous = previousStyle.layers.find(layer => layer.id === layerId)!;
      const track = (spec: StyleSpecification['layers'][number]): string => {
        const paint = spec.paint as Record<string, unknown> | undefined;
        if (paint?.[`${spec.type}-pattern`] != null) {
          return 'pattern';
        }
        return spec.type === 'line' && paint?.['line-dasharray'] != null ? 'dash' : spec.type;
      };
      return track(previous) === track(layer.serialize());
    });
    if (paintOnly) {
      // Existing paint updaters own material/attribute changes and request
      // continuation when a write needs a GPU upload. Geometry stays resident.
      this._vectorRenderer.invalidatePaint();
      this._requestRender();
      return;
    }
    this._vectorRenderer.freezePaint(cameraPaint);
    this._tilePublishQueue.clear();
    this._renderLayerIndex.rebuildIndex();
    this._sceneCollections.flushRemovals();
    const sourceIds = new Set(Object.keys(nextStyle.sources));
    const addedSourceIds = new Set(nextStyle.layers.flatMap(layer => 'source' in layer && !(layer.source in previousStyle.sources) ? [layer.source] : []));
    this._tileResidency.reconcileSources(sourceIds, addedSourceIds, new Map(previousStyle.layers.map((layer, index) => [layer.id, index])));
    for (const sourceId in this._style._updatedSources) {
      if (this._style._updatedSources[sourceId] === 'reload'
        && sourceId in previousStyle.sources && sourceIds.has(sourceId)) {
        this._tileResidency.beginSourceReplacement(sourceId);
      }
    }
    for (const change of changes) {
      if (change.command === 'addSource') {
        const sourceId = change.args[0] as string;
        if (sourceId in previousStyle.sources) {
          this._tileResidency.beginSourceReplacement(sourceId);
        }
      }
    }
    // Pooled geometry predates the layout change. Live geometry is handed
    // over by SceneCollections only after its successor is ready to draw.
    const previousLayerIds = new Set(previousStyle.layers.map(layer => layer.id));
    for (const { collections } of this._vectorRenderer.evictRetiredIntersectingLayers(previousLayerIds, () => false)) {
      for (const collection of collections) {
        this._sceneCollections.deferDestroy(collection);
      }
    }
    // Surviving source tiles need new scene geometry for the new style.
    this._buildRasterLayers();
    this._buildPatternLayers();

    // Style diffing keeps unchanged source tiles in TilePyramid caches. They
    // do not emit a new tile event merely because this tileset renderer was
    // rebuilt, so hydrate the new collections from the visible tiles now.
    this._hydrateRenderableTiles();
    this._backgroundRenderer.reset();
    this._styleEvaluation.acceptVisibility();
    this._requestRender();
  }

  /**
   * Raster layers are kept in style order so asynchronously arriving tiles do
   * not reorder imagery. Cached tiles are hydrated by setStyle immediately
   * after this method returns.
   */
  private _buildRasterLayers(): void {
    this._sourceRenderSync.reset();
    this._memoryBudgetDirty = true;
    this._sceneCollections.applyRasterUpdate(this._rasterRenderer.setLayers([...this._renderLayerIndex.rasterLayers], this._renderLayerIndex.order));
    for (const collection of this._rasterRenderer.collections.values()) {
      this._sceneCollections.add(collection);
    }
  }

  private _buildPatternLayers(): void {
    // Parked builds belong to the previous layer plan; committed tiles stay
    // drawable until SceneCollections accepts their replacements.
    this._tilePublishQueue.clearPatternRefreshes();
    this._sceneCollections.applyPatternUpdate(this._patternRenderer.clearRetired());
    this._sceneCollections.applyPatternUpdate(this._patternRenderer.setLayers([...this._renderLayerIndex.patternLayers], this._renderLayerIndex.order));
    for (const collection of this._patternRenderer.collections.values()) {
      this._sceneCollections.add(collection);
    }
  }

  private _hydrateRenderableTiles(): void {
    for (const sourceId in this._style.tilePyramids) {
      const tilePyramid = this._style.tilePyramids[sourceId];
      for (const tileId of tilePyramid.getRenderableIds()) {
        const tile = tilePyramid.getTileByID(tileId);
        if (tile) {
          this._tilePublishQueue.enqueue(sourceId, tile);
        }
      }
    }
  }

  private _rebuildRenderableTiles(previousMode: SceneMode): void {
    this._tilePublishQueue.clear();
    const planarSwitch = (previousMode === SceneMode.SCENE2D && this._sceneMode === SceneMode.COLUMBUS_VIEW)
      || (previousMode === SceneMode.COLUMBUS_VIEW && this._sceneMode === SceneMode.SCENE2D);
    this._vectorRenderer.freezePaint();
    if (!planarSwitch) {
      for (const collection of this._vectorRenderer.removeModeSpecificCollections()) {
        this._sceneCollections.detachForDestruction(collection);
      }
      this._buildRasterLayers();
      this._buildPatternLayers();
    }
    for (const { collections } of this._vectorRenderer.evictRetiredIntersectingLayers(new Set(this._style._getLayerOrder()), () => false)) {
      for (const collection of collections) this._sceneCollections.deferDestroy(collection);
    }
    // Native lines and buildings carry both coordinate tracks. Publication
    // keeps them visible until the target generation has actually uploaded.
    this._hydrateRenderableTiles();
  }

  /** Reuse resident geometry and publish only newly visible, missing layers. */
  private _publishVisibleLayers(newlyVisible: ReadonlySet<string>): void {
    if (newlyVisible.size === 0)
      return;
    for (const sourceId in this._style.tilePyramids) {
      const pyramid = this._style.tilePyramids[sourceId];
      for (const key of pyramid.getRenderableIds()) {
        const tile = pyramid.getTileByID(key);
        if (tile)
          this._tilePublishQueue.ensureVisibleLayers(sourceId, tile, newlyVisible);
      }
    }
  }

  /**
   * Cesium invokes this hook even when demand rendering skips the draw pass.
   * Observe insertion and visibility here so consumers never need to wake the
   * scene themselves after adding or toggling this primitive.
   */
  prePassesUpdate(frameState: RenderFrameState): void {
    this._assertNotDestroyed();
    const scene = frameState.camera._scene;
    if (scene !== this._renderScene) {
      this._releaseScene();
      this._renderScene = scene;
      this._bindFrameBudget(scene);
      // Observe before Cesium's first preRender so placement can use that
      // frame's complete camera snapshot instead of waiting for another draw.
      this._sceneCovering.observe(scene);
      const owners = (scene?.primitives && ownerCollections(scene.primitives, this)) ?? [];
      for (let index = 0; index < owners.length; index++) {
        const child = owners[index + 1] ?? this;
        this._removeSceneListeners.push(owners[index].primitiveRemoved.addEventListener((removed) => {
          if (removed === child) {
            this._requestRemovalFrame();
            this._releaseScene();
          }
        }));
      }
    }
    this._afterRender = frameState.afterRender;
    this._updateLoadingService(frameState);
    if (!this.show)
      this._cancelSymbolPlacementWake();
    if (this._lastShow !== this.show) {
      this._lastShow = this.show;
      if (!this.show)
        this._vectorRenderer.undrapeAll();
      this._requestRender();
    }
    else if (this._renderRequested) {
      this._requestRender();
    }
    const idlePreparationsEnabled = this._cpuPreparationsEnabled(frameState);
    this._sceneCollections.idlePreparationsEnabled = idlePreparationsEnabled;
    this._tilePublishQueue.idlePreparationsEnabled = idlePreparationsEnabled;
    if (frameState.newFrame === false && this.show && this._ready && scene?.mode === frameState.mode
      && this._symbolRenderer.observeIdlePlacement()) {
      this._continueSymbolPlacement();
    }
    if (idlePreparationsEnabled && frameState.newFrame === false)
      this._advanceIdlePreparations(frameState);
    Reflect.apply(prePassesUpdateCollection, this, [frameState]);
  }

  private _cpuPreparationsEnabled(frameState: RenderFrameState): boolean {
    const scene = frameState.camera._scene;
    if (scene?.requestRenderMode !== true || scene.mode !== frameState.mode)
      return false;
    if (frameState.mode === SceneMode.SCENE3D)
      return true;
    const projection = frameState.mapProjection ?? scene.mapProjection;
    return frameState.mode === SceneMode.COLUMBUS_VIEW && frameState.scene3DOnly !== true
      && (projection instanceof GeographicProjection || projection instanceof WebMercatorProjection);
  }

  private _updateLoadingService(frame: RenderFrameState): void {
    this._loadingContinuationMs = 0;
    const supportedMode = frame.mode === SceneMode.SCENE3D || frame.mode === SceneMode.COLUMBUS_VIEW;
    const pose = this.show && this._ready && supportedMode && frame.camera._scene?.mode === frame.mode
      ? cameraPoseForFrame(frame, this._loadingCameraCache, frame.mode)
      : undefined;
    const now = performance.now();
    if (pose !== this._loadingCameraPose) {
      this._loadingCameraPose = pose;
      this._loadingCameraChangedAt = now;
    }
    // A paused load can trade a larger work slice for fewer redraws. Restore
    // ordinary service immediately when the actual camera or viewport moves.
    if (pose && now - this._loadingCameraChangedAt >= 200
      && !this._style._changed && !this._style.getRenderTransitionFlags().any
      && (this._sceneCollections.pendingFirstUpdateCount > 0 || this._tilePublishQueue.size > 0)) {
      this._loadingContinuationMs = 12;
    }
  }

  private _advanceIdlePreparations(frameState: RenderFrameState): void {
    if (!this.show || !this._ready || this._destroyed || this._renderRequested
      || !this._cpuPreparationsEnabled(frameState) || frameState.camera._scene !== this._renderScene) {
      return;
    }
    const cpuUpload = this._sceneCollections.hasRunnablePreparations;
    const resources = this._sceneCollections.hasRunnableResourceUploads;
    const upload = cpuUpload || resources;
    const builds = this._tilePublishQueue.inspectBuilds();
    if (!upload && !builds.runnable && !builds.renderNeeded)
      return;
    // Prepared resources are immutable; changed paint inputs only gate CPU work.
    const cpuAllowed = !this._style._changed && !this._style.getRenderTransitionFlags().any
      && this._vectorRenderer.pixelRatio === this._pixelRatioCompensation(frameState);
    if (!cpuAllowed) {
      this._requestRender();
    }
    const frameWork = this._bindFrameBudget(frameState.camera._scene).frame(frameState.frameNumber);
    const runnable = {
      upload: (cpuAllowed && cpuUpload) || resources,
      build: cpuAllowed && builds.runnable,
      paint: this._vectorRenderer.needsPaintUpdate,
      placement: this._symbolRenderer.hasRunnableWork,
    };
    if (runnable.upload) {
      const budget = frameWork.continuation('upload', runnable, this._loadingContinuationMs) ?? frameWork.tileBudget;
      const minimum = budget !== frameWork.tileBudget;
      const cpuProgress = cpuAllowed
        ? this._sceneCollections.advancePreparations(frameState, budget, operation => frameWork.measure(operation), minimum)
        : { units: 0, renderNeeded: false };
      const resourceProgress = this._sceneCollections.advanceResourceUploads(frameState, budget, frameWork.tileBudget, operation => frameWork.measure(operation), minimum && cpuProgress.units === 0);
      if (cpuProgress.renderNeeded || resourceProgress.renderNeeded)
        this._requestRender();
    }
    if (cpuAllowed && builds.runnable && !this._renderRequested) {
      const budget = frameWork.continuation('build', runnable, this._loadingContinuationMs) ?? frameWork.tileBudget;
      const progress = frameWork.measure(() => this._tilePublishQueue.advanceBuilds(budget));
      if (progress.renderNeeded)
        this._requestRender();
    }
    if (builds.renderNeeded && !this._renderRequested)
      this._requestRender();
  }

  /** Spend the completed draw's remaining time on CPU preparation and resource writes. */
  postPassesUpdate(frameState: RenderFrameState): void {
    Reflect.apply(postPassesUpdateCollection, this, [frameState]);
    const scene = frameState.camera._scene;
    const tileWork = this._tileWorkFrame;
    if (!this.show || !this._ready || this._destroyed || frameState.newFrame !== true
      || !this._cpuPreparationsEnabled(frameState) || scene !== this._renderScene
      || !tileWork?.successfulUpdate || tileWork.frameNumber !== frameState.frameNumber) {
      return;
    }
    const frameWork = this._bindFrameBudget(scene).frame(frameState.frameNumber);
    if (tileWork.budget !== frameWork.tileBudget)
      return;
    const cpuAllowed = !this._style._changed && !this._style.getRenderTransitionFlags().any
      && this._vectorRenderer.pixelRatio === this._pixelRatioCompensation(frameState);
    if (!cpuAllowed) {
      this._requestRender();
    }
    const prepared = frameWork.prepareAfterPasses((budget) => {
      const upload = (cpuAllowed && this._sceneCollections.hasRunnablePreparations) || this._sceneCollections.hasRunnableResourceUploads;
      const builds = this._tilePublishQueue.inspectBuilds();
      if (upload) {
        const cpuProgress = cpuAllowed
          ? this._sceneCollections.advancePreparations(frameState, budget, operation => frameWork.measure(operation), false)
          : { units: 0, renderNeeded: false };
        const resourceProgress = this._sceneCollections.advanceResourceUploads(frameState, budget, frameWork.tileBudget, operation => frameWork.measure(operation), false);
        if (cpuProgress.renderNeeded || resourceProgress.renderNeeded)
          this._requestRender();
      }
      if (cpuAllowed && !budget.exhausted && builds.runnable) {
        const progress = frameWork.measure(() => this._tilePublishQueue.advanceBuilds(budget));
        if (progress.renderNeeded)
          this._requestRender();
      }
    });
    if (!prepared && this._sceneCollections.hasRunnableResourceUploads) {
      // Reuse the physical tick's single overload token after all Native draws.
      const runnable = {
        upload: true,
        build: cpuAllowed && this._tilePublishQueue.size > 0,
        paint: this._vectorRenderer.needsPaintUpdate,
        placement: this._symbolRenderer.hasRunnableWork,
      };
      const budget = frameWork.continuation('upload', runnable, this._loadingContinuationMs);
      if (budget && budget !== frameWork.tileBudget) {
        const progress = this._sceneCollections.advanceResourceUploads(frameState, budget, frameWork.tileBudget, operation => frameWork.measure(operation), true);
        if (progress.renderNeeded)
          this._requestRender();
      }
    }
  }

  private _requestRemovalFrame(): void {
    if (this._afterRender) {
      if (!this._afterRender.includes(requestRemovalFrame))
        this._afterRender.push(requestRemovalFrame);
    }
    else {
      this._renderScene?.requestRender?.();
    }
  }

  private _releaseScene(): void {
    this._loadingCameraPose = undefined;
    this._loadingContinuationMs = 0;
    this._cancelSymbolPlacementWake();
    for (const remove of this._removeSceneListeners)
      remove();
    this._removeSceneListeners = [];
    if (this._afterRender) {
      const pending = this._afterRender.indexOf(this._requestNextFrame);
      if (pending !== -1)
        this._afterRender.splice(pending, 1);
    }
    this._afterRender = undefined;
    this._renderScene = undefined;
    this._lastShow = undefined;
    this._lastPlacementFrame = undefined;
    this._lastPlacementView = undefined;
    this._tileWorkFrame = undefined;
    this._sceneBudget?.release();
    this._sceneBudget = undefined;
    this._budgetScene = undefined;
    this._sceneCollections.idlePreparationsEnabled = false;
    this._tilePublishQueue.idlePreparationsEnabled = false;
    this._renderRequested = true;
    this._sceneCovering.destroy();
    this._vectorRenderer.setDraping(undefined, this._heightReference);
  }

  private _bindFrameBudget(scene: RenderFrameState['camera']['_scene']): SceneFrameBudgetLease {
    const owner = scene ?? this._fallbackBudgetScene;
    if (this._budgetScene !== owner) {
      this._sceneBudget?.release();
      this._budgetScene = owner;
      this._sceneBudget = acquireSceneFrameBudget(owner, this, () => this.show && this._ready && !this._destroyed);
      this._tileWorkFrame = undefined;
    }
    return this._sceneBudget!;
  }

  /**
   * Cesium PrimitiveCollection#update: drives the covering computation from
   * the camera and refreshes the Buffer*Collections for loaded tiles.
   */
  update(frameState: RenderFrameState): void {
    this._assertNotDestroyed();
    // A later viewport must also finish successfully before the physical
    // frame may consume its old wake. An exception retains the pending debt.
    if (this._tileWorkFrame)
      this._tileWorkFrame.successfulUpdate = false;
    if (!this._destroyed) {
      // Cesium consumes this queue even when requestRenderMode skips drawing.
      // Bind before readiness so asynchronous style loading can wake rendering.
      this._afterRender = frameState.afterRender;
      this._vectorRenderer.setDraping(frameState.camera._scene?.vectorProvider, this._heightReference);
    }
    this._sceneCollections.flushRemovals();
    if (this._destroyed || !this.show || !this._ready) {
      this._lastSubmittedCommands = 0;
      if (!this._destroyed) {
        // The base PrimitiveCollection.update no-ops for hidden primitives, so
        // a hidden tileset must not drive covering/style/tile updates. A
        // destroyed tileset has already released everything it owns.
        this._sceneCollections.updateChildren(frameState);
      }
      return;
    }

    // StyleImages suppresses duplicate render-callback dispatches within one
    // frame. The tileset owns the frame boundary because Cesium, rather than a
    // MapLibre map loop, drives this renderer.
    this._updateLoadingService(frameState);
    const frameWork = this._bindFrameBudget(frameState.camera._scene).frame(frameState.frameNumber);
    const previousBudget = this._tileWorkFrame?.budget === frameWork.tileBudget
      ? this._tileWorkFrame.budget
      : undefined;
    // Camera coverage and style preparation consume this frame's allowance
    // before uploads and builds. Reuse the deadline across Cesium viewports.
    const frameBudget = frameWork.tileBudget;
    if (!previousBudget) {
      this._tileWorkFrame = {
        frameNumber: frameState.frameNumber,
        budget: frameBudget,
        requestGeneration: this._renderRequestGeneration,
        successfulUpdate: false,
      };
    }
    const tileWorkFrame = this._tileWorkFrame!;
    if (!previousBudget)
      this._style.images.beginFrame();

    const sceneMode = frameState.mode ?? SceneMode.SCENE3D;
    const previousSceneMode = this._sceneMode;
    const geometryChanged = sceneMode !== previousSceneMode;
    this._sceneMode = sceneMode;

    // The scene globe is reachable through the frame state via the camera's
    // private Scene back-reference (frameState.camera._scene.globe); the
    // tileset deliberately accepts no globe through its public entry points.
    // Read it fresh every frame so a globe added or swapped later takes
    // effect. Only its completed rendered tile selection supplies coverage.
    this._sceneCovering.observe(frameState.camera._scene);

    const coverings: Array<{
      sourceId: string;
      tilePyramid: Style['tilePyramids'][string];
      covering?: ReturnType<SceneTileCovering['covering']>;
    }> = [];
    for (const sourceId in this._style.tilePyramids) {
      const tilePyramid = this._style.tilePyramids[sourceId];
      const covering = this._sceneCovering.covering(tilePyramid, frameState, this._zoomLevelsToOverscale);
      coverings.push({ sourceId, tilePyramid, covering });
    }

    const coveringZoom = coverings.find(item => item.covering !== undefined)?.covering?.styleZoom;
    const evaluatedStyle = this._styleEvaluation.evaluate(coveringZoom);
    this._currentLightRevision = evaluatedStyle.lightRevision;
    this._vectorRenderer.lighting = evaluatedStyle.lighting;
    const transitionFlags = evaluatedStyle.transitions;
    if (geometryChanged) {
      this._renderLayerIndex.rebuildIndex();
      this._rebuildRenderableTiles(previousSceneMode);
    }
    else if (evaluatedStyle.visibility) {
      // Visibility is evaluated at command submission, independently of
      // geometry residency. Only tracks whose layer plan changed are updated.
      const { flipped } = evaluatedStyle.visibility;
      this._renderLayerIndex.rebuildIndex();
      // Globe draping consumes the visibility change on its next beginFrame.
      if (isClampHeightReference(this._heightReference))
        this._requestRender();
      for (const layerId of flipped) {
        const layer = this._style.getLayer(layerId);
        if (layer && isRasterStyleLayer(layer)) {
          this._buildRasterLayers();
          break;
        }
      }
      for (const layerId of flipped) {
        const layer = this._style.getLayer(layerId);
        if (layer && (isPatternStyleLayer(layer))) {
          this._buildPatternLayers();
          break;
        }
      }
      // Reconcile the surviving source tiles against the rebuilt layers.
    }
    if (transitionFlags.any) {
      // Cesium's requestRenderMode only runs update() for requested frames.
      // Keep MapLibre-style source/video/canvas and paint transitions alive.
      this._requestRender();
    }
    const pixelRatioCompensation = this._pixelRatioCompensation(frameState);
    this._vectorRenderer.pixelRatio = pixelRatioCompensation;
    let totalRenderable = 0;
    let retiredCapacity = 0;
    let residentChanged = false;
    let sourceFeatureStateChanged = false;
    for (const { sourceId, tilePyramid, covering } of coverings) {
      const result = frameWork.measure(() => this._sourceRenderSync.updateSource(sourceId, tilePyramid, covering, {
        mode: this._sceneMode,
        rasterLayers: this._renderLayerIndex.rasterForSource(sourceId),
        patternLayers: this._renderLayerIndex.patternForSource(sourceId),
        transitioningVectorLayers: transitionFlags.vectorLayerIds,
        styleRevision: this._style.styleRevision,
        imageUpdateRevision: this._style.images.imageUpdateRevision,
        budget: frameBudget,
      }));
      totalRenderable += result.renderableCount;
      retiredCapacity += tilePyramid._tileCache.max;
      residentChanged ||= result.changed;
      sourceFeatureStateChanged ||= result.featureStateChanged;
      this._memoryBudgetDirty ||= result.memoryChanged;
    }
    if (evaluatedStyle.visibility)
      this._publishVisibleLayers(evaluatedStyle.visibility.newlyVisible);
    this._tileResidency.syncRetiredCapacity(retiredCapacity);
    if (sourceFeatureStateChanged) {
      this._vectorRenderer.invalidatePaint();
    }
    // Native commands retain their material's samplers for this frame.
    // Refresh appearances before first updates can submit those commands.
    this._memoryBudgetDirty = this._symbolRenderer.refreshImages(this._style.images) || this._memoryBudgetDirty;
    const firstCommand = frameState.commandList?.length ?? 0;
    this._backgroundRenderer.update(this._style, frameState, this._sceneMode, this._requestRender);
    // Advance already committed resources before building more. Both stages
    // share one deadline, so a full build frame cannot repeatedly strand the
    // Native first-update queue. New commits request the following frame.
    this._memoryBudgetDirty ||= this._sceneCollections.pendingFirstUpdateCount > 0;
    const renderUpload = this._sceneCollections.hasRunnableFirstUpdates;
    const runnable = {
      upload: renderUpload || this._sceneCollections.hasRunnableResourceUploads,
      build: this._tilePublishQueue.size > 0,
      paint: this._vectorRenderer.needsPaintUpdate,
      placement: this._symbolRenderer.hasRunnableWork,
    };
    const uploadBudget = renderUpload ? frameWork.continuation('upload', runnable, this._loadingContinuationMs) ?? frameBudget : frameBudget;
    const pumped = this._sceneCollections.pumpFirstUpdates(frameState, uploadBudget, operation => frameWork.measure(operation), uploadBudget !== frameBudget, frameWork.tileBudget);
    // Select the current camera's tiles before spending the publish budget.
    // A quick pan can invalidate jobs queued by the preceding frame; drain()
    // must see the updated TilePyramid renderable set before building them.
    const buildBudget = frameWork.continuation('build', runnable, this._loadingContinuationMs) ?? frameBudget;
    if (this._tilePublishQueue.size > 0 && frameWork.measure(() => this._tilePublishQueue.drain(
      buildBudget,
      MAX_TILE_COMMITS,
      viewPriority(frameState),
      buildBudget !== frameBudget,
    )) > 0) {
      this._memoryBudgetDirty = true;
    }
    this._lastRenderableTiles = totalRenderable;
    this._lastPendingPublishes = this._tilePublishQueue.size;
    // A style mutation invalidates pooled symbol and pattern paints.
    if (evaluatedStyle.retiredPaintChanged) {
      this._sceneCollections.queueSymbolRemoval(this._symbolRenderer.clearRetired());
      this._sceneCollections.applyPatternUpdate(this._patternRenderer.clearRetired());
    }
    const paintFrame = {
      zoom: this._styleEvaluation.zoom,
      evaluationId: evaluatedStyle.evaluationId,
      force: transitionFlags.vector,
      styleRevision: this._style.styleRevision,
      transitionLayerIds: transitionFlags.vectorLayerIds,
      pixelRatio: pixelRatioCompensation,
      lightRevision: evaluatedStyle.lightRevision,
      budget: frameBudget,
    };
    this._vectorRenderer.updateLivePaint(paintFrame);
    const collectionReplacements = frameWork.run('paint', runnable, budget =>
      this._vectorRenderer.updatePaint({ ...paintFrame, budget }), this._loadingContinuationMs);
    if (this._vectorRenderer.needsPaintUpdate) {
      // Resume the records left by the frame paint budget.
      this._requestRender();
    }
    for (const { tileId, old, replacement } of collectionReplacements) {
      this._sceneCollections.replaceWhenReady(tileId, old, replacement);
    }
    const fadeOpacityOf = (tileId: string): number | undefined => {
      const slash = tileId.indexOf('/');
      const tilePyramid = this._style.tilePyramids[tileId.slice(0, slash)];
      return tilePyramid?.getRasterFadeOpacity(tileId.slice(slash + 1));
    };
    const rasterUpdate = this._rasterRenderer.update(
      this._style.renderRevision,
      transitionFlags.raster,
      transitionFlags.rasterLayerIds,
      fadeOpacityOf,
    );
    this._sceneCollections.applyRasterUpdate(rasterUpdate);
    if (rasterUpdate.added.length > 0 || rasterUpdate.removed.length > 0) {
      this._memoryBudgetDirty = true;
    }
    if (rasterUpdate.fading) {
      // A raster crossfade animates over time: keep frames coming until it
      // completes even though the camera and style are static.
      this._requestRender();
    }
    this._patternRenderer.pixelRatio = pixelRatioCompensation;
    this._patternRenderer.update(frameState.context);
    this._vectorRenderer.dashMaterial?.update(
      frameState.context,
      this._styleEvaluation.zoom,
      frameState.pixelRatio ?? devicePixelRatio(),
      this._style.getLayer(this._style._getLayerOrder()[0])?.getCrossfadeParameters(),
    );
    this._tickSymbolFades();
    this._updateSymbolPlacement(frameState, frameWork, runnable);
    // Publishing can add several renderer records after the renderable IDs
    // have already stabilized. Sync after all tracks' mutations, while a
    // settled frame still pays only the O(1) dirty check.
    if (residentChanged || this._memoryBudgetDirty) {
      this._tileResidency.syncMemoryBudget();
      this._memoryBudgetDirty = false;
    }
    if (this._tileResidency.syncHeldTileVisibility()) {
      this._memoryBudgetDirty = true;
      this._requestRender();
    }
    // Switch same-tile content only after its complete visible-owner layout
    // activates. A future placement alone cannot release the drawn generation.
    frameWork.measure(() => this._sceneCollections.finishReplacements(frameBudget));
    this._tileResidency.releaseReplacedFeatureIndices();
    // Draped collections are consumed by globe.beginFrame on the following
    // frame; their collection.update does not itself upload packed terrain data.
    if (frameState.frameNumber === undefined) {
      this._drapeFrameNumber += 1;
    }
    this._sceneCollections.syncDrapedVisibility(this._renderLayerIndex.visibility());
    if (this._vectorRenderer.markDrapedCollections(frameState.frameNumber ?? this._drapeFrameNumber, this._tileResidency.retainedLayerOrder ?? this._renderLayerIndex.order)) {
      this._requestRender();
    }
    // Draw completed collections after placement and visibility settle.
    // Newly queued resources enter Native preparation on the next frame.
    this._sceneCollections.updateChildren(frameState, pumped);
    this._drawCommands.prepare(frameState, firstCommand, this._sceneMode, this._tileResidency.retainedLayerOrder ?? this._renderLayerIndex.order, this._sceneCovering.scene, this._tileResidency.drawRanks, this._tileResidency.hiddenSurfaceLayers, this._tileResidency.hiddenStyleTiles, this._renderLayerIndex.visibility());
    this._lastSubmittedCommands = (frameState.commandList?.length ?? firstCommand) - firstCommand;
    // Symbol atlases and picking data must survive the last old color frame.
    // Native afterRender also covers both date-line viewports before release.
    if (frameState.passes?.render && this.tilesLoaded && this._tileResidency.retainedLayerOrder) {
      const revision = this._style.styleRevision;
      frameState.afterRender?.push(() => {
        if (!this._destroyed && this._style.styleRevision === revision && this.tilesLoaded
          && this._tileResidency.completeSourceReplacement()) {
          this._memoryBudgetDirty = true;
          this._requestRender();
          return true;
        }
        return false;
      });
    }
    tileWorkFrame.successfulUpdate = frameState.passes?.render === true && frameState.newFrame !== false;
  }

  /**
   * Tick symbol fade-outs: finished fades detach into the retired pool
   * (hide + remove, pooled inside the renderer), pool-overflow evictions go
   * out for destruction. Runs every frame; the renderer short-circuits an
   * empty fade set to one map lookup.
   */
  private _tickSymbolFades(): void {
    const { detach, destroy, active } = this._symbolRenderer.tickFades(performance.now());
    if (detach.length > 0 || destroy.length > 0) {
      this._memoryBudgetDirty = true;
    }
    for (const collection of detach) {
      collection.show = false;
      this._sceneCollections.detach(collection);
    }
    this._sceneCollections.queueSymbolRemoval(destroy);
    if (active) {
      // A fade animates over wall-clock time: keep frames coming until it
      // completes even though the camera and style are static.
      this._requestRender();
    }
  }

  private _updateSymbolPlacement(frameState: RenderFrameState, frameWork: SceneFrameWork, runnable: RunnableStages): void {
    if (!this._symbolRenderer.hasDrawableSymbols) {
      this._cancelSymbolPlacementWake();
      return;
    }
    if (frameState.frameNumber !== undefined && this._lastPlacementFrame === frameState.frameNumber) {
      return;
    }
    const snapshot = this._sceneCovering.cameraFrame;
    if (!snapshot || snapshot.frameNumber !== frameState.frameNumber) {
      // First observation happens inside a viewport update. Capture the
      // complete camera at the next preRender before placing any symbols.
      this._requestRender();
      return;
    }
    const view = symbolFrame(snapshot, this._styleEvaluation.zoom);
    const { viewProjection } = view;
    // The collision generation uses one full view; Cesium can draw that
    // generation through both of its date-line viewports.
    const viewChanged = !this._lastPlacementView || !sameViewProjection(viewProjection, this._lastPlacementView);
    if (viewChanged) {
      this._lastPlacementView = viewProjection;
    }
    // Drawing-buffer size in device pixels: the collision boxes are computed
    // in the same space the vertex shader offsets into (offsetPx uses
    // czm_pixelRatio, i.e. scene device pixels). A zero size (frameState
    // without a context, e.g. tests) would collapse every anchor onto one
    // point and hide all but the first label, so skip the pass instead.
    const { drawingBufferWidth: width, drawingBufferHeight: height } = snapshot;
    if (width <= 0 || height <= 0) {
      return;
    }
    // Composite symbol sizes interpolate in the vertex shader between the two
    // zoom stops packed per vertex; hand the live style zoom to the renderer.
    this._symbolRenderer.cameraZoom = this._styleEvaluation.zoom;
    this._symbolRenderer.update(view, viewChanged, frameState.context, operation => frameWork.run('placement', runnable, operation, this._loadingContinuationMs));
    this._lastPlacementFrame = frameState.frameNumber;
    this._continueSymbolPlacement();
  }

  private _cancelSymbolPlacementWake(): void {
    if (this._symbolPlacementWake !== undefined)
      clearTimeout(this._symbolPlacementWake);
    this._symbolPlacementWake = undefined;
    this._symbolPlacementDeadline = undefined;
  }

  private _continueSymbolPlacement(): boolean {
    // Read the deadline first: the clock may cross it before the runnable read.
    const deadline = this._symbolRenderer.nextPlacementTime;
    if (this._symbolRenderer.hasRunnableWork) {
      this._cancelSymbolPlacementWake();
      this._requestRender();
      return true;
    }
    if (deadline === undefined || !this.show || !this._ready || this._destroyed) {
      this._cancelSymbolPlacementWake();
      return false;
    }
    if (this._symbolPlacementDeadline === deadline)
      return false;
    this._cancelSymbolPlacementWake();
    this._symbolPlacementDeadline = deadline;
    const scene = this._renderScene;
    this._symbolPlacementWake = setTimeout(() => {
      this._symbolPlacementWake = undefined;
      this._symbolPlacementDeadline = undefined;
      if (this._destroyed || !this.show || !this._ready || this._renderScene !== scene)
        return;
      // The deadline may have moved after another scope committed. Recompute
      // it; only runnable work wakes Native, without waiting for an idle tick.
      if (this._continueSymbolPlacement())
        scene?.requestRender?.();
    }, Math.max(0, deadline - performance.now()));
    return false;
  }

  private _onTileData(event: SourceDataEvent): void {
    const tile: Tile | undefined = event.tile;
    if (!tile) {
      return;
    }
    // Every publish goes through the budgeted job queue: a dense tile
    // converts and bakes for hundreds of milliseconds, which must never run
    // synchronously in an event handler or a single frame (see
    // TilePublishQueue). The drain below keeps requesting frames while jobs
    // remain, so no extra latency handling is needed here.
    this._tilePublishQueue.enqueue(event.sourceId, tile);
  }

  /** Releases owned resources and returns undefined, following Cesium's lifecycle contract. */
  destroy(): undefined {
    this._assertNotDestroyed();
    // Removal destroys this primitive before another update can observe it.
    // The final frame must clear its old pixels even after its work is gone.
    this._requestRemovalFrame();
    this._releaseScene();
    this._destroyed = true;
    if (!this._readySettled) {
      this._readySettled = true;
      this._readyReject?.(new Error('CesiumVectorTileset was destroyed before it became ready'));
      this._readyReject = undefined;
    }
    this._afterRender = undefined;
    this._tilePublishQueue.clear();
    this._sourceRenderSync.reset();
    this._tileResidency.clear();
    this._sceneCollections.queueSymbolRemoval(this._symbolRenderer.removeAll());
    this._backgroundRenderer.destroy();
    this._drawCommands.destroy();
    this._style.destroy();
    this._sceneCollections.clearPendingReplacements();
    this._sceneCollections.flushRemovals();
    destroyRasterResources(this._rasterRenderer.clear());
    destroyPatternResources(this._patternRenderer.clear());
    const activeChildren = new Set<VectorCollection | PrimitiveCollection>([
      ...this._vectorRenderer.collections.values(),
      ...this._vectorRenderer.retiredCollections,
      ...this._rasterRenderer.collections.values(),
      ...this._patternRenderer.collections.values(),
    ]);
    for (const child of activeChildren) {
      this._sceneCollections.detach(child);
      if (!child.isDestroyed()) {
        child.destroy();
      }
    }
    // Detach draped fills from the scene vector provider before the
    // collections are destroyed; a marked collection outliving its buffers
    // would drape released GPU memory.
    this._vectorRenderer.undrapeAll();
    this._vectorRenderer.removeAll();
    this._vectorRenderer.dashMaterial?.destroy();
    super.destroy();
    return undefined;
  }

  /**
   * Resolve a pickObject (as produced by the Buffer*Collection primitives
   * under Scene#pick) into the hit layer and feature.
   */
  pick(pickObject: TilePickObject | RasterPrimitivePickObject | PatternPrimitiveID): {
    layerId: string;
    properties: Record<string, unknown>;
  } | undefined {
    this._assertNotDestroyed();
    if ('type' in pickObject && pickObject.type === 'raster') {
      if (!this._rasterRenderer.hasPickObject(pickObject)) {
        return undefined;
      }
      return { layerId: pickObject.layerId, properties: {} };
    }
    if ('type' in pickObject && pickObject.type === 'pattern'
      && !this._patternRenderer.hasPickObject(pickObject)) {
      return undefined;
    }
    const vectorPickObject = pickObject as TilePickObject;
    const featureIndex = 'type' in pickObject && pickObject.type === 'pattern'
      ? pickObject.tileFeatureIndex
      : this._tileResidency.featureIndex(vectorPickObject.tileId, vectorPickObject.generationId);
    if (!featureIndex) {
      return undefined;
    }
    const indexArray = featureIndex.featureIndexArray;
    let entry: ReturnType<typeof indexArray.get> | undefined;
    for (let i = 0; i < indexArray.length; i++) {
      const candidate = indexArray.get(i);
      const bucketLayerIds = featureIndex.bucketLayerIDs[candidate.bucketIndex] ?? [];
      if (candidate.featureIndex === vectorPickObject.featureIndex && bucketLayerIds.includes(vectorPickObject.layerId)) {
        entry = candidate;
        break;
      }
    }
    if (!entry) {
      return undefined;
    }
    const sourceLayerName = featureIndex.sourceLayerIds[entry.sourceLayerIndex];
    if (sourceLayerName === undefined) {
      return undefined;
    }
    const feature = featureIndex.features.getFeature(sourceLayerName, entry.featureIndex);
    if (!feature) {
      return undefined;
    }
    return {
      layerId: vectorPickObject.layerId,
      properties: feature.properties,
    };
  }
}

/** The tileset's CSS-to-device pixel ratio (sprites and imagery texels both use it). */
function devicePixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}
