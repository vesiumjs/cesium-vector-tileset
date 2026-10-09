import type { Bucket } from '../../data/bucket';
import type { CirclePrimitiveGeometry, FillOutlinePath, FillPatternGeometry, FillPrimitiveGeometry, LinePrimitiveGeometry, ProjectedGeometryList } from '../../data/projected-geometry';
import type { Segment } from '../../data/segment';
import type { CircleStyleLayer } from '../../style/style-layer/circle-style-layer';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import { CircleBucket, FillBucket, LineBucket } from '../../data/bucket-runtime';
import { EXTENT } from '../../data/extent';
import { projectCircleGeometry, projectFillGeometry, projectFillOutlineGeometry, projectLineGeometry } from '../../data/projected-geometry-transfer';
import { clipPlanarFill } from '../geometry/planar-fill';
import { subdivideTriangles, subdivideVertexLine, surfaceGranularity, visitSubdividedLineSegment } from '../geometry/surface-subdivision';
import { tileLocalToWgs84Ecef } from '../geometry/tile-to-ecef';
import { prepareLineGeometry } from '../line/prepared-line-geometry';
import { isPatternStyleLayer } from '../pattern/pattern-layer';
import { MORPHING, SCENE3D } from '../scene/scene-mode';

type TileID = CanonicalTileID | OverscaledTileID;

const fillGeometryCache = new WeakMap<FillBucket, Map<string, FillPrimitiveGeometry[]>>();
const lineGeometryCache = new WeakMap<LineBucket, Map<string, LinePrimitiveGeometry[]>>();

