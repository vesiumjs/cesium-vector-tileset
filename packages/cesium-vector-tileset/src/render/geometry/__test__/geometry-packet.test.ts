import type { CanonicalLineInput } from '../line-input';
import { BoundingSphere, Cartesian3, ComponentDatatype, Geometry, GeometryAttribute, GeometryInstance, Matrix4, PrimitiveType } from 'cesium';
import { describe, expect, it } from 'vitest';
import { createGeometryPacket, geometryPacketEnd } from '../geometry-packet';

function complete(compiler: ReturnType<typeof createGeometryPacket>) {
  let step = compiler.next();
  while (!step.done)
    step = compiler.next();
  return step.value;
}

function sourceGeometry(Indices: typeof Uint16Array | typeof Uint32Array = Uint16Array) {
  const positions = new Float64Array(131072).subarray(123, 135);
  positions.set([6378137, 0, 0, 6378137, 1, 0, 6378137, 1, 1, 6378137, 0, 1]);
  const flags = new Uint8Array(1048576).subarray(321, 325);
  flags.set([2, 4, 6, 8]);
  const records = new Float32Array([12, 13, 14, 15]);
  const indices = new Indices(262144).subarray(111, 117);
  indices.set([0, 1, 2, 0, 2, 3]);
  return Object.assign(new Geometry({
    attributes: {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
      a_flags: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 1, normalize: true, values: flags }),
      a_records: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: records }),
    } as unknown as Geometry['attributes'],
    indices: indices as never,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: new BoundingSphere(new Cartesian3(6378137, 0, 0), 2),
  }), { geometryType: 4, offsetAttribute: 1 });
}

