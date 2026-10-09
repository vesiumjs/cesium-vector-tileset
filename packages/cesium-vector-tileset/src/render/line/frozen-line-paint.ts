import type { Property } from '../../style/properties';
import type { LineStyleLayer } from '../../style/style-layer/line-style-layer';
import type { LineFeatureStyle } from '../vector/feature-attributes';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { PossiblyEvaluatedPropertyValue, PropertyValue } from '../../style/properties';
import { easeCubicInOut } from '../../util/math';
import { clone } from '../../util/objects';
import { straightAlphaColor } from '../vector/feature-attributes';

// Transitioning stores these nodes at runtime. Its public _values annotation
// describes the next evaluation stage rather than this transition tree.
interface PaintTransition {
  property: Property<unknown, unknown>;
  value: PropertyValue<unknown, unknown>;
  prior?: PaintTransition;
  begin: number;
  end: number;
}

export type FrozenLineCameraPaint = (zoom: number) => LineFeatureStyle;

function freezeProperty(node: PaintTransition, now: number): (zoom: number) => unknown {
  // Recompile, rather than sharing the expression's mutable global state and
  // evaluation context with the live layer. Feature paint never enters here.
  const value = new PropertyValue(node.property, clone(node.value.value), 'held-line-paint', clone(node.value.expression._globalState));
  const evaluate = (zoom: number) => value.possiblyEvaluate(new EvaluationParameters(zoom, { now }));
  if (!node.prior || now >= node.end || value.isDataDriven())
    return evaluate;
  const prior = freezeProperty(node.prior, now);
  if (now < node.begin)
    return prior;
  const amount = easeCubicInOut((now - node.begin) / (node.end - node.begin));
  const property = node.property;
  return zoom => property.interpolate(prior(zoom), evaluate(zoom), amount);
}

function unwrap(value: unknown): unknown {
  return value instanceof PossiblyEvaluatedPropertyValue ? value.constantOr(undefined) : value;
}

/** Preserve committed style and transition time while its camera zoom stays live. */
export function freezeLineCameraPaint(layer: LineStyleLayer): FrozenLineCameraPaint {
  const now = layer.paint.get('line-width').parameters.now;
  const transitions = layer._transitioningPaint._values;
  const width = freezeProperty(transitions['line-width'] as unknown as PaintTransition, now);
  const color = freezeProperty(transitions['line-color'] as unknown as PaintTransition, now);
  const opacity = freezeProperty(transitions['line-opacity'] as unknown as PaintTransition, now);
  const layerOpacity = freezeProperty(transitions['line-layer-opacity'] as unknown as PaintTransition, now);
  return (zoom) => {
    const rgba = unwrap(color(zoom)) as { r: number; g: number; b: number; a: number };
    const result = straightAlphaColor(rgba.r, rgba.g, rgba.b, rgba.a);
    result.alpha *= (unwrap(opacity(zoom)) as number) * (unwrap(layerOpacity(zoom)) as number);
    return { widthPx: unwrap(width(zoom)) as number, color: result };
  };
}
