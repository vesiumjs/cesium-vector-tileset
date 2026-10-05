import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';

import type { CircleLayoutProps, CircleLayoutPropsPossiblyEvaluated, CirclePaintProps, CirclePaintPropsPossiblyEvaluated } from './circle-style-layer-properties.g';
import { StyleLayer } from '../style-layer';
import properties from './circle-style-layer-properties.g';

/**
 * A style layer that defines a circle
 */
export class CircleStyleLayer extends StyleLayer<
  CirclePaintProps,
  CircleLayoutProps,
  CirclePaintPropsPossiblyEvaluated,
  CircleLayoutPropsPossiblyEvaluated
> {
  constructor(layer: LayerSpecification, globalState: Record<string, any>) {
    super(layer, properties, globalState);
  }
}
