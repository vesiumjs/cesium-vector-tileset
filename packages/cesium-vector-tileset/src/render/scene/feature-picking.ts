import type { FeatureIndex } from '../../data/feature-index';
import type { StyleLayer } from '../../style/style-layer';
import type { PickableLayerType, TilesetPickingOptions } from '../../tileset-options';
import { GEOJSON_TILE_LAYER_NAME } from '../../data/feature-index';

/** Metadata returned directly by Cesium's geometry id or collection pickObject. */
export interface TilesetPickObject {
  type: PickableLayerType;
  layerId: string;
  source: string;
  sourceLayer?: string;
  featureId?: number | string;
  properties: Record<string, unknown>;
}

/** Construction-time policy and feature metadata shared by all render tracks. */
export class FeaturePicking {
  private readonly _options: TilesetPickingOptions;

  constructor(options: TilesetPickingOptions = false) {
    this._options = typeof options === 'boolean' ? options : { ...options };
  }

  enabled(type: PickableLayerType): boolean {
    return typeof this._options === 'boolean' ? this._options : this._options[type] === true;
  }

  feature(layer: StyleLayer, index: FeatureIndex | undefined, featureIndex: number): TilesetPickObject {
    if (!index)
      throw new Error(`Picking layer ${layer.id} requires its tile feature index`);
    const sourceLayer = layer.sourceLayer ?? GEOJSON_TILE_LAYER_NAME;
    const feature = index.features.getFeature(sourceLayer, featureIndex);
    if (!feature)
      throw new Error(`Picking feature ${featureIndex} in ${sourceLayer} is unavailable`);
    return {
      type: layer.type as PickableLayerType,
      layerId: layer.id,
      source: layer.source!,
      ...(layer.sourceLayer ? { sourceLayer: layer.sourceLayer } : {}),
      featureId: index.getId(feature, sourceLayer),
      properties: feature.properties,
    };
  }

  raster(layer: StyleLayer): TilesetPickObject {
    return { type: 'raster', layerId: layer.id, source: layer.source!, properties: {} };
  }
}
