import type { LineBucket } from '../../data/bucket-runtime';
import type { FeaturePaintRange, ProgramConfiguration } from '../../data/program-configuration';
import type { LineStyleLayer } from '../../style/style-layer/line-style-layer';
import type { FeaturePaintConfiguration, LineFeatureStyle } from '../vector/feature-attributes';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { findRange, layerFor, lineStyleForFeature, lineStyleForPaint } from '../vector/feature-attributes';

export type FrozenLineCameraPaint = (zoom: number) => LineFeatureStyle;

const properties = ['line-width', 'line-gap-width', 'line-offset', 'line-blur', 'line-color', 'line-opacity', 'line-layer-opacity'] as const;
const emptyConfiguration: FeaturePaintConfiguration = {
  getAttributeArray: () => undefined,
  getInterpolationFactor: () => 0,
};
const featureRange: FeaturePaintRange = { index: 0, start: 0, end: 1 };

/** Preserve committed style and transition time while its camera zoom stays live. */
export function freezeLineCameraPaint(layer: LineStyleLayer): FrozenLineCameraPaint {
  const now = layer.paint.get('line-width').parameters.now;
  const transitions = layer._transitioningPaint.snapshot(properties);
  return zoom => lineStyleForPaint({ paint: transitions.possiblyEvaluate(new EvaluationParameters(zoom, { now })) }, emptyConfiguration, featureRange, zoom);
}

interface FeaturePaintSnapshot {
  layerRevision: number;
  featureRevision: number;
  configuration: ProgramConfiguration;
  transitions: LineStyleLayer['_transitioningPaint'];
  evaluate: (index: number) => FrozenLineCameraPaint;
  features: Map<number, FrozenLineCameraPaint>;
}

const featureSnapshots = new WeakMap<LineBucket, Map<string, FeaturePaintSnapshot>>();

/** Copy committed feature slots and their interpolation rules before binders mutate. */
export function freezeLineFeaturePaint(bucket: LineBucket, layerId: string, indices: Iterable<number>): ReadonlyMap<number, FrozenLineCameraPaint> {
  const layer = layerFor(bucket, layerId);
  const configuration = bucket.programConfigurations.get(layerId);
  let layers = featureSnapshots.get(bucket);
  if (!layers)
    featureSnapshots.set(bucket, layers = new Map());
  let snapshot = layers.get(layerId);
  if (!snapshot || snapshot.layerRevision !== layer.paintRevision
    || snapshot.featureRevision !== bucket.programConfigurations.paintRevision
    || snapshot.configuration !== configuration || snapshot.transitions !== layer._transitioningPaint) {
    const now = layer.paint.get('line-width').parameters.now;
    const transitions = layer._transitioningPaint.snapshot(properties);
    const usesZoom = layer.hasTransition() || properties.some((property) => {
      const kind = layer._transitionablePaint._values[property]?.value.expression.kind;
      return kind === 'camera' || kind === 'composite';
    });
    let evaluatedZoom: number;
    let paint: LineStyleLayer['paint'];
    snapshot = {
      layerRevision: layer.paintRevision,
      featureRevision: bucket.programConfigurations.paintRevision,
      configuration,
      transitions: layer._transitioningPaint,
      features: new Map(),
      evaluate: (index) => {
        if (!usesZoom) {
          const style = lineStyleForFeature(bucket, index, layerId);
          return () => style;
        }
        const range = findRange(bucket, index);
        const slots = new Map<string, { arrayBuffer: ArrayBuffer; bytesPerElement: number; length: number }>();
        const factors = new Map<string, (zoom: number) => number>();
        for (const property of properties) {
          const array = configuration.getAttributeArray(property);
          if (!array)
            continue;
          const components = array.bytesPerElement / Float32Array.BYTES_PER_ELEMENT;
          const values = new Float32Array(array.arrayBuffer, range.start * array.bytesPerElement, components).slice();
          slots.set(property, { arrayBuffer: values.buffer, bytesPerElement: array.bytesPerElement, length: 1 });
          const expression = configuration.binders[property].expression;
          if (configuration.isCompositeProperty(property) && expression.kind === 'composite') {
            const lower = bucket.zoom;
            factors.set(property, (zoom) => {
              const factor = expression.interpolationFactor(zoom, lower, lower + 1);
              return Math.max(0, Math.min(1, Number.isFinite(factor) ? factor : 0));
            });
          }
        }
        const frozen: FeaturePaintConfiguration = {
          getAttributeArray: property => slots.get(property),
          getInterpolationFactor: (property, zoom) => factors.get(property)?.(zoom) ?? 0,
        };
        return (zoom) => {
          if (evaluatedZoom !== zoom) {
            paint = transitions.possiblyEvaluate(new EvaluationParameters(zoom, { now }));
            evaluatedZoom = zoom;
          }
          return lineStyleForPaint({ paint }, frozen, featureRange, zoom);
        };
      },
    };
    layers.set(layerId, snapshot);
  }
  const result = new Map<number, FrozenLineCameraPaint>();
  for (const index of indices) {
    let evaluate = snapshot.features.get(index);
    if (!evaluate) {
      evaluate = snapshot.evaluate(index);
      snapshot.features.set(index, evaluate);
    }
    result.set(index, evaluate);
  }
  return result;
}
