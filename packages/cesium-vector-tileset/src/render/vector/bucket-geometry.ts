import type { Bucket } from '../../data/bucket';
import type { CirclePrimitiveGeometry, FillOutlinePath, FillPatternGeometry, FillPrimitiveGeometry, LinePrimitiveGeometry } from '../../data/projected-geometry';
import type { Segment } from '../../data/segment';
import type { CircleStyleLayer } from '../../style/style-layer/circle-style-layer';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import { CircleBucket, FillBucket, LineBucket } from '../../data/bucket-runtime';
import { EXTENT } from '../../data/extent';
import { subdivideTriangles, subdivideVertexLine, surfaceGranularity, visitSubdividedLineSegment } from '../geometry/surface-subdivision';
import { tileLocalToWgs84Ecef } from '../geometry/tile-to-ecef';
import { isPatternStyleLayer } from '../pattern/pattern-layer';
import { SCENE3D } from '../scene/scene-mode';

type TileID = CanonicalTileID | OverscaledTileID;

const fillGeometryCache = new WeakMap<FillBucket, Map<string, FillPrimitiveGeometry[]>>();
const fillOutlineCache = new WeakMap<FillPrimitiveGeometry, FillOutlinePath[]>();
const lineGeometryCache = new WeakMap<LineBucket, Map<string, LinePrimitiveGeometry[]>>();

/** Project the parser's bucket-owned geometry before WorkerChannel transfer. */
export function projectWorkerBuckets(buckets: readonly Bucket[], tileID: OverscaledTileID): void {
  for (const bucket of buckets) {
    if ((bucket instanceof FillBucket || bucket instanceof LineBucket)
      && bucket.layers.every(layer => isPatternStyleLayer(layer))) {
      continue;
    }
    if (bucket instanceof FillBucket) {
      bucket.projectedGeometry = { fill: fillBucketPrimitives(bucket, tileID, SCENE3D) };
    }
    else if (bucket instanceof LineBucket) {
      bucket.projectedGeometry = { lines: lineBucketPrimitives(bucket, tileID, SCENE3D) };
    }
    else if (bucket instanceof CircleBucket) {
      bucket.projectedGeometry = { circles: circleBucketPrimitives(bucket, tileID) };
    }
  }
}

function geometryCacheKey(tileID: TileID, granularity: number): string {
  return `${tileID.key}/${granularity}`;
}

/**
 * Locate the segment that owns `vertexIndex` in O(log n), mirroring the
 * ascending, non-overlapping vertex spans the worker appends segments in.
 */
function segmentForVertex(segments: Segment[], vertexIndex: number): Segment | undefined {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (vertexIndex < segment.vertexOffset) {
      high = middle - 1;
    }
    else if (vertexIndex >= segment.vertexOffset + segment.vertexLength) {
      low = middle + 1;
    }
    else {
      return segment;
    }
  }
  return undefined;
}

function positionsToEcef(
  bucket: FillBucket,
  tileID: TileID,
  start: number,
  count: number,
): Float64Array {
  const positions = new Float64Array(count * 3);
  const int16 = bucket.layoutVertexArray.int16;
  for (let i = 0; i < count; i++) {
    const x = int16[(start + i) * 2];
    const y = int16[(start + i) * 2 + 1];
    const cartesian = tileLocalToWgs84Ecef(tileID, x, y);
    positions[i * 3] = cartesian.x;
    positions[i * 3 + 1] = cartesian.y;
    positions[i * 3 + 2] = cartesian.z;
  }
  return positions;
}

/**
 * Clip polygon outlines to the tile's own X bounds. The Y axis remains open
 * for the globe pole extensions; Native LINES draw these outlines without
 * expanding a buffered centerline into a wide stroke.
 */