describe('native create packet ownership', () => {
  it('owns line topology with mesh attributes in the same aligned buffer without detaching cached views', () => {
    const geometry = sourceGeometry();
    const positions = new Float64Array(20000).subarray(7, 19);
    positions.set(geometry.attributes.position.values);
    const vertices = new Uint32Array(20000).subarray(13, 17);
    vertices.set([0, 1, 2, 3]);
    const longitudes = new Float64Array(20000).subarray(3, 7);
    longitudes.set([3.14, 3.15, 3.16, 3.17]);
    const input = { positions, vertices, longitudes, closed: true };
    const inputs = new WeakMap<Geometry, CanonicalLineInput>([[geometry, input]]);
    const packet = complete(createGeometryPacket([geometry, geometry], inputs));
    // Two 176-byte line packets retain flags, records, indices and topology;
    // their reconstructible DOUBLE centres would add another 192 bytes.
    expect(packet.transfers[0].byteLength).toBe(352);
    expect(packet.transfers[0].byteLength).toBe(geometryPacketEnd(geometry, geometryPacketEnd(geometry, 0, input), input));
    const received = structuredClone({ subTasks: packet.subTasks, lineInputs: packet.lineInputs! }, { transfer: packet.transfers });
    const owner = received.lineInputs[0].positions.buffer;
    for (const { geometry: actual } of received.subTasks) {
      expect(actual.attributes.position).toBeUndefined();
      const attributes = actual.attributes as unknown as Record<string, GeometryAttribute>;
      for (const name of ['a_flags', 'a_records']) {
        const attribute = attributes[name];
        const original = (geometry.attributes as unknown as Record<string, GeometryAttribute>)[name];
        expect((attribute.values as Uint8Array).buffer).toBe(owner);
        expect(Array.from(attribute.values)).toEqual(Array.from(original.values));
        expect(attribute.componentDatatype).toBe(original.componentDatatype);
        expect(attribute.componentsPerAttribute).toBe(original.componentsPerAttribute);
        expect(attribute.normalize).toBe(original.normalize);
      }
      expect((actual.indices as unknown as Uint16Array).buffer).toBe(owner);
      expect(Array.from(actual.indices!)).toEqual([0, 1, 2, 0, 2, 3]);
      expect(actual.boundingSphere).toEqual(geometry.boundingSphere);
    }
    for (const topology of received.lineInputs) {
      expect(topology.positions.buffer).toBe(owner);
      expect(topology.vertices.buffer).toBe(owner);
      expect((topology as CanonicalLineInput).longitudes.buffer).toBe(owner);
      expect(Array.from(topology.positions)).toEqual(Array.from(input.positions));
      expect(Array.from(topology.vertices)).toEqual(Array.from(input.vertices));
      expect(Array.from((topology as CanonicalLineInput).longitudes)).toEqual(Array.from(input.longitudes));
      expect(topology.closed).toBe(true);
    }
    expect(received.subTasks[0].geometry.boundingSphere).not.toBe(received.subTasks[1].geometry.boundingSphere);
    for (const cached of [positions, vertices, longitudes])
      expect(cached.buffer.byteLength).toBe(20000 * cached.BYTES_PER_ELEMENT);
    expect((geometry.attributes.position.values as Float64Array).buffer.byteLength).toBe(1048576);
    expect(Array.from(geometry.attributes.position.values)).toEqual(Array.from(input.positions));
    expect(Array.from(input.positions)).toEqual(Array.from(received.lineInputs[0].positions));
    const nextPacket = complete(createGeometryPacket([geometry], inputs));
    const restored = structuredClone({ subTasks: nextPacket.subTasks, lineInputs: nextPacket.lineInputs! }, { transfer: nextPacket.transfers });
    expect(restored.lineInputs[0]).toEqual(received.lineInputs[0]);
    expect(restored.lineInputs[0].positions.buffer).not.toBe(owner);
    expect(restored.subTasks[0].geometry.boundingSphere).not.toBe(received.subTasks[0].geometry.boundingSphere);
    expect(Array.from(geometry.attributes.position.values)).toEqual(Array.from(input.positions));
  });

  it('transfers one 65536-byte owner for 512 actual geometry inputs', () => {
    const geometry = sourceGeometry();
    const instances = Array.from({ length: 512 }, (_, index) => new GeometryInstance({
      geometry,
      id: `pick-${index}`,
      modelMatrix: Matrix4.fromTranslation(new Cartesian3(index, 2, 3)),
    }));
    const compiler = createGeometryPacket(instances.map(instance => instance.geometry));
    let step = compiler.next();
    let admissions = 1;
    while (!step.done && admissions < 64) {
      step = compiler.next();
      admissions++;
    }
    expect(step.done).toBe(true);
    expect(admissions).toBeGreaterThan(1);
    expect(admissions).toBeLessThan(64);
    const packet = step.value!;
    const before = packet.transfers.map(buffer => buffer.byteLength);
    const received = structuredClone({ subTasks: packet.subTasks }, { transfer: packet.transfers });
    expect(before).toHaveLength(1);
    expect(before[0]).toBe(65536);
    expect(packet.transfers.every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(received.subTasks).toHaveLength(512);
    const owners = new Set<ArrayBufferLike>();
    for (const { geometry: actual } of received.subTasks) {
      const attributes = actual.attributes as unknown as Record<string, GeometryAttribute>;
      const expected = geometry.attributes as unknown as Record<string, GeometryAttribute>;
      for (const [name, attribute] of Object.entries(attributes)) {
        const values = attribute.values as Float64Array;
        const source = expected[name].values as Float64Array;
        owners.add(values.buffer);
        expect(values.BYTES_PER_ELEMENT).toBe(source.BYTES_PER_ELEMENT);
        expect(Array.from(values)).toEqual(Array.from(source));
        expect(attribute.componentDatatype).toBe(expected[name].componentDatatype);
        expect(attribute.componentsPerAttribute).toBe(expected[name].componentsPerAttribute);
        expect(attribute.normalize).toBe(expected[name].normalize);
      }
      const indices = actual.indices as unknown as Uint16Array;
      owners.add(indices.buffer);
      expect(indices.BYTES_PER_ELEMENT).toBe(2);
      expect(Array.from(indices)).toEqual([0, 1, 2, 0, 2, 3]);
      expect(actual.primitiveType).toBe(geometry.primitiveType);
      expect((actual as typeof geometry).geometryType).toBe(geometry.geometryType);
      expect((actual as typeof geometry).offsetAttribute).toBe(geometry.offsetAttribute);
      expect(actual.boundingSphere).toEqual(geometry.boundingSphere);
    }
    expect(owners.size).toBe(1);
    for (const [index, instance] of instances.entries()) {
      expect(instance.geometry).toBe(geometry);
      expect(instance.id).toBe(`pick-${index}`);
      expect(Matrix4.getTranslation(instance.modelMatrix, new Cartesian3())).toEqual(new Cartesian3(index, 2, 3));
    }
    const attributes = geometry.attributes as unknown as Record<string, GeometryAttribute>;
    expect((attributes.position.values as Float64Array).buffer.byteLength).toBe(1048576);
    expect((attributes.a_flags.values as Uint8Array).buffer.byteLength).toBe(1048576);
    expect((geometry.indices as unknown as Uint16Array).buffer.byteLength).toBe(524288);
  });

  it.each([[Uint16Array, 98], [Uint32Array, 104]] as const)('aligns mixed attributes and %s indices with seven padding bytes', (Indices, expectedBytes) => {
    const geometry = new Geometry({
      attributes: {
        a_flags: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 1, values: [1, 2, 3] }),
        position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array([1.25, 2.5, 3.75, 4, 5, 6, 7, 8, 9]) }),
        a_signed: new GeometryAttribute({ componentDatatype: ComponentDatatype.SHORT, componentsPerAttribute: 1, values: new Int16Array([-12, 23, -34]) }),
        a_record: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: new Float32Array([123.5]) }),
      } as unknown as Geometry['attributes'],
      indices: new Indices([0, 1, 2]) as never,
      primitiveType: PrimitiveType.TRIANGLES,
    });
    const packet = complete(createGeometryPacket([geometry]));
    expect(packet.transfers).toHaveLength(1);
    expect(packet.transfers[0].byteLength).toBe(expectedBytes);
    const received = structuredClone({ subTasks: packet.subTasks }, { transfer: packet.transfers });
    const attributes = received.subTasks[0].geometry.attributes as unknown as Record<string, GeometryAttribute>;
    expect((attributes.a_flags.values as Uint8Array).byteOffset).toBe(0);
    expect((attributes.position.values as Float64Array).byteOffset).toBe(8);
    expect((attributes.a_signed.values as Int16Array).byteOffset).toBe(80);
    expect((attributes.a_record.values as Float32Array).byteOffset).toBe(88);
    for (const [name, attribute] of Object.entries(attributes)) {
      const original = (geometry.attributes as unknown as Record<string, GeometryAttribute>)[name];
      const values = attribute.values as Float64Array;
      expect(values.byteOffset % values.BYTES_PER_ELEMENT).toBe(0);
      expect(Array.from(values)).toEqual(Array.from(original.values));
      expect(values.buffer).toBe((attributes.position.values as Float64Array).buffer);
    }
    const indices = received.subTasks[0].geometry.indices as unknown as Uint16Array | Uint32Array;
    expect(indices.BYTES_PER_ELEMENT).toBe(Indices.BYTES_PER_ELEMENT);
    expect(indices.byteOffset).toBe(92);
    expect(indices.buffer).toBe((attributes.position.values as Float64Array).buffer);
    expect(Array.from(indices)).toEqual([0, 1, 2]);
    expect(Array.from((geometry.indices as unknown as Uint16Array | Uint32Array))).toEqual([0, 1, 2]);
  });

  it('copies at most 16KB before yielding on a 10000-point road and can cancel without a packet', () => {
    const positions = Float64Array.from({ length: 10000 * 3 }, (_, index) => index + 0.5);
    const geometry = new Geometry({
      attributes: { position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }) } as unknown as Geometry['attributes'],
      indices: new Uint16Array([0, 1, 2]) as never,
      primitiveType: PrimitiveType.TRIANGLES,
    });
    const compiler = createGeometryPacket([geometry]);
    let step = compiler.next();
    expect(step.done).toBe(false);
    // Changing the unread source independently reveals the completed prefix.
    positions.fill(-7);
    let admissions = 1;
    while (!step.done && admissions < 64) {
      step = compiler.next();
      admissions++;
    }
    expect(admissions).toBeGreaterThan(8);
    expect(admissions).toBeLessThan(64);
    expect(step.done).toBe(true);
    const packet = step.value!;
    const received = structuredClone({ subTasks: packet.subTasks }, { transfer: packet.transfers });
    const copied = received.subTasks[0].geometry.attributes.position!.values;
    expect(Array.from(copied.slice(0, 2048))).toEqual(Array.from({ length: 2048 }, (_, index) => index + 0.5));
    expect(Array.from(copied.slice(2048))).toEqual(Array.from({ length: 30000 - 2048 }).fill(-7));
    expect(positions.byteLength).toBe(240000);
    expect(positions.every(value => value === -7)).toBe(true);

    const cancelled = createGeometryPacket([geometry]);
    expect(cancelled.next().done).toBe(false);
    expect(cancelled.return(undefined as never)).toEqual({ done: true, value: undefined });
    expect(cancelled.next()).toEqual({ done: true, value: undefined });
    expect(positions.byteLength).toBe(240000);
    expect(positions.every(value => value === -7)).toBe(true);
  });

  it('keeps owned line topology copies within 16KB and cancels without touching cached geometry', () => {
    const positions = Float64Array.from({ length: 10000 * 3 }, (_, index) => index + 0.5);
    const expanded = positions.slice();
    const flags = new Uint8Array(10000).fill(3);
    const vertices = Uint32Array.from({ length: 10000 }, (_, index) => index);
    const geometry = new Geometry({
      attributes: {
        position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: expanded }),
        a_flags: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 1, values: flags }),
      } as unknown as Geometry['attributes'],
      primitiveType: PrimitiveType.TRIANGLES,
    });
    const inputs = new WeakMap([[geometry, { positions, vertices, closed: false }]]);
    const compiler = createGeometryPacket([geometry], inputs);
    expect(compiler.next().done).toBe(false);
    // The first admission copies 10000 flag bytes and 798 DOUBLE words.
    positions.fill(-7);
    const packet = complete(compiler);
    expect(packet.transfers[0].byteLength).toBe(290000);
    const received = structuredClone({ subTasks: packet.subTasks, lineInputs: packet.lineInputs! }, { transfer: packet.transfers });
    const copied = received.lineInputs[0].positions;
    expect(Array.from(copied.slice(0, 798))).toEqual(Array.from({ length: 798 }, (_, index) => index + 0.5));
    expect(copied.subarray(798).every(value => value === -7)).toBe(true);
    expect(received.subTasks[0].geometry.attributes.position).toBeUndefined();
    expect(Array.from((received.subTasks[0].geometry.attributes as unknown as Record<string, GeometryAttribute>).a_flags.values)).toEqual(Array.from(flags));
    expect(Array.from(received.lineInputs[0].vertices)).toEqual(Array.from(vertices));
    expect(expanded).toEqual(Float64Array.from({ length: 30000 }, (_, index) => index + 0.5));

    const cancelled = createGeometryPacket([geometry], inputs);
    expect(cancelled.next().done).toBe(false);
    expect(cancelled.return(undefined as never)).toEqual({ done: true, value: undefined });
    expect(cancelled.next()).toEqual({ done: true, value: undefined });
    expect(positions.byteLength).toBe(240000);
    expect(positions.every(value => value === -7)).toBe(true);
    expect(vertices.byteLength).toBe(40000);
    expect(flags.byteLength).toBe(10000);
    expect(expanded).toEqual(Float64Array.from({ length: 30000 }, (_, index) => index + 0.5));
  });
});
