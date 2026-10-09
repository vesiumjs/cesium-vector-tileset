import type { CirclePrimitiveGeometry, FillOutlinePath, FillPrimitiveGeometry, LinePrimitiveGeometry, PreparedLineGeometry, ProjectedBucketGeometry, ProjectedGeometryList } from './projected-geometry';

interface PackedFillGeometry {
  positions: Float64Array;
  triangles: Uint32Array;
  holes: Uint32Array;
  /** Vertex offset/count, triangle offset/count, hole offset/count, ring count, polygon, subdivision, feature. */
  ranges: Uint32Array;
}

interface PackedLineGeometry {
  positions: Float64Array;
  tilePositions: Float64Array;
  /** Point offset/count and source feature index. */
  ranges: Uint32Array;
  prepared?: PackedLineStrips;
}

interface PackedLineStrips {
  positions: Float64Array;
  flags: Uint8Array;
  indices16: Uint16Array;
  indices32: Uint32Array;
  sourcePositions: Float64Array;
  sourceVertices: Uint32Array;
  longitudes: Float64Array;
  bounds: Float64Array;
  layoutKeys: string[];
  /** Vertex offset/count, index offset/count, source offset/count, layout, closed, wide indices. */
  ranges: Uint32Array;
}

interface PackedFillOutlines {
  positions: Float64Array;
  tilePositions: Float64Array;
  polygonOffsets: Uint32Array;
  /** Point offset/count and closed flag. */
  ranges: Uint32Array;
}

interface PackedCircleGeometry {
  positions: Float64Array;
  featureIndices: Uint32Array;
}

/** The only projected geometry wire shape: a fixed number of owners per bucket. */
export interface PackedProjectedGeometry {
  fill?: PackedFillGeometry;
  lines?: PackedLineGeometry;
  fillOutlines?: PackedFillOutlines;
  fillPlanarOutlines?: PackedFillOutlines;
  circles?: PackedCircleGeometry;
}

type PackedGeometry = PackedFillGeometry | PackedLineGeometry | PackedFillOutlines | PackedCircleGeometry;
const storage = new WeakMap<object, PackedGeometry>();
const FILL_STRIDE = 10;
const PATH_STRIDE = 3;
const STRIP_STRIDE = 9;

/** Reception restores owners, not one object and two typed views per path. */
class GeometryList<T> implements ProjectedGeometryList<T> {
  private readonly _views = new Map<number, T>();
  private readonly _view: (index: number) => T;
  readonly length: number;

  constructor(length: number, packed: PackedGeometry, view: (index: number) => T) {
    this.length = length;
    this._view = view;
    storage.set(this, packed);
  }

  get(index: number): T {
    if (!Number.isInteger(index) || index < 0 || index >= this.length)
      throw new RangeError('projected geometry index is outside its owner');
    let view = this._views.get(index);
    if (view === undefined) {
      view = this._view(index);
      this._views.set(index, view);
    }
    return view;
  }

  * [Symbol.iterator](): Generator<T> {
    for (let index = 0; index < this.length; index++) yield this.get(index);
  }
}

/** Preserve an existing complete owner; otherwise consolidate separate primitive buffers. */
function packedPositions(arrays: readonly Float64Array[]): Float64Array {
  let length = 0;
  const first = arrays[0];
  let contiguous = first !== undefined && first.byteOffset === 0;
  for (const array of arrays) {
    contiguous &&= array.buffer === first.buffer && array.byteOffset === length * Float64Array.BYTES_PER_ELEMENT;
    length += array.length;
  }
  if (contiguous && length * Float64Array.BYTES_PER_ELEMENT === first.buffer.byteLength)
    return new Float64Array(first.buffer);
  const packed = new Float64Array(length);
  let offset = 0;
  for (const array of arrays) {
    packed.set(array, offset);
    offset += array.length;
  }
  return packed;
}

