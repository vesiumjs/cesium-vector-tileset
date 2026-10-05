import type { StructArray } from '../util/struct-array';

import type { TransferRegistry } from '../worker/transfer-registry';
import { warnOnce } from '../util/errors';

/**
 * A single segment of a vector
 * @internal
 */
export interface Segment {
  sortKey?: number;
  vertexOffset: number;
  primitiveOffset: number;
  vertexLength: number;
  primitiveLength: number;
}

/**
 * Used for calculations on vector segments
 * @internal
 */
export class SegmentVector {
  static MAX_VERTEX_ARRAY_LENGTH: number;
  segments: Segment[];
  private _forceNewSegmentOnNextPrepare: boolean = false;

  constructor(segments: Segment[] = []) {
    this.segments = segments;
  }

  /**
   * Returns the last segment if `numVertices` fits into it.
   * If there are no segments yet or `numVertices` doesn't fit into the last one, creates a new empty segment and returns it.
   */
  prepareSegment(
    numVertices: number,
    layoutVertexArray: StructArray,
    indexArray: StructArray,
    sortKey?: number,
  ): Segment {
    const lastSegment: Segment = this.segments[this.segments.length - 1];

    if (numVertices > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
      warnOnce(`Max vertices per segment is ${SegmentVector.MAX_VERTEX_ARRAY_LENGTH}: bucket requested ${numVertices}. Consider using the \`fillLargeMeshArrays\` function if you require meshes with more than ${SegmentVector.MAX_VERTEX_ARRAY_LENGTH} vertices.`);
    }

    if (this._forceNewSegmentOnNextPrepare || !lastSegment || lastSegment.vertexLength + numVertices > SegmentVector.MAX_VERTEX_ARRAY_LENGTH || lastSegment.sortKey !== sortKey) {
      return this.createNewSegment(layoutVertexArray, indexArray, sortKey);
    }
    else {
      return lastSegment;
    }
  }

  /**
   * Creates a new empty segment and returns it.
   */
  createNewSegment(
    layoutVertexArray: StructArray,
    indexArray: StructArray,
    sortKey?: number,
  ): Segment {
    const segment: Segment = {
      vertexOffset: layoutVertexArray.length,
      primitiveOffset: indexArray.length,
      vertexLength: 0,
      primitiveLength: 0,
    };

    if (sortKey !== undefined) {
      segment.sortKey = sortKey;
    }

    // If this was set, we have no need to create a new segment on next prepareSegment call,
    // since this function already created a new, empty segment.
    this._forceNewSegmentOnNextPrepare = false;
    this.segments.push(segment);
    return segment;
  }

  /**
   * Returns the last segment, or creates a new segments if there are no segments yet.
   */
  getOrCreateLatestSegment(
    layoutVertexArray: StructArray,
    indexArray: StructArray,
    sortKey?: number,
  ): Segment {
    return this.prepareSegment(0, layoutVertexArray, indexArray, sortKey);
  }

  /**
   * Causes the next call to {@link prepareSegment} to always return a new segment,
   * not reusing the current segment even if the new geometry would fit it.
   */
  forceNewSegmentOnNextPrepare(): void {
    this._forceNewSegmentOnNextPrepare = true;
  }

  get(): Segment[] {
    return this.segments;
  }

  static simpleSegment(
    vertexOffset: number,
    primitiveOffset: number,
    vertexLength: number,
    primitiveLength: number,
  ): SegmentVector {
    return new SegmentVector([{
      vertexOffset,
      primitiveOffset,
      vertexLength,
      primitiveLength,
      sortKey: 0,
    }]);
  }
}

/**
 * The maximum size of a vertex array. This limit is imposed by WebGL's 16 bit
 * addressing of vertex buffers.
 */
SegmentVector.MAX_VERTEX_ARRAY_LENGTH = 2 ** 16 - 1;

/**
 * One emitted chunk of a triangle mesh that was split across segment
 * boundaries: a contiguous run of vertices appended to the shared vertex
 * array together with the triangles referencing them, all contained in a
 * single segment.
 * @internal
 */
export interface TriangleMeshChunk {
  vertexLength: number;
  primitiveLength: number;
}

/**
 * Splits a triangle mesh whose vertex count exceeds
 * {@link SegmentVector.MAX_VERTEX_ARRAY_LENGTH} into multiple segment chunks,
 * duplicating vertices that straddle a chunk boundary. Ported from MapLibre's
 * `fillSegmentsTriangles` (src/render/fill_large_mesh_arrays.ts), which
 * assumes the incoming triangles reference vertices in roughly linear order
 * and copies a vertex into the current segment only when a triangle needs it.
 *
 * Mutates `segments`, `vertexArray` and `triangleIndexArray`: new vertices
 * are appended through `addVertex` and every emitted triangle index is local
 * to the segment it was written into, so values stay within the Uint16 range.
 * Returns one entry per emitted chunk in buffer order; a chunk's vertices
 * form a contiguous range of `vertexArray` and all of its triangles live in a
 * single segment.
 */
