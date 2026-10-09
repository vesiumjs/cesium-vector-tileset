import type Point from '@mapbox/point-geometry';
import type { DashEntry } from '../../assets/dash-atlas';
import type { ImagePosition } from '../../assets/image-atlas';
import type { LineStyleLayer } from '../../style/style-layer/line-style-layer';
import type { CanonicalTileID } from '../../tile/tile-id';
import type {
  BucketFeature,
  BucketParameters,
  IndexedFeature,
  PopulateParameters,
} from '../bucket';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { getPrimaryLayer } from '../bucket';
import { LineBucket as LineBucketRuntime } from '../bucket-runtime';
import { toEvaluationFeature } from '../evaluation-feature';
import { loadGeometry } from '../load-geometry';
import { ProgramConfigurationSet } from '../program-configuration';
import { addPatternDependencies, hasPattern } from './pattern-bucket-features';

/**
 * Line bucket class
 * @internal
 */
export class LineBucket extends LineBucketRuntime {
  patternFeatures: BucketFeature[];
  availableImages?: string[];

  private hasDataDrivenLineLayout = false;

  constructor(options: BucketParameters<LineStyleLayer>) {
    super();
    this.availableImages = options.availableImages;
    this.zoom = options.zoom;
    this.layers = options.layers;
    this.layerIds = this.layers.map(layer => layer.id);
    this.index = options.index;
    this.hasDependencies = false;
    this.patternFeatures = [];
    this.linePaths = [];
    this.lineJoinCap = { join: 'miter', cap: 'butt', miterLimit: 2, roundLimit: 1.05 };
    this.featureLineJoinCaps = {};
    this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
    this.stateDependentLayers = this.layers.filter(layer => layer.isStateDependent());
    this.stateDependentLayerIds = this.stateDependentLayers.map(layer => layer.id);
  }

  populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
    const pattern = hasPattern('line', this.layers, options);
    const dash = this.hasLineDasharray(this.layers);
    this.hasDependencies = pattern || dash;
    const layer = getPrimaryLayer(this.layers);
    const lineSortKey = layer.layout.get('line-sort-key');
    const sortFeaturesByKey = !lineSortKey.isConstant();
    const bucketFeatures: BucketFeature[] = [];

    const globalProperties = new EvaluationParameters(this.zoom);
    const needGeometry = layer._featureFilter.needGeometry;
    for (const { feature, id, index, sourceLayerIndex } of features) {
      const evaluationFeature = toEvaluationFeature(feature, needGeometry);

      if (!layer._featureFilter.filter(globalProperties, evaluationFeature, canonical))
        continue;

      const sortKey = sortFeaturesByKey
        ? lineSortKey.evaluate(evaluationFeature, {}, canonical)
        : undefined;

      const bucketFeature: BucketFeature = {
        id,
        properties: feature.properties,
        type: feature.type,
        sourceLayerIndex,
        index,
        geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature),
        patterns: {},
        dashes: {},
        sortKey,
      };

