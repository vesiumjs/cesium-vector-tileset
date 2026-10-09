import type { Style } from '../../style/style';
import type { StyleLayer } from '../../style/style-layer';
import type { RasterStyleLayer } from '../../style/style-layer/raster-style-layer';
import type { SymbolStyleLayer } from '../../style/style-layer/symbol-style-layer';
import type { PatternStyleLayer } from '../pattern/pattern-layer';
import { isRasterStyleLayer } from '../../style/style-layer/raster-style-layer';
import { isPatternStyleLayer } from '../pattern/pattern-layer';
import { constantValue } from '../vector/feature-attributes';

interface SourceLayers {
  raster: RasterStyleLayer[];
  pattern: PatternStyleLayer[];
  symbol: SymbolStyleLayer[];
}

const EMPTY_IDS: readonly string[] = [];

function append(index: Map<string, string[]>, sourceId: string, layerId: string): void {
  let ids = index.get(sourceId);
  if (!ids) {
    ids = [];
    index.set(sourceId, ids);
  }
  ids.push(layerId);
}

function rasterOpacity(layer: RasterStyleLayer): number {
  const value = constantValue(
    layer as unknown as { paint: { get: (property: string) => unknown } },
    'raster-opacity',
  );
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

function reuseLayers<T extends StyleLayer>(previous: T[] | undefined, current: T[]): T[] {
  return previous && previous.length === current.length
    && previous.every((layer, index) => layer === current[index])
    ? previous
    : current;
}

/** The ordered style-layer view consumed by the four Cesium render tracks. */
export class RenderLayerIndex {
  private _style: Style;

  private _order: ReadonlyMap<string, number> = new Map();

  private _rasterIds = new Map<string, string[]>();

  private _patternIds = new Map<string, string[]>();

  private _symbolIds = new Map<string, string[]>();

  private _allRaster: RasterStyleLayer[] = [];

  private _allPattern: PatternStyleLayer[] = [];

  private _sourceCache = new Map<string, { revision: number; layers: SourceLayers }>();

  private _visibilityRevision = -1;

  private _visibility: ReadonlyMap<string, boolean> = new Map();

  constructor(style: Style) {
    this._style = style;
    this.rebuildIndex(style);
  }

  get order(): ReadonlyMap<string, number> {
    return this._order;
  }

  /** Reindex when layer definitions or their order change. */
  rebuildIndex(style = this._style): void {
    this._style = style;
    this._rasterIds.clear();
    this._patternIds.clear();
    this._symbolIds.clear();
    this._sourceCache.clear();
    this._visibilityRevision = -1;
    const layers: StyleLayer[] = [];
    const order = style.getLayerOrder();
    this._order = new Map(order.map((id, index) => [id, index]));
    for (const id of order) {
      const layer = style.getLayer(id);
      if (layer) {
        layers.push(layer);
      }
    }
    this._allRaster = [];
    this._allPattern = [];
    for (const layer of layers) {
      if (isRasterStyleLayer(layer)) {
        if (!layer.isHidden(style.z)) {
          this._allRaster.push(layer);
        }
        if (layer.source) {
          append(this._rasterIds, layer.source, layer.id);
        }
      }
      if (isPatternStyleLayer(layer)) {
        if (!layer.isHidden(style.z)) {
          this._allPattern.push(layer);
        }
        if (layer.source) {
          append(this._patternIds, layer.source, layer.id);
        }
      }
      if (layer.type === 'symbol' && layer.source) {
        append(this._symbolIds, layer.source, layer.id);
      }
    }
  }

  get rasterLayers(): readonly RasterStyleLayer[] {
    return this._allRaster;
  }

  get patternLayers(): readonly PatternStyleLayer[] {
    return this._allPattern;
  }

  visibility(): ReadonlyMap<string, boolean> {
    if (this._visibilityRevision !== this._style.renderRevision) {
      const next = new Map<string, boolean>();
      let changed = false;
      for (const id of this._style.getLayerOrder()) {
        const layer = this._style.getLayer(id);
        const visible = !!layer && !layer.isHidden(this._style.z);
        next.set(id, visible);
        changed ||= this._visibility.get(id) !== visible;
      }
      if (changed || next.size !== this._visibility.size) {
        this._visibility = next;
      }
      this._visibilityRevision = this._style.renderRevision;
    }
    return this._visibility;
  }

  /**
   * @internal
   */
  private _sourceLayers(sourceId: string): SourceLayers {
    const revision = this._style.renderRevision;
    const cached = this._sourceCache.get(sourceId);
    if (cached?.revision === revision) {
      return cached.layers;
    }
    const visible = <T extends StyleLayer>(ids: readonly string[]): T[] => {
      const result: T[] = [];
      for (const id of ids) {
        const layer = this._style.getLayer(id) as T | undefined;
        if (layer && !layer.isHidden(this._style.z)) {
          result.push(layer);
        }
      }
      return result;
    };
    const previous = cached?.layers;
    const next: SourceLayers = {
      raster: reuseLayers(previous?.raster, visible<RasterStyleLayer>(this._rasterIds.get(sourceId) ?? EMPTY_IDS)
        .filter(layer => rasterOpacity(layer) > 0)),
      pattern: reuseLayers(previous?.pattern, visible<PatternStyleLayer>(this._patternIds.get(sourceId) ?? EMPTY_IDS)),
      symbol: reuseLayers(previous?.symbol, visible<SymbolStyleLayer>(this._symbolIds.get(sourceId) ?? EMPTY_IDS)),
    };
    this._sourceCache.set(sourceId, { revision, layers: next });
    return next;
  }

  rasterForSource(sourceId: string): readonly RasterStyleLayer[] {
    return this._sourceLayers(sourceId).raster;
  }

  patternForSource(sourceId: string): readonly PatternStyleLayer[] {
    return this._sourceLayers(sourceId).pattern;
  }

  symbolForSource(sourceId: string): readonly SymbolStyleLayer[] {
    return this._sourceLayers(sourceId).symbol;
  }
}
