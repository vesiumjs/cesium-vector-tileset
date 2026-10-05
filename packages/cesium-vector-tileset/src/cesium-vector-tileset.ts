import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Scene } from 'cesium';
import type { PatternPrimitiveID } from './render/pattern/pattern-renderer';
import type { RasterPrimitivePickObject } from './render/raster/raster-renderer';
import type { Budget } from './render/scene/frame-budget';
import type { RenderFrameState } from './render/scene/render-frame';
import type { TilePickObject } from './render/vector/tile-conversion';
import type { VectorPaintFrame } from './render/vector/vector-paint-updater';
import type { VectorCollection, VectorDrapingProvider } from './render/vector/vector-tile-renderer';
import type { Style } from './style/style';
import type { Tile } from './tile/tile';
import type { SourceDataEvent, StyleDataEvent } from './util/events';
import type { RequestTransformFunction } from './util/request';
import { diff as diffStyles } from '@maplibre/maplibre-gl-style-spec';
import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
  EllipsoidalOccluder,
  Event,
  HeightReference,
  PrimitiveCollection,
  SceneMode,
} from 'cesium';
import { isPatternStyleLayer } from './render/pattern/pattern-layer';
import { destroyPatternResources, PatternTileRenderer } from './render/pattern/pattern-renderer';
import { destroyRasterResources, rasterSourceInfo, RasterTileRenderer } from './render/raster/raster-renderer';
import { BackgroundRenderer } from './render/scene/background-renderer';
import { DrawCommands } from './render/scene/draw-commands';
import { FrameBudget, MAX_TILE_COMMITS, TILE_WORK_BUDGET_MS } from './render/scene/frame-budget';
import { RenderLayerIndex } from './render/scene/render-layer-index';
import { SceneCollections } from './render/scene/scene-collections';
import { SceneTileCovering } from './render/scene/scene-tile-covering';
import { SourceRenderSync } from './render/scene/source-render-sync';
import { StyleEvaluation } from './render/scene/style-evaluation';
import { TilePublishQueue } from './render/scene/tile-publish-queue';
import { TileResidency } from './render/scene/tile-residency';
import { sameViewProjection, symbolViewProjection } from './render/symbol/symbol-placement';
import { SymbolTileRenderer } from './render/symbol/symbol-renderer';
import { VectorTileRenderer } from './render/vector/vector-tile-renderer';
import { resolveStyleUrls } from './style/resolve-style-urls';
import { Style as StyleClass } from './style/style';
import { isRasterStyleLayer } from './style/style-layer/raster-style-layer';
import { warnOnce } from './util/errors';
import { RGBAImage } from './util/image';
import { ResourceType, transformRequest } from './util/request';

export interface CesiumVectorTilesetOptions {
  style: StyleSpecification;
  /** Transforms style, tile, sprite, glyph and source requests before loading. */
  transformRequest?: RequestTransformFunction;
  /**
   * Requests a new Cesium scene frame. Pass `() => scene.requestRender()` when
   * the scene uses `requestRenderMode`; continuous rendering does not need it.
   */
  requestRender?: () => void;
  /**
   * Number of zoom levels above a vector source's max zoom for which tiles
   * are re-parsed from the deepest available tile, keeping deep zoom crisp
   * instead of upscaled (MapLibre default: 4).
   */
  zoomLevelsToOverscale?: number;
  /**
   * Font family used to render CJK ideographs locally (client-side SDF)
   * instead of fetching their glyph ranges from the style's glyph server.
   * MapLibre defaults to 'sans-serif'; pass `false` to force server fonts.
   */
  localIdeographFontFamily?: string | false;
  /**
   * Drape fill polygons onto terrain / 3D Tiles through the scene's vector
   * provider (Cesium 1.144+). Defaults to `HeightReference.NONE` (geometry
   * drawn at ellipsoid heights, as before).
   *
   * Only fill polygons drape: circle points, lines, symbols, extrusions and
   * patterns keep their ellipsoid heights, because Cesium's vector pipeline
   * only packs polygons and polylines. Requires `scene`.
   */
  heightReference?: HeightReference;
  /**
   * The scene hosting this tileset. Required when `heightReference` is a
   * clamp value; the scene's vector provider drapes the fill collections.
   * (`Scene.vectorProvider` has no Cesium.d.ts declarations, hence the
   * structural member.)
   */
  scene?: Scene & { vectorProvider?: VectorDrapingProvider };
}

export type CesiumVectorTilesetFromUrlOptions = Omit<CesiumVectorTilesetOptions, 'style'> & {
  /** Cancels the style request before a tileset is created. */
  signal?: AbortSignal;
};