      bucketFeatures.push(bucketFeature);
    }

    if (sortFeaturesByKey) {
      bucketFeatures.sort((a, b) => {
        if (a.sortKey === undefined || b.sortKey === undefined)
          return 0;
        return (a.sortKey) - (b.sortKey);
      });
    }

    for (const bucketFeature of bucketFeatures) {
      const { geometry, index, sourceLayerIndex } = bucketFeature;

      if (this.hasDependencies) {
        if (pattern) {
          addPatternDependencies('line', this.layers, bucketFeature, { zoom: this.zoom }, options);
        }
        else if (dash) {
          this.addLineDashDependencies(this.layers, bucketFeature, this.zoom, options);
        }

        // pattern features are added only once the pattern is loaded into the image atlas
        // so are stored during populate until later updated with positions by tile worker in addFeatures
        this.patternFeatures.push(bucketFeature);
      }
      else {
        this.addFeature(bucketFeature, geometry, index, canonical, {}, {});
      }

      const feature = features[index].feature;
      options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.index);
    }
  }

  addFeatures(_options: PopulateParameters, canonical: CanonicalTileID, imagePositions: { [_: string]: ImagePosition }, dashPositions?: { [_: string]: DashEntry }): void {
    for (const feature of this.patternFeatures) {
      this.addFeature(feature, feature.geometry, feature.index, canonical, imagePositions, dashPositions ?? {});
    }
  }

  addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, imagePositions: { [_: string]: ImagePosition }, dashPositions: Record<string, DashEntry>): void {
    const isPolygon = feature.type === 3;
    const firstFeature = this.linePaths.length === 0;
    let added = false;
    for (const line of geometry) {
      const points = this._centerline(line, isPolygon);
      if (!points) {
        continue;
      }
      this.linePaths.push({ featureIndex: index, points });
      added = true;
    }
    if (added) {
      const layout = this.layers[0].layout;
      if (firstFeature) {
        this.lineJoinCap = {
          join: layout.get('line-join').constantOr('miter'),
          cap: layout.get('line-cap').constantOr('butt'),
          miterLimit: layout.get('line-miter-limit').constantOr(2),
          roundLimit: layout.get('line-round-limit').constantOr(1.05),
        };
        this.hasDataDrivenLineLayout = !layout.get('line-join').isConstant()
          || !layout.get('line-cap').isConstant()
          || !layout.get('line-miter-limit').isConstant()
          || !layout.get('line-round-limit').isConstant();
      }
      if (this.hasDataDrivenLineLayout) {
        this.featureLineJoinCaps[index] = {
          join: layout.get('line-join').evaluate(feature, {}, canonical),
          cap: layout.get('line-cap').evaluate(feature, {}, canonical),
          miterLimit: layout.get('line-miter-limit').evaluate(feature, {}, canonical),
          roundLimit: layout.get('line-round-limit').evaluate(feature, {}, canonical),
        };
      }
      // Cesium evaluates paint once per feature. A single slot keeps the
      // ProgramConfiguration binders and feature-state updates intact without
      // building MapLibre's unused screen-space triangle strip.
      const paintSlotCount = this.programConfigurations.getFeatureRanges().length + 1;
      this.programConfigurations.populatePaintArrays(paintSlotCount, feature, index, { imagePositions, dashPositions, canonical, availableImages: this.availableImages });
    }
  }

  private _centerline(vertices: Point[], isPolygon: boolean): Int16Array | undefined {
    let end = vertices.length;
    while (end >= 2 && vertices[end - 1].equals(vertices[end - 2])) {
      end--;
    }
    let start = 0;
    while (start < end - 1 && vertices[start].equals(vertices[start + 1])) {
      start++;
    }
    if (end - start < (isPolygon ? 3 : 2)) {
      return undefined;
    }
    const first = vertices[start];
    const close = isPolygon && !first.equals(vertices[end - 1]);
    const points = new Int16Array((end - start + (close ? 1 : 0)) * 2);
    for (let i = start; i < end; i++) {
      const offset = (i - start) * 2;
      points[offset] = vertices[i].x;
      points[offset + 1] = vertices[i].y;
    }
    if (close) {
      points[points.length - 2] = first.x;
      points[points.length - 1] = first.y;
    }
    return points;
  }

  private hasLineDasharray(layers: LineStyleLayer[]): boolean {
    for (const layer of layers) {
      const dasharrayProperty = layer.paint.get('line-dasharray');
      if (dasharrayProperty && !dasharrayProperty.isConstant()) {
        return true;
      }
    }
    return false;
  }

  private addLineDashDependencies(layers: LineStyleLayer[], bucketFeature: BucketFeature, zoom: number, options: PopulateParameters) {
    for (const layer of layers) {
      const dasharrayProperty = layer.paint.get('line-dasharray');

      if (!dasharrayProperty || dasharrayProperty.value.kind === 'constant') {
        continue;
      }

      const round = layer.layout.get('line-cap').evaluate(bucketFeature, {}) === 'round';

      const min = {
        dasharray: dasharrayProperty.value.evaluate({ zoom: zoom - 1 }, bucketFeature, {}),
        round,
      };
      const mid = {
        dasharray: dasharrayProperty.value.evaluate({ zoom }, bucketFeature, {}),
        round,
      };
      const max = {
        dasharray: dasharrayProperty.value.evaluate({ zoom: zoom + 1 }, bucketFeature, {}),
        round,
      };

      const minKey = `${min.dasharray.join(',')},${min.round}`;
      const midKey = `${mid.dasharray.join(',')},${mid.round}`;
      const maxKey = `${max.dasharray.join(',')},${max.round}`;

      options.dashDependencies[minKey] = min;
      options.dashDependencies[midKey] = mid;
      options.dashDependencies[maxKey] = max;

      const dashes = bucketFeature.dashes ?? {};
      bucketFeature.dashes = dashes;
      dashes[layer.id] = { min: minKey, mid: midKey, max: maxKey };
    }
  }
}