function fillViews(packed: PackedFillGeometry): ProjectedGeometryList<FillPrimitiveGeometry> {
  return new GeometryList(packed.ranges.length / FILL_STRIDE, packed, (index) => {
    const offset = index * FILL_STRIDE;
    const values = packed.ranges;
    const vertexStart = values[offset];
    const triangleStart = values[offset + 2];
    const holeStart = values[offset + 4];
    return {
      positions: packed.positions.subarray(vertexStart * 3, (vertexStart + values[offset + 1]) * 3),
      triangles: packed.triangles.subarray(triangleStart, triangleStart + values[offset + 3]),
      holes: Array.from(packed.holes.subarray(holeStart, holeStart + values[offset + 5])),
      ringVertexCount: values[offset + 6],
      polygonIndex: values[offset + 7],
      subdivision: values[offset + 8],
      featureIndex: values[offset + 9],
    };
  });
}

export function projectFillGeometry(primitives: readonly FillPrimitiveGeometry[]): ProjectedGeometryList<FillPrimitiveGeometry> {
  const positions = packedPositions(primitives.map(primitive => primitive.positions));
  const triangles = new Uint32Array(primitives.reduce((count, primitive) => count + primitive.triangles.length, 0));
  const holes = new Uint32Array(primitives.reduce((count, primitive) => count + primitive.holes.length, 0));
  const ranges = new Uint32Array(primitives.length * FILL_STRIDE);
  let vertexOffset = 0;
  let triangleOffset = 0;
  let holeOffset = 0;
  for (let index = 0; index < primitives.length; index++) {
    const primitive = primitives[index];
    const count = primitive.positions.length / 3;
    ranges.set([vertexOffset, count, triangleOffset, primitive.triangles.length, holeOffset, primitive.holes.length, primitive.ringVertexCount, primitive.polygonIndex, primitive.subdivision, primitive.featureIndex], index * FILL_STRIDE);
    triangles.set(primitive.triangles, triangleOffset);
    holes.set(primitive.holes, holeOffset);
    vertexOffset += count;
    triangleOffset += primitive.triangles.length;
    holeOffset += primitive.holes.length;
  }
  return fillViews({ positions, triangles, holes, ranges });
}

function lineViews(packed: PackedLineGeometry): ProjectedGeometryList<LinePrimitiveGeometry> {
  return new GeometryList(packed.ranges.length / PATH_STRIDE, packed, (index) => {
    const offset = index * PATH_STRIDE;
    const start = packed.ranges[offset];
    const end = start + packed.ranges[offset + 1];
    const positions = packed.positions.subarray(start * 3, end * 3);
    const tilePositions = packed.tilePositions.subarray(start * 2, end * 2);
    let prepared: PreparedLineGeometry | undefined;
    return {
      positions,
      tilePositions,
      featureIndex: packed.ranges[offset + 2],
      // Planar and atlas-dependent consumers need only the centerline. Strip
      // views are materialized once when a solid globe publication asks.
      get prepared() {
        return prepared ??= packed.prepared && lineStripView(packed.prepared, index, positions, tilePositions);
      },
    };
  });
}

function lineStripView(packed: PackedLineStrips, index: number, originalPositions: Float64Array, originalTilePositions: Float64Array): PreparedLineGeometry {
  const offset = index * STRIP_STRIDE;
  const ranges = packed.ranges;
  const vertexStart = ranges[offset];
  const vertexEnd = vertexStart + ranges[offset + 1];
  const indexStart = ranges[offset + 2];
  const indexEnd = indexStart + ranges[offset + 3];
  const sourceStart = ranges[offset + 4];
  const sourceEnd = sourceStart + ranges[offset + 5];
  return {
    layoutKey: packed.layoutKeys[ranges[offset + 6]],
    originalPositions,
    originalTilePositions,
    positions: packed.positions.subarray(vertexStart * 3, vertexEnd * 3),
    flags: packed.flags.subarray(vertexStart, vertexEnd),
    indices: (ranges[offset + 8] ? packed.indices32 : packed.indices16).subarray(indexStart, indexEnd),
    sourcePositions: packed.sourcePositions.subarray(sourceStart * 3, sourceEnd * 3),
    sourceVertices: packed.sourceVertices.subarray(vertexStart, vertexEnd),
    longitudes: packed.longitudes.subarray(sourceStart, sourceEnd),
    bounds: packed.bounds.subarray(index * 4, index * 4 + 4),
    closed: ranges[offset + 7] !== 0,
  };
}

