import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';

import type { BackgroundPaintProps, BackgroundPaintPropsPossiblyEvaluated } from './background-style-layer-properties.g';
import { StyleLayer } from '../style-layer';
import properties from './background-style-layer-properties.g';

export class BackgroundStyleLayer extends StyleLayer<
  BackgroundPaintProps,
  Record<string, any>,
  BackgroundPaintPropsPossiblyEvaluated,
  Record<string, any>
> {
  constructor(layer: LayerSpecification, globalState: Record<string, any>) {
    super(layer, properties, globalState);
  }
}