function clipPathToTileX(points: Array<[number, number]>): Array<Array<[number, number]>> {
  const paths: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  const flush = (): void => {
    if (current.length >= 2) {
      paths.push(current);
    }
    current = [];
  };
  const clipBoundary = (
    from: [number, number],
    to: [number, number],
    boundary: number,
  ): [number, number] => {
    const dx = to[0] - from[0];
    const t = Math.abs(dx) < 1e-12 ? 0 : (boundary - from[0]) / dx;
    return [boundary, from[1] + (to[1] - from[1]) * t];
  };
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    if (from[0] < 0 && to[0] < 0) {
      flush();
      continue;
    }
    if (from[0] > EXTENT && to[0] > EXTENT) {
      flush();
      continue;
    }
    let clippedFrom = from;
    let clippedTo = to;
    if (from[0] < 0) {
      clippedFrom = clipBoundary(from, to, 0);
    }
    else if (from[0] > EXTENT) {
      clippedFrom = clipBoundary(from, to, EXTENT);
    }
    if (to[0] < 0) {
      clippedTo = clipBoundary(from, to, 0);
    }
    else if (to[0] > EXTENT) {
      clippedTo = clipBoundary(from, to, EXTENT);
    }
    if (current.length === 0
      || current[current.length - 1][0] !== clippedFrom[0]
      || current[current.length - 1][1] !== clippedFrom[1]) {
      current.push(clippedFrom);
    }
    if (current.length === 0
      || current[current.length - 1][0] !== clippedTo[0]
      || current[current.length - 1][1] !== clippedTo[1]) {
      current.push(clippedTo);
    }
  }
  flush();
  return paths;
}

function outlinePathsForPolygon(
  localPositions: Array<[number, number]>,
  holes: number[],
  granularity: number,
  tileID: TileID,
): FillOutlinePath[] {
  const starts = [0, ...holes];
  const paths: FillOutlinePath[] = [];
  for (let ring = 0; ring < starts.length; ring++) {
    const start = starts[ring];
    const end = starts[ring + 1] ?? localPositions.length;
    const points = localPositions.slice(start, end);
    const sampled = subdivideVertexLine(points, granularity, true);
    for (const current of clipPathToTileX(sampled)) {
      const positions = new Float64Array(current.length * 3);
      for (let i = 0; i < current.length; i++) {
        const cartesian = tileLocalToWgs84Ecef(tileID, current[i][0], current[i][1]);
        positions[i * 3] = cartesian.x;
        positions[i * 3 + 1] = cartesian.y;
        positions[i * 3 + 2] = cartesian.z;
      }
      paths.push({
        positions,
        tilePositions: Float64Array.from(current.flat()),
        closed: current.length >= 3
          && current[0][0] === current[current.length - 1][0]
          && current[0][1] === current[current.length - 1][1],
      });
    }
  }
  return paths;
}

function polygonPositions(bucket: FillBucket, polygonIndex: number): Array<[number, number]> {
  const polygon = bucket.polygons[polygonIndex];
  const int16 = bucket.layoutVertexArray.int16;
  const points: Array<[number, number]> = [];
  for (let i = 0; i < polygon.vertexLength; i++) {
    const vertex = polygon.vertexOffset + i;
    points.push([int16[vertex * 2], int16[vertex * 2 + 1]]);
  }
  return points;
}

/** Project original rings only when a visible fill outline consumes them. */
export function fillOutlinePaths(
  bucket: FillBucket,
  primitive: FillPrimitiveGeometry,
  tileID: TileID,
): FillOutlinePath[] {
  const cached = fillOutlineCache.get(primitive);
  if (cached) {
    return cached;
  }
  const polygon = bucket.polygons[primitive.polygonIndex];
  const paths = outlinePathsForPolygon(
    polygonPositions(bucket, primitive.polygonIndex),
    polygon.holes,
    primitive.subdivision,
    tileID,
  );
  fillOutlineCache.set(primitive, paths);
  return paths;
}

/**
 * Split a fill bucket into per-polygon primitives. A polygon is the geometry
 * group produced by `addFeature` (one classifyRings result): an outer ring
 * plus its holes. Triangles are read straight from the bucket's earcut index
 * array (bounded by the polygon's segment); hole start indices come from the
 * ring metadata recorded during `addFeature`.
 */