async function loadStyleFromUrl(url: string, requestTransform?: RequestTransformFunction, signal?: AbortSignal): Promise<{ style: StyleSpecification; url: string }> {
  signal?.throwIfAborted();
  const request = await transformRequest(url, ResourceType.Style, requestTransform);
  signal?.throwIfAborted();
  const response = await fetch(request.url, {
    signal,
    method: request.method,
    headers: request.headers,
    body: request.body,
    credentials: request.credentials,
    cache: request.cache,
    referrerPolicy: request.referrerPolicy,
  });
  if (!response.ok) {
    throw new Error(`Failed to load style from ${request.url}: ${response.status} ${response.statusText}`);
  }
  const style: unknown = await response.json();
  signal?.throwIfAborted();
  if (!isStyleSpecification(style)) {
    throw new Error(`The style response from ${request.url} is not a valid style object`);
  }
  return { style, url: response.url || request.url };
}

function isStyleSpecification(value: unknown): value is StyleSpecification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  return fields.version === 8
    && typeof fields.sources === 'object'
    && fields.sources !== null
    && !Array.isArray(fields.sources)
    && Array.isArray(fields.layers);
}

/**
 * The frame state fields the tileset consumes. Structural type so the class
 * does not depend on Cesium's private FrameState declaration.
 */
export type { RenderFrameState } from './render/scene/render-frame';

