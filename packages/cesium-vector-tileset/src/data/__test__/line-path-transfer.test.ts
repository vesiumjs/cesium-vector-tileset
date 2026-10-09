import type { LinePath, PackedLinePaths } from '../line-path-transfer';
import { describe, expect, it } from 'vitest';
import { TransferRegistry } from '../../worker/transfer-registry';
import { restoreLinePaths, serializeLinePaths } from '../line-path-transfer';

class LinePathOwner {
  constructor(public linePaths: LinePath[]) {}
}

function createRegistry(): TransferRegistry {
  const registry = new TransferRegistry();
  registry.register('Object', Object);
  registry.register('LinePathOwner', LinePathOwner, {
    serialize: owner => ({ linePaths: serializeLinePaths(owner.linePaths) }),
    restore: (owner) => {
      owner.linePaths = restoreLinePaths(owner.linePaths as unknown as PackedLinePaths);
    },
  });
  return registry;
}

function wireViews(value: unknown): ArrayBufferView[] {
  if (ArrayBuffer.isView(value)) {
    return [value];
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(wireViews);
  }
  return [];
}

describe('line path transfer', () => {
  it.each([1, 128, 2048])('transfers %i paths through a constant number of views and buffers', (count) => {
    const paths = Array.from({ length: count }, (_, index) => ({
      featureIndex: index * 7,
      points: new Int16Array([-12, index, 8192, index + 1]),
    }));
    const source = new LinePathOwner(paths);
    const transferables: Transferable[] = [];
    const wire = createRegistry().serialize(source, transferables);

    expect(wireViews(wire)).toHaveLength(3);
    expect(transferables).toHaveLength(3);
    expect(new Set(wireViews(wire).map(view => view.buffer)).size).toBe(3);
    expect(Array.isArray((wire as unknown as LinePathOwner).linePaths)).toBe(false);
    const received = structuredClone(wire, { transfer: transferables });
    const restored = createRegistry().deserialize(received) as LinePathOwner;

    expect(restored).toBeInstanceOf(LinePathOwner);
    expect(restored.linePaths).toHaveLength(count);
    expect(new Set(restored.linePaths.map(path => path.points.buffer)).size).toBe(1);
    expect(restored.linePaths.map(path => path.featureIndex)).toEqual(paths.map(path => path.featureIndex));
    for (const [index, path] of restored.linePaths.entries()) {
      expect(Array.from(path.points)).toEqual([-12, index, 8192, index + 1]);
      expect(Array.from(paths[index].points)).toEqual([-12, index, 8192, index + 1]);
    }
    expect(transferables.every(buffer => (buffer as ArrayBuffer).byteLength === 0)).toBe(true);
  });

  it('preserves buffered extents, sparse feature indices and closed rings byte for byte', () => {
    const sourceCoordinates = new Int16Array([
      99,
      99,
      -32768,
      32767,
      -42,
      8300,
      4096,
      -20,
      0,
      0,
      8192,
      0,
      8192,
      8192,
      0,
      0,
      77,
      77,
    ]);
    const original = sourceCoordinates.slice();
    const paths = [
      { featureIndex: 0xFFFFFFFF, points: sourceCoordinates.subarray(2, 8) },
      { featureIndex: 0, points: sourceCoordinates.subarray(8, 16) },
      { featureIndex: 7001, points: new Int16Array() },
      { featureIndex: 7001, points: sourceCoordinates.subarray(2, 6) },
    ];
    const transferables: Transferable[] = [];
    const encoded = createRegistry().serialize(new LinePathOwner(paths), transferables);
    const received = structuredClone(encoded, { transfer: transferables });
    const packed = (received as unknown as { linePaths: PackedLinePaths }).linePaths;
    const owner = packed.coordinates;
    expect(Array.from(packed.offsets)).toEqual([0, 6, 14, 14, 18]);
    const restored = createRegistry().deserialize(received) as LinePathOwner;

    expect(sourceCoordinates).toEqual(original);
    expect(restored.linePaths.map(path => path.featureIndex)).toEqual([0xFFFFFFFF, 0, 7001, 7001]);
    for (const [index, path] of restored.linePaths.entries()) {
      const source = paths[index].points;
      expect(path.points.buffer).toBe(owner.buffer);
      expect(new Uint8Array(path.points.buffer, path.points.byteOffset, path.points.byteLength))
        .toEqual(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    }
    expect(Array.from(restored.linePaths[1].points.subarray(-2))).toEqual([0, 0]);
    expect(transferables.every(buffer => (buffer as ArrayBuffer).byteLength === 0)).toBe(true);
  });

  it('round-trips an empty bucket without per-path owners', () => {
    const transferables: Transferable[] = [];
    const encoded = createRegistry().serialize(new LinePathOwner([]), transferables);
    expect(wireViews(encoded)).toHaveLength(3);
    expect(transferables).toHaveLength(3);
    const received = structuredClone(encoded, { transfer: transferables });
    const restored = createRegistry().deserialize(received) as LinePathOwner;
    expect(restored.linePaths).toEqual([]);
  });
});
