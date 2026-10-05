import type Point from '@mapbox/point-geometry';

/** Decoded source data shared by MVT, MLT, GeoJSON and overzoom slicing. */
export interface VectorTileFeature {
  type: 0 | 1 | 2 | 3;
  properties: Record<string, unknown>;
  id: string | number | undefined;
  extent: number;
  loadGeometry: () => Point[][];
}

export interface VectorTileLayer {
  version: number;
  name: string;
  extent: number;
  length: number;
  feature: (index: number) => VectorTileFeature;
}

export interface VectorTileData {
  layers: Record<string, VectorTileLayer>;
}

const MIN_SAFE_ID = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_ID = BigInt(Number.MAX_SAFE_INTEGER);

/** Keep integer identity without widening the expression or state ID protocol. */
export function normalizeFeatureId(id: string | number | bigint | undefined): string | number | undefined {
  if (typeof id !== 'bigint')
    return id;
  return id >= MIN_SAFE_ID && id <= MAX_SAFE_ID
    ? Number(id)
    : id.toString();
}
