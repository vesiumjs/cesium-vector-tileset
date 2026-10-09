import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type {
  Event,
} from 'cesium';
import type { Style } from '../../style/style';
import type { Tile } from '../../tile/tile';
import type { CesiumVectorTilesetOptions } from '../../tileset-options';
import type { TilesetImage, TilesetImageOptions, TilesetStats } from '../../tileset-types';
import type { SourceDataEvent, StyleDataEvent } from '../../util/events';
import type { RequestTransformFunction } from '../../util/request';
import type { PatternPrimitiveID } from '../pattern/pattern-renderer';
import type { RasterPrimitivePickObject } from '../raster/raster-renderer';
import type { TilePickObject } from '../vector/tile-conversion';
import type { VectorPaintFrame } from '../vector/vector-paint-updater';
import type { VectorCollection } from '../vector/vector-tile-renderer';
import type { Budget } from './frame-budget';
import type { RenderFrameState } from './render-frame';
import {
  DeveloperError,
  HeightReference,
  PrimitiveCollection,
  SceneMode,
} from 'cesium';
import { Style as StyleClass } from '../../style/style';
import { isRasterStyleLayer } from '../../style/style-layer/raster-style-layer';
import { browser } from '../../util/browser';
import { RGBAImage } from '../../util/image';
import { isPatternStyleLayer } from '../pattern/pattern-layer';
import { destroyPatternResources, PatternTileRenderer } from '../pattern/pattern-renderer';
import { destroyRasterResources, rasterSourceInfo, RasterTileRenderer } from '../raster/raster-renderer';
import { SymbolTileRenderer } from '../symbol/symbol-renderer';
import { isClampHeightReference, VectorTileRenderer } from '../vector/vector-tile-renderer';
import { BackgroundRenderer } from './background-renderer';
import { DrawCommands } from './draw-commands';
import { MAX_TILE_COMMITS } from './frame-budget';
import { FramePreparation, pixelRatioCompensation } from './frame-preparation';
import { pickedFeature } from './picked-feature';
import { RenderLayerIndex } from './render-layer-index';
import { SceneCollections } from './scene-collections';
import { SceneRenderWake } from './scene-render-wake';
import { SceneSymbolPlacement } from './scene-symbol-placement';
import { SceneTileCovering } from './scene-tile-covering';
import { SourceRenderSync } from './source-render-sync';
import { classifyStyleChange } from './style-change';
import { StyleEvaluation } from './style-evaluation';
import { TilePublishQueue } from './tile-publish-queue';
import { TileResidency } from './tile-residency';
import { viewPriority } from './view-priority';

const prePassesUpdateCollection = (PrimitiveCollection.prototype as unknown as {
  prePassesUpdate: (state: RenderFrameState) => void;
}).prePassesUpdate;

const postPassesUpdateCollection = (PrimitiveCollection.prototype as unknown as {
  postPassesUpdate: (state: RenderFrameState) => void;
}).postPassesUpdate;

/**
 * Coordinates style evaluation, tile publication and Cesium draw submission.
 * @internal
 */
export class TilesetRenderer {
  readonly wake: SceneRenderWake;

  readonly preparation: FramePreparation;

  readonly placement: SceneSymbolPlacement;
  private _styleSpec: StyleSpecification;
  get styleSpec(): StyleSpecification {
    return this._styleSpec;
  }

  readonly style!: Style;

  readonly vector: VectorTileRenderer;

  layerIndex!: RenderLayerIndex;

  evaluation!: StyleEvaluation;

  readonly commands = new DrawCommands();

  lightRevision = 0;

  readonly publishQueue: TilePublishQueue;
  private _ready = false;
  private _readySettled = false;
  private _readyResolve?: () => void;
  private _readyReject?: (reason?: unknown) => void;
  private _destroyed = false;

  mode: SceneMode = SceneMode.SCENE3D;
  private readonly _zoomLevelsToOverscale: number;
  private readonly _localIdeographFontFamily: string | false;

  readonly covering: SceneTileCovering;
  private _readyPromise!: Promise<void>;
  private _lastShow?: boolean;

  private readonly _heightReference: HeightReference;
  private readonly _transformRequest?: RequestTransformFunction;
  private _backgroundRenderer = new BackgroundRenderer();

