import type { StyleLayer } from '../../style/style-layer';
import type { FillExtrusionStyleLayer } from '../../style/style-layer/fill-extrusion-style-layer';
import type { FillStyleLayer } from '../../style/style-layer/fill-style-layer';
import type { LineStyleLayer } from '../../style/style-layer/line-style-layer';

export type PatternStyleLayer = FillStyleLayer | LineStyleLayer | FillExtrusionStyleLayer;

/** A declared pattern selects the pattern render track. */
export function isPatternStyleLayer(layer: StyleLayer): layer is PatternStyleLayer {
  if (layer.type !== 'fill' && layer.type !== 'line' && layer.type !== 'fill-extrusion') {
    return false;
  }
  const paint = layer.serialize().paint as Record<string, unknown> | undefined;
  return paint?.[`${layer.type}-pattern`] != null;
}
