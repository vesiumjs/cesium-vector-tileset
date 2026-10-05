import type { FeatureSnapshotInput } from '../feature-snapshot';
import Point from '@mapbox/point-geometry';
import { describe, expect, it } from 'vitest';
import { TransferRegistry } from '../../worker/transfer-registry';
import { FeatureSnapshot, registerFeatureSnapshotTransfers } from '../feature-snapshot';

function input(sourceLayer: string, index: number, properties: Record<string, unknown> = {}): FeatureSnapshotInput {
  return { sourceLayer, index, type: 1, properties };
}

describe('feature snapshot', () => {
  it('looks up sparse source indices independently in sorted layers', () => {
    const snapshot = new FeatureSnapshot([
      { ...input('roads', 1000, { name: 'far' }), id: 'road-id', type: 2 },
      { ...input('land', 9, { name: 'parcel' }), id: 0, type: 3 },
      input('roads', 4, { name: 'near' }),
    ]);

    expect(snapshot.sourceLayers).toEqual(['land', 'roads']);
    expect(Array.from(snapshot.layers[1]!.indices)).toEqual([4, 1000]);
    expect(snapshot.getFeature('land', 9)).toEqual({ id: 0, type: 3, properties: { name: 'parcel' } });
    expect(snapshot.getFeature('roads', 1000)).toEqual({ id: 'road-id', type: 2, properties: { name: 'far' } });
    expect(snapshot.getFeature('roads', 4)?.id).toBeUndefined();
    for (const index of [-1, 0, 5, 999, 1001, 2 ** 32])
      expect(snapshot.getFeature('roads', index)).toBeUndefined();
    expect(snapshot.getFeature('missing', 9)).toBeUndefined();
    expect(new FeatureSnapshot([]).getFeature('land', 9)).toBeUndefined();
  });

  it('shares property dictionaries across layers with exact-sized binary arrays', () => {
    const snapshot = new FeatureSnapshot([
      input('land', 9, { name: 'same', selected: true, count: 7 }),
      input('roads', 4, { name: 'same', selected: true, count: 7 }),
    ]);

    expect(snapshot.keys).toEqual(['name', 'selected', 'count']);
    expect(snapshot.values).toEqual(['same', true, 7]);
    for (const layer of snapshot.layers) {
      expect(layer.indices.byteLength).toBe(4);
      expect(layer.offsets.byteLength).toBe(8);
      expect(layer.entries.byteLength).toBe(24);
      expect(layer.types.byteLength).toBe(1);
      expect(layer.geometry).toBeUndefined();
      expect(Array.from(layer.entries)).toEqual([0, 0, 1, 1, 2, 2]);
    }
    const binaryBytes = snapshot.layers.reduce((sum, layer) =>
      sum + layer.indices.buffer.byteLength + layer.offsets.buffer.byteLength
      + layer.entries.buffer.byteLength + layer.types.buffer.byteLength, 0);
    expect(binaryBytes).toBe(74);
  });

  it('preserves scalar types, nested properties and literal JSON prefixes without shared lookup objects', () => {
    const nested = { list: [1, null, { active: false }], object: { label: 'first' } };
    const properties = {
      nested,
      array: ['x', null],
      empty: null,
      literal: '__$json__:{"list":[1]}',
      jsonText: '{"list":[1,null,{"active":false}],"object":{"label":"first"}}',
      absent: undefined,
      numeric: 1,
      text: '1',
      bool: false,
    };
    const snapshot = new FeatureSnapshot([input('land', 1, properties), input('roads', 2, properties)]);
    const first = snapshot.getFeature('land', 1)!;
    expect(first.properties).toEqual(properties);
    expect(snapshot.values).toHaveLength(9);

    nested.object.label = 'input changed';
    const firstNested = first.properties.nested as typeof nested;
    firstNested.object.label = 'lookup changed';
    firstNested.list.push(2);
    first.properties.literal = 'changed';
    const second = snapshot.getFeature('land', 1)!;
    const otherLayer = snapshot.getFeature('roads', 2)!;
    expect(second.properties.nested).toEqual({ list: [1, null, { active: false }], object: { label: 'first' } });
    expect(second.properties.literal).toBe('__$json__:{"list":[1]}');
    expect(second.properties).not.toBe(first.properties);
    expect(second.properties.nested).not.toBe(otherLayer.properties.nested);
    expect(Object.hasOwn(second.properties, 'absent')).toBe(true);
  });

  it('stores geometry only for selected sparse features and rebuilds points and rings', () => {
    const snapshot = new FeatureSnapshot([
      input('land', 1),
      { ...input('land', 9), type: 3, geometry: [
        [new Point(-16384, 16383), new Point(8192, -8192), new Point(0, 0)],
        [new Point(3, 4), new Point(5, 6)],
      ] },
      input('land', 1000),
      { ...input('land', 5000), geometry: [[new Point(7, 8)], []] },
    ]);
    const geometry = snapshot.layers[0]!.geometry!;
    expect(Array.from(geometry.indices)).toEqual([9, 5000]);
    expect(Array.from(geometry.featureRingOffsets)).toEqual([0, 2, 4]);
    expect(Array.from(geometry.ringOffsets)).toEqual([0, 3, 5, 6, 6]);
    expect(geometry.coordinates.byteLength).toBe(24);
    expect(geometry.featureRingOffsets.byteLength).toBe(12);
    expect(snapshot.getFeature('land', 1)?.geometry).toBeUndefined();
    expect(snapshot.getFeature('land', 1000)?.geometry).toBeUndefined();
    const first = snapshot.getFeature('land', 9)!.geometry!;
    expect(first).toEqual([
      [new Point(-16384, 16383), new Point(8192, -8192), new Point(0, 0)],
      [new Point(3, 4), new Point(5, 6)],
    ]);
    first[0]![0]!.x = 20;
    expect(snapshot.getFeature('land', 9)!.geometry![0]![0]).toEqual(new Point(-16384, 16383));
    expect(snapshot.getFeature('land', 5000)?.geometry).toEqual([[new Point(7, 8)], []]);
  });

  it('round-trips through independent transfer registries with real buffer transfer', () => {
    const snapshot = new FeatureSnapshot([
      { ...input('land', 9, { nested: { array: [null, true] } }), id: 'nine', geometry: [[new Point(-5, 6)]] },
      { ...input('roads', 4000, { selected: false }), id: 4000, type: 2 },
    ]);
    const expected = snapshot.getFeature('land', 9);
    const worker = new TransferRegistry();
    const scene = new TransferRegistry();
    for (const registry of [worker, scene]) {
      registry.register('Object', Object);
      registerFeatureSnapshotTransfers(registry);
    }
    const transferables: Transferable[] = [];
    const serialized = worker.serialize(snapshot, transferables);
    expect(transferables).toHaveLength(12);
    expect(new Set(transferables).size).toBe(12);
    const restored = scene.deserialize(structuredClone(serialized, { transfer: transferables })) as FeatureSnapshot;

    expect(snapshot.layers[0]!.indices.buffer.byteLength).toBe(0);
    expect(restored).toBeInstanceOf(FeatureSnapshot);
    expect(restored.getFeature('land', 9)).toEqual(expected);
    expect(restored.getFeature('roads', 4000)).toEqual({ id: 4000, type: 2, properties: { selected: false } });
    expect(restored.getFeature('land', 4000)).toBeUndefined();
    expect(restored.getFeature('land', 9)!.geometry![0]![0]).toBeInstanceOf(Point);
  });

  it('deduplicates native values by scalar type or object identity while preserving negative zero', () => {
    const shared = { count: 9007199254740993n };
    const snapshot = new FeatureSnapshot([
      input('land', 1, { shared, equal: { count: 9007199254740993n }, zero: 0, negativeZero: -0, integer: 7n }),
      input('land', 4, { shared, integer: 7n, text: '7', number: 7 }),
    ]);

    expect(snapshot.values).toHaveLength(7);
    expect(snapshot.values[0]).not.toBe(shared);
    expect(snapshot.values[0]).toEqual(shared);
    expect(snapshot.values[1]).not.toBe(snapshot.values[0]);
    const first = snapshot.getFeature('land', 1)!;
    expect(Object.is(first.properties.zero, 0)).toBe(true);
    expect(Object.is(first.properties.negativeZero, -0)).toBe(true);
    expect(first.properties.integer).toBe(7n);
    expect(snapshot.getFeature('land', 4)?.properties).toEqual({ shared, integer: 7n, text: '7', number: 7 });
  });

  it('preserves scalar and nested BigInt and user $name properties through native transfer', () => {
    const integer = 9007199254740993n;
    const nested = { $name: 'user object', signed: -integer, array: [null, integer, { $name: 'nested', count: 1n }] };
    const properties = { $name: 'user feature', scalar: integer, nested, literal: '__$json__:9007199254740993' };
    const snapshot = new FeatureSnapshot([input('land', 99, properties)]);
    nested.signed = 0n;
    const worker = new TransferRegistry();
    const scene = new TransferRegistry();
    for (const registry of [worker, scene]) {
      registry.register('Object', Object);
      registerFeatureSnapshotTransfers(registry);
    }
    const transferables: Transferable[] = [];
    const serialized = worker.serialize(snapshot, transferables);
    const restored = scene.deserialize(structuredClone(serialized, { transfer: transferables })) as FeatureSnapshot;
    expect(snapshot.layers[0]!.indices.buffer.byteLength).toBe(0);
    const first = restored.getFeature('land', 99)!;
    const expected = {
      $name: 'user feature',
      scalar: integer,
      nested: { $name: 'user object', signed: -integer, array: [null, integer, { $name: 'nested', count: 1n }] },
      literal: '__$json__:9007199254740993',
    };
    expect(first.properties).toEqual(expected);
    expect(typeof first.properties.scalar).toBe('bigint');
    const firstNested = first.properties.nested as typeof nested;
    firstNested.signed = 2n;
    firstNested.array.push(3n);
    first.properties.$name = 'caller changed';
    const second = restored.getFeature('land', 99)!;
    expect(second.properties).toEqual(expected);
    expect(second.properties.nested).not.toBe(firstNested);
  });
});