export function fillBucketPrimitives(
  bucket: FillBucket,
  tileID: TileID,
  mode?: number,
): FillPrimitiveGeometry[];
export function fillBucketPrimitives(
  bucket: FillBucket,
  tileID: TileID,
  mode: number | undefined,
  output: 'pattern',
): FillPatternGeometry[];
export function fillBucketPrimitives(
  bucket: FillBucket,
  tileID: TileID,
  mode?: number,
  output?: 'pattern',
): FillPrimitiveGeometry[] {
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  const subdivision = mode === undefined ? 1 : surfaceGranularity('fill', canonical.z, mode);
  const surfaceKey = geometryCacheKey(tileID, subdivision);
  const key = output === 'pattern' ? `${surfaceKey}/pattern` : surfaceKey;
  let bucketCache = fillGeometryCache.get(bucket);
  const cached = bucketCache?.get(key);
  if (cached) {
    return cached;
  }
  const surfacePrimitives = output === 'pattern' ? bucketCache?.get(surfaceKey) : undefined;
  const primitives: FillPrimitiveGeometry[] = [];

  for (let polygonIndex = 0; polygonIndex < bucket.polygons.length; polygonIndex++) {
    const polygon = bucket.polygons[polygonIndex];
    let outsideTile = false;
    const int16 = bucket.layoutVertexArray.int16;
    for (let i = 0; i < polygon.vertexLength; i++) {
      const vertex = polygon.vertexOffset + i;
      const x = int16[vertex * 2];
      const y = int16[vertex * 2 + 1];
      outsideTile ||= x < 0 || x > EXTENT || y < 0 || y > EXTENT;
    }

    const triangles: number[] = [];
    const segment = segmentForVertex(bucket.segments.get(), polygon.vertexOffset);
    // A missing segment means the worker payload is malformed. Falling back
    // to zero would reinterpret the first segment's indices as this polygon
    // and can produce a plausible-looking but unrelated triangle set.
    if (!segment) {
      continue;
    }
    const segmentVertexOffset = segment.vertexOffset;
    for (let i = 0; i < polygon.primitiveLength * 3; i += 3) {
      const absoluteA = segmentVertexOffset + bucket.indexArray.uint16[polygon.primitiveOffset * 3 + i];
      const absoluteB = segmentVertexOffset + bucket.indexArray.uint16[polygon.primitiveOffset * 3 + i + 1];
      const absoluteC = segmentVertexOffset + bucket.indexArray.uint16[polygon.primitiveOffset * 3 + i + 2];
      const relativeA = absoluteA - polygon.vertexOffset;
      const relativeB = absoluteB - polygon.vertexOffset;
      const relativeC = absoluteC - polygon.vertexOffset;
      // Do not turn a malformed worker index into a huge Uint32 index that
      // Cesium will reject later while building the GPU collection.
      if (relativeA >= 0 && relativeA < polygon.vertexLength
        && relativeB >= 0 && relativeB < polygon.vertexLength
        && relativeC >= 0 && relativeC < polygon.vertexLength) {
        triangles.push(relativeA, relativeB, relativeC);
      }
    }

    if (triangles.length === 0 || triangles.length % 3 !== 0) {
      continue;
    }

    let positions: Float64Array;
    let tilePositions: Float64Array | undefined;
    let indices: Uint32Array;
    const surface = surfacePrimitives?.[primitives.length];
    const tessellate = subdivision >= 2 || outsideTile;
    if (!tessellate) {
      positions = surface?.positions ?? positionsToEcef(
        bucket,
        tileID,
        polygon.vertexOffset,
        polygon.vertexLength,
      );
      if (output === 'pattern') {
        tilePositions = Float64Array.from(int16.subarray(
          polygon.vertexOffset * 2,
          (polygon.vertexOffset + polygon.vertexLength) * 2,
        ));
      }
      indices = surface?.triangles ?? new Uint32Array(triangles);
    }
    else {
      const subdivided = subdivideTriangles(polygonPositions(bucket, polygonIndex), triangles, subdivision, {
        clipToTile: true,
        northPole: canonical.y === 0,
        southPole: canonical.y === (2 ** canonical.z) - 1,
      });
      if (subdivided.indices.length === 0) {
        continue;
      }
      // Subdivision already owns the deduplicated vertex order and indices.
      // Write final buffers directly; only image patterns consume tile XY.
      positions = surface?.positions ?? new Float64Array(subdivided.vertices.length * 3);
      if (output === 'pattern') {
        tilePositions = new Float64Array(subdivided.vertices.length * 2);
      }
      for (let index = 0; index < subdivided.vertices.length; index++) {
        const { x, y } = subdivided.vertices[index];
        if (!surface) {
          const cartesian = tileLocalToWgs84Ecef(tileID, x, y);
          positions[index * 3] = cartesian.x;
          positions[index * 3 + 1] = cartesian.y;
          positions[index * 3 + 2] = cartesian.z;
        }
        if (tilePositions) {
          tilePositions[index * 2] = x;
          tilePositions[index * 2 + 1] = y;
        }
      }
      indices = surface?.triangles ?? new Uint32Array(subdivided.indices);
    }

    const featureIndex = polygon.featureIndex;

    const primitive: FillPrimitiveGeometry = {
      positions,
      ringVertexCount: positions.length / 3,
      // Once subdivision adds vertices, the original ring offsets no longer
      // describe the contiguous position buffer. Triangles already encode
      // the earcut hole topology, so omit stale hole metadata for that mesh.
      holes: tessellate ? [] : polygon.holes,
      triangles: indices,
      polygonIndex,
      subdivision,
      featureIndex,
    };
    if (tilePositions) {
      Object.assign(primitive, { tilePositions });
    }
    primitives.push(primitive);
  }
  if (!bucketCache) {
    bucketCache = new Map();
    fillGeometryCache.set(bucket, bucketCache);
  }
  bucketCache.set(key, primitives);
  return primitives;
}

