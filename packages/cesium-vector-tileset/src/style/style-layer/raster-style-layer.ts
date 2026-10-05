import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';

import type { RasterPaintProps, RasterPaintPropsPossiblyEvaluated } from './raster-style-layer-properties.g';
import { StyleLayer } from '../style-layer';
import properties from './raster-style-layer-properties.g';

export const isRasterStyleLayer = (layer: StyleLayer): layer is RasterStyleLayer => layer.type === 'raster';

export class RasterStyleLayer extends StyleLayer<
  RasterPaintProps,
  Record<string, any>,
  RasterPaintPropsPossiblyEvaluated,
  Record<string, any>
> {
  constructor(layer: LayerSpecification, globalState: Record<string, any>) {
    super(layer, properties, globalState);
  }
}
