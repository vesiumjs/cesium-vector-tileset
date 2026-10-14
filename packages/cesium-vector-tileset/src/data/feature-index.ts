import type { PromoteIdSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { VectorTileFeature } from '../source/vector-tile-data';
import type { TransferRegistry } from '../worker/transfer-registry';
import { normalizeFeatureId } from '../source/vector-tile-data';
import { FeatureIndexArray } from './array-types.g';
import { FeatureSnapshot } from './feature-snapshot';

export const GEOJSON_TILE_LAYER_NAME = '_geojsonTileLayer';

/**
 * An in memory index class to allow fast interaction with features
 */
export class FeatureIndex {
  featureIndexArray: FeatureIndexArray;
  promoteId?: PromoteIdSpecification;
  bucketLayerIDs: string[][];
  /** Sorted source-layer order used to assign feature source-layer indices. */
  sourceLayerIds: string[] = [];
  features = new FeatureSnapshot([]);

  constructor(promoteId?: PromoteIdSpecification | null) {
    this.featureIndexArray = new FeatureIndexArray();
    this.promoteId = promoteId ?? undefined;
    this.bucketLayerIDs = [];
  }

  insert(featureIndex: number, sourceLayerIndex: number, bucketIndex: number): void {
    this.featureIndexArray.emplaceBack(featureIndex, sourceLayerIndex, bucketIndex);
  }

  getId(feature: { id?: VectorTileFeature['id']; properties: VectorTileFeature['properties'] }, sourceLayerId: string): string | number | undefined {
    let id: string | number | undefined = feature.id;
    if (this.promoteId) {
      const propName = typeof this.promoteId === 'string' ? this.promoteId : this.promoteId[sourceLayerId];
      if (propName !== undefined) {
        const promotedId = feature.properties[propName];
        if (typeof promotedId === 'string' || typeof promotedId === 'number' || typeof promotedId === 'bigint') {
          id = normalizeFeatureId(promotedId);
        }
        else if (typeof promotedId === 'boolean') {
          id = Number(promotedId);
        }
        else {
          id = undefined;
        }
      }

      // When cluster is true, the id is the cluster_id even though promoteId is set
      if (id === undefined && feature.properties.cluster === true) {
        id = Number(feature.properties.cluster_id);
      }
    }
    return id;
  }
}

export function registerFeatureIndexTransfers(registry: TransferRegistry): void {
  registry.register('FeatureIndex', FeatureIndex);
}
