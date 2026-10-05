import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { EvaluationParameters } from '../evaluation-parameters';

import type { FillLayoutProps, FillLayoutPropsPossiblyEvaluated, FillPaintProps, FillPaintPropsPossiblyEvaluated } from './fill-style-layer-properties.g';
import { StyleLayer } from '../style-layer';
import properties from './fill-style-layer-properties.g';

export class FillStyleLayer extends StyleLayer<
  FillPaintProps,
  FillLayoutProps,
  FillPaintPropsPossiblyEvaluated,
  FillLayoutPropsPossiblyEvaluated
> {
  constructor(layer: LayerSpecification, globalState: Record<string, any>) {
    super(layer, properties, globalState);
  }

  recalculate(parameters: EvaluationParameters, availableImages: string[]): void {
    super.recalculate(parameters, availableImages);

    const outlineColor = this.paint._values['fill-outline-color'];
    if (outlineColor.value.kind === 'constant' && outlineColor.value.value === undefined) {
      this.paint._values['fill-outline-color'] = this.paint._values['fill-color'];
    }
  }

  isTileClipped(): boolean {
    return true;
  }
}
