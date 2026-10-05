import type Point from '@mapbox/point-geometry';
import type { Feature } from '@maplibre/maplibre-gl-style-spec';
import type { VectorTileFeature } from '../source/vector-tile-data';
import { loadGeometry } from './load-geometry';

type EvaluationFeature = Feature & { geometry: Point[][] };
/**
 * Construct a new feature for expression evaluation, the geometry of which
 * will be loaded based on necessity.
 * @param feature - the feature to evaluate
 * @param needGeometry - if set to true this will load the geometry
 */
export function toEvaluationFeature(feature: VectorTileFeature, needGeometry: boolean): EvaluationFeature {
  return { type: feature.type, id: feature.id, properties: feature.properties, geometry: needGeometry ? loadGeometry(feature) : [] };
}
