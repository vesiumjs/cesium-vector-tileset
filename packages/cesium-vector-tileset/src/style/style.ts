import type {
  AllLayoutProperties,
  AllPaintProperties,
  DiffCommand,
  DiffOperations,
  FeatureState,
  FilterSpecification,
  LayerSpecification,
  LightSpecification,
  SourceSpecification,
  SpriteSpecification,
  StateSpecification,
  StyleSpecification,
  TransitionSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import type { MissingImageRequestHandler } from '../assets/style-images';
import type { CanvasSourceSpecification } from '../source/canvas-source';
import type { GeoJSONSource } from '../source/geojson-source';
import type { Source } from '../source/source';
import type { StyleEventType } from '../util/events';
import type { RequestTransformFunction } from '../util/request';
import type { GetDashesParameters, GetDashesResponse, GetGlyphsParameters, GetGlyphsResponse, GetImagesParameters, GetImagesResponse } from '../worker/messages';
import type { EvaluationParameters } from './evaluation-parameters';
import type { RenderTransitionFlags } from './render-transition';
import type { StyleImage } from './style-image';
import type { StyleLayer } from './style-layer';
import type { Validator } from './validate-style';
import { derefLayers, diff as diffStyles, emptyStyle } from '@maplibre/maplibre-gl-style-spec';
import { DashAtlas } from '../assets/dash-atlas';
import { GlyphSource } from '../assets/glyph-source';
import { StyleImages } from '../assets/style-images';
import { rtlMainThreadPluginFactory } from '../source/rtl-text-plugin-main-thread';
import { RTLPluginLoadedEventName } from '../source/rtl-text-plugin-status';
import { TilePyramid } from '../tile/tile-pyramid';
import { throwIfAborted } from '../util/abort-error';
import { getJSON, getReferrer } from '../util/ajax';
import { browser } from '../util/browser';
import { ensureError } from '../util/errors';
import { ErrorEvent, Evented } from '../util/evented';
import { SourceDataEvent, StyleDataEvent, StyleLoadEvent } from '../util/events';
import { clone, deepEqual, filterObject, mapObject } from '../util/objects';
import { ResourceType, transformRequest } from '../util/request';
import { WorkerDispatcher } from '../worker/dispatcher';
import { MessageType } from '../worker/messages';
import { getSharedWorkerPool } from '../worker/worker-pool';
import { createStyleLayer } from './create-style-layer';
import { Light } from './light';
import { loadSprite } from './load-sprite';
import { renderTransitionFlags, samePaintZoom } from './render-transition';
import { normalizeSprite } from './sprite';
import { isRasterStyleLayer } from './style-layer/raster-style-layer';
import { SPEC_SOURCE_TYPES, validateAndEmit, validateStyle, validateStyleAndEmit } from './validate-style';
import { ZoomHistory } from './zoom-history';

const empty = emptyStyle();

let styleIdCounter = 0;
/**
 * A feature identifier that is bound to a source
 */
export interface FeatureIdentifier {
  /**
   * Unique id of the feature.
   */
  id?: string | number | undefined;
  /**
   * The id of the vector or GeoJSON source for the feature.
   */
  source: string;
  /**
   * For vector tile sources, `sourceLayer` is required.*
   */
  sourceLayer?: string | undefined;
}

/**
 * The options object related to the {@link Map}'s style related methods
 */
export interface StyleOptions {
  /**
   * If false, style validation will be skipped. Useful in production environment.
   */
  validate?: boolean;
  /**
   * Device pixel ratio used when loading style resources: the sprite atlas
   * (@2x), the `{ratio}` tile URL substitution and the worker bucket pixel
   * ratio. MapLibre wires `map.getPixelRatio()` here; the CesiumVectorTileset passes
   * its device pixel ratio. Defaults to 1.
   */
  pixelRatio?: number;
  /**
   * Defines a CSS
   * font-family for locally overriding generation of Chinese, Japanese, and Korean characters.
   * For these characters, font settings from the map's style will be ignored, except for font-weight keywords (light/regular/medium/bold).
   * Set to `false`, to enable font settings from the map's style for these glyph ranges.
   * Forces a full update.
   */
  localIdeographFontFamily?: string | false;
}

/**
 * Supporting type to add validation to another style related type
 */
export interface StyleSetterOptions {
  /**
   * Whether to check if the filter conforms to the MapLibre Style Specification. Disabling validation is a performance optimization that should only be used if you have previously validated the values you will be passing to this function.
   */
  validate?: boolean;
}

/**
 * Part of {@link Map.setStyle} options, transformStyle is a convenience function that allows to modify a style after it is fetched but before it is committed to the map state.
 *
 * This function exposes previous and next styles, it can be commonly used to support a range of functionalities like:
 *
 * - when previous style carries certain 'state' that needs to be carried over to a new style gracefully;
 * - when a desired style is a certain combination of previous and incoming style;
 * - when an incoming style requires modification based on external state.
 * - when an incoming style uses relative paths, which need to be converted to absolute.
 *
 * @param previous - The current style.
 * @param next - The next style.
 * @returns resulting style that will to be applied to the map
 *
 * @example
 * ```ts
 * map.setStyle('https://demotiles.maplibre.org/style.json', {
 *   transformStyle: (previousStyle, nextStyle) => ({
 *       ...nextStyle,
 *       // make relative sprite path like "../sprite" absolute
 *       sprite: new URL(nextStyle.sprite, "https://demotiles.maplibre.org/styles/osm-bright-gl-style/sprites/").href,
 *       // make relative glyphs path like "../fonts/{fontstack}/{range}.pbf" absolute
 *       glyphs: new URL(nextStyle.glyphs, "https://demotiles.maplibre.org/font/").href,
 *       sources: {
 *           // make relative vector url like "../../" absolute
 *           ...nextStyle.sources.map(source => {
 *              if (source.url) {
 *                  source.url = new URL(source.url, "https://tiles.openfreemap.org/planet");
 *              }
 *              return source;
 *           }),
 *           // copy a source from previous style
 *           'osm': previousStyle.sources.osm
 *       },
 *       layers: [
 *           // background layer
 *           nextStyle.layers[0],
 *           // copy a layer from previous style
 *           previousStyle.layers[0],
 *           // other layers from the next style
 *           ...nextStyle.layers.slice(1).map(layer => {
 *               // hide the layers we don't need from demotiles style
 *               if (layer.id.startsWith('geolines')) {
 *                   layer.layout = {...layer.layout || {}, visibility: 'none'};
 *               // filter out US polygons
 *               } else if (layer.id.startsWith('coastline') || layer.id.startsWith('countries')) {
 *                   layer.filter = ['!=', ['get', 'ADM0_A3'], 'USA'];
 *               }
 *               return layer;
 *           })
 *       ]
 *   })
 * });
 * ```
 */
export type TransformStyleFunction = (previous: StyleSpecification | undefined, next: StyleSpecification) => StyleSpecification;

/**
 * The options object related to the {@link Map}'s style related methods
 */
export interface StyleSwapOptions {
  /**
   * If false, force a 'full' update, removing the current style
   * and building the given one instead of attempting a diff-based update.
   */
  diff?: boolean;
  /**
   * TransformStyleFunction is a convenience function
   * that allows to modify a style after it is fetched but before it is committed to the map state. Refer to {@link TransformStyleFunction}.
   */
  transformStyle?: TransformStyleFunction;
}

/**
 * Specifies a layer to be added to a {@link Style}. In addition to a standard {@link LayerSpecification},
 * a {@link LayerSpecification} with an embedded {@link SourceSpecification} can also be provided.
 */
export type AddLayerObject = LayerSpecification | (Omit<LayerSpecification, 'source'> & { source: SourceSpecification });

/**
 * The Style base class
 */
export class Style extends Evented<StyleEventType> {
  transformRequest?: RequestTransformFunction;
  /**
   * The device pixel ratio used when loading style resources such as sprites. Set by the tileset renderer.
   */
  pixelRatio: number = 1;
  /**
   * The maximum number of tiles kept in the out-of-view cache per source.
   */
  maxTileCacheSize: number = 500;
  /**
   * The maximum number of zoom levels below the current zoom that are kept in the tile cache.
   */
  maxTileCacheZoomLevels: number = 5;
  /**
   * Debug flag: refresh expired tiles.
   */
  refreshExpiredTiles: boolean = false;
  /**
   * The duration of tile fade animations in milliseconds.
   */
  fadeDuration: number = 300;
  /**
   * Whether to cancel pending tile requests while zooming.
   */
  cancelPendingTileRequestsWhileZooming: boolean = false;
  /**
   * The number of zoom levels above the source max zoom to overscale tiles.
   */
  zoomLevelsToOverscale: number | undefined;
  /**
   * Requests the tileset renderer to repaint.
   */
  triggerRepaint: () => void = () => {};
  stylesheet: StyleSpecification = clone(empty);
  dispatcher: WorkerDispatcher;
  images: StyleImages;
  glyphSource: GlyphSource;
  dashAtlas: DashAtlas;
  light?: Light;

  _frameRequest?: AbortController;
  _loadStyleRequest?: AbortController;
  _spriteRequest?: AbortController;
  _layers: { [_: string]: StyleLayer } = {};
  _serializedLayers: { [_: string]: LayerSpecification } | null;
  _order: string[] = [];
  tilePyramids: { [_: string]: TilePyramid } = {};
  zoomHistory: ZoomHistory = new ZoomHistory();
  _loaded = false;
  _changed = false;
  _updatedSources: { [_: string]: 'clear' | 'reload' } = {};
  _updatedLayers: { [_: string]: true } = {};
  _removedLayers: { [_: string]: StyleLayer } = {};
  _changedImages: { [_: string]: true } = {};
  _imagesListDirty = false;
  _glyphsDidChange = false;
  _updatedPaintProps: { [layer: string]: true } = {};
  _layerOrderChanged = false;
  // image ids of images loaded from style's sprite
  _spritesImagesIds: { [spriteId: string]: string[] } = {};
  // image ids of all images loaded (sprite + user)
  _availableImages: string[] = [];
  _globalState: Record<string, any> = {};
  z = 0;
  /** Render-facing revision for style and zoom evaluation changes. */
  renderRevision = 0;
  /** Revision for style mutations, excluding a camera-only zoom change. */
  styleRevision = 0;

  constructor(transformRequest?: RequestTransformFunction, options: StyleOptions = {}) {
    super();

    this.transformRequest = transformRequest;
    this.dispatcher = new WorkerDispatcher(getSharedWorkerPool(), `style-${styleIdCounter++}`, error => this.fire(new ErrorEvent(error)));
    void this.dispatcher.registerMessageHandler(MessageType.getGlyphs, (mapId, params) => {
      return this.getGlyphs(mapId, params);
    }).catch(() => {});
    void this.dispatcher.registerMessageHandler(MessageType.getImages, (mapId, params) => {
      return this.getImages(mapId, params);
    }).catch(() => {});
    void this.dispatcher.registerMessageHandler(MessageType.getDashes, (mapId, params) => {
      return this.getDashes(mapId, params);
    }).catch(() => {});
    this.images = new StyleImages();
    this.images.setEventedParent(this);
    if (options.pixelRatio !== undefined && options.pixelRatio > 0) {
      this.pixelRatio = options.pixelRatio;
    }
    const glyphLang = (typeof document !== 'undefined' && document.documentElement?.lang) || undefined;
    this.glyphSource = new GlyphSource(transformRequest, options.localIdeographFontFamily, glyphLang);
    this.dashAtlas = new DashAtlas(256, 512);
    Object.assign(this, this._getInitialValues());

    this._resetUpdates();

    void this.dispatcher.broadcast(MessageType.setReferrer, getReferrer()).catch(() => {});
    const rtlPlugin = rtlMainThreadPluginFactory();
    rtlPlugin.on(RTLPluginLoadedEventName, this._rtlPluginLoaded);
    void rtlPlugin.syncStateWithWorkers().catch(() => {});

    this.on('data', (event) => {
      if (event.dataType !== 'source' || event.sourceDataType !== 'metadata') {
        return;
      }

      const tilePyramid = this.tilePyramids[event.sourceId];
      if (!tilePyramid) {
        return;
      }

      const source = tilePyramid.getSource();
      if (!source?.vectorLayerIds) {
        return;
      }

      for (const layerId in this._layers) {
        const layer = this._layers[layerId];
        if (layer.source === source.id) {
          this._validateLayer(layer);
        }
      }
    });
  }

  private _getInitialValues() {
    return {
      _spritesImagesIds: {},
      _layers: {},
      _order: [],
      tilePyramids: {},
      zoomHistory: new ZoomHistory(),
      _availableImages: [],
      _imagesListDirty: false,
      _globalState: {},
      _serializedLayers: null,
      stylesheet: clone(empty),
      light: undefined,
      _loaded: false,
      _changed: false,
      _updatedLayers: {},
      _updatedSources: {},
      _changedImages: {},
      _glyphsDidChange: false,
      _updatedPaintProps: {},
      _layerOrderChanged: false,
      z: 0,
      renderRevision: 0,
      styleRevision: 0,
    };
  }

  _rtlPluginLoaded: () => void = () => {
    for (const id in this.tilePyramids) {
      const sourceType = this.tilePyramids[id].getSource().type;
      if (sourceType === 'vector' || sourceType === 'geojson') {
        // Non-vector sources don't have any symbols buckets to reload when the RTL text plugin loads
        // They also load more quickly, so they're more likely to have already displaying tiles
        // that would be unnecessarily booted by the plugin load event
        this.tilePyramids[id].reload(); // Should be a no-op if the plugin loads before any tiles load
      }
    }
  };

  setGlobalStateProperty(name: string, value: any): this {
    this._checkLoaded();

    const newValue = value === null
      ? this.stylesheet.state?.[name]?.default ?? null
      : value;

    if (deepEqual(newValue, this._globalState[name])) {
      return this;
    }

    this._globalState[name] = newValue;

    this._applyGlobalStateChanges([name]);
    return this;
  }

  getGlobalState(): Record<string, any> {
    return this._globalState;
  }

  setGlobalState(newStylesheetState: StateSpecification): void {
    this._checkLoaded();

    const changedGlobalStateRefs = [];

    for (const propertyName in newStylesheetState) {
      const didChange = !deepEqual(this._globalState[propertyName], newStylesheetState[propertyName].default);

      if (didChange) {
        changedGlobalStateRefs.push(propertyName);
        this._globalState[propertyName] = newStylesheetState[propertyName].default;
      }
    }

    this._applyGlobalStateChanges(changedGlobalStateRefs);
  }

  /**
   * Find all sources that are affected by the global state changes and reload them.
   * Find all paint properties that are affected by the global state changes and update them.
   * For example, if a layer filter uses global-state expression, this function will find the source id of that layer.
   * @internal
   */
  _applyGlobalStateChanges(globalStateRefs: string[]): void {
    if (globalStateRefs.length === 0) {
      return;
    }

    const sourceIdsToReload = new Set<string>();
    const globalStateChange: Record<string, any> = {};

    for (const ref of globalStateRefs) {
      globalStateChange[ref] = this._globalState[ref];

      for (const layerId in this._layers) {
        const layer = this._layers[layerId];
        const layoutAffectingGlobalStateRefs = layer.getLayoutAffectingGlobalStateRefs();
        const paintAffectingGlobalStateRefs = layer.getPaintAffectingGlobalStateRefs();
        const visibilityAffectingGlobalStateRefs = layer.getVisibilityAffectingGlobalStateRefs();

        if (layoutAffectingGlobalStateRefs.has(ref)) {
          sourceIdsToReload.add(layer.source);
        }
        const paintProperties = paintAffectingGlobalStateRefs.get(ref);
        if (paintProperties) {
          for (const { name, value } of paintProperties) {
            this._updatePaintProperty(layer, name, value);
          }
        }
        if (visibilityAffectingGlobalStateRefs?.has(ref)) {
          layer.recalculateVisibility();
          this._updateLayer(layer);
        }
      }
    }

    // Propagate global state changes to workers
    void this.dispatcher.broadcast(MessageType.updateGlobalState, globalStateChange).catch(() => {});

    for (const id in this.tilePyramids) {
      if (sourceIdsToReload.has(id)) {
        this._reloadSource(id);
        this._changed = true;
      }
    }
  }

  async loadURL(url: string, options: StyleSwapOptions & StyleSetterOptions = {}, previousStyle?: StyleSpecification): Promise<void> {
    this.fire(new StyleDataEvent('dataloading'));

    options.validate = typeof options.validate === 'boolean'
      ? options.validate
      : true;

    this._loadStyleRequest = new AbortController();
    const abortController = this._loadStyleRequest;
    try {
      const request = await transformRequest(url, ResourceType.Style, this.transformRequest);
      throwIfAborted(abortController.signal);

      const response = await getJSON<StyleSpecification>(request, abortController);
      if (this._loadStyleRequest === abortController) {
        // Clear this request only if it is still the active style load. A stale
        // request can finish after a newer loadURL() call has already installed
        // another controller, and must not clear that newer abort handle.
        delete this._loadStyleRequest;
      }
      this._load(response.data, options, previousStyle);
    }
    catch (error) {
      if (this._loadStyleRequest === abortController) {
        delete this._loadStyleRequest;
      }
      if (error && !abortController.signal.aborted) { // ignore abort
        this.fire(new ErrorEvent(ensureError(error)));
      }
    }
  }

  loadJSON(json: StyleSpecification, options: StyleSetterOptions & StyleSwapOptions = {}, previousStyle?: StyleSpecification): void {
    this.fire(new StyleDataEvent('dataloading'));

    this._frameRequest = new AbortController();
    browser.frameAsync(this._frameRequest).then(() => {
      delete this._frameRequest;
      options.validate = options.validate !== false;
      this._load(json, options, previousStyle);
    }).catch(() => {}); // ignore abort
  }

  loadEmpty(): void {
    this.fire(new StyleDataEvent('dataloading'));
    this._load(empty, { validate: false });
  }

  _load(json: StyleSpecification, options: StyleSwapOptions & StyleSetterOptions, previousStyle?: StyleSpecification): void {
    let nextState = options.transformStyle ? options.transformStyle(previousStyle, json) : json;
    if (options.validate && validateStyleAndEmit(this, nextState)) {
      return;
    }

    nextState = { ...nextState };

    this._loaded = true;
    // The layer set goes from empty to the loaded specification here, so every
    // layer's paint is still at its specification default. Flag the style as
    // changed: update() skips recalculation on frames with no mutation, and
    // without this the defaults would never be evaluated.
    this._changed = true;
    this.stylesheet = nextState;

    for (const id in nextState.sources) {
      this.addSource(id, nextState.sources[id], { validate: false });
    }

    if (nextState.sprite) {
      this._loadSprite(nextState.sprite);
    }
    else {
      this.images.setLoaded(true);
    }

    this.glyphSource.setURL(nextState.glyphs);
    this._createLayers();
    this._applyRasterFadeDurations();

    this.light = new Light(this.stylesheet.light ?? {}, this._globalState);
    this.fire(new StyleDataEvent('data'));
    this.fire(new StyleLoadEvent());
  }

  private _createLayers() {
    const dereferencedLayers = derefLayers(this.stylesheet.layers);

    this.setGlobalState(this.stylesheet.state ?? null);

    // Broadcast layers to workers first, so that expensive style processing (createStyleLayer)
    // can happen in parallel on both main and worker threads.
    void this.dispatcher.broadcast(MessageType.setLayers, dereferencedLayers).catch(() => {});

    this._order = dereferencedLayers.map(layer => layer.id);
    this._layers = {};

    // reset serialization field, to be populated only when needed
    this._serializedLayers = null;
    for (const layer of dereferencedLayers) {
      const styledLayer = createStyleLayer(layer, this._globalState);
      styledLayer.setEventedParent(this, { layer: { id: layer.id } });
      this._layers[layer.id] = styledLayer;
    }
  }

  _loadSprite(sprite: SpriteSpecification, isUpdate: boolean = false, completion?: (err?: Error) => void): void {
    this._spriteRequest?.abort();
    this.images.setLoaded(false);

    const abortController = new AbortController();
    this._spriteRequest = abortController;
    let err: Error | undefined;
    loadSprite(sprite, this.transformRequest, this.pixelRatio, abortController).then((images) => {
      if (this._spriteRequest !== abortController) {
        return;
      }
      if (images) {
        // Drop sprites that disappeared from the sprite spec entirely: their
        // images would otherwise stay in the StyleImages forever and leak on
        // every setStyle that swaps the sprite id.
        const newSpriteIds = new Set(Object.keys(images));
        for (const spriteId of Object.keys(this._spritesImagesIds)) {
          if (!newSpriteIds.has(spriteId)) {
            for (const id of this._spritesImagesIds[spriteId]) {
              this.images.removeImage(id);
              this._changedImages[id] = true;
            }
            delete this._spritesImagesIds[spriteId];
          }
        }
        for (const spriteId in images) {
          const previous = this._spritesImagesIds[spriteId];
          const newIds = Object.keys(images[spriteId]).map(id => spriteId === 'default' ? id : `${spriteId}:${id}`);
          const newIdSet = new Set(newIds);
          if (previous) {
            for (const id of previous) {
              if (!newIdSet.has(id)) {
                this.images.removeImage(id);
                this._changedImages[id] = true;
              }
            }
          }
          this._spritesImagesIds[spriteId] = newIds;

          for (const id in images[spriteId]) {
            // don't prefix images of the "default" sprite
            const imageId = spriteId === 'default' ? id : `${spriteId}:${id}`;
            // save all the sprite's images' ids to be able to delete them in `removeSprite`
            if (imageId in this.images.images) {
              this.images.updateImage(imageId, images[spriteId][id], false);
            }
            else {
              this.images.addImage(imageId, images[spriteId][id]);
            }

            if (isUpdate) {
              this._changedImages[imageId] = true;
            }
          }
        }
      }
    }).catch((error) => {
      if (this._spriteRequest !== abortController) {
        return;
      }
      err = error;
      if (!abortController.signal.aborted) { // ignore abort
        this.fire(new ErrorEvent(err));
      }
    }).finally(() => {
      if (this._spriteRequest !== abortController) {
        return;
      }
      delete this._spriteRequest;
      this.images.setLoaded(true);
      this._availableImages = this.images.listImages();

      if (isUpdate) {
        this._changed = true;
      }

      void this.dispatcher.broadcast(MessageType.setImages, this._availableImages).catch(() => {});
      this.fire(new StyleDataEvent('data'));

      if (completion) {
        completion?.(err);
      }
    });
  }

  _unloadSprite(): void {
    this._spriteRequest?.abort();
    delete this._spriteRequest;
    for (const id of Object.values(this._spritesImagesIds).flat()) {
      this.images.removeImage(id);
      this._changedImages[id] = true;
    }

    this._spritesImagesIds = {};
    this._availableImages = this.images.listImages();
    this.images.setLoaded(true);
    this._imagesListDirty = true;
    this._changed = true;
    this.fire(new StyleDataEvent('data'));
  }

  _validateLayer(layer: StyleLayer): void {
    if (!layer.source) {
      return;
    }
    const tilePyramid = this.tilePyramids[layer.source];
    if (!tilePyramid) {
      return;
    }

    const sourceLayer = layer.sourceLayer;
    if (!sourceLayer) {
      return;
    }

    const source = tilePyramid.getSource();
    if (source.type === 'geojson' || (source.vectorLayerIds && !source.vectorLayerIds.includes(sourceLayer))) {
      this.fire(new ErrorEvent(new Error(
        `Source layer "${sourceLayer}" `
        + `does not exist on source "${source.id}" `
        + `as specified by style layer "${layer.id}".`,
      )));
    }
  }

  loaded(): boolean {
    if (!this._loaded)
      return false;

    if (Object.keys(this._updatedSources).length)
      return false;

    for (const id in this.tilePyramids) {
      if (!this.tilePyramids[id].loaded())
        return false;
    }

    return this.images.isLoaded();
  }

  /**
   * @hidden
   * take an array of string IDs, and based on this._layers, generate an array of LayerSpecification
   * @param ids - an array of string IDs, for which serialized layers will be generated. If omitted, all serialized layers will be returned
   * @param returnClone - if true, return a clone of the layer object
   * @returns generated result
   */
  private _serializeByIds(ids: string[], returnClone: boolean = false): LayerSpecification[] {
    const serializedLayersDictionary = this._serializedAllLayers();
    if (!ids || ids.length === 0) {
      return returnClone ? Object.values(clone(serializedLayersDictionary)) : Object.values(serializedLayersDictionary);
    }

    const serializedLayers = [];
    for (const id of ids) {
      // this check will skip all custom layers
      if (serializedLayersDictionary[id]) {
        const toPush = returnClone ? clone(serializedLayersDictionary[id]) : serializedLayersDictionary[id];
        serializedLayers.push(toPush);
      }
    }

    return serializedLayers;
  }

  /**
   * @hidden
   * Lazy initialization of this._serializedLayers dictionary and return it
   * @returns this._serializedLayers dictionary
   */
  private _serializedAllLayers(): { [_: string]: LayerSpecification } {
    let serializedLayers = this._serializedLayers;
    if (serializedLayers) {
      return serializedLayers;
    }

    serializedLayers = this._serializedLayers = {};
    const allLayerIds: string [] = Object.keys(this._layers);
    for (const layerId of allLayerIds) {
      serializedLayers[layerId] = this._layers[layerId].serialize();
    }

    return serializedLayers;
  }

  hasTransitions(): boolean {
    return this.getRenderTransitionFlags().any;
  }

  /**
   * Return transition classes consumed by the CesiumVectorTileset. The
   * classification is performed in one layer pass instead of repeating
   * broad, vector, and raster scans in the tileset update loop.
   * @internal
   */
  getRenderTransitionFlags(): RenderTransitionFlags {
    return renderTransitionFlags(this.light, this.tilePyramids, this._layers, this._order);
  }

  _checkLoaded(): asserts this is this & { light: Light } {
    if (!this._loaded) {
      throw new Error('Style is not done loading.');
    }
  }

  /**
   * Apply queued style updates in a batch and recalculate zoom-dependent paint properties.
   * @internal
   */
  update(parameters: EvaluationParameters): RenderTransitionFlags {
    if (!this._loaded) {
      return this.getRenderTransitionFlags();
    }

    const changed = this._changed;
    // Exact comparison would treat the tileset's float-noise zoom wiggle (~1e-11
    // during pans) as a real zoom change; see PAINT_ZOOM_EPSILON.
    const zoomChanged = !samePaintZoom(this.z, parameters.zoom);
    // A changed style must be recalculated regardless of transition state, so
    // defer transition classification until after the mutation is applied.
    // On steady frames there is only one classification pass; the old path
    // scanned every source and layer both before and after recalculation.
    let transitionFlags: RenderTransitionFlags | undefined;
    if (!changed) {
      transitionFlags = this.getRenderTransitionFlags();
    }
    // Recalculation is the expensive part of the frame path. Static scenes
    // have no pending style mutation, zoom change, or transition, so retain
    // the last evaluated paint/layout values exactly as MapLibre does between
    // transform/style invalidations.
    if (!changed && !zoomChanged && !transitionFlags!.any) {
      return transitionFlags;
    }
    if (changed) {
      if (this._imagesListDirty) {
        void this.dispatcher.broadcast(MessageType.setImages, this._availableImages).catch(() => {});
        this._imagesListDirty = false;
      }

      const updatedIds = Object.keys(this._updatedLayers);
      const removedIds = Object.keys(this._removedLayers);

      if (updatedIds.length || removedIds.length) {
        this._updateWorkerLayers(updatedIds, removedIds);
      }
      for (const id in this._updatedSources) {
        const action = this._updatedSources[id];

        if (action === 'reload') {
          this._reloadSource(id);
        }
        else if (action === 'clear') {
          this._clearSource(id);
        }
        else {
          throw new Error(`Invalid action ${action}`);
        }
      }

      this._updateTilesForChangedImages();
      this._updateTilesForChangedGlyphs();

      for (const id in this._updatedPaintProps) {
        this._layers[id].updateTransitions(parameters);
      }

      this.light?.updateTransitions(parameters);

      this._resetUpdates();
    }

    const previousSourceUsage: Record<string, boolean | undefined> = {};

    // save 'used' status to previousSourceUsage object and reset all tilePyramids 'used' field to false
    for (const id in this.tilePyramids) {
      const tilePyramid = this.tilePyramids[id];

      // tilePyramid.used could be undefined, and previousSourceUsage[id] is also 'undefined'
      previousSourceUsage[id] = tilePyramid.used;
      tilePyramid.used = false;
    }

    // loop all layers and find layers that are not hidden at parameters.zoom
    // and set used to true in tilePyramids dictionary for the sources of these layers
    for (const layerId of this._order) {
      const layer = this._layers[layerId];

      layer.recalculate(parameters, this._availableImages);
      if (!layer.isHidden(parameters.zoom) && layer.source) {
        this.tilePyramids[layer.source].used = true;
      }
    }
    this._applyRasterFadeDurations();

    // cross check previousSourceUsage against updated this.tilePyramids dictionary
    // if "used" field is different fire visibility event
    for (const id in previousSourceUsage) {
      const tilePyramid = this.tilePyramids[id];

      // (undefine !== false) will evaluate to true and fire an useless visibility event
      // need force "falsy" values to boolean to avoid the case above
      if (!!previousSourceUsage[id] !== !!tilePyramid.used) {
        tilePyramid.fire(new SourceDataEvent('data', {
          sourceDataType: 'visibility',
          sourceId: id,
        }));
      }
    }

    this.light?.recalculate(parameters);
    this.z = parameters.zoom;
    if (changed) {
      this.styleRevision++;
    }
    if (changed || zoomChanged) {
      this.renderRevision++;
    }

    if (changed) {
      this.fire(new StyleDataEvent('data'));
    }
    return changed ? this.getRenderTransitionFlags() : transitionFlags!;
  }

  /*
     * Apply any queued image changes.
     */
  _updateTilesForChangedImages(): void {
    const changedImages = Object.keys(this._changedImages);
    if (changedImages.length) {
      for (const name in this.tilePyramids) {
        this.tilePyramids[name].reloadTilesForDependencies(['icons', 'patterns'], changedImages);
      }
      this._changedImages = {};
    }
  }

  /**
   * Feed each raster layer's `raster-fade-duration` to its source's tile
   * pyramid so the crossfade driver knows how long transitions last.
   */
  _applyRasterFadeDurations(): void {
    for (const id of this._order) {
      const layer = this._layers[id];
      if (!isRasterStyleLayer(layer)) {
        continue;
      }
      this.tilePyramids[layer.source].setRasterFadeDuration(layer.paint.get('raster-fade-duration'));
    }
  }

  _updateTilesForChangedGlyphs(): void {
    if (this._glyphsDidChange) {
      for (const name in this.tilePyramids) {
        this.tilePyramids[name].reloadTilesForDependencies(['glyphs'], ['']);
      }
      this._glyphsDidChange = false;
    }
  }

  _updateWorkerLayers(updatedIds: string[], removedIds: string[]): void {
    void this.dispatcher.broadcast(MessageType.updateLayers, {
      layers: this._serializeByIds(updatedIds, false),
      removedIds,
    }).catch(() => {});
  }

  _resetUpdates(): void {
    this._changed = false;

    this._updatedLayers = {};
    this._removedLayers = {};

    this._updatedSources = {};
    this._updatedPaintProps = {};

    this._changedImages = {};
    this._glyphsDidChange = false;
  }

  /**
   * Update this style's state to match the given style JSON, performing only
   * the necessary mutations.
   *
   * May throw an Error ('Unimplemented: METHOD') if the maplibre-gl-style-spec
   * diff algorithm produces an operation that is not supported.
   *
   * @returns true if any changes were made; false otherwise
   */
  setState(nextState: StyleSpecification, options: StyleSwapOptions & StyleSetterOptions = {}): boolean {
    this._checkLoaded();

    const serializedStyle = this.serialize();
    nextState = options.transformStyle ? options.transformStyle(serializedStyle, nextState) : nextState;
    const validate = options.validate ?? true;
    if (validate && validateStyleAndEmit(this, nextState))
      return false;

    nextState = clone(nextState);
    nextState.layers = derefLayers(nextState.layers);

    if (!serializedStyle) {
      throw new Error('Style is not serialized.');
    }
    const changes = diffStyles(serializedStyle, nextState);
    const operations = this._getOperationsToPerform(changes);

    if (operations.unimplemented.length > 0) {
      throw new Error(`Unimplemented: ${operations.unimplemented.join(', ')}.`);
    }

    if (operations.operations.length === 0) {
      return false;
    }

    // A new style starts with a fresh zoom history; integer-zoom crossfade
    // state from the previous style would otherwise bleed into the first
    // frames of the swapped style.
    this.zoomHistory = new ZoomHistory();

    for (const styleChangeOperation of operations.operations) {
      styleChangeOperation();
    }

    this.stylesheet = nextState;

    // reset serialization field, to be populated only when needed
    this._serializedLayers = null;

    this.fire(new StyleLoadEvent({ style: this }));

    return true;
  }

  _getOperationsToPerform(diff: Array<DiffCommand<DiffOperations>>): { operations: Array<() => void>; unimplemented: string[] } {
    const operations: Array<() => void> = [];
    const unimplemented: string[] = [];
    for (const op of diff) {
      switch (op.command) {
        case 'setCenter':
        case 'setZoom':
        case 'setBearing':
        case 'setPitch':
        case 'setRoll':
          continue;
        case 'addLayer': {
          const [layerObject, before] = op.args;
          operations.push(() => this.addLayer(layerObject, before ?? undefined));
          break;
        }
        case 'removeLayer': {
          const [id] = op.args;
          operations.push(() => this.removeLayer(id));
          break;
        }
        case 'setPaintProperty': {
          const [layerId, name, value] = op.args;
          operations.push(() => this.setPaintProperty(layerId, name, value));
          break;
        }
        case 'setLayoutProperty': {
          const [layerId, name, value] = op.args;
          operations.push(() => this.setLayoutProperty(layerId, name, value));
          break;
        }
        case 'setFilter': {
          const [layerId, filter] = op.args;
          operations.push(() => this.setFilter(layerId, filter));
          break;
        }
        case 'addSource': {
          const [id, source] = op.args;
          operations.push(() => this.addSource(id, source));
          break;
        }
        case 'removeSource': {
          const [id] = op.args;
          operations.push(() => this.removeSource(id));
          break;
        }
        case 'setLayerZoomRange': {
          const [layerId, minzoom, maxzoom] = op.args;
          operations.push(() => this.setLayerZoomRange(layerId, minzoom, maxzoom));
          break;
        }
        case 'setLight':
          operations.push(() => this.setLight(op.args[0]));
          break;
        case 'setGeoJSONSourceData': {
          const [id, data] = op.args;
          operations.push(() => this.setGeoJSONSourceData(id, data));
          break;
        }
        case 'setGlyphs': {
          const [glyphsUrl] = op.args;
          operations.push(() => this.setGlyphs(glyphsUrl));
          break;
        }
        case 'setSprite': {
          const [sprite] = op.args;
          operations.push(() => this.setSprite(sprite));
          break;
        }

        case 'setGlobalState': {
          const [state] = op.args;
          operations.push(() => this.setGlobalState(state));
          break;
        }
        case 'setTransition':
          operations.push(() => {});
          break;
        // projection is managed by the tileset (Cesium globe); keep the style JSON in sync
        case 'setProjection':
          operations.push(() => {});
          break;
        default:
          unimplemented.push(op.command);
          break;
      }
    }
    const result: { operations: Array<() => void>; unimplemented: string[] } = {
      operations,
      unimplemented,
    };
    return result;
  }

  addImage(id: string, image: StyleImage): void {
    if (this.getImage(id)) {
      this.fire(new ErrorEvent(new Error(`An image named "${id}" already exists.`)));
      return;
    }
    this.images.addImage(id, image);
    this._afterImageUpdated(id);
  }

  updateImage(id: string, image: StyleImage): void {
    const previous = this.images.getImage(id);
    const layoutChanged = previous.pixelRatio !== image.pixelRatio || previous.sdf !== image.sdf;
    this.images.updateImage(id, image);
    if (layoutChanged) {
      this._afterImageUpdated(id);
    }
    else {
      this.fire(new StyleDataEvent('data'));
    }
  }

  getImage(id: string): StyleImage {
    return this.images.getImage(id);
  }

  setMissingImageResolver(resolver: MissingImageRequestHandler | null): void {
    this.images.setMissingImageResolver(resolver);
  }

  removeImage(id: string): void {
    if (!this.getImage(id)) {
      this.fire(new ErrorEvent(new Error(`An image named "${id}" does not exist.`)));
      return;
    }
    this.images.removeImage(id);
    this._afterImageUpdated(id);
  }

  _afterImageUpdated(id: string): void {
    this._availableImages = this.images.listImages();
    this._changedImages[id] = true;
    this._imagesListDirty = true;
    this._changed = true;
    this.fire(new StyleDataEvent('data'));
  }

  listImages(): string[] {
    this._checkLoaded();

    return this.images.listImages();
  }

  addSource(id: string, source: SourceSpecification | CanvasSourceSpecification, options: StyleSetterOptions = {}): void {
    this._checkLoaded();

    if (this.tilePyramids[id] !== undefined) {
      throw new Error(`Source "${id}" already exists.`);
    }

    if (!source.type) {
      throw new Error(`The type property must be defined, but only the following properties were given: ${Object.keys(source).join(', ')}.`);
    }

    const shouldValidate = SPEC_SOURCE_TYPES.has(source.type);
    if (shouldValidate && this._validate(validateStyle.source, `sources.${id}`, source, null, options))
      return;
    const tilePyramid = this.tilePyramids[id] = new TilePyramid(id, source, this.dispatcher);
    tilePyramid.style = this;
    tilePyramid.setEventedParent(this, () => ({
      isSourceLoaded: tilePyramid.loaded(),
      source: tilePyramid.serialize(),
      sourceId: id,
    }));

    tilePyramid.onAdd();
    this._changed = true;
  }

  /**
   * Remove a source from this stylesheet, given its id.
   * @param id - id of the source to remove
   * @throws if no source is found with the given ID
   */
  removeSource(id: string): this {
    this._checkLoaded();

    if (this.tilePyramids[id] === undefined) {
      throw new Error(`There is no source with this ID=${id}`);
    }
    for (const layerId in this._layers) {
      if (this._layers[layerId].source === id) {
        return this.fire(new ErrorEvent(new Error(`Source "${id}" cannot be removed while layer "${layerId}" is using it.`)));
      }
    }

    const tilePyramid = this.tilePyramids[id];
    delete this.tilePyramids[id];
    delete this._updatedSources[id];
    tilePyramid.fire(new SourceDataEvent('data', { sourceDataType: 'metadata', sourceId: id }));
    tilePyramid.setEventedParent(null);
    tilePyramid.onRemove();
    this._changed = true;
    return this;
  }

  /**
   * Set the data of a GeoJSON source, given its id.
   * @param id - id of the source
   * @param data - GeoJSON source
   */
  setGeoJSONSourceData(id: string, data: GeoJSON.GeoJSON | string): void {
    this._checkLoaded();

    if (this.tilePyramids[id] === undefined)
      throw new Error(`There is no source with this ID=${id}`);
    const geojsonSource: GeoJSONSource = this.tilePyramids[id].getSource() as any;
    if (geojsonSource.type !== 'geojson')
      throw new Error(`geojsonSource.type is ${geojsonSource.type}, which is !== 'geojson`);

    geojsonSource.setData(data);
    this._changed = true;
  }

  /**
   * Get a source by ID.
   * @param id - ID of the desired source
   * @returns source
   */
  getSource(id: string): Source | undefined {
    return this.tilePyramids[id]?.getSource();
  }

  /**
   * Add a layer to the map style. The layer will be inserted before the layer with
   * ID `before`, or appended if `before` is omitted.
   * @param layerObject - The style layer to add.
   * @param before - ID of an existing layer to insert before
   * @param options - Style setter options.
   */
  addLayer(layerObject: AddLayerObject, before?: string, options: StyleSetterOptions = {}): this {
    this._checkLoaded();

    const id = layerObject.id;

    if (this.getLayer(id)) {
      this.fire(new ErrorEvent(new Error(`Layer "${id}" already exists on this map.`)));
      return this;
    }

    if ('source' in layerObject && typeof layerObject.source === 'object') {
      this.addSource(id, layerObject.source);
      layerObject = clone(layerObject);
      layerObject = Object.assign(layerObject, { source: id });
    }

    // this layer is not in the style.layers array, so we pass an impossible array index
    if (this._validate(validateStyle.layer, `layers.${id}`, layerObject, { arrayIndex: -1 }, options)) {
      return this;
    }

    const layer = createStyleLayer(layerObject as LayerSpecification, this._globalState);
    this._validateLayer(layer);

    layer.setEventedParent(this, { layer: { id } });

    const index = before ? this._order.indexOf(before) : this._order.length;
    if (before && index === -1) {
      this.fire(new ErrorEvent(new Error(`Cannot add layer "${id}" before non-existing layer "${before}".`)));
      return this;
    }

    this._order.splice(index, 0, id);
    this._layerOrderChanged = true;

    this._layers[id] = layer;

    if (this._removedLayers[id] && layer.source) {
      // If, in the current batch, we have already removed this layer
      // and we are now re-adding it with a different `type`, then we
      // need to clear (rather than just reload) the underlying source's
      // tiles.  Otherwise, tiles marked 'reloading' will have buckets /
      // buffers that are set up for the _previous_ version of this
      // layer and cannot be reused for the new layer type.
      const removed = this._removedLayers[id];
      delete this._removedLayers[id];
      const sourceId = layer.source;
      if (removed.type !== layer.type) {
        this._updatedSources[sourceId] = 'clear';
      }
      else {
        this._updatedSources[sourceId] = 'reload';
        this.tilePyramids[sourceId].pause();
      }
    }
    this._updateLayer(layer);
    return this;
  }

  /**
   * Moves a layer to a different z-position. The layer will be inserted before the layer with
   * ID `before`, or appended if `before` is omitted.
   * @param id - ID of the layer to move
   * @param before - ID of an existing layer to insert before
   */
  moveLayer(id: string, before?: string): void {
    this._checkLoaded();
    this._changed = true;

    const layer = this._layers[id];
    if (!layer) {
      this.fire(new ErrorEvent(new Error(`The layer '${id}' does not exist in the map's style and cannot be moved.`)));
      return;
    }

    if (id === before) {
      return;
    }

    const index = this._order.indexOf(id);
    this._order.splice(index, 1);

    const newIndex = before ? this._order.indexOf(before) : this._order.length;
    if (before && newIndex === -1) {
      this.fire(new ErrorEvent(new Error(`Cannot move layer "${id}" before non-existing layer "${before}".`)));
      return;
    }
    this._order.splice(newIndex, 0, id);

    this._layerOrderChanged = true;
  }

  /**
   * Remove the layer with the given id from the style.
   * A {@link ErrorEvent} event will be fired if no such layer exists.
   *
   * @param id - id of the layer to remove
   */
  removeLayer(id: string): void {
    this._checkLoaded();

    const layer = this._layers[id];
    if (!layer) {
      this.fire(new ErrorEvent(new Error(`Cannot remove non-existing layer "${id}".`)));
      return;
    }

    layer.setEventedParent(null);

    const index = this._order.indexOf(id);
    this._order.splice(index, 1);

    this._layerOrderChanged = true;
    this._changed = true;
    this._removedLayers[id] = layer;
    delete this._layers[id];

    if (this._serializedLayers) {
      delete this._serializedLayers[id];
    }
    delete this._updatedLayers[id];
    delete this._updatedPaintProps[id];
  }

  /**
   * Return the style layer object with the given `id`.
   *
   * @param id - id of the desired layer
   * @returns a layer, if one with the given `id` exists
   */
  getLayer(id: string): StyleLayer | undefined {
    return this._layers[id];
  }

  /**
   * Return the ids of all layers currently in the style, including custom layers, in order.
   *
   * @returns ids of layers, in order
   */
  getLayersOrder(): string[] {
    return [...this._order];
  }

  /**
   * Return the live internal order for render-path iteration.
   * @internal
   */
  _getLayerOrder(): readonly string[] {
    return this._order;
  }

  /**
   * Checks if a specific layer is present within the style.
   *
   * @param id - the id of the desired layer
   * @returns a boolean specifying if the given layer is present
   */
  hasLayer(id: string): boolean {
    return id in this._layers;
  }

  setLayerZoomRange(layerId: string, minzoom?: number | null, maxzoom?: number | null): void {
    this._checkLoaded();

    const layer = this.getLayer(layerId);
    if (!layer) {
      this.fire(new ErrorEvent(new Error(`Cannot set the zoom range of non-existing layer "${layerId}".`)));
      return;
    }

    if (layer.minzoom === minzoom && layer.maxzoom === maxzoom)
      return;

    if (minzoom != null) {
      layer.minzoom = minzoom;
    }
    if (maxzoom != null) {
      layer.maxzoom = maxzoom;
    }
    this._updateLayer(layer);
  }

  setFilter(layerId: string, filter?: FilterSpecification | null, options: StyleSetterOptions = {}): void {
    this._checkLoaded();

    const layer = this.getLayer(layerId);
    if (!layer) {
      this.fire(new ErrorEvent(new Error(`Cannot filter non-existing layer "${layerId}".`)));
      return;
    }

    if (deepEqual(layer.filter, filter)) {
      return;
    }

    if (filter === null || filter === undefined) {
      layer.setFilter(undefined);
      this._updateLayer(layer);
      return;
    }

    if (this._validate(validateStyle.filter, `layers.${layer.id}.filter`, filter, null, options)) {
      return;
    }

    layer.setFilter(clone(filter));
    this._updateLayer(layer);
  }

  /**
   * Get a layer's filter object
   * @param layer - the layer to inspect
   * @returns the layer's filter, if any
   */
  getFilter(layer: string): FilterSpecification | void {
    return clone(this.getLayer(layer)?.filter);
  }

  setLayoutProperty<K extends keyof AllLayoutProperties>(layerId: string, name: K, value: AllLayoutProperties[K], options: StyleSetterOptions = {}): void {
    this._checkLoaded();

    const layer = this.getLayer(layerId);
    if (!layer) {
      this.fire(new ErrorEvent(new Error(`Cannot style non-existing layer "${layerId}".`)));
      return;
    }

    if (deepEqual(layer.getLayoutProperty(name), value))
      return;

    layer.setLayoutProperty(name, value, options);
    this._updateLayer(layer);
  }

  /**
   * Get a layout property's value from a given layer
   * @param layerId - the layer to inspect
   * @param name - the name of the layout property
   * @returns the property value
   */
  getLayoutProperty<K extends keyof AllLayoutProperties>(layerId: string, name: K): AllLayoutProperties[K] | undefined {
    const layer = this.getLayer(layerId);
    if (!layer) {
      this.fire(new ErrorEvent(new Error(`Cannot get style of non-existing layer "${layerId}".`)));
      return;
    }

    return layer.getLayoutProperty(name);
  }

  setPaintProperty<K extends keyof AllPaintProperties>(layerId: string, name: K, value: AllPaintProperties[K], options: StyleSetterOptions = {}): void {
    this._checkLoaded();

    const layer = this.getLayer(layerId);
    if (!layer) {
      this.fire(new ErrorEvent(new Error(`Cannot style non-existing layer "${layerId}".`)));
      return;
    }

    if (deepEqual(layer.getPaintProperty(name), value))
      return;

    this._updatePaintProperty(layer, name, value, options);
  }

  _updatePaintProperty<K extends keyof AllPaintProperties>(layer: StyleLayer, name: K, value: AllPaintProperties[K], options: StyleSetterOptions = {}): void {
    const requiresRelayout = layer.setPaintProperty(name, value, options);
    if (requiresRelayout) {
      this._updateLayer(layer);
    }

    this._changed = true;
    this._updatedPaintProps[layer.id] = true;
    // reset serialization field, to be populated only when needed
    this._serializedLayers = null;
  }

  getPaintProperty<K extends keyof AllPaintProperties>(layer: string, name: K): AllPaintProperties[K] {
    const styleLayer = this.getLayer(layer);
    if (!styleLayer) {
      throw new Error(`Cannot get style of non-existing layer "${layer}".`);
    }
    return styleLayer.getPaintProperty(name);
  }

  setFeatureState(target: FeatureIdentifier, state: FeatureState): void {
    this._checkLoaded();
    const sourceId = target.source;
    const sourceLayer = target.sourceLayer;
    const tilePyramid = this.tilePyramids[sourceId];

    if (tilePyramid === undefined) {
      this.fire(new ErrorEvent(new Error(`The source '${sourceId}' does not exist in the map's style.`)));
      return;
    }
    const sourceType = tilePyramid.getSource().type;
    if (sourceType === 'geojson' && sourceLayer) {
      this.fire(new ErrorEvent(new Error('GeoJSON sources cannot have a sourceLayer parameter.')));
      return;
    }
    if (sourceType === 'vector' && !sourceLayer) {
      this.fire(new ErrorEvent(new Error('The sourceLayer parameter must be provided for vector source types.')));
      return;
    }
    if (target.id === undefined) {
      this.fire(new ErrorEvent(new Error('The feature id parameter must be provided.')));
      return;
    }
    const forbiddenStateKeys = ['__proto__', 'constructor', 'prototype'];
    if (state && Object.keys(state).some((stateKey: string) => forbiddenStateKeys.includes(stateKey))) {
      this.fire(new ErrorEvent(new Error(`The feature state should not include one of the following keys: ${forbiddenStateKeys}`)));
      return;
    }

    tilePyramid.setFeatureState(sourceLayer ?? '', target.id, state);
  }

  removeFeatureState(target: FeatureIdentifier, key?: string): void {
    this._checkLoaded();
    const sourceId = target.source;
    const tilePyramid = this.tilePyramids[sourceId];

    if (tilePyramid === undefined) {
      this.fire(new ErrorEvent(new Error(`The source '${sourceId}' does not exist in the map's style.`)));
      return;
    }

    const sourceType = tilePyramid.getSource().type;
    const sourceLayer = sourceType === 'vector' ? target.sourceLayer : undefined;

    if (sourceType === 'vector' && !sourceLayer) {
      this.fire(new ErrorEvent(new Error('The sourceLayer parameter must be provided for vector source types.')));
      return;
    }

    if (key && (typeof target.id !== 'string' && typeof target.id !== 'number')) {
      this.fire(new ErrorEvent(new Error('A feature id is required to remove its specific state property.')));
      return;
    }

    tilePyramid.removeFeatureState(sourceLayer, target.id, key);
  }

  getFeatureState(target: FeatureIdentifier): FeatureState {
    this._checkLoaded();
    const sourceId = target.source;
    const sourceLayer = target.sourceLayer;
    const tilePyramid = this.tilePyramids[sourceId];

    if (tilePyramid === undefined) {
      this.fire(new ErrorEvent(new Error(`The source '${sourceId}' does not exist in the map's style.`)));
      return;
    }
    const sourceType = tilePyramid.getSource().type;
    if (sourceType === 'vector' && !sourceLayer) {
      this.fire(new ErrorEvent(new Error('The sourceLayer parameter must be provided for vector source types.')));
      return;
    }
    if (target.id === undefined) {
      this.fire(new ErrorEvent(new Error('The feature id parameter must be provided.')));
    }

    if (target.id === undefined) {
      return {};
    }
    return tilePyramid.getFeatureState(sourceLayer ?? '', target.id);
  }

  getTransition(): { duration: number; delay: number } & TransitionSpecification {
    return Object.assign({ duration: 300, delay: 0 }, this.stylesheet?.transition);
  }

  serialize(): StyleSpecification | undefined {
    // We return undefined before we're loaded, following the pattern of Map.getStyle() before
    // the Style object is initialized.
    // Internally, Style._validate() calls Style.serialize() but callers are responsible for
    // calling Style._checkLoaded() first if their validation requires the style to be loaded.
    if (!this._loaded)
      return;

    const sources = mapObject(this.tilePyramids, source => source.serialize());
    const layers = this._serializeByIds(this._order, true);
    return filterObject({
      ...this.stylesheet,
      sources,
      layers,
    }, value => value !== undefined) as StyleSpecification;
  }

  _updateLayer(layer: StyleLayer): void {
    this._updatedLayers[layer.id] = true;
    if (layer.source && !this._updatedSources[layer.source]
    // Raster tiles do not contain style-dependent geometry buckets to reload.
      && this.tilePyramids[layer.source].getSource().type !== 'raster') {
      this._updatedSources[layer.source] = 'reload';
      this.tilePyramids[layer.source].pause();
    }

    // upon updating, serialized layer dictionary should be reset.
    // When needed, it will be populated with the correct copy again.
    this._serializedLayers = null;
    this._changed = true;
  }

  getLight(): LightSpecification {
    this._checkLoaded();
    return this.light.getLight();
  }

  setLight(lightOptions: LightSpecification, options: StyleSetterOptions = {}): void {
    this._checkLoaded();

    const light = this.light.getLight();
    let _update = false;
    for (const key in lightOptions) {
      if (!deepEqual(lightOptions[key], light[key])) {
        _update = true;
        break;
      }
    }
    if (!_update)
      return;

    const parameters = {
      now: performance.now(),
      transition: Object.assign({
        duration: 300,
        delay: 0,
      }, this.stylesheet.transition),
    };

    this.light.setLight(lightOptions, options);
    this.light.updateTransitions(parameters);
  }

  _validate(validate: Validator, key: string, value: any, props: any, options: StyleSetterOptions = {}): boolean {
    return validateAndEmit(this, validate, {
      key,
      style: this.serialize(),
      value,
      ...props,
    }, options);
  }

  _clearSource(id: string): void {
    this.tilePyramids[id].clearTiles();
  }

  _reloadSource(id: string): void {
    this.tilePyramids[id].resume();
    this.tilePyramids[id].reload();
  }

  // Callbacks from web workers

  async getImages(_mapId: string | number, params: GetImagesParameters): Promise<GetImagesResponse> {
    const images = await this.images.getImages(params.icons);

    // Apply queued image changes before setting the tile's dependencies so that the tile
    // is not reloaded unnecessarily. Without this forced update the reload could happen in cases
    // like this one:
    // - icons contains "my-image"
    // - images.getImages(...) resolves "my-image" with a missing-image resolver
    // - addImage adds "my-image" to this._changedImages
    // - the next frame triggers a reload of this tile even though it already has the latest version
    this._updateTilesForChangedImages();

    const tilePyramid = this.tilePyramids[params.source];
    if (tilePyramid) {
      tilePyramid.setDependencies(params.tileID.key, params.type, params.icons);
    }
    return images;
  }

  async getGlyphs(_mapId: string | number, params: GetGlyphsParameters): Promise<GetGlyphsResponse> {
    const glyphs = await this.glyphSource.getGlyphs(params.stacks);
    const tilePyramid = this.tilePyramids[params.source];
    if (tilePyramid) {
      // we are not setting stacks as dependencies since for now
      // we just need to know which tiles have glyph dependencies
      tilePyramid.setDependencies(params.tileID.key, params.type, ['']);
    }
    return glyphs;
  }

  getGlyphsUrl(): string | null {
    return this.stylesheet.glyphs || null;
  }

  setGlyphs(glyphsUrl: string | null | undefined, options: StyleSetterOptions = {}): void {
    this._checkLoaded();

    if (glyphsUrl && this._validate(validateStyle.glyphs, 'glyphs', glyphsUrl, null, options)) {
      return;
    }

    this._glyphsDidChange = true;
    this.stylesheet.glyphs = glyphsUrl;
    this.glyphSource.entries = {};
    this.glyphSource.setURL(glyphsUrl);
  }

  async getDashes(_mapId: string | number, params: GetDashesParameters): Promise<GetDashesResponse> {
    const result: GetDashesResponse = {};
    for (const [key, dash] of Object.entries(params.dashes)) {
      result[key] = this.dashAtlas.getDash(dash.dasharray, dash.round);
    }
    return result;
  }

  /**
   * Add a sprite.
   *
   * @param id - The id of the desired sprite
   * @param url - The url to load the desired sprite from
   * @param options - The style setter options
   * @param completion - The completion handler
   */
  addSprite(id: string, url: string, options: StyleSetterOptions = {}, completion?: (err?: Error) => void): void {
    this._checkLoaded();

    const spriteToAdd = [{ id, url }];
    const updatedSprite = [
      ...normalizeSprite(this.stylesheet.sprite),
      ...spriteToAdd,
    ];

    if (this._validate(validateStyle.sprite, 'sprite', updatedSprite, null, options))
      return;

    this.stylesheet.sprite = updatedSprite;
    this._loadSprite(updatedSprite, true, completion);
  }

  /**
   * Remove a sprite by its id. When the last sprite is removed, the whole `this.stylesheet.sprite` object becomes
   * `undefined`. This falsy `undefined` value later prevents attempts to load the sprite when it's absent.
   *
   * @param id - the id of the sprite to remove
   */
  removeSprite(id: string): void {
    this._checkLoaded();

    const internalSpriteRepresentation = normalizeSprite(this.stylesheet.sprite);

    if (!internalSpriteRepresentation.some(sprite => sprite.id === id)) {
      this.fire(new ErrorEvent(new Error(`Sprite "${id}" doesn't exists on this map.`)));
      return;
    }

    if (this._spritesImagesIds[id]) {
      for (const imageId of this._spritesImagesIds[id]) {
        this.images.removeImage(imageId);
        this._changedImages[imageId] = true;
      }
    }

    internalSpriteRepresentation.splice(internalSpriteRepresentation.findIndex(sprite => sprite.id === id), 1);
    this.stylesheet.sprite = internalSpriteRepresentation.length > 0 ? internalSpriteRepresentation : undefined;

    delete this._spritesImagesIds[id];
    if (!this.stylesheet.sprite) {
      this._unloadSprite();
      return;
    }
    this._loadSprite(this.stylesheet.sprite, true);
    this._availableImages = this.images.listImages();
    this._imagesListDirty = true;
    this._changed = true;
    this.fire(new StyleDataEvent('data'));
  }

  /**
   * Get the current sprite value.
   *
   * @returns empty array when no sprite is set; id-url pairs otherwise
   */
  getSprite(): Array<{ id: string; url: string }> {
    return normalizeSprite(this.stylesheet.sprite);
  }

  /**
   * Set a new value for the style's sprite.
   *
   * @param sprite - new sprite value
   * @param options - style setter options
   * @param completion - the completion handler
   */
  setSprite(sprite: SpriteSpecification, options: StyleSetterOptions = {}, completion?: (err?: Error) => void): void {
    this._checkLoaded();

    if (sprite && this._validate(validateStyle.sprite, 'sprite', sprite, null, options)) {
      return;
    }

    this.stylesheet.sprite = sprite;

    if (sprite) {
      this._loadSprite(sprite, true, completion);
    }
    else {
      this._unloadSprite();
      if (completion) {
        completion(undefined);
      }
    }
  }

  /**
   * Destroys all internal resources of the style (sources, images, layers, etc.)
   */
  destroy(): void {
    // cancel any pending requests
    if (this._frameRequest) {
      this._frameRequest.abort();
      delete this._frameRequest;
    }
    if (this._loadStyleRequest) {
      this._loadStyleRequest.abort();
      delete this._loadStyleRequest;
    }
    if (this._spriteRequest) {
      this._spriteRequest.abort();
      delete this._spriteRequest;
    }

    // Worker-side map state (workerSources, layerIndexes, availableImages)
    // is only released on removeMap, and the RTL plugin listener closes over
    // this Style. Without both, a destroyed tileset leaks worker memory and
    // the RTL singleton forever.
    rtlMainThreadPluginFactory().off(RTLPluginLoadedEventName, this._rtlPluginLoaded);

    // remove sourcecaches
    for (const id in this.tilePyramids) {
      const tilePyramid = this.tilePyramids[id];
      tilePyramid.setEventedParent(null);
      tilePyramid.onRemove();
    }
    this.tilePyramids = {};

    // Destroy images and clear images
    if (this.images) {
      this.images.setEventedParent(null);
      this.images.destroy();
      this._availableImages = [];
      this._spritesImagesIds = {};
    }

    // Destroy glyphSource
    if (this.glyphSource) {
      this.glyphSource.destroy();
    }

    // Remove layers
    for (const layerId in this._layers) {
      const layer = this._layers[layerId];
      layer.setEventedParent(null);
    }

    // reset internal state
    Object.assign(this, this._getInitialValues());

    // Remove event listeners
    this.setEventedParent(null);
    this.dispatcher.remove();
    this._listeners = {};
    this._oneTimeListeners = {};
  }
}
