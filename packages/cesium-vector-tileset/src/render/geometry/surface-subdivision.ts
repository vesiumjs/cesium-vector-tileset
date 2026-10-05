import { EXTENT } from '../../data/extent';
import { MORPHING, SCENE3D } from '../scene/scene-mode';

export type TilePoint = [number, number];

export interface SubdividedVertex {
  x: number;
  y: number;
  /** Barycentric coordinates in the source triangle. */
  weights: [number, number, number];
  /** Local source-vertex indices for the source triangle. */
  sourceIndices: [number, number, number];
}

export interface SubdividedTriangles {
  vertices: SubdividedVertex[];
  indices: number[];
}

export const NORTH_POLE_Y = -32768;
export const SOUTH_POLE_Y = 32767;

/**
 * MapLibre's globe projection uses a 128-cell fill mesh and a 512-cell line
 * mesh at z0, halving the cell count at each zoom. Cesium's 2D projection is
 * planar, so the extra vertices are unnecessary there.
 */
export function surfaceGranularity(
  kind: 'fill' | 'line' | 'extrusion',
  zoom: number,
  mode: number,
): number {
  // Cesium's morphing transform interpolates between the globe and the flat
  // representation. Keep the globe mesh during that transition so long
  // ECEF chords do not become visible while the standard Primitive performs
  // the mode conversion.
  if (mode !== SCENE3D && mode !== MORPHING) {
    return 1;
  }
  const base = kind === 'line' ? 512 : 128;
  const safeZoom = Math.max(0, Math.floor(Number.isFinite(zoom) ? zoom : 0));
  // At z14 a whole equatorial tile's diagonal sags only 0.24 m below the
  // ellipsoid; fills already sit at least 1 m above it. Split coarser fills
  // so their long ECEF chords do not sink into the globe.
  const minimum = kind === 'fill' && safeZoom < 14 ? 2 : 0;
  return Math.max(Math.floor(base / (2 ** safeZoom)), minimum, 1);
}

function samePoint(a: TilePoint, b: TilePoint): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function interpolate(a: SubdividedVertex, b: SubdividedVertex, t: number): SubdividedVertex {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    weights: [
      a.weights[0] + (b.weights[0] - a.weights[0]) * t,
      a.weights[1] + (b.weights[1] - a.weights[1]) * t,
      a.weights[2] + (b.weights[2] - a.weights[2]) * t,
    ],
    sourceIndices: a.sourceIndices,
  };
}

function clipPolygon(
  polygon: SubdividedVertex[],
  value: (point: SubdividedVertex) => number,
  boundary: number,
  keepGreater: boolean,
): SubdividedVertex[] {
  if (polygon.length === 0) {
    return polygon;
  }
  const result: SubdividedVertex[] = [];
  const inside = (point: SubdividedVertex): boolean => {
    const difference = value(point) - boundary;
    return keepGreater ? difference >= -1e-9 : difference <= 1e-9;
  };

  let previous = polygon[polygon.length - 1];
  let previousInside = inside(previous);
  for (const current of polygon) {
    const currentInside = inside(current);
    if (currentInside !== previousInside) {
      const previousValue = value(previous);
      const currentValue = value(current);
      const denominator = currentValue - previousValue;
      const t = Math.abs(denominator) < 1e-12
        ? 0
        : Math.max(0, Math.min(1, (boundary - previousValue) / denominator));
      result.push(interpolate(previous, current, t));
    }
    if (currentInside) {
      result.push(current);
    }
    previous = current;
    previousInside = currentInside;
  }
  return result;
}

function clipToCell(
  triangle: [SubdividedVertex, SubdividedVertex, SubdividedVertex],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): SubdividedVertex[] {
  let polygon = [...triangle];
  polygon = clipPolygon(polygon, point => point.x, minX, true);
  polygon = clipPolygon(polygon, point => point.x, maxX, false);
  polygon = clipPolygon(polygon, point => point.y, minY, true);
  polygon = clipPolygon(polygon, point => point.y, maxY, false);

  const compact: SubdividedVertex[] = [];
  for (const point of polygon) {
    const rounded: SubdividedVertex = {
      x: Math.round(point.x),
      y: Math.round(point.y),
      weights: point.weights,
      sourceIndices: point.sourceIndices,
    };
    if (!compact.length || !samePoint([compact[compact.length - 1].x, compact[compact.length - 1].y], [rounded.x, rounded.y])) {
      compact.push(rounded);
    }
  }
  if (compact.length > 1 && samePoint(
    [compact[0].x, compact[0].y],
    [compact[compact.length - 1].x, compact[compact.length - 1].y],
  )) {
    compact.pop();
  }
  return compact;
}

