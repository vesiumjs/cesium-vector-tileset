import type { Primitive } from 'cesium';
import type { VectorTileRecord } from '../../packages/cesium-vector-tileset/src/render/vector/vector-tile-renderer';
import { ComponentDatatype, PrimitiveCollection } from 'cesium';
import { GeometryPrimitive } from '../../packages/cesium-vector-tileset/src/render/geometry/geometry-primitive';
import { primitiveResourceOwner } from '../../packages/cesium-vector-tileset/src/render/scene/resource-memory';

export interface GeometryTextureUpload {
  phase: string;
  method: string;
  width: number;
  height: number;
  bytes: number;
}

interface NativeBuffer { sizeInBytes: number; _buffer: WebGLBuffer }
interface NativeAttribute {
  index: number;
  componentsPerAttribute: number;
  componentDatatype: ComponentDatatype;
  vertexBuffer?: NativeBuffer;
  strideInBytes: number;
}
interface NativeVertexArray {
  numberOfAttributes: number;
  numberOfVertices: number;
  indexBuffer?: NativeBuffer;
  getAttribute: (index: number) => NativeAttribute;
}
interface BufferRenderer {
  _records: Map<string, VectorTileRecord>;
  _retired: { entries: () => IterableIterator<[string, VectorTileRecord]> };
}

/** Inspect real Native buffers only between measured runs, never in a frame. */
export function performanceBufferSnapshot(renderer: object, contextBuffers: Map<WebGLBuffer, number>, textureUploads: Map<WebGLTexture, GeometryTextureUpload[]>) {
  const buffers = new Set<NativeBuffer>();
  const primitives = new Set<Primitive>();
  const textureRows: Array<{ tile: string; state: 'live' | 'retired'; kind: string; width: number; height: number; bytes: number; uploads: GeometryTextureUpload[] }> = [];
  const rows: Array<{
    tile: string;
    state: 'live' | 'retired';
    kind: string;
    vertices: number;
    indexBytes: number;
    vertexBytes: number;
    attributes: Array<{ name: string; components: number; componentBytes: number; stride: number }>;
  }> = [];
  const componentBytes = (ComponentDatatype as unknown as { getSizeInBytes: (type: ComponentDatatype) => number }).getSizeInBytes;
  function allocation(buffer: NativeBuffer | undefined): number {
    if (!buffer || buffers.has(buffer))
      return 0;
    if (contextBuffers.get(buffer._buffer) !== buffer.sizeInBytes)
      throw new Error('Native buffer capacity does not match the actual WebGL bufferData allocation');
    buffers.add(buffer);
    return buffer.sizeInBytes;
  }
  function visit(owner: object, tile: string, state: 'live' | 'retired', kind: string) {
    if (owner instanceof PrimitiveCollection) {
      for (let index = 0; index < owner.length; index++)
        visit(owner.get(index), tile, state, kind);
      return;
    }
    const primitive = primitiveResourceOwner(owner);
    if (!primitive || primitives.has(primitive) || !primitive.ready)
      return;
    primitives.add(primitive);
    if (primitive instanceof GeometryPrimitive && primitive.positionTexture) {
      const texture = primitive.positionTexture;
      const uploads = textureUploads.get((texture as typeof texture & { _texture: WebGLTexture })._texture);
      if (!uploads?.some(upload => upload.method === 'texImage2D' && upload.width === texture.width
        && upload.height === texture.height && upload.bytes === texture.sizeInBytes)) {
        throw new Error('Native geometry texture capacity does not match its actual WebGL upload');
      }
      textureRows.push({ tile, state, kind, width: texture.width, height: texture.height, bytes: texture.sizeInBytes, uploads: [...uploads] });
    }
    const native = primitive as Primitive & { _va: NativeVertexArray[]; _attributeLocations: Record<string, number> };
    const attributeNames = new Map(Object.entries(native._attributeLocations).map(([name, index]) => [index, name]));
    for (const va of native._va) {
      const row: (typeof rows)[number] = { tile, state, kind, vertices: va.numberOfVertices, indexBytes: allocation(va.indexBuffer), vertexBytes: 0, attributes: [] };
      for (let index = 0; index < va.numberOfAttributes; index++) {
        const attribute = va.getAttribute(index);
        if (!attribute.vertexBuffer)
          continue;
        row.vertexBytes += allocation(attribute.vertexBuffer);
        row.attributes.push({ name: attributeNames.get(attribute.index)!, components: attribute.componentsPerAttribute, componentBytes: componentBytes(attribute.componentDatatype), stride: attribute.strideInBytes });
      }
      rows.push(row);
    }
  }
  const work = renderer as BufferRenderer;
  for (const [state, records] of [['live', work._records], ['retired', work._retired]] as const) {
    for (const [tile, record] of records.entries()) {
      for (const [kind, collection] of record.collections)
        visit(collection, tile, state, kind);
    }
  }
  const bytes = rows.reduce((sum, row) => sum + row.vertexBytes + row.indexBytes, 0);
  const byKind = Object.fromEntries([...new Set(rows.map(row => row.kind))].map(kind => [kind, {
    liveBytes: rows.filter(row => row.kind === kind && row.state === 'live').reduce((sum, row) => sum + row.vertexBytes + row.indexBytes, 0),
    retiredBytes: rows.filter(row => row.kind === kind && row.state === 'retired').reduce((sum, row) => sum + row.vertexBytes + row.indexBytes, 0),
    vertices: rows.filter(row => row.kind === kind).reduce((sum, row) => sum + row.vertices, 0),
  }]));
  return { bytes, unattributedBytes: [...contextBuffers.values()].reduce((sum, value) => sum + value, 0) - bytes, byKind, rows, geometryTextures: { bytes: textureRows.reduce((sum, row) => sum + row.bytes, 0), rows: textureRows } };
}
