import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { DashAtlasRow } from './dash-material';
import { Cartesian3, Cartographic, ComponentDatatype, Ellipsoid, Geometry, GeometryAttribute, IndexDatatype, PrimitiveType, WebMercatorProjection } from 'cesium';
import { geometryBoundingSphere } from '../geometry/geometry-bounds';
import { lineInputs } from '../geometry/line-input';
import { tileLocalToMercatorFraction } from '../geometry/tile-to-ecef';
import { LINE_CORNER_ANCHOR, LINE_CORNER_BUTT_NEXT, LINE_CORNER_BUTT_PREV, LINE_CORNER_JOIN_FAN, LINE_CORNER_REGULAR, LINE_CORNER_ROUND_BOTH_ENDS, LINE_CORNER_ROUND_CAP, LINE_CORNER_ROUND_END, LINE_CORNER_SQUARE, LINE_FAN_PARAMETERS, MAX_FAN_VERTICES } from './line-vertex-format';

export interface LineGeometrySource {
  /** Packed ECEF centreline and its paired canonical tile coordinates. */
  positions: Float64Array;
  tilePositions: Float64Array;
}

export interface LineGeometryOptions {
  join: string;
  cap: string;
  miterLimit: number;
  roundLimit: number;
  /** CSS width chooses round-join fan detail; strip positions stay unit width. */
  widthPx: number;
  dashFrom?: DashAtlasRow;
  dashTo?: DashAtlasRow;
}

const MIN_SEGMENT_LENGTH_METERS = 1e-8;
const DEG_PER_TRIANGLE = 20;
const MAX_FAN_ERROR_PX = 0.15;
// Amortize deadline checks without making a complete path the work unit.
// The renderer keeps consuming these quanta until its wall-clock budget ends.
const POINT_QUANTUM = 32;
// Cesium exports this helper at runtime, but its enum declaration omits it.
const createIndices = (IndexDatatype as typeof IndexDatatype & {
  createTypedArray: (vertices: number, length: number) => Uint16Array | Uint32Array;
}).createTypedArray;

function roundFanSegments(widthPx: number): number {
  const radius = widthPx * 0.5;
  const maximumStep = 2 * Math.acos(1 - Math.min(1, MAX_FAN_ERROR_PX / radius));
  return Math.min(MAX_FAN_VERTICES, Math.max(2, Math.ceil(Math.PI / maximumStep)));
}

/** Geometry sharing and paint reuse must use the same fan and atlas layout. */
export function lineLayoutKey(options: LineGeometryOptions): string {
  const { dashFrom, dashTo } = options;
  const dashKey = dashFrom && dashTo
    ? `d${dashFrom.y},${dashFrom.height},${dashFrom.width}|${dashTo.y},${dashTo.height},${dashTo.width}`
    : 's';
  const fanSegments = options.join === 'round' ? roundFanSegments(options.widthPx) : 0;
  return `${options.join}|${options.cap}|${options.miterLimit}|${options.roundLimit}|${fanSegments}|${dashKey}`;
}

/** Shares Geometry only within one publication build; source arrays stay immutable. */
export class LineGeometryCache {
  private readonly _geometries = new WeakMap<Float64Array, WeakMap<Float64Array, Map<string, Geometry>>>();
  private readonly _tileID: CanonicalTileID;

  constructor(tileID: CanonicalTileID | OverscaledTileID) {
    this._tileID = 'canonical' in tileID ? tileID.canonical : tileID;
  }

  geometry(source: LineGeometrySource, options: LineGeometryOptions, planar = false): Geometry | undefined {
    const iterator = this.compile(source, options, planar);
    let result = iterator.next();
    while (!result.done) result = iterator.next();
    return result.value;
  }

  /** Only completed geometry enters the cache; abandoned iterators own no entry. */
  * compile(source: LineGeometrySource, options: LineGeometryOptions, planar = false): Generator<void, Geometry | undefined> {
    const key = `${lineLayoutKey(options)}|${planar ? 'planar' : '3d'}`;
    let coordinates = this._geometries.get(source.positions);
    let layouts = coordinates?.get(source.tilePositions);
    let geometry = layouts?.get(key);
    if (!geometry) {
      geometry = yield* compileLineGeometry(source.positions, options, planar, {
        tileID: this._tileID,
        tilePositions: source.tilePositions,
      });
      if (!geometry)
        return undefined;
      layouts ??= new Map();
      layouts.set(key, geometry);
      coordinates ??= new WeakMap();
      coordinates.set(source.tilePositions, layouts);
      this._geometries.set(source.positions, coordinates);
    }
    return geometry;
  }
}

