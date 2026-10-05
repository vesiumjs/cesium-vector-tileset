import type { FeatureTable, Feature as MLTFeature } from '@maplibre/mlt';
import type { VectorTileData, VectorTileFeature, VectorTileLayer } from './vector-tile-data';
import Point from '@mapbox/point-geometry';
import { decodeTile, GEOMETRY_TYPE } from '@maplibre/mlt';
import { normalizeFeatureId } from './vector-tile-data';

class MLTVectorTileFeature implements VectorTileFeature {
  _featureData: MLTFeature;
  properties: VectorTileFeature['properties'];
  type: VectorTileFeature['type'];
  extent: VectorTileFeature['extent'];
  id: VectorTileFeature['id'];

  constructor(feature: MLTFeature, extent: number) {
    this._featureData = feature;
    this.properties = this._featureData.properties || {};
    switch (this._featureData.geometry?.type) {
      case GEOMETRY_TYPE.POINT:
      case GEOMETRY_TYPE.MULTIPOINT:
        this.type = 1;
        break;
      case GEOMETRY_TYPE.LINESTRING:
      case GEOMETRY_TYPE.MULTILINESTRING:
        this.type = 2;
        break;
      case GEOMETRY_TYPE.POLYGON:
      case GEOMETRY_TYPE.MULTIPOLYGON:
        this.type = 3;
        break;
      default:
        this.type = 0;
    };
    this.extent = extent;
    this.id = normalizeFeatureId(this._featureData.id);
  }

  loadGeometry(): Point[][] {
    const points: Point[][] = [];
    for (const ring of this._featureData.geometry.coordinates) {
      const pointRing: Point[] = [];
      for (const coord of ring) {
        pointRing.push(new Point(coord.x, coord.y));
      }
      points.push(pointRing);
    }
    return points;
  }
}

class MLTVectorTileLayer implements VectorTileLayer {
  featureTable: FeatureTable;
  name: string;
  length: number;
  version: number;
  extent: number;
  features: MLTFeature[] = [];

  constructor(featureTable: FeatureTable) {
    this.featureTable = featureTable;
    this.name = featureTable.name;
    this.extent = featureTable.extent;
    this.version = 2;
    this.features = featureTable.getFeatures();
    this.length = this.features.length;
  }

  feature(i: number): VectorTileFeature {
    return new MLTVectorTileFeature(this.features[i], this.extent);
  }
}

export class MLTVectorTile implements VectorTileData {
  layers: Record<string, VectorTileLayer> = {};

  constructor(buffer: ArrayBuffer) {
    const features = decodeTile(new Uint8Array(buffer), undefined, false);
    this.layers = features.reduce((acc, f) => ({ ...acc, [f.name]: new MLTVectorTileLayer(f) }), {});
  }
}