  readonly collections: SceneCollections;
  /** Renderable tile count from the last update, for {@link stats}. */
  private _lastRenderableTiles = 0;
  /** Publish queue depth observed at the end of the last update. */
  private _lastPendingPublishes = 0;
  /** This tileset's commands in its last frame, before Cesium's render passes. */
  private _lastSubmittedCommands = 0;
  private _memoryBudgetDirty = true;

  readonly raster: RasterTileRenderer;

  readonly pattern: PatternTileRenderer;

  readonly symbol: SymbolTileRenderer;

  readonly residency: TileResidency;

  readonly sourceSync: SourceRenderSync;
  private _drapeFrameNumber = 0;
  private readonly root: PrimitiveCollection;
  private readonly errorEvent: Event<(error: Error) => void>;

  constructor(
    root: PrimitiveCollection,
    options: CesiumVectorTilesetOptions,
    errorEvent: Event<(error: Error) => void>,
  ) {
    this.root = root;
    this.errorEvent = errorEvent;
    this.collections = new SceneCollections(
      this.root,
      () => this.wake.request(),
      tileId => this.symbol.isTilePlacementActive(tileId),
      collection => this.vector.releaseDrapedCollection(collection),
      (collection, budget) => {
        const paint = this.vector.refreshCollectionPaint(collection, this._paintFrame(budget));
        for (const { tileId, old, replacement } of paint.replacements) {
          this.collections.replaceWhenReady(tileId, old, replacement);
        }
        return paint.ready;
      },
    );
    this.covering = new SceneTileCovering(() => {
      if (!this._destroyed && this.root.show && this._ready) {
        this.wake.request();
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
    this.style = new StyleClass(this._transformRequest, {
      localIdeographFontFamily: this._localIdeographFontFamily,
      // Sprite @2x selection, `{ratio}` tile URLs and worker bucket pixel
      // ratios all read this; leaving it at the default 1 would make every
      // HiDPI tileset fetch and render 1x resources.
      pixelRatio: browser.devicePixelRatio,
    });
    this.vector = new VectorTileRenderer(1, this.style.dashAtlas);
    this.raster = new RasterTileRenderer();
    this.pattern = new PatternTileRenderer();
    this.symbol = new SymbolTileRenderer();
    this.publishQueue = new TilePublishQueue({
      vector: this.vector,
      raster: this.raster,
      pattern: this.pattern,
      symbol: this.symbol,
      style: () => this.style,
      styleZoom: () => this.evaluation.zoom,
      lightRevision: () => this.lightRevision,
      sceneMode: () => this.mode,
      layerOrder: () => this.layerIndex.order,
      symbolLayers: sourceId => this.layerIndex.symbolForSource(sourceId),
      patternLayers: sourceId => this.layerIndex.patternForSource(sourceId),
      rasterLayers: sourceId => this.layerIndex.rasterForSource(sourceId),
      rasterSource: sourceId => rasterSourceInfo(this.style.tilePyramids[sourceId]?.getSource()),
      isRenderable: (sourceId, tileKey) => this.style.tilePyramids[sourceId]?.isRenderableId(tileKey) ?? false,
      publish: result => this.residency.commit(result),
      publishPattern: (sourceId, tileID, update) => {
        this.residency.published(sourceId, tileID);
        if (update) {
          this.collections.applyPatternUpdate(update);
        }
        this._memoryBudgetDirty = true;
      },
      requestRender: () => this.wake.request(),
    });
    this.residency = new TileResidency({
      vector: this.vector,
      raster: this.raster,
      pattern: this.pattern,
      symbol: this.symbol,
      publishQueue: this.publishQueue,
      scene: this.collections,
      fadeDuration: () => this.style.fadeDuration,
      paintFrame: () => this._paintFrame(),
    });
    this.sourceSync = new SourceRenderSync({
      raster: this.raster,
      publishQueue: this.publishQueue,
      residency: this.residency,
      scene: this.collections,
    });
    this.vector.setDraping(undefined, this._heightReference);
    if (options.gpuMemoryBudgetBytes !== undefined)
      this.residency.setMemoryBudgetBytes(options.gpuMemoryBudgetBytes);

    this.wake = new SceneRenderWake(this.root, () => !this._destroyed, () => this.root.show && this._ready, () => this.preparation.frameRecord, () => this.symbol, () => this._releaseScene());
    this.preparation = new FramePreparation(this.root, this.style, this.vector, this.collections, this.publishQueue, this.symbol, this.wake);
    this.placement = new SceneSymbolPlacement(this.symbol, this.covering, this.collections, this.wake);
    this._initStyle(options.style);
  }

  private _paintFrame(budget?: Budget): VectorPaintFrame {
    const transitions = this.style.getRenderTransitionFlags();
    return {
      zoom: this.evaluation.zoom,
      evaluationId: this.evaluation.evaluationId,
      styleRevision: this.style.styleRevision,
      force: transitions.vector,
      transitionLayerIds: transitions.vectorLayerIds,
      pixelRatio: this.vector.pixelRatio,
      lightRevision: this.lightRevision,
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
    this.layerIndex = new RenderLayerIndex(this.style);
    this.evaluation = new StyleEvaluation(this.style, this.layerIndex);
    this.style.triggerRepaint = () => this.wake.request();
    this.style.zoomLevelsToOverscale = this._zoomLevelsToOverscale;
    this.style.on('data', this._onStyleData);
    this.style.on('style.load', () => {
      if (this._readySettled || this._destroyed) {
        return;
      }
      this._readySettled = true;
      this._readyReject = undefined;
      this._ready = true;
      this.layerIndex.rebuildIndex();
      this._buildRasterLayers();
      this._buildPatternLayers();
      this._backgroundRenderer.destroy();
      this.evaluation.acceptVisibility();
      this.wake.request();
      resolveReady();
    });
    this.style.on('error', (event) => {
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
    this.style.loadJSON(styleSpec);
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
      this.wake.request();
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
    this.style.addImage(id, {
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
    const previous = this.style.getImage(id);
    this.style.updateImage(id, {
      ...previous,
      data: new RGBAImage({ width: image.width, height: image.height }, image.data),
      pixelRatio: options.pixelRatio ?? previous.pixelRatio,
      sdf: options.sdf ?? previous.sdf,
    });
  }

  removeImage(id: string): void {
    this._assertNotDestroyed();
    this.style.removeImage(id);
  }

  /**
   * Rescale the global GPU memory budget (see GpuMemoryBudget). Overflow
   * evicts retired tiles oldest-first; live tiles are never evicted.
   *
   * A shrink requests a frame so it also takes effect under requestRenderMode.
   */
  setGpuMemoryBudgetBytes(bytes: number): void {
    this._assertNotDestroyed();
    this.residency.setMemoryBudgetBytes(bytes);
    this._memoryBudgetDirty = true;
    this.wake.request();
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
    const bucket = this.vector.stats;
    const symbol = this.symbol.stats;
    const pattern = this.pattern.stats;
    const raster = this.raster.stats;
    return {
      renderableTiles: this._lastRenderableTiles,
      pendingPublishes: this._lastPendingPublishes,
      bucket,
      symbol,
      pattern,
      raster,
      featureIndexes: this.residency.featureIndexCount,
      gpuMemory: this.residency.memoryStats(),
      renderPassGpuBytes: this.commands.extrusionGpuBytes,
      submittedCommands: this._lastSubmittedCommands,
    };
  }

  /** Whether the current source data and geometry uploads have finished. */
  get tilesLoaded(): boolean {
    return this._ready && !this._destroyed && this.style.loaded()
      && this.publishQueue.size === 0
      && this.collections.pendingFirstUpdateCount === 0
      && !this.vector.needsPaintUpdate
      && !(this.symbol.hasDrawableSymbols && this.symbol.hasPendingWork);
  }

  /**
   * Hot-swap the style. Runs the style diff (unchanged sources keep their
   * tile cache) and rebuilds only the affected layer collections.
   */
  setStyle(nextStyle: StyleSpecification): void {
    this._assertNotDestroyed();
    const previousStyle = this.style.serialize()!;
    const cameraPaint = this.vector.captureLivePaint();
    // Style preflights unsupported operations before applying the diff.
    // Failures reach the caller without silently discarding a working scene.
    if (!this.style.setState(nextStyle)) {
      return;
    }
    this._styleSpec = nextStyle;
    const { changes, paintOnly } = classifyStyleChange(previousStyle, nextStyle, this.style);
    if (paintOnly) {
      // Existing paint updaters own material/attribute changes and request
      // continuation when a write needs a GPU upload. Geometry stays resident.
      this.vector.invalidatePaint();
      this.wake.request();
      return;
    }
    this.vector.freezePaint(cameraPaint);
    this.publishQueue.clear();
    this.layerIndex.rebuildIndex();
    this.collections.flushRemovals();
    const sourceIds = new Set(Object.keys(nextStyle.sources));
    const addedSourceIds = new Set(nextStyle.layers.flatMap(layer => 'source' in layer && !(layer.source in previousStyle.sources) ? [layer.source] : []));
    this.residency.reconcileSources(sourceIds, addedSourceIds, new Map(previousStyle.layers.map((layer, index) => [layer.id, index])));
    for (const sourceId in this.style._updatedSources) {
      if (this.style._updatedSources[sourceId] === 'reload'
        && sourceId in previousStyle.sources && sourceIds.has(sourceId)) {
        this.residency.beginSourceReplacement(sourceId);
      }
    }
    for (const change of changes) {
      if (change.command === 'addSource') {
        const sourceId = change.args[0] as string;
        if (sourceId in previousStyle.sources) {
          this.residency.beginSourceReplacement(sourceId);
        }
      }
    }
    // Pooled geometry predates the layout change. Live geometry is handed
    // over by SceneCollections only after its successor is ready to draw.
    const previousLayerIds = new Set(previousStyle.layers.map(layer => layer.id));
    for (const { collections } of this.vector.evictRetiredIntersectingLayers(previousLayerIds, () => false)) {
      for (const collection of collections) {
        this.collections.deferDestroy(collection);
      }
    }
    // Surviving source tiles need new scene geometry for the new style.
    this._buildRasterLayers();
    this._buildPatternLayers();

    // Style diffing keeps unchanged source tiles in TilePyramid caches. They
    // do not emit a new tile event merely because this tileset renderer was
    // rebuilt, so hydrate the new collections from the visible tiles now.
    this._hydrateRenderableTiles();
    this._backgroundRenderer.destroy();
    this.evaluation.acceptVisibility();
    this.wake.request();
  }

  /**
   * Raster layers are kept in style order so asynchronously arriving tiles do
   * not reorder imagery. Cached tiles are hydrated by setStyle immediately
   * after this method returns.
   */
  private _buildRasterLayers(): void {
    this.sourceSync.reset();
    this._memoryBudgetDirty = true;
    this.collections.applyRasterUpdate(this.raster.setLayers([...this.layerIndex.rasterLayers], this.layerIndex.order));
    for (const collection of this.raster.collections.values()) {
      this.collections.add(collection);
    }
  }

  private _buildPatternLayers(): void {
    // Parked builds belong to the previous layer plan; committed tiles stay
    // drawable until SceneCollections accepts their replacements.
    this.publishQueue.clearPatternRefreshes();
    this.collections.applyPatternUpdate(this.pattern.clearRetired());
    this.collections.applyPatternUpdate(this.pattern.setLayers([...this.layerIndex.patternLayers], this.layerIndex.order));
    for (const collection of this.pattern.collections.values()) {
      this.collections.add(collection);
    }
  }

  private _hydrateRenderableTiles(): void {
    for (const sourceId in this.style.tilePyramids) {
      const tilePyramid = this.style.tilePyramids[sourceId];
      for (const tileId of tilePyramid.getRenderableIds()) {
        const tile = tilePyramid.getTileByID(tileId);
        if (tile) {
          this.publishQueue.enqueue(sourceId, tile);
        }
      }
    }
  }

  private _rebuildRenderableTiles(previousMode: SceneMode): void {
    this.publishQueue.clear();
    const planarSwitch = (previousMode === SceneMode.SCENE2D && this.mode === SceneMode.COLUMBUS_VIEW)
      || (previousMode === SceneMode.COLUMBUS_VIEW && this.mode === SceneMode.SCENE2D);
    this.vector.freezePaint();
    if (!planarSwitch) {
      for (const collection of this.vector.removeModeSpecificCollections()) {
        this.collections.detachForDestruction(collection);
      }
      this._buildRasterLayers();
      this._buildPatternLayers();
    }
    for (const { collections } of this.vector.evictRetiredIntersectingLayers(new Set(this.style.getLayerOrder()), () => false)) {
      for (const collection of collections) this.collections.deferDestroy(collection);
    }
    // Native lines and buildings carry both coordinate tracks. Publication
    // keeps them visible until the target generation has actually uploaded.
    this._hydrateRenderableTiles();
  }

  /** Reuse resident geometry and publish only newly visible, missing layers. */
  private _publishVisibleLayers(newlyVisible: ReadonlySet<string>): void {
    if (newlyVisible.size === 0)
      return;
    for (const sourceId in this.style.tilePyramids) {
      const pyramid = this.style.tilePyramids[sourceId];
      for (const key of pyramid.getRenderableIds()) {
        const tile = pyramid.getTileByID(key);
        if (tile)
          this.publishQueue.ensureVisibleLayers(sourceId, tile, newlyVisible);
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
    if (this.wake.observe(scene)) {
      this.preparation.bind(scene);
      this.covering.observe(scene);
    }
    this.wake.afterRender = frameState.afterRender;
    this.preparation.updateLoading(frameState);
    if (!this.root.show)
      this.wake.cancelPlacement();
    if (this._lastShow !== this.root.show) {
      this._lastShow = this.root.show;
      if (!this.root.show)
        this.vector.undrapeAll();
      this.wake.request();
    }
    else if (this.wake.requested) {
      this.wake.request();
    }
    const idlePreparationsEnabled = this.preparation.cpuEnabled(frameState);
    this.collections.idlePreparationsEnabled = idlePreparationsEnabled;
    this.publishQueue.idlePreparationsEnabled = idlePreparationsEnabled;
    if (frameState.newFrame === false && this.root.show && this._ready && scene?.mode === frameState.mode
      && this.symbol.observeIdlePlacement()) {
      this.wake.continuePlacement();
    }
    if (idlePreparationsEnabled && frameState.newFrame === false)
      this.preparation.advanceIdle(frameState);
    Reflect.apply(prePassesUpdateCollection, this.root, [frameState]);
  }

  private _releaseScene(): void {
    this.wake.release();
    this.preparation.release();
    this._lastShow = undefined;
    this.placement.release();
    this.covering.destroy();
    this.vector.setDraping(undefined, this._heightReference);
  }

  postPassesUpdate(frameState: RenderFrameState): void {
    Reflect.apply(postPassesUpdateCollection, this.root, [frameState]);
    this.preparation.afterPasses(frameState);
  }

  /**
   * Cesium PrimitiveCollection#update: drives the covering computation from
   * the camera and refreshes the Buffer*Collections for loaded tiles.
   */
  update(frameState: RenderFrameState): void {
    this._assertNotDestroyed();
    // A later viewport must also finish successfully before the physical
    // frame may consume its old wake. An exception retains the pending debt.
    if (this.preparation.frameRecord)
      this.preparation.frameRecord.successfulUpdate = false;
    if (!this._destroyed) {
      // Cesium consumes this queue even when requestRenderMode skips drawing.
      // Bind before readiness so asynchronous style loading can wake rendering.
      this.wake.afterRender = frameState.afterRender;
      this.vector.setDraping(frameState.camera._scene?.vectorProvider, this._heightReference);
    }
    this.collections.flushRemovals();
    if (this._destroyed || !this.root.show || !this._ready) {
      this._lastSubmittedCommands = 0;
      if (!this._destroyed) {
        // The base PrimitiveCollection.update no-ops for hidden primitives, so
        // a hidden tileset must not drive covering/style/tile updates. A
        // destroyed tileset has already released everything it owns.
        this.collections.updateChildren(frameState);
      }
      return;
    }

    // StyleImages suppresses duplicate render-callback dispatches within one
    // frame. The tileset owns the frame boundary because Cesium, rather than a
    // MapLibre map loop, drives this renderer.
    this.preparation.updateLoading(frameState);
    const frameWork = this.preparation.admit(frameState, this.wake.generation);
    const tileWorkFrame = this.preparation.frameRecord!;
    const frameBudget = frameWork.tileBudget;

    const sceneMode = frameState.mode ?? SceneMode.SCENE3D;
    const previousSceneMode = this.mode;
    const geometryChanged = sceneMode !== previousSceneMode;
    this.mode = sceneMode;

    // The scene globe is reachable through the frame state via the camera's
    // private Scene back-reference (frameState.camera._scene.globe); the
    // tileset deliberately accepts no globe through its public entry points.
    // Read it fresh every frame so a globe added or swapped later takes
    // effect. Only its completed rendered tile selection supplies coverage.
    this.covering.observe(frameState.camera._scene);

    const coverings: Array<{
      sourceId: string;
      tilePyramid: Style['tilePyramids'][string];
      covering?: ReturnType<SceneTileCovering['covering']>;
    }> = [];
    for (const sourceId in this.style.tilePyramids) {
      const tilePyramid = this.style.tilePyramids[sourceId];
      const covering = this.covering.covering(tilePyramid, frameState, this._zoomLevelsToOverscale);
      coverings.push({ sourceId, tilePyramid, covering });
    }

    const coveringZoom = coverings.find(item => item.covering !== undefined)?.covering?.styleZoom;
    const evaluatedStyle = this.evaluation.evaluate(coveringZoom);
    this.lightRevision = evaluatedStyle.lightRevision;
    this.vector.lighting = evaluatedStyle.lighting;
    const transitionFlags = evaluatedStyle.transitions;
    if (geometryChanged) {
      this.layerIndex.rebuildIndex();
      this._rebuildRenderableTiles(previousSceneMode);
    }
    else if (evaluatedStyle.visibility) {
      // Visibility is evaluated at command submission, independently of
      // geometry residency. Only tracks whose layer plan changed are updated.
      const { flipped } = evaluatedStyle.visibility;
      this.layerIndex.rebuildIndex();
      // Globe draping consumes the visibility change on its next beginFrame.
      if (isClampHeightReference(this._heightReference))
        this.wake.request();
      for (const layerId of flipped) {
        const layer = this.style.getLayer(layerId);
        if (layer && isRasterStyleLayer(layer)) {
          this._buildRasterLayers();
          break;
        }
      }
      for (const layerId of flipped) {
        const layer = this.style.getLayer(layerId);
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
      this.wake.request();
    }
    const pixelRatio = pixelRatioCompensation(frameState);
    this.vector.pixelRatio = pixelRatio;
    let totalRenderable = 0;
    let retiredCapacity = 0;
    let residentChanged = false;
    let sourceFeatureStateChanged = false;
    for (const { sourceId, tilePyramid, covering } of coverings) {
      const result = frameWork.measure(() => this.sourceSync.updateSource(sourceId, tilePyramid, covering, {
        mode: this.mode,
        rasterLayers: this.layerIndex.rasterForSource(sourceId),
        patternLayers: this.layerIndex.patternForSource(sourceId),
        transitioningVectorLayers: transitionFlags.vectorLayerIds,
        styleRevision: this.style.styleRevision,
        imageUpdateRevision: this.style.images.imageUpdateRevision,
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
    this.residency.syncRetiredCapacity(retiredCapacity);
    if (sourceFeatureStateChanged) {
      this.vector.invalidatePaint();
    }
    // Native commands retain their material's samplers for this frame.
    // Refresh appearances before first updates can submit those commands.
    this._memoryBudgetDirty = this.symbol.refreshImages(this.style.images) || this._memoryBudgetDirty;
    const firstCommand = frameState.commandList?.length ?? 0;
    this._backgroundRenderer.update(this.style, frameState, this.mode, this.wake.request);
    // Advance already committed resources before building more. Both stages
    // share one deadline, so a full build frame cannot repeatedly strand the
    // Native first-update queue. New commits request the following frame.
    this._memoryBudgetDirty ||= this.collections.pendingFirstUpdateCount > 0;
    const renderUpload = this.collections.hasRunnableFirstUpdates;
    const runnable = {
      upload: renderUpload || this.collections.hasRunnableResourceUploads,
      build: this.publishQueue.size > 0,
      paint: this.vector.needsPaintUpdate,
      placement: this.symbol.hasRunnableWork,
    };
    const uploadBudget = renderUpload ? frameWork.continuation('upload', runnable, this.preparation.continuationMs) ?? frameBudget : frameBudget;
    const pumped = this.collections.pumpFirstUpdates(frameState, uploadBudget, operation => frameWork.measure(operation), uploadBudget !== frameBudget, frameWork.tileBudget);
    // Select the current camera's tiles before spending the publish budget.
    // A quick pan can invalidate jobs queued by the preceding frame; drain()
    // must see the updated TilePyramid renderable set before building them.
    const buildBudget = frameWork.continuation('build', runnable, this.preparation.continuationMs) ?? frameBudget;
    if (this.publishQueue.size > 0 && frameWork.measure(() => this.publishQueue.drain(
      buildBudget,
      MAX_TILE_COMMITS,
      viewPriority(frameState),
      buildBudget !== frameBudget,
    )) > 0) {
      this._memoryBudgetDirty = true;
    }
    this._lastRenderableTiles = totalRenderable;
    this._lastPendingPublishes = this.publishQueue.size;
    // A style mutation invalidates pooled symbol and pattern paints.
    if (evaluatedStyle.retiredPaintChanged) {
      this.collections.queueSymbolRemoval(this.symbol.clearRetired());
      this.collections.applyPatternUpdate(this.pattern.clearRetired());
    }
    const paintFrame = {
      zoom: this.evaluation.zoom,
      evaluationId: evaluatedStyle.evaluationId,
      force: transitionFlags.vector,
      styleRevision: this.style.styleRevision,
      transitionLayerIds: transitionFlags.vectorLayerIds,
      pixelRatio,
      lightRevision: evaluatedStyle.lightRevision,
      budget: frameBudget,
    };
    this.vector.updateLivePaint(paintFrame);
    const collectionReplacements = frameWork.run('paint', runnable, budget =>
      this.vector.updatePaint({ ...paintFrame, budget }), this.preparation.continuationMs);
    if (this.vector.needsPaintUpdate) {
      // Resume the records left by the frame paint budget.
      this.wake.request();
    }
    for (const { tileId, old, replacement } of collectionReplacements) {
      this.collections.replaceWhenReady(tileId, old, replacement);
    }
    const fadeOpacityOf = (tileId: string): number | undefined => {
      const slash = tileId.indexOf('/');
      const tilePyramid = this.style.tilePyramids[tileId.slice(0, slash)];
      return tilePyramid?.getRasterFadeOpacity(tileId.slice(slash + 1));
    };
    const rasterUpdate = this.raster.update(
      this.style.renderRevision,
      transitionFlags.raster,
      transitionFlags.rasterLayerIds,
      fadeOpacityOf,
    );
    this.collections.applyRasterUpdate(rasterUpdate);
    if (rasterUpdate.added.length > 0 || rasterUpdate.removed.length > 0) {
      this._memoryBudgetDirty = true;
    }
    if (rasterUpdate.fading) {
      // A raster crossfade animates over time: keep frames coming until it
      // completes even though the camera and style are static.
      this.wake.request();
    }
    this.pattern.pixelRatio = pixelRatio;
    this.pattern.update(frameState.context);
    this.vector.dashMaterial?.update(
      frameState.context,
      this.evaluation.zoom,
      frameState.pixelRatio ?? browser.devicePixelRatio,
      this.style.getLayer(this.style.getLayerOrder()[0])?.getCrossfadeParameters(),
    );
    this._memoryBudgetDirty = this.placement.tickFades() || this._memoryBudgetDirty;
    this.placement.update(frameState, frameWork, runnable, this.evaluation.zoom, this.preparation.continuationMs);
    // Publishing can add several renderer records after the renderable IDs
    // have already stabilized. Sync after all tracks' mutations, while a
    // settled frame still pays only the O(1) dirty check.
    if (residentChanged || this._memoryBudgetDirty) {
      this.residency.syncMemoryBudget();
      this._memoryBudgetDirty = false;
    }
    if (this.residency.syncHeldTileVisibility()) {
      this._memoryBudgetDirty = true;
      this.wake.request();
    }
    // Switch same-tile content only after its complete visible-owner layout
    // activates. A future placement alone cannot release the drawn generation.
    frameWork.measure(() => this.collections.finishReplacements(frameBudget));
    this.residency.releaseReplacedFeatureIndices();
    // Draped collections are consumed by globe.beginFrame on the following
    // frame; their collection.update does not itself upload packed terrain data.
    if (frameState.frameNumber === undefined) {
      this._drapeFrameNumber += 1;
    }
    this.collections.syncDrapedVisibility(this.layerIndex.visibility());
    if (this.vector.markDrapedCollections(frameState.frameNumber ?? this._drapeFrameNumber, this.residency.retainedLayerOrder ?? this.layerIndex.order)) {
      this.wake.request();
    }
    // Draw completed collections after placement and visibility settle.
    // Newly queued resources enter Native preparation on the next frame.
    this.collections.updateChildren(frameState, pumped);
    this.commands.prepare(frameState, firstCommand, this.mode, this.residency.retainedLayerOrder ?? this.layerIndex.order, this.covering.scene, this.residency.drawRanks, this.residency.hiddenSurfaceLayers, this.residency.hiddenStyleTiles, this.layerIndex.visibility());
    this._lastSubmittedCommands = (frameState.commandList?.length ?? firstCommand) - firstCommand;
    // Symbol atlases and picking data must survive the last old color frame.
    // Native afterRender also covers both date-line viewports before release.
    if (frameState.passes?.render && this.tilesLoaded && this.residency.retainedLayerOrder) {
      const revision = this.style.styleRevision;
      frameState.afterRender?.push(() => {
        if (!this._destroyed && this.style.styleRevision === revision && this.tilesLoaded
          && this.residency.completeSourceReplacement()) {
          this._memoryBudgetDirty = true;
          this.wake.request();
          return true;
        }
        return false;
      });
    }
    tileWorkFrame.successfulUpdate = frameState.passes?.render === true && frameState.newFrame !== false;
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
    this.publishQueue.enqueue(event.sourceId, tile);
  }

  /** Releases renderer resources before the owning primitive is destroyed. */
  destroy(): void {
    this._assertNotDestroyed();
    // Removal destroys this primitive before another update can observe it.
    // The final frame must clear its old pixels even after its work is gone.
    this.wake.requestRemoval();
    this._releaseScene();
    this._destroyed = true;
    if (!this._readySettled) {
      this._readySettled = true;
      this._readyReject?.(new Error('CesiumVectorTileset was destroyed before it became ready'));
      this._readyReject = undefined;
    }
    this.wake.afterRender = undefined;
    this.publishQueue.clear();
    this.sourceSync.reset();
    this.residency.clear();
    this.collections.queueSymbolRemoval(this.symbol.removeAll());
    this._backgroundRenderer.destroy();
    this.commands.destroy();
    this.style.destroy();
    this.collections.clearPendingReplacements();
    this.collections.flushRemovals();
    destroyRasterResources(this.raster.clear());
    destroyPatternResources(this.pattern.clear());
    const activeChildren = new Set<VectorCollection | PrimitiveCollection>([
      ...this.vector.collections.values(),
      ...this.vector.retiredCollections,
      ...this.raster.collections.values(),
      ...this.pattern.collections.values(),
    ]);
    for (const child of activeChildren) {
      this.collections.detach(child);
      if (!child.isDestroyed()) {
        child.destroy();
      }
    }
    // Detach draped fills from the scene vector provider before the
    // collections are destroyed; a marked collection outliving its buffers
    // would drape released GPU memory.
    this.vector.undrapeAll();
    this.vector.removeAll();
    this.vector.dashMaterial?.destroy();
  }

  pick(pickObject: TilePickObject | RasterPrimitivePickObject | PatternPrimitiveID): {
    layerId: string;
    properties: Record<string, unknown>;
  } | undefined {
    this._assertNotDestroyed();
    return pickedFeature(pickObject, this.raster, this.pattern, this.residency);
  }
}
