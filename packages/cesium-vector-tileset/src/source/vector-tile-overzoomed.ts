import type { CanonicalTileID } from '../tile/tile-id';
import type { VectorTileData, VectorTileFeature, VectorTileLayer } from './vector-tile-data';
import Point from '@mapbox/point-geometry';
import { clipGeometry } from '../symbol/clip-line';

class VectorTileFeatureOverzoomed implements VectorTileFeature {
  readonly type: VectorTileFeature['type'];
  readonly properties: VectorTileFeature['properties'];
  readonly id: VectorTileFeature['id'];
  readonly extent: number;

  private readonly geometry: Point[][];

  constructor(
    feature: VectorTileFeature,
    geometry: Point[][],
    extent: number,
  ) {
    this.type = feature.type;
    this.properties = feature.properties;
    this.id = feature.id;
    this.extent = extent;
    this.geometry = geometry;
  }

  loadGeometry(): Point[][] {
    // Bucket geometry loading mutates points during extent normalization.
    return this.geometry.map(ring =>
      ring.map(point => new Point(point.x, point.y)),
    );
  }
}

class VectorTileLayerOverzoomed implements VectorTileLayer {
  readonly version = 2;
  readonly length: number;
  readonly name: string;
  readonly extent: number;

  private readonly features: VectorTileFeature[];

  constructor(
    features: VectorTileFeature[],
    name: string,
    extent: number,
  ) {
    this.length = features.length;
    this.features = features;
    this.name = name;
    this.extent = extent;
  }

  feature(i: number): VectorTileFeature {
    return this.features[i];
  }
}

export class VectorTileOverzoomed implements VectorTileData {
  layers: Record<string, VectorTileLayer> = {};

  addLayer(layer: VectorTileLayer): void {
    this.layers[layer.name] = layer;
  }
}

/**
 * This function slices a source tile layer into an overzoomed tile layer for a target tile ID.
 * @param sourceLayer - the source tile layer to slice
 * @param maxZoomTileID - the maximum zoom tile ID
 * @param targetTileID - the target tile ID
 * @returns - the overzoomed tile layer
 */
export function sliceVectorTileLayer(sourceLayer: VectorTileLayer, maxZoomTileID: CanonicalTileID, targetTileID: CanonicalTileID): VectorTileLayer {
  const { extent } = sourceLayer;
  const scale = 2 ** (targetTileID.z - maxZoomTileID.z);

  // Work in the source layer's extent until bucket loading normalizes geometry.
  const offsetX = (targetTileID.x - maxZoomTileID.x * scale) * extent;
  const offsetY = (targetTileID.y - maxZoomTileID.y * scale) * extent;
  // Preserve the 128-unit buffer of a 4096-extent layer as a tile fraction.
  const buffer = extent / 32;

  const features: VectorTileFeature[] = [];
  for (let index = 0; index < sourceLayer.length; index++) {
    const feature = sourceLayer.feature(index);
    let geometry = feature.loadGeometry();

    // Transform all coordinates to target tile space
    for (const ring of geometry) {
      for (const point of ring) {
        point.x = point.x * scale - offsetX;
        point.y = point.y * scale - offsetY;
      }
    }

    geometry = clipGeometry(geometry, feature.type, -buffer, -buffer, extent + buffer, extent + buffer);
    if (geometry.length === 0) {
      continue;
    }

    features.push(new VectorTileFeatureOverzoomed(feature, geometry, extent));
  }
  return new VectorTileLayerOverzoomed(features, sourceLayer.name, extent);
}
