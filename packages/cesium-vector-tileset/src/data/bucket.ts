import type Point from '@mapbox/point-geometry';
import type { Feature as StyleFeature } from '@maplibre/maplibre-gl-style-spec';
import type { FeatureStates } from '../source/source-state';
import type { VectorTileFeature } from '../source/vector-tile-data';
import type { Style } from '../style/style';
import type { StyleLayer } from '../style/style-layer';
import type { TypedStyleLayer } from '../style/style-layer/typed-style-layer';
import type { CollisionBoxArray } from './array-types.g';
import type { FeatureIndex } from './feature-index';
import type { FeatureLookup, PaintOptions } from './program-configuration';
import type { ProjectedBucketGeometry } from './projected-geometry';
import { CircleBucket, FillBucket, FillExtrusionBucket, LineBucket, SymbolBucket } from './bucket-runtime';

export interface BucketParameters<Layer extends TypedStyleLayer> {
  index: number;
  layers: Layer[];
  availableImages?: string[];
  zoom: number;
  pixelRatio: number;
  overscaling: number;
  collisionBoxArray: CollisionBoxArray;
  sourceLayerIndex: number;
  sourceID: string;
}

export interface PopulateParameters {
  featureIndex: FeatureIndex;
  iconDependencies: Record<string, boolean>;
  patternDependencies: Record<string, boolean>;
  glyphDependencies: Record<string, Record<string, boolean>>;
  dashDependencies: Record<string, { round: boolean; dasharray: number[] }>;
  availableImages: string[];
}

export interface IndexedFeature {
  feature: VectorTileFeature;
  id?: number | string;
  index: number;
  sourceLayerIndex: number;
}

export interface BucketFeature {
  index: number;
  sourceLayerIndex: number;
  geometry: Point[][];
  properties: VectorTileFeature['properties'];
  type: 0 | 1 | 2 | 3;
  id?: number | string;
  readonly patterns: {
    [_: string]: {
      min: string;
      mid: string;
      max: string;
    };
  };
  dashes?: NonNullable<StyleFeature['dashes']>;
  sortKey?: number;
}

export function getPrimaryLayer<Layer extends TypedStyleLayer>(layers: readonly Layer[]): Layer {
  const layer = layers[0];
  if (!layer) {
    throw new Error('A bucket must contain at least one style layer');
  }
  return layer;
}

/** Tile data shared by worker construction, scene rendering, and feature-state paint updates. */
export interface Bucket {
  projectedGeometry?: ProjectedBucketGeometry;
  layerIds: string[];
  hasDependencies: boolean;
  layers: StyleLayer[];
  stateDependentLayers: StyleLayer[];
  readonly stateDependentLayerIds: string[];
  update: (states: FeatureStates, lookup: FeatureLookup, options: PaintOptions) => void;
  isEmpty: () => boolean;
}

export function deserialize(input: Bucket[], style: Style): { [_: string]: Bucket } {
  const output: Record<string, Bucket> = {};

  for (const bucket of input) {
    const layers = bucket.layerIds
      .map(id => style.getLayer(id))
      .filter((layer): layer is StyleLayer => layer !== undefined);

    if (layers.length === 0) {
      continue;
    }

    // look up StyleLayer objects from layer ids (since we don't
    // want to waste time serializing/copying them from the worker)
    bucket.layers = layers;
    const typedLayers = layers as TypedStyleLayer[];
    if (bucket instanceof SymbolBucket) {
      bucket.text.programConfigurations.bindLayers(typedLayers);
      bucket.icon.programConfigurations.bindLayers(typedLayers);
    }
    else if (bucket instanceof CircleBucket || bucket instanceof FillBucket || bucket instanceof FillExtrusionBucket || bucket instanceof LineBucket) {
      bucket.programConfigurations.bindLayers(typedLayers);
    }
    else {
      throw new TypeError('Cannot bind paint for an unsupported bucket');
    }
    const layersById = new Map(layers.map(layer => [layer.id, layer] as const));
    bucket.stateDependentLayers = bucket.stateDependentLayerIds.flatMap((layerId) => {
      const layer = layersById.get(layerId);
      return layer ? [layer] : [];
    });
    for (const layer of layers) {
      output[layer.id] = bucket;
    }
  }

  return output;
}
