import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { StyleLayer } from './style-layer';
import { groupByLayout } from '@maplibre/maplibre-gl-style-spec';
import { GEOJSON_TILE_LAYER_NAME } from '../data/feature-index';
import { createStyleLayer } from './create-style-layer';

export interface LayerConfigs { [_: string]: LayerSpecification }

export class StyleLayerIndex {
  familiesBySource: {
    [source: string]: {
      [sourceLayer: string]: StyleLayer[][];
    };
  } = Object.create(null);

  keyCache: { [source: string]: string };

  _layerConfigs: LayerConfigs = Object.create(null);
  _layers: { [_: string]: StyleLayer } = Object.create(null);

  constructor(layerConfigs?: LayerSpecification[] | null, globalState?: Record<string, any>) {
    this.keyCache = Object.create(null);
    if (layerConfigs) {
      this.replace(layerConfigs, globalState);
    }
  }

  replace(layerConfigs: LayerSpecification[], globalState?: Record<string, any>): void {
    this.keyCache = Object.create(null);
    this._layerConfigs = Object.create(null);
    this._layers = Object.create(null);
    this.update(layerConfigs, [], globalState);
  }

  update(layerConfigs: LayerSpecification[], removedIds: string[], globalState?: Record<string, any>): void {
    const state = globalState ?? {};
    for (const layerConfig of layerConfigs) {
      this._layerConfigs[layerConfig.id] = layerConfig;

      this._layers[layerConfig.id] = createStyleLayer(layerConfig, state);
      if (this.keyCache[layerConfig.id])
        delete this.keyCache[layerConfig.id];
    }
    for (const id of removedIds) {
      delete this.keyCache[id];
      delete this._layerConfigs[id];
      delete this._layers[id];
    }

    this.familiesBySource = Object.create(null);

    const groups = groupByLayout(Object.values(this._layerConfigs), this.keyCache);

    for (const layerConfigs of groups) {
      const layers = layerConfigs.map(layerConfig => this._layers[layerConfig.id]);

      const layer = layers[0];
      if (layer.isHidden()) {
        continue;
      }

      const sourceId = layer.source || '';
      let sourceGroup = this.familiesBySource[sourceId];
      sourceGroup ||= this.familiesBySource[sourceId] = Object.create(null);

      const sourceLayerId = layer.sourceLayer || GEOJSON_TILE_LAYER_NAME;
      let sourceLayerFamilies = sourceGroup[sourceLayerId];
      sourceLayerFamilies ||= sourceGroup[sourceLayerId] = [];

      sourceLayerFamilies.push(layers);
    }
  }
}
