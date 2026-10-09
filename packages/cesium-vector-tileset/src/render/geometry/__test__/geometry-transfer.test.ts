import { BoundingSphere, buildModuleUrl, Cartesian3, ComponentDatatype, GeographicProjection, Geometry, GeometryAttribute, GeometryInstance, Matrix4, Primitive, PrimitiveType, SceneMode, TaskProcessor } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { GeometryPrimitive, updateGeometryWithBudget } from '../geometry-primitive';

afterEach(() => vi.restoreAllMocks());

function frame() {
  return { mode: SceneMode.SCENE3D, mapProjection: new GeographicProjection(), scene3DOnly: true, context: { elementIndexUint: true }, commandList: [], afterRender: [] };
}

describe('native geometry transfer ownership', () => {
  it.each([Uint16Array, Uint32Array])('transfers an aligned packet owner instead of cloning huge backing buffers (%s)', async (Indices) => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const positions = new Float64Array(131072).subarray(123, 132);
    positions.set([6378137, 0, 0, 6378137, 1, 0, 6378137, 0, 1]);
    const flags = new Uint8Array(1048576).subarray(321, 324);
    flags.set([2, 4, 6]);
    const indices = new Indices(262144).subarray(111, 114);
    indices.set([0, 1, 2]);
    const geometry = Object.assign(new Geometry({
      attributes: {
        position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
        a_flags: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 1, values: flags }),
      } as unknown as Geometry['attributes'],
      indices: indices as never,
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: new BoundingSphere(new Cartesian3(6378137, 0, 0), 2),
    }), { geometryType: 4, offsetAttribute: 1 });
    const matrix = Matrix4.fromTranslation(new Cartesian3(1, 2, 3));
    const instance = new GeometryInstance({ geometry, id: 'source', modelMatrix: matrix });
    const owner = new GeometryPrimitive({ geometryInstances: instance }, 'native');
    const worker = { addEventListener() {}, removeEventListener() {}, terminate() {} };
    const messages: Array<{ cloned: { requests: Array<{ geometries: Array<typeof geometry> }> }; before: number[]; after: number[] }> = [];
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters, transfers) {
      Object.assign(this, { _worker: worker });
      const buffers = transfers as ArrayBuffer[];
      const before = buffers.map(buffer => buffer.byteLength);
      const cloned = structuredClone(parameters, { transfer: buffers });
      messages.push({ cloned: cloned as { requests: Array<{ geometries: Array<typeof geometry> }> }, before, after: buffers.map(buffer => buffer.byteLength) });
      return new Promise(() => {});
    });
    try {
      const state = frame();
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => owner.update(state));
      await Promise.resolve();
      expect(messages).toHaveLength(1);
      expect(messages[0].cloned.requests).toHaveLength(1);
      const received = messages[0].cloned.requests[0].geometries[0];
      const attributes = received.attributes as unknown as Record<string, GeometryAttribute>;
      const receivedIndices = received.indices as unknown as Uint16Array | Uint32Array;
      const owners = new Set([...(Object.values(attributes).map(attribute => (attribute.values as Float64Array).buffer)), receivedIndices.buffer]);
      const logicalBytes = positions.byteLength + flags.byteLength + indices.byteLength;
      expect(owners.size).toBe(1);
      // One byte aligns the index subview after three Uint8 flags.
      // The first independent owner is Native's matrix/offset metadata.
      expect(messages[0].before).toEqual([(1 + 19) * 8, logicalBytes + 1]);
      expect(Array.from(owners, buffer => buffer.byteLength)).toEqual([logicalBytes + 1]);
      expect(receivedIndices.byteOffset % receivedIndices.BYTES_PER_ELEMENT).toBe(0);
      expect(messages[0].after.every(bytes => bytes === 0)).toBe(true);
      expect(Array.from(attributes.position.values)).toEqual(Array.from(positions));
      expect(Array.from(attributes.a_flags.values)).toEqual(Array.from(flags));
      expect(receivedIndices.BYTES_PER_ELEMENT).toBe(indices.BYTES_PER_ELEMENT);
      expect(Array.from(receivedIndices)).toEqual([0, 1, 2]);
      expect(received.primitiveType).toBe(geometry.primitiveType);
      expect(received.geometryType).toBe(geometry.geometryType);
      expect(received.offsetAttribute).toBe(geometry.offsetAttribute);
      expect(received.boundingSphere).toEqual(geometry.boundingSphere);
      expect(positions.buffer.byteLength).toBe(1048576);
      expect(flags.buffer.byteLength).toBe(1048576);
      expect(indices.buffer.byteLength).toBe(262144 * Indices.BYTES_PER_ELEMENT);
      expect((owner.geometryInstances as GeometryInstance).geometry).toBe(geometry);
      expect((owner.geometryInstances as GeometryInstance).id).toBe('source');
      expect((owner.geometryInstances as GeometryInstance).modelMatrix).toEqual(matrix);
    }
    finally {
      owner.destroy();
    }
  });

  it('bounds owned-buffer copying when the frame budget is exhausted and discards unpublished copies', async () => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const positions = new Float64Array(10000 * 3);
    const geometry = new Geometry({
      attributes: { position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }) } as unknown as Geometry['attributes'],
      indices: new Uint16Array([0, 1, 2]) as never,
      primitiveType: PrimitiveType.TRIANGLES,
    });
    const worker = { addEventListener() {}, removeEventListener() {}, terminate() {} };
    const tasks = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function () {
      Object.assign(this, { _worker: worker });
      return new Promise(() => {});
    });
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const owner = new GeometryPrimitive({ geometryInstances: new GeometryInstance({ geometry }) }, 'native');
    const state = frame();
    try {
      updateGeometryWithBudget(state, { exhausted: true }, () => owner.update(state));
      expect(tasks).not.toHaveBeenCalled();
      let frames = 1;
      while (!tasks.mock.calls.length && frames < 64) {
        updateGeometryWithBudget(state, { exhausted: true }, () => owner.update(state));
        frames++;
        await Promise.resolve();
      }
      expect(frames).toBeGreaterThan(8);
      expect(frames).toBeLessThan(64);
      expect(tasks).toHaveBeenCalledTimes(1);
      expect(positions.byteLength).toBe(240000);
    }
    finally {
      owner.destroy();
    }
    tasks.mockClear();
    const cancelled = new GeometryPrimitive({ geometryInstances: new GeometryInstance({ geometry }) }, 'native');
    updateGeometryWithBudget(state, { exhausted: true }, () => cancelled.update(state));
    cancelled.destroy();
    await Promise.resolve();
    expect(tasks).not.toHaveBeenCalled();
    expect(positions.byteLength).toBe(240000);
  });
});