/**
 * Build Cesium Geometry directly from packed centres. Final byte roles and
 * indices are emitted together in strip order, including the provoking
 * vertex rotation at a round end. Spatial geometry retains DOUBLE centres;
 * planar geometry keeps its source centreline until GeometryPrimitive knows
 * the actual scene projection. Both retain Native ECEF bounds.
 */
export function createLineGeometry(
  positions: Float64Array,
  options: LineGeometryOptions,
  planar = false,
  source?: { tileID: CanonicalTileID; tilePositions: Float64Array },
): Geometry | undefined {
  const iterator = compileLineGeometry(positions, options, planar, source);
  let result = iterator.next();
  while (!result.done) result = iterator.next();
  return result.value;
}

/** One compiler shared by synchronous callers and budgeted publication. */
export function* compileLineGeometry(
  positions: Float64Array,
  options: LineGeometryOptions,
  planar = false,
  source?: { tileID: CanonicalTileID; tilePositions: Float64Array },
): Generator<void, Geometry | undefined> {
  if (planar && !source)
    throw new TypeError('planar line geometry requires source coordinates');
  const { join, cap, roundLimit } = options;
  const sourceCount = positions.length / 3;
  const resumable = sourceCount > POINT_QUANTUM;
  if (source && source.tilePositions.length !== sourceCount * 2)
    throw new TypeError('line source coordinates must match its ECEF point count');
  let retained: Uint32Array | undefined;
  const point = new Cartesian3();
  const previous = new Cartesian3();
  let n = 0;
  for (let index = 0; index < sourceCount; index++) {
    Cartesian3.unpack(positions as unknown as number[], index * 3, point);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z))
      return undefined;
    const prior = retained ? retained[n - 1] : n - 1;
    if (n && (source && planar
      ? source.tilePositions[prior * 2] === source.tilePositions[index * 2]
      && source.tilePositions[prior * 2 + 1] === source.tilePositions[index * 2 + 1]
      : Cartesian3.distanceSquared(previous, point) < MIN_SEGMENT_LENGTH_METERS * MIN_SEGMENT_LENGTH_METERS)) {
      if (!retained) {
        retained = new Uint32Array(sourceCount);
        for (let retainedIndex = 0; retainedIndex < n; retainedIndex++) {
          retained[retainedIndex] = retainedIndex;
          if (resumable && (retainedIndex + 1) % POINT_QUANTUM === 0)
            yield;
        }
      }
      if (resumable && (index + 1) % POINT_QUANTUM === 0)
        yield;
      continue;
    }
    if (retained)
      retained[n] = index;
    n++;
    Cartesian3.clone(point, previous);
    if (resumable && (index + 1) % POINT_QUANTUM === 0)
      yield;
  }
  if (resumable)
    yield;
  const last = retained ? retained[n - 1] : n - 1;
  const closed = n > 3 && (source
    ? source.tilePositions[0] === source.tilePositions[last * 2]
    && source.tilePositions[1] === source.tilePositions[last * 2 + 1]
    : Cartesian3.equalsEpsilon(Cartesian3.unpack(positions as unknown as number[], 0, point), previous, 0, 1e-9));
  if (closed)
    n--;
  if (n < 2)
    return undefined;

  const resumableCentres = n > POINT_QUANTUM;
  // Contiguous source points share their existing backing. Filtering internal
  // duplicates owns only the surviving packed centres, without JS point arrays.
  const contiguous = !retained || retained[n - 1] === n - 1;
  const centres = contiguous
    ? n === sourceCount ? positions : positions.subarray(0, n * 3)
    : new Float64Array(n * 3);
  if (!contiguous) {
    for (let j = 0; j < n; j++) {
      const input = retained![j] * 3;
      centres[j * 3] = positions[input];
      centres[j * 3 + 1] = positions[input + 1];
      centres[j * 3 + 2] = positions[input + 2];
      if (resumableCentres && (j + 1) % POINT_QUANTUM === 0)
        yield;
    }
  }
  if (resumableCentres)
    yield;
  const planarSource = planar && source;
  const longitudes = source ? new Float64Array(n) : undefined;
  const dashed = options.dashFrom !== undefined && options.dashTo !== undefined;
  const linesofar = dashed ? new Float64Array(n) : undefined;
  let perimeter = 0;
  if (linesofar || longitudes) {
    const projection = source ? undefined : new WebMercatorProjection();
    const circumference = source ? 1 : 2 * Math.PI * projection!.ellipsoid.maximumRadius;
    const cartographic = new Cartographic();
    const projected = new Cartesian3();
    let firstX = 0;
    let firstY = 0;
    let previousX = 0;
    let previousY = 0;
    const distance = (x: number, y: number, nextX: number, nextY: number): number => {
      const delta = x - nextX;
      const dx = source ? delta : delta - circumference * Math.round(delta / circumference);
      return Math.hypot(dx, y - nextY) / circumference;
    };
    for (let j = 0; j < n; j++) {
      let x: number, y: number;
      if (source) {
        const index = (retained ? retained[j] : j) * 2;
        const coordinate = tileLocalToMercatorFraction(source.tileID, source.tilePositions[index], source.tilePositions[index + 1]);
        x = coordinate.x;
        y = coordinate.y;
      }
      else {
        Cartesian3.unpack(centres as unknown as number[], j * 3, point);
        projection!.project(Ellipsoid.WGS84.cartesianToCartographic(point, cartographic)!, projected);
        x = projected.x;
        y = projected.y;
      }
      if (longitudes)
        longitudes[j] = (x - 0.5) * 2 * Math.PI;
      if (linesofar && j > 0)
        linesofar[j] = linesofar[j - 1] + distance(previousX, previousY, x, y);
      if (j === 0) {
        firstX = x;
        firstY = y;
      }
      previousX = x;
      previousY = y;
      if (resumableCentres && (j + 1) % POINT_QUANTUM === 0)
        yield;
    }
    if (linesofar && closed)
      perimeter = linesofar[n - 1] + distance(previousX, previousY, firstX, firstY);
  }
  if (resumableCentres)
    yield;

  const fanCounts = join === 'round' ? new Int16Array(n) : undefined;
  const fanSides = join === 'round' ? new Int8Array(n) : undefined;
  const joinFanCount = join === 'round' ? roundFanSegments(options.widthPx) : 0;
  let vertexCount = closed ? 4 * n : 4 * n - 4;
  let indexCount = 6 * (closed ? n : n - 1);
  if (join === 'round') {
    const incoming = new Cartesian3();
    const outgoing = new Cartesian3();
    const cross = new Cartesian3();
    for (let j = closed ? 0 : 1; j < (closed ? n : n - 1); j++) {
      const prior = (j + n - 1) % n;
      const following = (j + 1) % n;
      if (planarSource) {
        const current = (retained ? retained[j] : j) * 2;
        const prev = (retained ? retained[prior] : prior) * 2;
        const next = (retained ? retained[following] : following) * 2;
        const coordinates = planarSource.tilePositions;
        incoming.x = coordinates[current] - coordinates[prev];
        incoming.y = -coordinates[current + 1] - (-coordinates[prev + 1]);
        incoming.z = 0;
        outgoing.x = coordinates[next] - coordinates[current];
        outgoing.y = -coordinates[next + 1] - (-coordinates[current + 1]);
        outgoing.z = 0;
      }
      else {
        Cartesian3.unpack(centres as unknown as number[], j * 3, point);
        Cartesian3.unpack(centres as unknown as number[], prior * 3, previous);
        Cartesian3.subtract(point, previous, incoming);
        Cartesian3.unpack(centres as unknown as number[], following * 3, previous);
        Cartesian3.subtract(previous, point, outgoing);
      }
      Cartesian3.normalize(incoming, incoming);
      Cartesian3.normalize(outgoing, outgoing);
      const turnAngle = Cartesian3.angleBetween(incoming, outgoing);
      const cosHalf = Math.cos(turnAngle / 2);
      const miterLength = cosHalf > 1e-9 ? 1 / cosHalf : Infinity;
      if (miterLength >= roundLimit) {
        const approxAngle = 2 * Math.sqrt(2 - 2 * Math.max(-1, Math.min(1, cosHalf)));
        const mapLibreCount = Math.max(1, Math.round(approxAngle * 180 / Math.PI / DEG_PER_TRIANGLE));
        const segments = Math.max(1, Math.ceil(turnAngle * joinFanCount / Math.PI));
        const detailCount = segments === 1 ? 1 : segments + 1;
        const count = fanCounts![j] = Math.min(MAX_FAN_VERTICES, mapLibreCount, detailCount);
        Cartesian3.cross(incoming, outgoing, cross);
        const turn = planarSource ? cross.z : Cartesian3.dot(cross, point);
        fanSides![j] = turn > 0 ? -1 : 1;
        vertexCount += count + 1;
        indexCount += 3 * (count + 3);
      }
      if (resumableCentres && (j + 1) % POINT_QUANTUM === 0)
        yield;
    }
  }
  if (!closed && (cap === 'round' || cap === 'square')) {
    vertexCount += 4;
    indexCount += 12;
  }
  if (resumableCentres)
    yield;

  const expanded = new Float64Array(vertexCount * 3);
  const flags = new Uint8Array(vertexCount);
  const lineDistances = dashed ? new Float32Array(vertexCount) : undefined;
  const dashFrom = dashed ? new Float32Array(vertexCount * 3) : undefined;
  const dashTo = dashed ? new Float32Array(vertexCount * 3) : undefined;
  const indices = createIndices(vertexCount, indexCount);
  const sourceVertices = new Uint32Array(vertexCount);
  let vertex = 0;
  let index = 0;
  const emit = (j: number, side: number, usePrev: boolean, corner: number, parameter = 0, distance = linesofar?.[j] ?? 0): number => {
    const result = vertex++;
    expanded[result * 3] = centres[j * 3];
    expanded[result * 3 + 1] = centres[j * 3 + 1];
    expanded[result * 3 + 2] = centres[j * 3 + 2];
    sourceVertices[result] = j;
    let role = corner;
    if (corner === LINE_CORNER_JOIN_FAN) {
      const fanParameter = LINE_FAN_PARAMETERS.indexOf(Math.fround(parameter) as (typeof LINE_FAN_PARAMETERS)[number]);
      if (fanParameter < 0)
        throw new RangeError('line fan parameter is outside the exact nine-vertex format');
      role = 7 + fanParameter;
    }
    flags[result] = (side + 1) | (usePrev ? 4 : 0) | (role << 3);
    if (dashFrom && dashTo && lineDistances) {
      lineDistances[result] = distance;
      dashFrom[result * 3] = options.dashFrom!.y;
      dashFrom[result * 3 + 1] = options.dashFrom!.height;
      dashFrom[result * 3 + 2] = options.dashFrom!.width;
      dashTo[result * 3] = options.dashTo!.y;
      dashTo[result * 3 + 1] = options.dashTo!.height;
      dashTo[result * 3 + 2] = options.dashTo!.width;
    }
    return result;
  };
  const triangle = (a: number, b: number, c: number): void => {
    indices[index++] = a;
    indices[index++] = b;
    indices[index++] = c;
  };
  let previousL = -1;
  let previousR = -1;
  let firstL = -1;
  let firstR = -1;
  for (let j = 0; j < n; j++) {
    let prevL = -1;
    let prevR = -1;
    let nextL = -1;
    let nextR = -1;
    let fanStart = -1;
    let fanEnd = -1;
    let anchor = -1;
    let capL = -1;
    let capR = -1;
    const prevDistance = closed && j === 0 ? perimeter : linesofar?.[j] ?? 0;
    if (j === 0 && !closed && (cap === 'round' || cap === 'square')) {
      const corner = cap === 'round' ? LINE_CORNER_ROUND_CAP : LINE_CORNER_SQUARE;
      capL = emit(j, 1, false, corner, -1);
      capR = emit(j, -1, false, corner, -1);
    }
    const nFan = fanCounts?.[j] ?? 0;
    if (nFan > 0) {
      prevL = emit(j, 1, true, LINE_CORNER_BUTT_PREV, 0, prevDistance);
      prevR = emit(j, -1, true, LINE_CORNER_BUTT_PREV, 0, prevDistance);
      fanStart = vertex;
      for (let f = 0; f < nFan; f++) emit(j, fanSides![j], false, LINE_CORNER_JOIN_FAN, f / Math.max(1, nFan - 1));
      fanEnd = vertex - 1;
      nextL = emit(j, 1, false, LINE_CORNER_BUTT_NEXT);
      nextR = emit(j, -1, false, LINE_CORNER_BUTT_NEXT);
      anchor = emit(j, 0, false, LINE_CORNER_ANCHOR);
    }
    else {
      const emitPrev = closed || j > 0;
      const emitNext = closed || j < n - 1;
      const corner = !closed && cap === 'round' && (j === 0 || j === n - 1)
        ? n === 2 ? LINE_CORNER_ROUND_BOTH_ENDS : LINE_CORNER_ROUND_END
        : LINE_CORNER_REGULAR;
      if (emitPrev) {
        prevL = emit(j, 1, true, corner, 0, prevDistance);
        prevR = emit(j, -1, true, corner, 0, prevDistance);
      }
      if (emitNext) {
        nextL = emit(j, 1, false, corner);
        nextR = emit(j, -1, false, corner);
      }
    }
    if (j === n - 1 && !closed && (cap === 'round' || cap === 'square')) {
      const corner = cap === 'round' ? LINE_CORNER_ROUND_CAP : LINE_CORNER_SQUARE;
      capL = emit(j, 1, true, corner, 1);
      capR = emit(j, -1, true, corner, 1);
    }

    if (j > 0) {
      if (!closed && cap === 'round' && j === n - 1) {
        triangle(previousR, previousL, prevL);
        triangle(previousR, prevL, prevR);
      }
      else {
        triangle(previousL, prevL, previousR);
        triangle(prevL, prevR, previousR);
      }
    }
    if (fanStart >= 0) {
      const prevOuter = fanSides![j] > 0 ? prevL : prevR;
      const nextOuter = fanSides![j] > 0 ? nextL : nextR;
      triangle(prevL, prevR, anchor);
      triangle(prevOuter, fanStart, anchor);
      for (let f = fanStart; f < fanEnd; f++) triangle(f, f + 1, anchor);
      triangle(fanEnd, nextOuter, anchor);
      triangle(nextL, nextR, anchor);
    }
    if (capL >= 0) {
      const left = j === 0 ? nextL : prevL;
      const right = j === 0 ? nextR : prevR;
      triangle(left, capL, right);
      triangle(capL, capR, right);
    }
    if (j === 0) {
      firstL = prevL;
      firstR = prevR;
    }
    previousL = nextL;
    previousR = nextR;
    if (resumableCentres && (j + 1) % POINT_QUANTUM === 0)
      yield;
  }
  if (closed) {
    triangle(previousL, firstL, previousR);
    triangle(firstL, firstR, previousR);
  }
  if (resumableCentres)
    yield;

  const attributes: Record<string, GeometryAttribute> = {};
  attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: expanded });
  attributes.a_lineFlags = new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 1, values: flags });
  if (dashFrom && dashTo) {
    attributes.a_linesofar = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: lineDistances });
    attributes.a_dashFrom = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: dashFrom });
    attributes.a_dashTo = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: dashTo });
  }
  const geometry = new Geometry({
    // Native accepts custom attributes; its declaration requires unused normals.
    attributes: attributes as unknown as Geometry['attributes'],
    indices: indices as never,
    primitiveType: PrimitiveType.TRIANGLES,
    // Every strip role repeats a retained world-space centre.
    boundingSphere: yield* geometryBoundingSphere(centres),
  });
  lineInputs.set(geometry, {
    positions: centres,
    vertices: sourceVertices,
    closed,
    ...(longitudes ? { longitudes } : {}),
  });
  return geometry;
}

/** Cesium's Ritter/box sphere scan, with local scratch and bounded point quanta. */