const EMPTY_LAYER_SET: ReadonlySet<string> = new Set();

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
  private _requestRender: () => void = () => {};
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
  private _tileWorkFrame?: { frameNumber?: number; budget: FrameBudget };

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

  static async fromUrl(url: string, options?: CesiumVectorTilesetFromUrlOptions): Promise<CesiumVectorTileset> {
    const response = await loadStyleFromUrl(url, options?.transformRequest, options?.signal);

    return new CesiumVectorTileset({ ...options, style: resolveStyleUrls(response.style, response.url) });
  }

  constructor(options: CesiumVectorTilesetOptions) {
    // Renderer-owned children are retired at an explicit frame boundary below.
    // Letting PrimitiveCollection destroy them during remove() defeats the
    // pending-removal queue and can release a command buffer still referenced
    // by the previous frame.
    super({ destroyPrimitives: false });
    this._sceneCollections = new SceneCollections(
      this,
      () => this._requestRender(),
      tileId => this._symbolRenderer.isTilePlaced(tileId),
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
    this._requestRender = options.requestRender ?? (options.scene ? () => options.scene!.requestRender() : () => {});
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
    this._initDraping(options);

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

  /**
   * Wire fill-polygon draping when the tileset requests a clamp height
   * reference. The scene's vector provider is the only draping path Cesium
   * offers; without a scene the option cannot take effect, so warn once and
   * keep the previous unclamped rendering instead of failing silently.
   */
  private _initDraping(options: CesiumVectorTilesetOptions): void {
    const heightReference = options.heightReference ?? HeightReference.NONE;
    if (heightReference === HeightReference.NONE) {
      return;
    }
    const vectorProvider = options.scene?.vectorProvider;
    if (!vectorProvider) {
      warnOnce(
        '[cesium-vector-tileset] heightReference requires the hosting scene '
        + '(pass `scene`); rendering unclamped.',
      );
      return;
    }
    this._vectorRenderer.setDraping(vectorProvider, heightReference);
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

  /** Resolves when the style has loaded. */
  whenReady(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Register a named style image for `icon-image` / `*-pattern` references.
   *
   * Accepts the documented `{width, height, data}` shape (data as a plain
   * `Uint8Array`, non-premultiplied RGBA) and wraps it into the internal
   * image representation. The wrap is required: the worker transfer clones
   * the payload via `data.clone()`, so a raw `Uint8Array` would fail
   * silently later with `image.data.clone is not a function` and the icon
   * would never render. Tiles already parsed without this image are
   * reloaded so the icon appears immediately.
   */
  addImage(
    id: string,
    image: { width: number; height: number; data: Uint8Array | Uint8ClampedArray },
    options: {
      pixelRatio?: number;
      sdf?: boolean;
      stretchX?: Array<[number, number]>;
      stretchY?: Array<[number, number]>;
      content?: [number, number, number, number];
    } = {},
  ): void {
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
    image: { width: number; height: number; data: Uint8Array | Uint8ClampedArray },
    options: { pixelRatio?: number; sdf?: boolean } = {},
  ): void {
    const previous = this._style.getImage(id);
    this._style.updateImage(id, {
      ...previous,
      data: new RGBAImage({ width: image.width, height: image.height }, image.data),
      pixelRatio: options.pixelRatio ?? previous.pixelRatio,
      sdf: options.sdf ?? previous.sdf,
    });
  }

  removeImage(id: string): void {
    this._style.removeImage(id);
  }

  /**
   * Rescale the global GPU memory budget (see GpuMemoryBudget). Overflow
   * evicts retired tiles oldest-first; live tiles are never evicted.
   *
   * A shrink requests a frame so it also takes effect under requestRenderMode.
   */
  setGpuMemoryBudgetBytes(bytes: number): void {
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
   */
  stats(): {
    renderableTiles: number;
    pendingPublishes: number;
    bucket: { tiles: number; collections: number; retiredTiles: number };
    symbol: { tiles: number; fadingTiles: number; retiredTiles: number; primitives: number };
    pattern: { tiles: number; retiredTiles: number; layerCollections: number };
    raster: { tiles: number; layerCollections: number };
    featureIndexes: number;
    gpuMemory: { totalBytes: number; maxBytes: number; entries: number; evictions: number };
    submittedCommands: number;
  } {
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
    const previousStyle = this._style.serialize()!;
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
    this._vectorRenderer.freezePaint();
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

  /**
   * Visibility-flip republish for exactly the tiles a flip affects. Live
   * collections stay attached until the republish commits and swaps them
   * (see TilePublishQueue): a zoom crossing one layer's minzoom no longer
   * blanks every retained ancestor the way the old blanket removeAll did.
   * Retired bucket entries baking a flipped layer are evicted (restoring
   * them would show pre-flip content); retired symbol entries predating a
   * newly visible layer go the same way. The cleared render sync below makes
   * _syncHydratedTiles pick up anything this pass did not enqueue.
   */
  private _republishFlippedTiles(flipped: Set<string>, newlyVisible: Set<string>): void {
    if (flipped.size === 0) {
      return;
    }
    this._tilePublishQueue.clear();
    const isPattern = (layerId: string): boolean => {
      const layer = this._style.getLayer(layerId);
      return !!layer && (isPatternStyleLayer(layer));
    };
    const isRasterOf = (layerId: string, sourceId: string): boolean => {
      const layer = this._style.getLayer(layerId);
      return !!layer && isRasterStyleLayer(layer) && layer.source === sourceId;
    };
    const symbolNewBySource = new Map<string, Set<string>>();
    if (newlyVisible.size > 0) {
      for (const layerId of this._style._getLayerOrder()) {
        if (!newlyVisible.has(layerId)) {
          continue;
        }
        const layer = this._style.getLayer(layerId);
        if (layer && layer.type === 'symbol' && typeof layer.source === 'string') {
          let set = symbolNewBySource.get(layer.source);
          if (!set) {
            set = new Set<string>();
            symbolNewBySource.set(layer.source, set);
          }
          set.add(layerId);
        }
      }
    }
    for (const sourceId in this._style.tilePyramids) {
      const tilePyramid = this._style.tilePyramids[sourceId];
      const renderableIds = tilePyramid.getRenderableIds();
      const rasterFlipped = [...flipped].some(layerId => isRasterOf(layerId, sourceId));
      const symbolNew = symbolNewBySource.get(sourceId) ?? EMPTY_LAYER_SET;
      for (const tileKey of renderableIds) {
        const tile = tilePyramid.getTileByID(tileKey);
        if (!tile) {
          continue;
        }
        const bucketKeys = Object.keys(tile.buckets);
        const record = this._vectorRenderer.tileBuildLayers(`${sourceId}/${tileKey}`);
        // No record (never published): republish conservatively when the
        // tile carries buckets; raster-only tiles are covered below.
        const baked = record
          ? record.layerIds.filter(layerId => !record.skipLayerIds?.has(layerId) && !isPattern(layerId))
          : bucketKeys;
        const needsBucket = record?.complete === false || baked.some(layerId => flipped.has(layerId));
        const needsPattern = bucketKeys.some(layerId => flipped.has(layerId) && isPattern(layerId));
        const needsSymbol = bucketKeys.some(layerId => symbolNew.has(layerId));
        const needsRaster = rasterFlipped && !!tile.textureData;
        if (needsBucket || needsPattern || needsSymbol || needsRaster) {
          this._tilePublishQueue.enqueue(sourceId, tile);
        }
      }
    }
    for (const { collections } of this._vectorRenderer.evictRetiredIntersectingLayers(flipped, isPattern)) {
      for (const collection of collections) {
        this._sceneCollections.deferDestroy(collection);
      }
    }
    this._sceneCollections.queueSymbolRemoval(this._symbolRenderer.evictRetiredMissingLayers(newlyVisible));
  }

  /**
   * Cesium PrimitiveCollection#update: drives the covering computation from
   * the camera and refreshes the Buffer*Collections for loaded tiles.
   */
  update(frameState: RenderFrameState): void {
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
    const previousBudget = frameState.frameNumber !== undefined
      && this._tileWorkFrame?.frameNumber === frameState.frameNumber
      ? this._tileWorkFrame.budget
      : undefined;
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
      // A visibility flip (often a zoom crossing one layer's min/maxzoom)
      // republishes exactly the tiles a flip affects; live collections stay
      // attached until the republish commits, so a retained ancestor
      // survives the crossing instead of blanking. Mode changes keep the
      // blanket path above (different geometry tracks per mode).
      const { flipped, newlyVisible } = evaluatedStyle.visibility;
      this._renderLayerIndex.rebuildIndex();
      this._republishFlippedTiles(flipped, newlyVisible);
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
    const frameBudget = previousBudget ?? new FrameBudget(TILE_WORK_BUDGET_MS);
    if (!previousBudget)
      this._tileWorkFrame = { frameNumber: frameState.frameNumber, budget: frameBudget };
    const pixelRatioCompensation = this._pixelRatioCompensation(frameState);
    this._vectorRenderer.pixelRatio = pixelRatioCompensation;
    let totalRenderable = 0;
    let retiredCapacity = 0;
    let residentChanged = false;
    let sourceFeatureStateChanged = false;
    for (const { sourceId, tilePyramid, covering } of coverings) {
      const result = this._sourceRenderSync.updateSource(sourceId, tilePyramid, covering, {
        mode: this._sceneMode,
        rasterLayers: this._renderLayerIndex.rasterForSource(sourceId),
        patternLayers: this._renderLayerIndex.patternForSource(sourceId),
        transitioningVectorLayers: transitionFlags.vectorLayerIds,
        styleRevision: this._style.styleRevision,
        imageUpdateRevision: this._style.images.imageUpdateRevision,
        budget: frameBudget,
      });
      totalRenderable += result.renderableCount;
      retiredCapacity += tilePyramid._tileCache.max;
      residentChanged ||= result.changed;
      sourceFeatureStateChanged ||= result.featureStateChanged;
      this._memoryBudgetDirty ||= result.memoryChanged;
    }
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
    if (this._tileResidency.syncHeldTileVisibility()) {
      this._memoryBudgetDirty = true;
      this._requestRender();
    }
    this._memoryBudgetDirty ||= this._sceneCollections.pendingFirstUpdateCount > 0;
    const pumped = this._sceneCollections.pumpFirstUpdates(frameState, frameBudget);
    // Select the current camera's tiles before spending the publish budget.
    // A quick pan can invalidate jobs queued by the preceding frame; drain()
    // must see the updated TilePyramid renderable set before building them.
    if (this._tilePublishQueue.size > 0 && this._tilePublishQueue.drain(frameBudget, MAX_TILE_COMMITS, frameState.camera.positionCartographic) > 0) {
      this._memoryBudgetDirty = true;
    }
    this._lastRenderableTiles = totalRenderable;
    this._lastPendingPublishes = this._tilePublishQueue.size;
    // A style mutation invalidates pooled symbol and pattern paints.
    if (evaluatedStyle.retiredPaintChanged) {
      this._sceneCollections.queueSymbolRemoval(this._symbolRenderer.clearRetired());
      this._sceneCollections.applyPatternUpdate(this._patternRenderer.clearRetired());
    }
    const collectionReplacements = this._vectorRenderer.updatePaint({
      zoom: this._styleEvaluation.zoom,
      evaluationId: evaluatedStyle.evaluationId,
      force: transitionFlags.vector,
      styleRevision: this._style.styleRevision,
      transitionLayerIds: transitionFlags.vectorLayerIds,
      pixelRatio: pixelRatioCompensation,
      lightRevision: evaluatedStyle.lightRevision,
      budget: frameBudget,
    });
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
    this._updateSymbolPlacement(frameState);
    // A symbol replacement can become placed after its upload. Settle that
    // handoff now even when requestRenderMode has no other work left.
    this._sceneCollections.finishReplacements(frameBudget);
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
    this._tileResidency.releaseReplacedFeatureIndices();
    // Draped collections are consumed by globe.beginFrame on the following
    // frame; their collection.update does not itself upload packed terrain data.
    if (frameState.frameNumber === undefined) {
      this._drapeFrameNumber += 1;
    }
    this._vectorRenderer.markDrapedCollections(frameState.frameNumber ?? this._drapeFrameNumber);
    // Draw completed collections after placement and visibility settle.
    // Newly queued resources enter Native preparation on the next frame.
    this._sceneCollections.updateChildren(frameState, pumped);
    this._drawCommands.prepare(frameState, firstCommand, this._sceneMode, this._tileResidency.retainedLayerOrder ?? this._renderLayerIndex.order, this._sceneCovering.scene, this._tileResidency.drawRanks, this._tileResidency.hiddenSurfaceLayers, this._tileResidency.hiddenStyleTiles);
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

  private _updateSymbolPlacement(frameState: RenderFrameState): void {
    if (!this._symbolRenderer.hasDrawableSymbols
      || (frameState.frameNumber !== undefined && this._lastPlacementFrame === frameState.frameNumber)) {
      return;
    }
    const snapshot = this._sceneCovering.cameraFrame;
    if (!snapshot || snapshot.frameNumber !== frameState.frameNumber) {
      // First observation happens inside a viewport update. Capture the
      // complete camera at the next preRender before placing any symbols.
      this._requestRender();
      return;
    }
    const viewProjection = symbolViewProjection(snapshot.viewMatrix, snapshot.projectionMatrix);
    const { mapProjection, centerLng } = snapshot;
    const isPointVisible = this._sceneMode === SceneMode.SCENE3D
      ? (() => {
          const occluder = new EllipsoidalOccluder(mapProjection.ellipsoid, snapshot.positionWC);
          const position = new Cartesian3();
          return (x: number, y: number, z: number): boolean => {
            position.x = x;
            position.y = y;
            position.z = z;
            return occluder.isPointVisible(position);
          };
        })()
      : undefined;
    const projectPosition = this._sceneMode !== SceneMode.SCENE3D && mapProjection
      ? (() => {
          const ellipsoid = mapProjection.ellipsoid ?? Ellipsoid.WGS84;
          const world = new Cartesian3();
          const cartographic = new Cartographic();
          const projected = new Cartesian3();
          const position: [number, number, number] = [0, 0, 0];
          const worldWidth = 2 * Math.PI * ellipsoid.maximumRadius;
          const centerX = centerLng * Math.PI / 180 * ellipsoid.maximumRadius;
          return (x: number, y: number, z: number): readonly [number, number, number] | undefined => {
            world.x = x;
            world.y = y;
            world.z = z;
            if (!ellipsoid.cartesianToCartographic(world, cartographic)) {
              return undefined;
            }
            mapProjection.project(cartographic, projected);
            if (this._sceneMode === SceneMode.SCENE2D) {
              projected.x += worldWidth * Math.round((centerX - projected.x) / worldWidth);
            }
            // Cesium's GeometryPipeline.projectTo2D writes x,y,z, then
            // czm_computePosition reorders them to z,x,y for 2D/CV.
            position[0] = projected.z;
            position[1] = projected.x;
            position[2] = projected.y;
            return position;
          };
        })()
      : undefined;
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
    const { drawingBufferWidth: width, drawingBufferHeight: height, pixelRatio } = snapshot;
    if (width <= 0 || height <= 0) {
      return;
    }
    // Composite symbol sizes interpolate in the vertex shader between the two
    // zoom stops packed per vertex; hand the live style zoom to the renderer.
    this._symbolRenderer.cameraZoom = this._styleEvaluation.zoom;
    this._symbolRenderer.update({
      viewProjection,
      projectPosition,
      isPointVisible,
      width,
      height,
      pixelRatio,
      cameraZoom: this._styleEvaluation.zoom,
    }, viewChanged, frameState.context);
    this._lastPlacementFrame = frameState.frameNumber;
    if (this._symbolRenderer.hasPendingWork) {
      // Cesium may not have created the opacity VBO or line-label instance
      // attributes yet. Request a follow-up under requestRenderMode so their
      // pending writes complete after the first Primitive update.
      this._requestRender();
    }
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

  destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this._sceneCovering.destroy();
    if (!this._readySettled) {
      this._readySettled = true;
      this._readyReject?.(new Error('CesiumVectorTileset was destroyed before it became ready'));
      this._readyReject = undefined;
    }
    this._requestRender = () => {};
    this._tilePublishQueue.clear();
    this._sourceRenderSync.reset();
    this._tileResidency.clear();
    this._sceneCollections.queueSymbolRemoval(this._symbolRenderer.removeAll());
    this._backgroundRenderer.destroy();
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
  }

  /**
   * Resolve a pickObject (as produced by the Buffer*Collection primitives
   * under Scene#pick) into the hit layer and feature.
   */
  pick(pickObject: TilePickObject | RasterPrimitivePickObject | PatternPrimitiveID): {
    layerId: string;
    properties: Record<string, unknown>;
  } | undefined {
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