function packLineStrips(strips: readonly PreparedLineGeometry[]): PackedLineStrips {
  let vertexCount = 0;
  let sourceCount = 0;
  let indexCount16 = 0;
  let indexCount32 = 0;
  for (const strip of strips) {
    vertexCount += strip.flags.length;
    sourceCount += strip.sourcePositions.length / 3;
    if (strip.indices instanceof Uint32Array)
      indexCount32 += strip.indices.length;
    else indexCount16 += strip.indices.length;
  }
  const packed: PackedLineStrips = {
    positions: new Float64Array(vertexCount * 3),
    flags: new Uint8Array(vertexCount),
    indices16: new Uint16Array(indexCount16),
    indices32: new Uint32Array(indexCount32),
    sourcePositions: new Float64Array(sourceCount * 3),
    sourceVertices: new Uint32Array(vertexCount),
    longitudes: new Float64Array(sourceCount),
    bounds: new Float64Array(strips.length * 4),
    layoutKeys: [],
    ranges: new Uint32Array(strips.length * STRIP_STRIDE),
  };
  const layouts = new Map<string, number>();
  let vertexOffset = 0;
  let sourceOffset = 0;
  let indexOffset16 = 0;
  let indexOffset32 = 0;
  for (const [index, strip] of strips.entries()) {
    let layout = layouts.get(strip.layoutKey);
    if (layout === undefined) {
      layout = packed.layoutKeys.length;
      layouts.set(strip.layoutKey, layout);
      packed.layoutKeys.push(strip.layoutKey);
    }
    const wide = strip.indices instanceof Uint32Array;
    const indexOffset = wide ? indexOffset32 : indexOffset16;
    packed.ranges.set([vertexOffset, strip.flags.length, indexOffset, strip.indices.length, sourceOffset, strip.sourcePositions.length / 3, layout, Number(strip.closed), Number(wide)], index * STRIP_STRIDE);
    packed.positions.set(strip.positions, vertexOffset * 3);
    packed.flags.set(strip.flags, vertexOffset);
    (wide ? packed.indices32 : packed.indices16).set(strip.indices, indexOffset);
    packed.sourcePositions.set(strip.sourcePositions, sourceOffset * 3);
    packed.sourceVertices.set(strip.sourceVertices, vertexOffset);
    packed.longitudes.set(strip.longitudes, sourceOffset);
    packed.bounds.set(strip.bounds, index * 4);
    vertexOffset += strip.flags.length;
    sourceOffset += strip.sourcePositions.length / 3;
    if (wide)
      indexOffset32 += strip.indices.length;
    else indexOffset16 += strip.indices.length;
  }
  return packed;
}

export function projectLineGeometry(primitives: readonly LinePrimitiveGeometry[], prepared?: readonly PreparedLineGeometry[]): ProjectedGeometryList<LinePrimitiveGeometry> {
  if (prepared && prepared.length !== primitives.length)
    throw new TypeError('prepared strips must match the projected line sources');
  const positions = packedPositions(primitives.map(primitive => primitive.positions));
  const tilePositions = packedPositions(primitives.map(primitive => primitive.tilePositions));
  const ranges = new Uint32Array(primitives.length * PATH_STRIDE);
  let offset = 0;
  for (let index = 0; index < primitives.length; index++) {
    const primitive = primitives[index];
    const count = primitive.positions.length / 3;
    ranges.set([offset, count, primitive.featureIndex], index * PATH_STRIDE);
    offset += count;
  }
  return lineViews({ positions, tilePositions, ranges, ...(prepared ? { prepared: packLineStrips(prepared) } : {}) });
}

