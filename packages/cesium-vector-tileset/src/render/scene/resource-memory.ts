import type { GeometryInstanceAttribute } from 'cesium';
import { BufferPointCollection, BufferPolygonCollection, ComponentDatatype, PointPrimitiveCollection, Primitive, PrimitiveCollection } from 'cesium';
import { geometryBytes } from '../geometry/geometry-bytes';
import { GeometryPrimitive } from '../geometry/geometry-primitive';
import { lineInputs } from '../geometry/line-input';

const primitiveBytes = new WeakMap<object, number>();
const uploadedPrimitives = new WeakSet<Primitive>();
const sharedPrimitives = new WeakMap<object, { primitive: Primitive; additionalBytes: number }>();

interface NativeBuffer {
  readonly sizeInBytes: number;
}

interface NativeVertexArray {
  readonly numberOfAttributes: number;
  readonly indexBuffer?: NativeBuffer;
  getAttribute: (index: number) => { vertexBuffer?: NativeBuffer };
}

// Public at runtime in Cesium; omitted from the generated declarations.
const componentBytes = (ComponentDatatype as unknown as { getSizeInBytes: (datatype: ComponentDatatype) => number }).getSizeInBytes;

/** Reserve input geometry bytes before upload; this is not an exact GPU allocation. */
export function rememberPrimitiveBytes(owner: object): void {
  if (!(owner instanceof Primitive) || primitiveBytes.has(owner))
    return;
  const instances = Array.isArray(owner.geometryInstances) ? owner.geometryInstances : [owner.geometryInstances];
  let bytes = 0;
  for (const instance of instances) {
    if (!instance)
      continue;
    const geometry = instance.geometry;
    bytes += geometryBytes(geometry);
    // Reserve the source arrays plus batching inputs. The native pipeline can
    // add planar positions or compact indices; ready-time capture replaces this.
    const position = geometry.attributes.position;
    const line = lineInputs.get(geometry);
    if (line && 'longitudes' in line) {
      // Planar construction owns only the source centreline. Native preparation
      // still generates DOUBLE positions and FLOAT batch IDs for these roles;
      // retain that reservation until the real uploaded allocation is captured.
      bytes += line.vertices.length * (3 * Float64Array.BYTES_PER_ELEMENT + Float32Array.BYTES_PER_ELEMENT);
    }
    else if (position) {
      bytes += position.values.length / position.componentsPerAttribute * Float32Array.BYTES_PER_ELEMENT;
    }
    for (const attribute of Object.values(instance.attributes) as GeometryInstanceAttribute[])
      bytes += attribute.value.length * componentBytes(attribute.componentDatatype);
  }
  primitiveBytes.set(owner, bytes);
}

/** A wrapper owns one uploaded primitive even when several layers replay it. */
export function sharePrimitiveBytes(wrapper: object, primitive: Primitive, additionalBytes = 0): void {
  sharedPrimitives.set(wrapper, { primitive, additionalBytes });
}

/** A replay wrapper delegates readiness and allocation to this physical owner. */
export function primitiveResourceOwner(owner: object): Primitive | undefined {
  return sharedPrimitives.get(owner)?.primitive ?? (owner instanceof Primitive ? owner : undefined);
}

/**
 * Cesium's private Primitive._va contract, read once after Native ready.
 * Buffer.sizeInBytes is its bufferData allocation. Buffer identity de-duplicates
 * interleaved attributes and repeated VAs without retaining their GL handles.
 * Immutable line position textures are included. Feature batch-table textures,
 * shaders and driver storage are outside this snapshot.
 */
export function captureUploadedPrimitiveBytes(primitive: Primitive): boolean {
  if (!primitiveBytes.has(primitive) || uploadedPrimitives.has(primitive)
    || primitive.isDestroyed() || !primitive.ready) {
    return false;
  }
  const vertexArrays = (primitive as Primitive & { _va: NativeVertexArray[] })._va;
  if (!Array.isArray(vertexArrays)) {
    throw new TypeError('Cesium Primitive._va buffer contract is unavailable');
  }
  const buffers = new Set<NativeBuffer>();
  let bytes = 0;
  const add = (buffer: NativeBuffer | undefined): void => {
    if (!buffer || buffers.has(buffer)) {
      return;
    }
    if (!Number.isFinite(buffer.sizeInBytes) || buffer.sizeInBytes < 0) {
      throw new TypeError('Cesium Buffer.sizeInBytes contract is unavailable');
    }
    buffers.add(buffer);
    bytes += buffer.sizeInBytes;
  };
  for (const vertexArray of vertexArrays) {
    if (!Number.isInteger(vertexArray.numberOfAttributes) || vertexArray.numberOfAttributes < 0
      || typeof vertexArray.getAttribute !== 'function') {
      throw new TypeError('Cesium VertexArray attribute contract is unavailable');
    }
    for (let index = 0; index < vertexArray.numberOfAttributes; index++) {
      add(vertexArray.getAttribute(index).vertexBuffer);
    }
    // Native exposes a getter, not getIndexBuffer().
    add(vertexArray.indexBuffer);
  }
  if (primitive instanceof GeometryPrimitive)
    bytes += primitive.positionTexture?.sizeInBytes ?? 0;
  primitiveBytes.set(primitive, bytes);
  uploadedPrimitives.add(primitive);
  return true;
}

/**
 * Primitive bytes are input reservations until first upload, then exact VA
 * buffer and immutable position texture allocations. Replay batch-table storage
 * remains a separate estimate.
 * Buffer collections reserve their fixed native capacity, including draped
 * collections whose buffers/textures are uploaded later by VectorProvider.
 * Driver overhead, native batch textures and terrain-owned textures are excluded.
 */
export function collectionGpuBytes(collection: object): number {
  const shared = sharedPrimitives.get(collection);
  if (shared) {
    return collectionGpuBytes(shared.primitive) + shared.additionalBytes;
  }
  if (collection instanceof BufferPolygonCollection) {
    const positionBytes = 3 * componentBytes(collection.positionDatatype);
    const indexBytes = collection.vertexCountMax >= 65536 ? 4 : 2;
    return collection.vertexCountMax * (positionBytes + 16) + collection.triangleCountMax * 3 * indexBytes;
  }
  if (collection instanceof BufferPointCollection) {
    const positionBytes = 3 * componentBytes(collection.positionDatatype);
    return collection.primitiveCountMax * (positionBytes + 32);
  }
  if (collection instanceof PointPrimitiveCollection) {
    // Cesium's point VAF has one vertex with six float vec4 attributes.
    // It uses GL_POINTS and has no element index buffer.
    return collection.length * 6 * 4 * Float32Array.BYTES_PER_ELEMENT;
  }
  if (collection instanceof PrimitiveCollection) {
    let bytes = 0;
    for (let index = 0; index < collection.length; index++)
      bytes += collectionGpuBytes(collection.get(index));
    return bytes;
  }
  return primitiveBytes.get(collection) ?? 0;
}