function signedArea(polygon: SubdividedVertex[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function separatedOnAxis(
  axisX: number,
  axisY: number,
  triangle: [SubdividedVertex, SubdividedVertex, SubdividedVertex],
  centerX: number,
  centerY: number,
  halfX: number,
  halfY: number,
): boolean {
  const first = triangle[0].x * axisX + triangle[0].y * axisY;
  const second = triangle[1].x * axisX + triangle[1].y * axisY;
  const third = triangle[2].x * axisX + triangle[2].y * axisY;
  const triangleMin = Math.min(first, second, third);
  const triangleMax = Math.max(first, second, third);
  const rectangleCenter = centerX * axisX + centerY * axisY;
  const rectangleRadius = halfX * Math.abs(axisX) + halfY * Math.abs(axisY);
  return triangleMax < rectangleCenter - rectangleRadius - 1e-9
    || triangleMin > rectangleCenter + rectangleRadius + 1e-9;
}

/**
 * Reject grid cells that cannot intersect a source triangle before invoking
 * the four-sided polygon clipper. This matters for long, thin tile triangles:
 * their bounding box can cover thousands of cells although only a small
 * fraction contains geometry. The separating-axis test is allocation-free and
 * preserves boundary-touching cells for exact clipping.
 */
function triangleIntersectsCell(
  triangle: [SubdividedVertex, SubdividedVertex, SubdividedVertex],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): boolean {
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const halfX = (maxX - minX) / 2;
  const halfY = (maxY - minY) / 2;
  if (separatedOnAxis(1, 0, triangle, centerX, centerY, halfX, halfY)
    || separatedOnAxis(0, 1, triangle, centerX, centerY, halfX, halfY)) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    const from = triangle[i];
    const to = triangle[(i + 1) % 3];
    const edgeX = to.x - from.x;
    const edgeY = to.y - from.y;
    if (separatedOnAxis(-edgeY, edgeX, triangle, centerX, centerY, halfX, halfY)) {
      return false;
    }
  }
  return true;
}

function vertexKey(point: SubdividedVertex): string {
  return `${point.x}:${point.y}`;
}

function edgePointAt(
  from: SubdividedVertex,
  to: SubdividedVertex,
  point: TilePoint,
): SubdividedVertex {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const t = Math.abs(dx) >= Math.abs(dy)
    ? (Math.abs(dx) < 1e-12 ? 0 : (point[0] - from.x) / dx)
    : (Math.abs(dy) < 1e-12 ? 0 : (point[1] - from.y) / dy);
  return interpolate(from, to, Math.max(0, Math.min(1, t)));
}

/**
 * Extrusion side faces are triangles in 3D but collapse to a line in tile
 * coordinates: two vertices often share x/y while their heights differ. A
 * polygon clipper quite correctly calls that triangle degenerate, but dropping
 * it would remove the entire wall. Split its longest tile-space edge instead,
 * preserving the triangle's 3D barycentric interpolation.
 */
function subdivideDegenerateTriangle(
  triangle: [SubdividedVertex, SubdividedVertex, SubdividedVertex],
  granularity: number,
  addVertex: (point: SubdividedVertex) => number,
  dropOutsideTileX: boolean,
): number[] {
  const edges: Array<[
    SubdividedVertex,
    SubdividedVertex,
    SubdividedVertex,
  ]> = [
    [triangle[0], triangle[1], triangle[2]],
    [triangle[1], triangle[2], triangle[0]],
    [triangle[2], triangle[0], triangle[1]],
  ];
  const edge = edges.reduce((longest, candidate) => {
    const currentLength = Math.hypot(candidate[1].x - candidate[0].x, candidate[1].y - candidate[0].y);
    const longestLength = Math.hypot(longest[1].x - longest[0].x, longest[1].y - longest[0].y);
    return currentLength > longestLength ? candidate : longest;
  });
  const line = subdivideVertexLine(
    [[edge[0].x, edge[0].y], [edge[1].x, edge[1].y]],
    granularity,
  );
  const result: number[] = [];
  const opposite = edge[2];
  for (let i = 1; i < line.length; i++) {
    const from = edgePointAt(edge[0], edge[1], line[i - 1]);
    const to = edgePointAt(edge[0], edge[1], line[i]);
    if (dropOutsideTileX && [from, to, opposite].some(point => point.x < 0 || point.x > EXTENT)) {
      continue;
    }
    result.push(addVertex(from), addVertex(to), addVertex(opposite));
  }
  return result;
}

/**
 * Cut each source triangle by the same axis-aligned grid used by MapLibre's
 * scanline subdivider. Clipping each triangle to grid cells avoids the
 * unordered vertex reconstruction that was previously used for lines and
 * shares all fill vertices on a grid boundary.
 */
export function subdivideTriangles(
  points: TilePoint[],
  triangles: number[],
  granularity: number,
  options: {
    shareVertices?: boolean;
    dropOutsideTileX?: boolean;
    clipToTile?: boolean;
    northPole?: boolean;
    southPole?: boolean;
  } = {},
): SubdividedTriangles {
  const shareVertices = options.shareVertices ?? true;
  const dropOutsideTileX = options.dropOutsideTileX ?? false;
  const clipToTile = options.clipToTile ?? false;
  const vertices: SubdividedVertex[] = [];
  const indices: number[] = [];
  const dictionary = shareVertices ? new Map<string, number>() : undefined;
  const cellSize = EXTENT / Math.max(1, granularity);

  const addVertex = (point: SubdividedVertex): number => {
    if (!dictionary) {
      const index = vertices.length;
      vertices.push(point);
      return index;
    }
    const key = vertexKey(point);
    const existing = dictionary.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const index = vertices.length;
    vertices.push(point);
    dictionary.set(key, index);
    return index;
  };

  for (let triangleOffset = 0; triangleOffset + 2 < triangles.length; triangleOffset += 3) {
    const aIndex = triangles[triangleOffset];
    const bIndex = triangles[triangleOffset + 1];
    const cIndex = triangles[triangleOffset + 2];
    const a = points[aIndex];
    const b = points[bIndex];
    const c = points[cIndex];
    if (!a || !b || !c) {
      continue;
    }

    const normalizePoleCoordinate = (value: number): number => value === NORTH_POLE_Y
      ? NORTH_POLE_Y + 1
      : value === SOUTH_POLE_Y ? SOUTH_POLE_Y - 1 : value;
    const source: [SubdividedVertex, SubdividedVertex, SubdividedVertex] = [
      { x: a[0], y: normalizePoleCoordinate(a[1]), weights: [1, 0, 0], sourceIndices: [aIndex, bIndex, cIndex] },
      { x: b[0], y: normalizePoleCoordinate(b[1]), weights: [0, 1, 0], sourceIndices: [aIndex, bIndex, cIndex] },
      { x: c[0], y: normalizePoleCoordinate(c[1]), weights: [0, 0, 1], sourceIndices: [aIndex, bIndex, cIndex] },
    ];
    const minX = Math.min(a[0], b[0], c[0]);
    const maxX = Math.max(a[0], b[0], c[0]);
    const minY = Math.min(a[1], b[1], c[1]);
    const maxY = Math.max(a[1], b[1], c[1]);
    const sourceSign = signedArea(source);
    if (Math.abs(sourceSign) < 1e-9) {
      // Flat fill triangles cover no tile area. Extrusion walls use the
      // separate, unclipped path below because their tile-space area is zero.
      if (clipToTile) {
        continue;
      }
      indices.push(...subdivideDegenerateTriangle(source, granularity, addVertex, dropOutsideTileX));
      continue;
    }

    const cellXMin = Math.floor(minX / cellSize);
    const cellXMax = Math.ceil(maxX / cellSize);
    const cellYMin = Math.floor(minY / cellSize);
    const cellYMax = Math.ceil(maxY / cellSize);
    const xStart = clipToTile ? Math.max(0, cellXMin) : cellXMin;
    const xEnd = granularity < 2
      ? clipToTile ? 1 : cellXMin + 1
      : clipToTile ? Math.min(granularity, cellXMax) : cellXMax;
    const yStart = clipToTile ? Math.max(0, cellYMin) : cellYMin;
    const yEnd = granularity < 2
      ? clipToTile ? 1 : cellYMin + 1
      : clipToTile ? Math.min(granularity, cellYMax) : cellYMax;

    for (let cellY = yStart; cellY < yEnd; cellY++) {
      for (let cellX = xStart; cellX < xEnd; cellX++) {
        const cellMinX = cellX * cellSize;
        const cellMaxX = (cellX + 1) * cellSize;
        const cellMinY = cellY * cellSize;
        const cellMaxY = (cellY + 1) * cellSize;
        if (granularity >= 2 && !triangleIntersectsCell(source, cellMinX, cellMaxX, cellMinY, cellMaxY)) {
          continue;
        }
        const clipped = granularity < 2 && !clipToTile
          ? source
          : clipToCell(source, cellMinX, cellMaxX, cellMinY, cellMaxY);
        if (clipped.length < 3 || Math.abs(signedArea(clipped)) < 1e-9) {
          continue;
        }
        if (dropOutsideTileX && clipped.some(point => point.x < 0 || point.x > EXTENT)) {
          continue;
        }

        const polygon = signedArea(clipped) * sourceSign < 0 ? [...clipped].reverse() : clipped;
        const first = addVertex(polygon[0]);
        for (let i = 1; i + 1 < polygon.length; i++) {
          indices.push(first, addVertex(polygon[i]), addVertex(polygon[i + 1]));
        }
      }
    }
  }

  // Mercator tiles stop at roughly +/-85 degrees, while the globe projection
  // continues to the poles. MapLibre adds a pair of quads for every subdivided
  // edge on the north/south tile boundary. Do the same after clipping so the
  // pole vertex carries the edge's barycentric height/feature data as well.
  if (granularity >= 2 && (options.northPole || options.southPole)) {
    const generatedTriangleCount = indices.length;
    const addPoleVertex = (point: SubdividedVertex, poleY: number): number => addVertex({
      x: point.x,
      y: poleY,
      weights: point.weights,
      sourceIndices: point.sourceIndices,
    });
    const addPoleQuad = (
      firstIndex: number,
      secondIndex: number,
      first: SubdividedVertex,
      second: SubdividedVertex,
      poleY: number,
    ): void => {
      if (dropOutsideTileX
        && (first.x < 0 || first.x > EXTENT || second.x < 0 || second.x > EXTENT)) {
        return;
      }
      const firstPole = addPoleVertex(first, poleY);
      const secondPole = addPoleVertex(second, poleY);
      const flip = (first.x > second.x) !== (poleY === NORTH_POLE_Y);
      if (flip) {
        indices.push(firstIndex, secondIndex, firstPole, secondIndex, secondPole, firstPole);
      }
      else {
        indices.push(secondIndex, firstIndex, firstPole, secondPole, secondIndex, firstPole);
      }
    };

    for (let triangleOffset = 0; triangleOffset < generatedTriangleCount; triangleOffset += 3) {
      const firstIndex = indices[triangleOffset];
      const secondIndex = indices[triangleOffset + 1];
      const thirdIndex = indices[triangleOffset + 2];
      const first = vertices[firstIndex];
      const second = vertices[secondIndex];
      const third = vertices[thirdIndex];
      if (!first || !second || !third) {
        continue;
      }
      if (options.northPole) {
        if (first.y === 0 && second.y === 0)
          addPoleQuad(firstIndex, secondIndex, first, second, NORTH_POLE_Y);
        if (second.y === 0 && third.y === 0)
          addPoleQuad(secondIndex, thirdIndex, second, third, NORTH_POLE_Y);
        if (third.y === 0 && first.y === 0)
          addPoleQuad(thirdIndex, firstIndex, third, first, NORTH_POLE_Y);
      }
      if (options.southPole) {
        if (first.y === EXTENT && second.y === EXTENT)
          addPoleQuad(firstIndex, secondIndex, first, second, SOUTH_POLE_Y);
        if (second.y === EXTENT && third.y === EXTENT)
          addPoleQuad(secondIndex, thirdIndex, second, third, SOUTH_POLE_Y);
        if (third.y === EXTENT && first.y === EXTENT)
          addPoleQuad(thirdIndex, firstIndex, third, first, SOUTH_POLE_Y);
      }
    }
  }

  return { vertices, indices };
}

/**
 * Exact grid-axis line subdivision adapted from MapLibre's
 * `subdivideVertexLine`. `granularity` is the number of cells across a tile.
 */
export function subdivideVertexLine(
  linePoints: TilePoint[],
  granularity: number,
  isRing = false,
): TilePoint[] {
  if (linePoints.length < 2) {
    return [];
  }
  // A malformed worker payload must not enter the boundary walk below:
  // comparisons involving NaN are always false and would otherwise leave
  // the subdivision loop advancing forever with NaN coordinates.
  if (linePoints.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    return [];
  }
  const first = linePoints[0];
  const last = linePoints[linePoints.length - 1];
  const addLastToFirstSegment = isRing && !samePoint(first, last);
  if (granularity < 2) {
    return addLastToFirstSegment ? [...linePoints, first] : [...linePoints];
  }

  const result: TilePoint[] = [[first[0], first[1]]];
  const totalPoints = linePoints.length;
  const lastIndex = addLastToFirstSegment ? totalPoints : totalPoints - 1;
  for (let pointIndex = 0; pointIndex < lastIndex; pointIndex++) {
    const point0 = linePoints[pointIndex];
    const point1 = pointIndex < totalPoints - 1 ? linePoints[pointIndex + 1] : first;
    visitSubdividedLineSegment(point0[0], point0[1], point1[0], point1[1], granularity, (x, y) => result.push([x, y]));
  }
  return result;
}

/** Visit grid intersections and the endpoint, excluding the segment's start. */
export function visitSubdividedLineSegment(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  granularity: number,
  visit?: (x: number, y: number) => void,
): number {
  const dirX = endX - startX;
  const dirY = endY - startY;
  const nonZeroX = dirX !== 0;
  const nonZeroY = dirY !== 0;
  if (!nonZeroX && !nonZeroY)
    return 0;
  if (granularity < 2) {
    visit?.(endX, endY);
    return 1;
  }

  const cellSize = Math.floor(EXTENT / granularity);
  const absX = Math.abs(dirX);
  const absY = Math.abs(dirY);
  let currentX = startX;
  let currentY = startY;
  let previousX = startX;
  let previousY = startY;
  let count = 0;
  const emit = (x: number, y: number): void => {
    if (previousX === x && previousY === y)
      return;
    previousX = x;
    previousY = y;
    count++;
    visit?.(x, y);
  };
  while (true) {
    const nextBoundaryX = dirX > 0
      ? (Math.floor(currentX / cellSize) + 1) * cellSize
      : (Math.ceil(currentX / cellSize) - 1) * cellSize;
    const nextBoundaryY = dirY > 0
      ? (Math.floor(currentY / cellSize) + 1) * cellSize
      : (Math.ceil(currentY / cellSize) - 1) * cellSize;
    const distanceBoundaryX = Math.abs(currentX - nextBoundaryX);
    const distanceBoundaryY = Math.abs(currentY - nextBoundaryY);
    const distanceEndX = Math.abs(currentX - endX);
    const distanceEndY = Math.abs(currentY - endY);
    const realBoundaryX = nonZeroX ? distanceBoundaryX / absX : Infinity;
    const realBoundaryY = nonZeroY ? distanceBoundaryY / absY : Infinity;
    if ((distanceEndX <= distanceBoundaryX || !nonZeroX)
      && (distanceEndY <= distanceBoundaryY || !nonZeroY)) {
      break;
    }

    if ((realBoundaryX < realBoundaryY && nonZeroX) || !nonZeroY) {
      currentX = nextBoundaryX;
      currentY += dirY * realBoundaryX;
      emit(currentX, Math.round(currentY));
    }
    else {
      currentX += dirX * realBoundaryY;
      currentY = nextBoundaryY;
      emit(Math.round(currentX), currentY);
    }
  }
  emit(endX, endY);
  return count;
}
