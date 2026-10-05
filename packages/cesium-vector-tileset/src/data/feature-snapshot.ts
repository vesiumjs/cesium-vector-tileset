import type { Feature } from '@maplibre/maplibre-gl-style-spec';
import type { TransferRegistry } from '../worker/transfer-registry';
import Point from '@mapbox/point-geometry';

export interface FeatureSnapshotInput {
  sourceLayer: string;
  index: number;
  id?: string | number;
  type: 0 | 1 | 2 | 3;
  properties: Record<string, unknown>;
  geometry?: Point[][];
}

type Scalar = string | number | boolean | bigint | null | undefined;

interface SnapshotGeometry {
  indices: Uint32Array;
  featureRingOffsets: Uint32Array;
  ringOffsets: Uint32Array;
  coordinates: Int16Array;
}

interface SnapshotLayer {
  indices: Uint32Array;
  offsets: Uint32Array;
  entries: Uint32Array;
  types: Uint8Array;
  ids: Array<string | number | undefined>;
  geometry?: SnapshotGeometry;
}

function findIndex(indices: Uint32Array, index: number): number {
  let start = 0;
  let end = indices.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    const candidate = indices[middle]!;
    if (candidate < index)
      start = middle + 1;
    else
      end = middle;
  }
  return start < indices.length && indices[start] === index ? start : -1;
}

function scalarKey(value: Scalar): string {
  return `${typeof value}:${Object.is(value, -0) ? '-0' : String(value)}`;
}

function isScalar(value: unknown): value is Scalar {
  return value === null || value === undefined || typeof value === 'string'
    || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint';
}

/** Tile-local feature metadata; source indices stay independent of dense paint slots. */
export class FeatureSnapshot {
  sourceLayers: string[];
  layers: SnapshotLayer[];
  keys: string[];
  values: unknown[];

  constructor(inputs: readonly FeatureSnapshotInput[]) {
    this.sourceLayers = [];
    this.layers = [];
    this.keys = [];
    this.values = [];
    const keyIndices = new Map<string, number>();
    const valueIndices = new Map<unknown, number>();
    const sorted = [...inputs].sort((left, right) =>
      left.sourceLayer < right.sourceLayer
        ? -1
        : left.sourceLayer > right.sourceLayer ? 1 : left.index - right.index,
    );

    const encodeKey = (key: string): number => {
      let index = keyIndices.get(key);
      if (index === undefined) {
        index = this.keys.length;
        keyIndices.set(key, index);
        this.keys.push(key);
      }
      return index;
    };
    const encodeValue = (value: unknown): number => {
      const scalar = isScalar(value);
      const key = scalar ? scalarKey(value) : value;
      let index = valueIndices.get(key);
      if (index === undefined) {
        index = this.values.length;
        valueIndices.set(key, index);
        this.values.push(scalar ? value : structuredClone(value));
      }
      return index;
    };

    let start = 0;
    while (start < sorted.length) {
      const sourceLayer = sorted[start]!.sourceLayer;
      let end = start + 1;
      while (end < sorted.length && sorted[end]!.sourceLayer === sourceLayer)
        end++;

      const length = end - start;
      const indices = new Uint32Array(length);
      const offsets = new Uint32Array(length + 1);
      const entries: number[] = [];
      const types = new Uint8Array(length);
      const ids: Array<string | number | undefined> = [];
      const geometryIndices: number[] = [];
      const featureRingOffsets = [0];
      const ringOffsets = [0];
      const coordinates: number[] = [];

      for (let position = start; position < end; position++) {
        const input = sorted[position]!;
        const featurePosition = position - start;
        indices[featurePosition] = input.index;
        types[featurePosition] = input.type;
        ids.push(input.id);
        for (const [key, value] of Object.entries(input.properties)) {
          entries.push(encodeKey(key), encodeValue(value));
        }
        offsets[featurePosition + 1] = entries.length;

        if (input.geometry !== undefined) {
          geometryIndices.push(input.index);
          for (const ring of input.geometry) {
            for (const point of ring)
              coordinates.push(point.x, point.y);
            ringOffsets.push(coordinates.length / 2);
          }
          featureRingOffsets.push(ringOffsets.length - 1);
        }
      }

      this.sourceLayers.push(sourceLayer);
      const layer: SnapshotLayer = { indices, offsets, entries: new Uint32Array(entries), types, ids };
      if (geometryIndices.length) {
        layer.geometry = {
          indices: new Uint32Array(geometryIndices),
          featureRingOffsets: new Uint32Array(featureRingOffsets),
          ringOffsets: new Uint32Array(ringOffsets),
          coordinates: new Int16Array(coordinates),
        };
      }
      this.layers.push(layer);
      start = end;
    }
  }

  getFeature(sourceLayer: string, index: number): Feature | undefined {
    const layer = this.layers[this.sourceLayers.indexOf(sourceLayer)];
    if (!layer)
      return undefined;
    const position = findIndex(layer.indices, index);
    if (position < 0)
      return undefined;

    const properties: Array<[string, unknown]> = [];
    for (let entry = layer.offsets[position]!; entry < layer.offsets[position + 1]!; entry += 2) {
      const key = this.keys[layer.entries[entry]!]!;
      const valueIndex = layer.entries[entry + 1]!;
      const stored = this.values[valueIndex];
      properties.push([key, isScalar(stored) ? stored : structuredClone(stored)]);
    }
    const feature: Feature = {
      id: layer.ids[position],
      type: layer.types[position] as Feature['type'],
      properties: Object.fromEntries(properties),
    };

    const geometry = layer.geometry;
    if (geometry) {
      const geometryPosition = findIndex(geometry.indices, index);
      if (geometryPosition >= 0) {
        const rings: Point[][] = [];
        for (let ring = geometry.featureRingOffsets[geometryPosition]!;
          ring < geometry.featureRingOffsets[geometryPosition + 1]!; ring++) {
          const points: Point[] = [];
          for (let point = geometry.ringOffsets[ring]!; point < geometry.ringOffsets[ring + 1]!; point++) {
            points.push(new Point(geometry.coordinates[point * 2]!, geometry.coordinates[point * 2 + 1]!));
          }
          rings.push(points);
        }
        return { ...feature, geometry: rings };
      }
    }
    return feature;
  }
}

export function registerFeatureSnapshotTransfers(registry: TransferRegistry): void {
  registry.register('FeatureSnapshot', FeatureSnapshot, { shallow: ['values'] });
}
