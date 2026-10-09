import type { CanonicalLineInput, LineInput } from './line-input';
import { BoundingSphere, ComponentDatatype, Geometry, GeometryAttribute } from 'cesium';

type GeometryValues = Exclude<GeometryAttribute['values'], number[]>;
const datatypes = ComponentDatatype as typeof ComponentDatatype & {
  getSizeInBytes: (datatype: ComponentDatatype) => number;
  createArrayBufferView: (datatype: ComponentDatatype, buffer: ArrayBuffer, byteOffset: number, length: number) => GeometryValues;
};
const copyQuantumBytes = 16 * 1024;
const geometryQuantum = 32;
type GeometryIndices = Uint16Array | Uint32Array;

export interface GeometryPacket {
  subTasks: Array<{ geometry: Geometry }>;
  transfers: ArrayBuffer[];
  lineInputs?: Array<LineInput | CanonicalLineInput>;
}

/** End offset includes every alignment pad and optional source topology. */
export function geometryPacketEnd(geometry: Geometry, offset: number, input?: LineInput | CanonicalLineInput): number {
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (input && name === 'position')
      continue;
    if (attribute) {
      const size = datatypes.getSizeInBytes(attribute.componentDatatype);
      offset = aligned(offset, size) + attribute.values.length * size;
    }
  }
  const indices = geometry.indices as unknown as GeometryIndices | undefined;
  if (indices) {
    indexDatatype(indices);
    offset = aligned(offset, indices.BYTES_PER_ELEMENT) + indices.byteLength;
  }
  if (input) {
    offset = aligned(offset, 8) + input.positions.byteLength;
    offset = aligned(offset, 4) + input.vertices.byteLength;
    if ('longitudes' in input)
      offset = aligned(offset, 8) + input.longitudes.byteLength;
  }
  return offset;
}

/** One aligned owner per Native packet; shared source geometry remains intact. */
export function* createGeometryPacket(geometries: readonly Geometry[], inputs?: WeakMap<Geometry, LineInput | CanonicalLineInput>): Generator<void, GeometryPacket> {
  let bytes = 0;
  for (const [index, geometry] of geometries.entries()) {
    const input = inputs?.get(geometry);
    if (inputs && !input)
      throw new TypeError('line geometry requires source coordinates');
    bytes = geometryPacketEnd(geometry, bytes, input);
    if ((index + 1) % geometryQuantum === 0)
      yield;
  }
  const owner = new ArrayBuffer(bytes);
  const packet: GeometryPacket = { subTasks: [], transfers: [owner], ...(inputs ? { lineInputs: [] } : {}) };
  const copying = { remaining: copyQuantumBytes };
  let offset = 0;
  for (const [index, geometry] of geometries.entries()) {
    const input = inputs?.get(geometry);
    const attributes: Record<string, GeometryAttribute> = {};
    for (const [name, attribute] of Object.entries(geometry.attributes as unknown as Record<string, GeometryAttribute>)) {
      // The Worker reconstructs Native DOUBLE centres from owned topology.
      if (!attribute || (input && name === 'position'))
        continue;
      const size = datatypes.getSizeInBytes(attribute.componentDatatype);
      offset = aligned(offset, size);
      const values = datatypes.createArrayBufferView(attribute.componentDatatype, owner, offset, attribute.values.length);
      yield* copyValues(attribute.values, values, copying);
      attributes[name] = new GeometryAttribute({ ...attribute, values });
      offset += values.byteLength;
    }
    const sourceIndices = geometry.indices as unknown as GeometryIndices | undefined;
    let indices: GeometryIndices | undefined;
    if (sourceIndices) {
      offset = aligned(offset, sourceIndices.BYTES_PER_ELEMENT);
      indices = datatypes.createArrayBufferView(indexDatatype(sourceIndices), owner, offset, sourceIndices.length) as GeometryIndices;
      yield* copyValues(sourceIndices, indices, copying);
      offset += indices.byteLength;
    }
    // Native transforms bounds in place. The same cached Geometry may feed
    // several instance matrices; every packet geometry needs its own bounds.
    const boundingSphereCV = (geometry as Geometry & { boundingSphereCV?: BoundingSphere }).boundingSphereCV;
    packet.subTasks.push({ geometry: Object.assign(new Geometry({ attributes: attributes as unknown as Geometry['attributes'] }), geometry, {
      attributes,
      indices,
      boundingSphere: BoundingSphere.clone(geometry.boundingSphere),
      boundingSphereCV: BoundingSphere.clone(boundingSphereCV),
    }) });
    if (input) {
      offset = aligned(offset, 8);
      const positions = new Float64Array(owner, offset, input.positions.length);
      yield* copyValues(input.positions, positions, copying);
      offset += positions.byteLength;
      offset = aligned(offset, 4);
      const vertices = new Uint32Array(owner, offset, input.vertices.length);
      yield* copyValues(input.vertices, vertices, copying);
      offset += vertices.byteLength;
      let longitudes: Float64Array | undefined;
      if ('longitudes' in input) {
        offset = aligned(offset, 8);
        longitudes = new Float64Array(owner, offset, input.longitudes.length);
        yield* copyValues(input.longitudes, longitudes, copying);
        offset += longitudes.byteLength;
      }
      packet.lineInputs!.push({ positions, vertices, closed: input.closed, ...(longitudes ? { longitudes } : {}) });
    }
    if ((index + 1) % geometryQuantum === 0) {
      copying.remaining = copyQuantumBytes;
      yield;
    }
  }
  return packet;
}

function aligned(offset: number, size: number): number {
  return Math.ceil(offset / size) * size;
}

function indexDatatype(indices: GeometryIndices): ComponentDatatype {
  if (indices.BYTES_PER_ELEMENT === 2)
    return ComponentDatatype.UNSIGNED_SHORT;
  if (indices.BYTES_PER_ELEMENT === 4)
    return ComponentDatatype.UNSIGNED_INT;
  throw new TypeError('Native geometry indices must be unsigned short or unsigned integer storage');
}

function* copyValues(source: GeometryAttribute['values'], target: GeometryValues, copying: { remaining: number }): Generator<void> {
  let offset = 0;
  while (offset < source.length) {
    const quantum = Math.floor(copying.remaining / target.BYTES_PER_ELEMENT);
    if (!quantum) {
      copying.remaining = copyQuantumBytes;
      yield;
      continue;
    }
    const end = Math.min(source.length, offset + quantum);
    target.set(Array.isArray(source) ? source.slice(offset, end) : source.subarray(offset, end), offset);
    copying.remaining -= (end - offset) * target.BYTES_PER_ELEMENT;
    offset = end;
  }
}