function outlineViews(packed: PackedFillOutlines): ProjectedGeometryList<readonly FillOutlinePath[]> {
  return new GeometryList(packed.polygonOffsets.length - 1, packed, (polygon) => {
    const paths: FillOutlinePath[] = [];
    for (let index = packed.polygonOffsets[polygon]; index < packed.polygonOffsets[polygon + 1]; index++) {
      const offset = index * PATH_STRIDE;
      const start = packed.ranges[offset];
      const end = start + packed.ranges[offset + 1];
      paths.push({ positions: packed.positions.subarray(start * 3, end * 3), tilePositions: packed.tilePositions.subarray(start * 2, end * 2), closed: packed.ranges[offset + 2] !== 0 });
    }
    return paths;
  });
}

export function projectFillOutlineGeometry(polygons: readonly (readonly FillOutlinePath[])[]): ProjectedGeometryList<readonly FillOutlinePath[]> {
  const paths = polygons.flat();
  const positions = packedPositions(paths.map(path => path.positions));
  const tilePositions = packedPositions(paths.map(path => path.tilePositions));
  const polygonOffsets = new Uint32Array(polygons.length + 1);
  const ranges = new Uint32Array(paths.length * PATH_STRIDE);
  let pathOffset = 0;
  for (let polygon = 0; polygon < polygons.length; polygon++) {
    polygonOffsets[polygon] = pathOffset;
    pathOffset += polygons[polygon].length;
  }
  polygonOffsets[polygons.length] = pathOffset;
  let offset = 0;
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    const count = path.positions.length / 3;
    ranges.set([offset, count, Number(path.closed)], index * PATH_STRIDE);
    offset += count;
  }
  return outlineViews({ positions, tilePositions, polygonOffsets, ranges });
}

function circleViews(packed: PackedCircleGeometry): ProjectedGeometryList<CirclePrimitiveGeometry> {
  return new GeometryList(packed.featureIndices.length, packed, index => ({ position: [packed.positions[index * 3], packed.positions[index * 3 + 1], packed.positions[index * 3 + 2]], featureIndex: packed.featureIndices[index] }));
}

export function projectCircleGeometry(primitives: readonly CirclePrimitiveGeometry[]): ProjectedGeometryList<CirclePrimitiveGeometry> {
  const positions = new Float64Array(primitives.length * 3);
  const featureIndices = new Uint32Array(primitives.length);
  for (let index = 0; index < primitives.length; index++) {
    positions.set(primitives[index].position, index * 3);
    featureIndices[index] = primitives[index].featureIndex;
  }
  return circleViews({ positions, featureIndices });
}

/** Encoding never walks or materializes lazy primitive views. */
function projectedStorage(list: object): PackedGeometry {
  const packed = storage.get(list);
  if (!packed)
    throw new TypeError('projected geometry must have a packed owner');
  return packed;
}

export function serializeProjectedGeometry(geometry: ProjectedBucketGeometry): PackedProjectedGeometry {
  return {
    fill: geometry.fill && projectedStorage(geometry.fill) as PackedFillGeometry | undefined,
    lines: geometry.lines && projectedStorage(geometry.lines) as PackedLineGeometry | undefined,
    fillOutlines: geometry.fillOutlines && projectedStorage(geometry.fillOutlines) as PackedFillOutlines | undefined,
    fillPlanarOutlines: geometry.fillPlanarOutlines && projectedStorage(geometry.fillPlanarOutlines) as PackedFillOutlines | undefined,
    circles: geometry.circles && projectedStorage(geometry.circles) as PackedCircleGeometry | undefined,
  };
}

/** Restore constant-sized owner lists; each consumed primitive creates its own stable views. */
export function restoreProjectedGeometry(packed: PackedProjectedGeometry): ProjectedBucketGeometry {
  return {
    fill: packed.fill && fillViews(packed.fill),
    lines: packed.lines && lineViews(packed.lines),
    fillOutlines: packed.fillOutlines && outlineViews(packed.fillOutlines),
    fillPlanarOutlines: packed.fillPlanarOutlines && outlineViews(packed.fillPlanarOutlines),
    circles: packed.circles && circleViews(packed.circles),
  };
}
