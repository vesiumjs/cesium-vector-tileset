import type Point from '@mapbox/point-geometry';
import type { Feature } from '@maplibre/maplibre-gl-style-spec';
import type { VectorTileFeature } from '../source/vector-tile-data';
import { loadGeometry } from './load-geometry';

type EvaluationFeature = Feature & { geometry: Point[][] };

const minimumSafeInteger = BigInt(Number.MIN_SAFE_INTEGER);
const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const propertyViews = new WeakMap<Record<string, unknown>, Record<string, unknown>>();

/** Published source properties are immutable; expressions require Number scalars. */
function evaluationProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const cached = propertyViews.get(properties);
  if (cached)
    return cached;
  let view = properties;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'bigint' && value >= minimumSafeInteger && value <= maximumSafeInteger) {
      if (view === properties)
        view = { ...properties };
      view[key] = Number(value);
    }
  }
  propertyViews.set(properties, view);
  return view;
}

/** Keep raw picking metadata and unsafe integers intact while evaluating safe scalars. */
export function numericEvaluationFeature<F extends Feature | null | undefined>(feature: F): F {
  // Native expression evaluation treats absent feature/properties as empty.
  // Preserve that input so its existing default/coalesce behavior still runs.
  if (!feature?.properties)
    return feature;
  const properties = evaluationProperties(feature.properties);
  // Geometry can be assigned after filtering; cache only the properties view.
  return properties === feature.properties ? feature : { ...feature, properties };
}
/**
 * Construct a new feature for expression evaluation, the geometry of which
 * will be loaded based on necessity.
 * @param feature - the feature to evaluate
 * @param needGeometry - if set to true this will load the geometry
 */
export function toEvaluationFeature(feature: VectorTileFeature, needGeometry: boolean): EvaluationFeature {
  return numericEvaluationFeature({ type: feature.type, id: feature.id, properties: feature.properties, geometry: needGeometry ? loadGeometry(feature) : [] });
}