function visitLinePath(points: Int16Array, granularity: number, visit?: (x: number, y: number) => void): number {
  let count = 0;
  for (let i = 2; i < points.length; i += 2) {
    const x = points[i - 2];
    const y = points[i - 1];
    const nextX = points[i];
    const nextY = points[i + 1];
    if (x === nextX && y === nextY)
      continue;
    if (count === 0) {
      visit?.(x, y);
      count++;
    }
    count += visitSubdividedLineSegment(x, y, nextX, nextY, granularity, visit);
  }
  return count;
}

/** Project logical centerlines into two bucket-owned buffers with stable path views. */
export function lineBucketPrimitives(
  bucket: LineBucket,
  tileID: TileID,
  mode: number,
): LinePrimitiveGeometry[] {
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  const granularity = surfaceGranularity('line', canonical.z, mode);
  const key = geometryCacheKey(canonical, granularity);
  const cached = lineGeometryCache.get(bucket)?.get(key);
  if (cached) {
    return cached;
  }
  const primitives: LinePrimitiveGeometry[] = [];
  // Count before allocating: no per-path coordinate arrays or tuple lists are
  // retained while creating the packed owner. Buffered centerlines remain
  // intact; wide-stroke clipping belongs to the line fragment shader.
  const total = bucket.linePaths.reduce((sum, path) => sum + visitLinePath(path.points, granularity), 0);
  const positions = new Float64Array(total * 3);
  const tilePositions = new Float64Array(total * 2);
  let offset = 0;
  for (const path of bucket.linePaths) {
    const start = offset;
    visitLinePath(path.points, granularity, (x, y) => {
      const cartesian = tileLocalToWgs84Ecef(canonical, x, y);
      positions[offset * 3] = cartesian.x;
      positions[offset * 3 + 1] = cartesian.y;
      positions[offset * 3 + 2] = cartesian.z;
      tilePositions[offset * 2] = x;
      tilePositions[offset * 2 + 1] = y;
      offset++;
    });
    primitives.push({
      positions: positions.subarray(start * 3, offset * 3),
      tilePositions: tilePositions.subarray(start * 2, offset * 2),
      featureIndex: path.featureIndex,
    });
  }
  let bucketCache = lineGeometryCache.get(bucket);
  if (!bucketCache) {
    bucketCache = new Map();
    lineGeometryCache.set(bucket, bucketCache);
  }
  bucketCache.set(key, primitives);
  return primitives;
}

/**
 * Split a circle bucket into point primitives using explicit geometry spans.
 */
export function circleBucketPrimitives(
  bucket: CircleBucket<CircleStyleLayer>,
  tileID: TileID,
): CirclePrimitiveGeometry[] {
  const primitives: CirclePrimitiveGeometry[] = [];
  const int16 = bucket.layoutVertexArray.int16;
  for (const range of bucket.geometryRanges) {
    for (let point = range.start; point < range.end; point++) {
      const x = int16[point * 2];
      const y = int16[point * 2 + 1];

      const cartesian = tileLocalToWgs84Ecef(tileID, x, y);
      primitives.push({
        position: [cartesian.x, cartesian.y, cartesian.z],
        featureIndex: range.featureIndex,
      });
    }
  }
  return primitives;
}
