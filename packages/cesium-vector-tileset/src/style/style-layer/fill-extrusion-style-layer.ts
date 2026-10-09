import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';

import type { FillExtrusionLayoutProps, FillExtrusionLayoutPropsPossiblyEvaluated, FillExtrusionPaintProps, FillExtrusionPaintPropsPossiblyEvaluated } from './fill-extrusion-style-layer-properties.g';
import { StyleLayer } from '../style-layer';
import properties from './fill-extrusion-style-layer-properties.g';

export class FillExtrusionStyleLayer extends StyleLayer<
  FillExtrusionPaintProps,
  FillExtrusionLayoutProps,
  FillExtrusionPaintPropsPossiblyEvaluated,
  FillExtrusionLayoutPropsPossiblyEvaluated
> {
  constructor(layer: LayerSpecification, globalState: Record<string, any>) {
    super(layer, properties, globalState);
  }

  is3D(): boolean {
    return true;
  }
}
