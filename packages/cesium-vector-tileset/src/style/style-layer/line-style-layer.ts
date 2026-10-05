import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { LineLayoutProps, LineLayoutPropsPossiblyEvaluated, LinePaintProps, LinePaintPropsPossiblyEvaluated } from './line-style-layer-properties.g';
import { StyleLayer } from '../style-layer';
import properties from './line-style-layer-properties.g';

export class LineStyleLayer extends StyleLayer<
  LinePaintProps,
  LineLayoutProps,
  LinePaintPropsPossiblyEvaluated,
  LineLayoutPropsPossiblyEvaluated
> {
  constructor(layer: LayerSpecification, globalState: Record<string, any>) {
    super(layer, properties, globalState);
  }

  isTileClipped(): boolean {
    return true;
  }
}
