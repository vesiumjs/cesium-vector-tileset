import type { Geometry } from 'cesium';
import * as Cesium from 'cesium';
import { ComponentDatatype, IndexDatatype, Geometry as NativeGeometry } from 'cesium';

interface NativeBuffer {
  readonly sizeInBytes: number;
  copyFromArrayView: (values: ArrayBufferView, offset: number) => void;
  isDestroyed: () => boolean;
  destroy: () => void;
}

export interface LineVertexArray {
  readonly numberOfAttributes: number;
  readonly indexBuffer: NativeBuffer;
  getAttribute: (index: number) => { vertexBuffer: NativeBuffer };
  isDestroyed: () => boolean;
  destroy: () => void;
}

export interface LineIndexRange {
  index: number;
  offset: number;
  count: number;
}

const runtime = Cesium as unknown as {
  Buffer: {
    createVertexBuffer: (options: object) => NativeBuffer;
    createIndexBuffer: (options: object) => NativeBuffer;
  };
  VertexArray: new (options: object) => LineVertexArray;
  BufferUsage: { STATIC_DRAW: number };
};

const uploadBytes = 256 * 1024;

/** One permanent VA per Native geometry; bounded writes never create draw owners. */
export class LineGeometryUpload {
  readonly vertexArrays: LineVertexArray[] = [];
  readonly counts: number[];

  private readonly _buffers: NativeBuffer[] = [];

  private readonly _steps: Generator<void>;
  complete = false;

  constructor(geometries: Geometry[], locations: Record<string, number>, ranges: readonly LineIndexRange[], context: object) {
    this.counts = geometries.map(() => 0);
    this._steps = this._upload(geometries, locations, ranges, context);
  }

  advance(): void {
    if (!this.complete)
      this.complete = this._steps.next().done === true;
  }

  count(vertexArray: unknown): number {
    const index = this.vertexArrays.indexOf(vertexArray as LineVertexArray);
    return index < 0 ? 0 : this.counts[index];
  }

  /**
   * @internal
   */
  private* _upload(geometries: Geometry[], locations: Record<string, number>, ranges: readonly LineIndexRange[], context: object): Generator<void> {
    for (const [geometryIndex, geometry] of geometries.entries()) {
      const attributes: object[] = [];
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        if (!attribute)
          continue;
        if (attribute.componentDatatype === ComponentDatatype.DOUBLE)
          throw new TypeError('prepared line attributes must use their exact packed GPU representation');
        const values = attribute.values;
        if (!ArrayBuffer.isView(values))
          throw new TypeError('prepared line attributes require typed storage');
        const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
        const buffer = runtime.Buffer.createVertexBuffer({ context, sizeInBytes: bytes.byteLength, usage: runtime.BufferUsage.STATIC_DRAW });
        this._buffers.push(buffer);
        attributes.push({ index: locations[name], vertexBuffer: buffer, componentDatatype: attribute.componentDatatype, componentsPerAttribute: attribute.componentsPerAttribute, normalize: attribute.normalize });
        for (let offset = 0; offset < bytes.length; offset += uploadBytes) {
          buffer.copyFromArrayView(bytes.subarray(offset, Math.min(bytes.length, offset + uploadBytes)), offset);
          yield;
        }
      }
      const storedIndices: unknown = geometry.indices;
      const indexKind = Object.prototype.toString.call(storedIndices);
      if (indexKind !== '[object Uint16Array]' && indexKind !== '[object Uint32Array]')
        throw new TypeError('prepared line indices require unsigned typed storage');
      const indices = storedIndices as Uint16Array | Uint32Array;
      const indexDatatype = indexKind === '[object Uint32Array]' ? IndexDatatype.UNSIGNED_INT : IndexDatatype.UNSIGNED_SHORT;
      const indexBuffer = runtime.Buffer.createIndexBuffer({ context, sizeInBytes: indices.byteLength, indexDatatype, usage: runtime.BufferUsage.STATIC_DRAW });
      this._buffers.push(indexBuffer);
      this.vertexArrays.push(new runtime.VertexArray({ context, attributes, indexBuffer }));
      const ends = ranges.filter(range => range.index === geometryIndex).map(range => range.offset + range.count);
      if (ends.at(-1) !== indices.length)
        throw new RangeError('line feature ranges must cover every uploaded index');
      let offset = 0;
      for (let range = 0; range < ends.length;) {
        let end = ends[range++];
        while (range < ends.length && (ends[range] - offset) * indices.BYTES_PER_ELEMENT <= uploadBytes)
          end = ends[range++];
        // A feature can exceed a write quantum. Upload it over several writes,
        // then publish its complete index prefix in one atomic count change.
        for (let index = offset; index < end;) {
          const next = Math.min(end, index + uploadBytes / indices.BYTES_PER_ELEMENT);
          indexBuffer.copyFromArrayView(indices.subarray(index, next), index * indices.BYTES_PER_ELEMENT);
          index = next;
          if (index < end)
            yield;
        }
        offset = end;
        this.counts[geometryIndex] = end;
        yield;
      }
      if (NativeGeometry.computeNumberOfVertices(geometry) === 0)
        throw new RangeError('line upload requires nonempty geometry');
    }
  }

  destroy(): void {
    this._steps.return(undefined);
    for (const vertexArray of this.vertexArrays) {
      if (!vertexArray.isDestroyed())
        vertexArray.destroy();
    }
    for (const buffer of this._buffers) {
      if (!buffer.isDestroyed())
        buffer.destroy();
    }
  }
}
