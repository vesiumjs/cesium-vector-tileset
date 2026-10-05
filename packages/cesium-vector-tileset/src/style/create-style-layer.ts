import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import { BackgroundStyleLayer } from './style-layer/background-style-layer';
import { CircleStyleLayer } from './style-layer/circle-style-layer';
import { FillExtrusionStyleLayer } from './style-layer/fill-extrusion-style-layer';
import { FillStyleLayer } from './style-layer/fill-style-layer';
import { LineStyleLayer } from './style-layer/line-style-layer';
import { RasterStyleLayer } from './style-layer/raster-style-layer';

import { SymbolStyleLayer } from './style-layer/symbol-style-layer';

export type AnyStyleLayer
  = | CircleStyleLayer
    | FillExtrusionStyleLayer
    | FillStyleLayer
    | LineStyleLayer
    | SymbolStyleLayer
    | BackgroundStyleLayer
    | RasterStyleLayer;

export function createStyleLayer(layer: LayerSpecification, globalState: Record<string, any>): AnyStyleLayer {
  switch (layer.type) {
    case 'background':
      return new BackgroundStyleLayer(layer, globalState);
    case 'circle':
      return new CircleStyleLayer(layer, globalState);
    case 'fill':
      return new FillStyleLayer(layer, globalState);
    case 'fill-extrusion':
      return new FillExtrusionStyleLayer(layer, globalState);
    case 'line':
      return new LineStyleLayer(layer, globalState);
    case 'raster':
      return new RasterStyleLayer(layer, globalState);
    case 'symbol':
      return new SymbolStyleLayer(layer, globalState);
    default:
      throw new Error(`Unsupported style layer type "${layer.type}".`);
  }
}
