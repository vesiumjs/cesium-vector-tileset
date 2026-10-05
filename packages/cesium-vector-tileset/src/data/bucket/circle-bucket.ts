import type Point from '@mapbox/point-geometry';

import type { CircleStyleLayer } from '../../style/style-layer/circle-style-layer';
import type { CanonicalTileID } from '../../tile/tile-id';

import type {
  BucketFeature,
  BucketParameters,
  IndexedFeature,
  PopulateParameters,
} from '../bucket';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { PosArray } from '../array-types.g';
import { getPrimaryLayer } from '../bucket';
import { CircleBucket as CircleBucketRuntime } from '../bucket-runtime';
import { toEvaluationFeature } from '../evaluation-feature';
import { EXTENT } from '../extent';
import { loadGeometry } from '../load-geometry';
import { ProgramConfigurationSet } from '../program-configuration';

/**
 * Native point primitives consume one tile-local center per circle.
 * @internal
 */
export class CircleBucket<Layer extends CircleStyleLayer = CircleStyleLayer> extends CircleBucketRuntime<Layer> {
  availableImages?: string[];

  constructor(options: BucketParameters<Layer>) {
    super();
    this.availableImages = options.availableImages;
    this.zoom = options.zoom;
    this.overscaling = options.overscaling;
    this.layers = options.layers;
    this.layerIds = this.layers.map(layer => layer.id);
    this.index = options.index;
    this.hasDependencies = false;

    this.layoutVertexArray = new PosArray();
    this.geometryRanges = [];
    this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
    this.stateDependentLayers = this.layers.filter(layer => layer.isStateDependent());
    this.stateDependentLayerIds = this.stateDependentLayers.map(layer => layer.id);
  }

  populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
    const styleLayer = getPrimaryLayer(this.layers);
    const bucketFeatures: BucketFeature[] = [];
    const sourceFeaturesByIndex = new Map(features.map(({ index, feature }) => [index, feature]));
    const circleSortKey = styleLayer.layout.get('circle-sort-key');
    const sortFeaturesByKey = !circleSortKey.isConstant();

    const globalProperties = new EvaluationParameters(this.zoom);
    const needGeometry = styleLayer._featureFilter.needGeometry;
    for (const { feature, id, index, sourceLayerIndex } of features) {
      const evaluationFeature = toEvaluationFeature(feature, needGeometry);

      if (!styleLayer._featureFilter.filter(globalProperties, evaluationFeature, canonical))
        continue;

      const sortKey = sortFeaturesByKey
        ? circleSortKey.evaluate(evaluationFeature, {}, canonical)
        : undefined;

      const bucketFeature: BucketFeature = {
        id,
        properties: feature.properties,
        type: feature.type,
        sourceLayerIndex,
        index,
        geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature),
        patterns: {},
        sortKey,
      };

      bucketFeatures.push(bucketFeature);
    }

    if (sortFeaturesByKey) {
      bucketFeatures.sort((a, b) => {
        if (a.sortKey === undefined || b.sortKey === undefined)
          return 0;
        return a.sortKey - b.sortKey;
      });
    }

    for (const bucketFeature of bucketFeatures) {
      const { geometry, index, sourceLayerIndex } = bucketFeature;
      const feature = sourceFeaturesByIndex.get(index)!;

      this.addFeature(bucketFeature, geometry, index, canonical);
      options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.index);
    }
  }

  addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID): void {
    const start = this.layoutVertexArray.length;

    for (const ring of geometry) {
      for (const point of ring) {
        const vx = point.x;
        const vy = point.y;

        // Do not include points that are outside the tile boundaries.
        if (vx < 0 || vx >= EXTENT || vy < 0 || vy >= EXTENT) {
          continue;
        }

        this.layoutVertexArray.emplaceBack(vx, vy);
      }
    }

    this.geometryRanges.push({ featureIndex: index, start, end: this.layoutVertexArray.length });
    const paintSlotCount = this.programConfigurations.getFeatureRanges().length + 1;
    this.programConfigurations.populatePaintArrays(paintSlotCount, feature, index, { imagePositions: {}, canonical, availableImages: this.availableImages });
  }
}