export function fillSegmentsTriangles(
  segments: SegmentVector,
  vertexArray: StructArray,
  triangleIndexArray: StructArray,
  flattened: number[],
  triangleIndices: number[],
  addVertex: (x: number, y: number) => void,
): TriangleMeshChunk[] {
  // Map of [vertex index in the original data] -> index of the latest copy of
  // this vertex in the final vertex buffer.
  const actualVertexIndices: number[] = [];
  for (let i = 0; i < flattened.length / 2; i++) {
    actualVertexIndices.push(-1);
  }

  const totalVerticesCreated = { count: 0 };
  const chunks: TriangleMeshChunk[] = [];
  let chunkVertexLength = 0;
  let chunkPrimitiveLength = 0;

  let currentSegmentCutoff = 0;
  let segment = segments.getOrCreateLatestSegment(vertexArray, triangleIndexArray);
  let baseVertex = segment.vertexLength;

  for (let primitiveEndIndex = 2; primitiveEndIndex < triangleIndices.length; primitiveEndIndex += 3) {
    const i0 = triangleIndices[primitiveEndIndex - 2];
    const i1 = triangleIndices[primitiveEndIndex - 1];
    const i2 = triangleIndices[primitiveEndIndex];

    let i0needsVertexCopy = actualVertexIndices[i0] < currentSegmentCutoff;
    let i1needsVertexCopy = actualVertexIndices[i1] < currentSegmentCutoff;
    let i2needsVertexCopy = actualVertexIndices[i2] < currentSegmentCutoff;

    let vertexCopyCount = (i0needsVertexCopy ? 1 : 0) + (i1needsVertexCopy ? 1 : 0) + (i2needsVertexCopy ? 1 : 0);

    // Will needed vertex copies fit into this segment?
    if (segment.vertexLength + vertexCopyCount > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
      // Break up into a new segment if not.
      chunks.push({ vertexLength: chunkVertexLength, primitiveLength: chunkPrimitiveLength });
      segment = segments.createNewSegment(vertexArray, triangleIndexArray);
      currentSegmentCutoff = totalVerticesCreated.count;
      i0needsVertexCopy = true;
      i1needsVertexCopy = true;
      i2needsVertexCopy = true;
      baseVertex = 0;
      chunkVertexLength = 0;
      chunkPrimitiveLength = 0;
      // The break forces all three vertices to be copied, regardless of what
      // the pre-break value was. Counting the stale value would under-report
      // this chunk's vertexLength by up to 3, and the deficit accumulates
      // across every break because callers sum chunk.vertexLength into
      // running polygon vertex offsets.
      vertexCopyCount = 3;
    }

    const actualIndex0 = copyOrReuseVertex(
      actualVertexIndices,
      flattened,
      addVertex,
      totalVerticesCreated,
      i0,
      i0needsVertexCopy,
      segment,
    );
    const actualIndex1 = copyOrReuseVertex(
      actualVertexIndices,
      flattened,
      addVertex,
      totalVerticesCreated,
      i1,
      i1needsVertexCopy,
      segment,
    );
    const actualIndex2 = copyOrReuseVertex(
      actualVertexIndices,
      flattened,
      addVertex,
      totalVerticesCreated,
      i2,
      i2needsVertexCopy,
      segment,
    );

    triangleIndexArray.emplaceBack(
      baseVertex + actualIndex0 - currentSegmentCutoff,
      baseVertex + actualIndex1 - currentSegmentCutoff,
      baseVertex + actualIndex2 - currentSegmentCutoff,
    );

    segment.primitiveLength++;
    chunkVertexLength += vertexCopyCount;
    chunkPrimitiveLength++;
  }
  chunks.push({ vertexLength: chunkVertexLength, primitiveLength: chunkPrimitiveLength });
  return chunks;
}

/**
 * Determines the index of a vertex in the final vertex buffer given its index
 * in the original data, copying the vertex into the vertex array when the
 * current segment cannot reference the earlier copy.
 */
function copyOrReuseVertex(
  actualVertexIndices: number[],
  flattened: number[],
  addVertex: (x: number, y: number) => void,
  totalVerticesCreated: { count: number },
  oldIndex: number,
  needsCopy: boolean,
  segment: Segment,
): number {
  if (needsCopy) {
    const newIndex = totalVerticesCreated.count;
    addVertex(flattened[oldIndex * 2], flattened[oldIndex * 2 + 1]);
    actualVertexIndices[oldIndex] = totalVerticesCreated.count;
    totalVerticesCreated.count++;
    segment.vertexLength++;
    return newIndex;
  }
  else {
    return actualVertexIndices[oldIndex];
  }
}

/**
 * Reorders the triangles of a triangulated polygon so that every triangle has
 * counter-clockwise winding. earcut preserves the input ring winding, and the
 * MVT spec does not mandate an orientation, so back-face culling can hide
 * polygons depending on the data producer. Ported from MapLibre's
 * `fixWindingOrder` (src/render/subdivision.ts).
 *
 * Mutates `triangleIndices` in place.
 */
export function fixWindingOrder(flattened: number[], triangleIndices: number[]): void {
  for (let i = 0; i < triangleIndices.length; i += 3) {
    const i0 = triangleIndices[i];
    const i1 = triangleIndices[i + 1];
    const i2 = triangleIndices[i + 2];

    const v0x = flattened[i0 * 2];
    const v0y = flattened[i0 * 2 + 1];
    const v1x = flattened[i1 * 2];
    const v1y = flattened[i1 * 2 + 1];
    const v2x = flattened[i2 * 2];
    const v2y = flattened[i2 * 2 + 1];

    const e0x = v1x - v0x;
    const e0y = v1y - v0y;
    const e1x = v2x - v0x;
    const e1y = v2y - v0y;

    const crossProduct = e0x * e1y - e0y * e1x;

    if (crossProduct > 0) {
      // Flip the winding
      triangleIndices[i + 1] = i2;
      triangleIndices[i + 2] = i1;
    }
  }
}

export function registerSegmentTransfers(registry: TransferRegistry): void {
  registry.register('SegmentVector', SegmentVector);
}