/** Project the parser's bucket-owned geometry before WorkerChannel transfer. */
export function projectWorkerBuckets(buckets: readonly Bucket[], tileID: OverscaledTileID): void {
  for (const bucket of buckets) {
    if ((bucket instanceof FillBucket || bucket instanceof LineBucket)
      && bucket.layers.every(layer => isPatternStyleLayer(layer))) {
      continue;
    }
    if (bucket instanceof FillBucket) {
      const projected = bucket.projectedGeometry ??= {};
      projected.fill = projectFillGeometry(fillBucketPrimitives(bucket, tileID, SCENE3D));
      // The packed owner replaces the per-polygon projection buffers.
      fillGeometryCache.delete(bucket);
    }
    else if (bucket instanceof LineBucket) {
      const primitives = lineBucketPrimitives(bucket, tileID, SCENE3D);
      // Dash rows depend on the scene atlas. Pattern-only families were
      // excluded above; only families with a solid member prepare strips.
      const solid = bucket.layers.some((layer) => {
        const paint = layer.serialize().paint as Record<string, unknown> | undefined;
        return paint?.['line-pattern'] == null && paint?.['line-dasharray'] == null;
      });
      const prepared = solid
        ? primitives.map(source => prepareLineGeometry(source, {
            ...(bucket.featureLineJoinCaps[source.featureIndex] ?? bucket.lineJoinCap),
            widthPx: 255,
          }, tileID.canonical))
        : undefined;
      bucket.projectedGeometry = { lines: projectLineGeometry(primitives, prepared) };
      lineGeometryCache.delete(bucket);
    }
    else if (bucket instanceof CircleBucket) {
      bucket.projectedGeometry = { circles: projectCircleGeometry(circleBucketPrimitives(bucket, tileID)) };
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

function outlinePointsForPolygon(
  localPositions: Array<[number, number]>,
  holes: number[],
  granularity: number,
): Array<Array<[number, number]>> {
  const starts = [0, ...holes];
  const paths: Array<Array<[number, number]>> = [];
  for (let ring = 0; ring < starts.length; ring++) {
    const start = starts[ring];
    const end = starts[ring + 1] ?? localPositions.length;
    const points = localPositions.slice(start, end);
    const sampled = subdivideVertexLine(points, granularity, true);
    for (const current of clipPathToTileX(sampled)) {
      paths.push(current);
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

/**
 * Project both source-ring topologies before Worker transfer. Globe grid
 * intersections retain their existing rounding; planar rings keep the exact
 * original edges, including their independently computed clipping endpoints.
 */
function projectFillOutlines(bucket: FillBucket, tileID: TileID): ProjectedGeometryList<readonly FillOutlinePath[]> {
  const projected = bucket.projectedGeometry ??= {};
  if (projected.fillOutlines && projected.fillPlanarOutlines) {
    return projected.fillOutlines;
  }
  const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
  projected.fillOutlines = projectOutlineTopology(bucket, canonical, surfaceGranularity('fill', canonical.z, SCENE3D));
  projected.fillPlanarOutlines = projectOutlineTopology(bucket, canonical, 1);
  return projected.fillOutlines;
}

function projectOutlineTopology(bucket: FillBucket, tileID: CanonicalTileID, granularity: number): ProjectedGeometryList<readonly FillOutlinePath[]> {
  const polygons = bucket.polygons.map((polygon, polygonIndex) => outlinePointsForPolygon(
    polygonPositions(bucket, polygonIndex),
    polygon.holes,
    granularity,
  ));
  let count = 0;
  for (const paths of polygons) {
    for (const path of paths) count += path.length;
  }
  const positions = new Float64Array(count * 3);
  const tilePositions = new Float64Array(count * 2);
  const outlines: FillOutlinePath[][] = [];
  let offset = 0;
  for (const paths of polygons) {
    const polygonOutlines: FillOutlinePath[] = [];
    for (const path of paths) {
      const start = offset;
      for (const [x, y] of path) {
        const cartesian = tileLocalToWgs84Ecef(tileID, x, y);
        positions[offset * 3] = cartesian.x;
        positions[offset * 3 + 1] = cartesian.y;
        positions[offset * 3 + 2] = cartesian.z;
        tilePositions[offset * 2] = x;
        tilePositions[offset * 2 + 1] = y;
        offset++;
      }
      polygonOutlines.push({
        positions: positions.subarray(start * 3, offset * 3),
        tilePositions: tilePositions.subarray(start * 2, offset * 2),
        closed: path.length >= 3
          && path[0][0] === path[path.length - 1][0]
          && path[0][1] === path[path.length - 1][1],
      });
    }
    outlines.push(polygonOutlines);
  }
  return projectFillOutlineGeometry(outlines);
}

/** Consume the bucket's original rings, shared across fill surface variants. */
export function fillOutlinePaths(
  bucket: FillBucket,
  primitive: FillPrimitiveGeometry,
  mode?: number,
): readonly FillOutlinePath[] {
  const outlines = mode === undefined || mode === SCENE3D || mode === MORPHING
    ? bucket.projectedGeometry?.fillOutlines
    : bucket.projectedGeometry?.fillPlanarOutlines;
  if (!outlines)
    throw new TypeError('fill geometry requires projected source outlines');
  const paths = outlines.get(primitive.polygonIndex);
  if (primitive.subdivision !== 1)
    return paths;
  const group = bucket.polygons[primitive.polygonIndex].polygonGroupId;
  let end = primitive.polygonIndex + 1;
  while (end < bucket.polygons.length && bucket.polygons[end].polygonGroupId === group)
    end++;
  return end === primitive.polygonIndex + 1
    ? paths
    : Array.from({ length: end - primitive.polygonIndex }, (_, index) => outlines.get(primitive.polygonIndex + index)).flat();
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
  if (output !== 'pattern') {
    projectFillOutlines(bucket, tileID);
  }
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

  for (let polygonIndex = 0; polygonIndex < bucket.polygons.length;) {
    const polygon = bucket.polygons[polygonIndex];
    const firstPolygonIndex = polygonIndex;
    let end = polygonIndex + 1;
    if (subdivision === 1) {
      while (end < bucket.polygons.length && bucket.polygons[end].polygonGroupId === polygon.polygonGroupId)
        end++;
    }
    const chunks = bucket.polygons.slice(polygonIndex, end);
    polygonIndex = end;
    const vertexLength = chunks.reduce((count, chunk) => count + chunk.vertexLength, 0);
    let outsideTile = false;
    const int16 = bucket.layoutVertexArray.int16;
    for (let i = 0; i < vertexLength; i++) {
      const vertex = polygon.vertexOffset + i;
      const x = int16[vertex * 2];
      const y = int16[vertex * 2 + 1];
      outsideTile ||= x < 0 || x > EXTENT || y < 0 || y > EXTENT;
    }

    const triangles: number[] = [];
    const segments = chunks.map(chunk => segmentForVertex(bucket.segments.get(), chunk.vertexOffset));
    // A missing segment means the worker payload is malformed. Falling back
    // to zero would reinterpret the first segment's indices as this polygon
    // and can produce a plausible-looking but unrelated triangle set.
    if (segments.some(segment => !segment)) {
      continue;
    }
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const segmentVertexOffset = segments[chunkIndex]!.vertexOffset;
      for (let i = 0; i < chunk.primitiveLength * 3; i += 3) {
        const absoluteA = segmentVertexOffset + bucket.indexArray.uint16[chunk.primitiveOffset * 3 + i];
        const absoluteB = segmentVertexOffset + bucket.indexArray.uint16[chunk.primitiveOffset * 3 + i + 1];
        const absoluteC = segmentVertexOffset + bucket.indexArray.uint16[chunk.primitiveOffset * 3 + i + 2];
        const relativeA = absoluteA - chunk.vertexOffset;
        const relativeB = absoluteB - chunk.vertexOffset;
        const relativeC = absoluteC - chunk.vertexOffset;
        // Do not turn a malformed worker index into a huge Uint32 index that
        // Cesium will reject later while building the GPU collection.
        if (relativeA >= 0 && relativeA < chunk.vertexLength
          && relativeB >= 0 && relativeB < chunk.vertexLength
          && relativeC >= 0 && relativeC < chunk.vertexLength) {
          triangles.push(absoluteA - polygon.vertexOffset, absoluteB - polygon.vertexOffset, absoluteC - polygon.vertexOffset);
        }
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
        vertexLength,
      );
      if (output === 'pattern') {
        tilePositions = Float64Array.from(int16.subarray(
          polygon.vertexOffset * 2,
          (polygon.vertexOffset + vertexLength) * 2,
        ));
      }
      indices = surface?.triangles ?? new Uint32Array(triangles);
    }
    else {
      const sourcePoints = chunks.flatMap((_chunk, index) => polygonPositions(bucket, firstPolygonIndex + index));
      const planar = subdivision === 1 ? clipPlanarFill(sourcePoints, triangles) : undefined;
      const subdivided = planar
        ? { vertices: planar.points.map(([x, y]) => ({ x, y })), indices: planar.indices }
        : subdivideTriangles(sourcePoints, triangles, subdivision, {
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
      polygonIndex: firstPolygonIndex,
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
