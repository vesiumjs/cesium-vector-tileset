import type { CanonicalTileID } from '../../packages/cesium-vector-tileset/src/tile/tile-id';
import { BoundingSphere, Cartesian3, Ellipsoid, WebMercatorProjection } from 'cesium';

// Independent E2E oracle frozen before topology compaction. Do not import
// production bake or shader generators here: that would mask shared defects.
// Source SHA256: 49c222462d62cc7d99d958a9e7ec5dd876ab5d95b28d22bf42a2591ad7517dac
interface ReferenceSource { positions: Float64Array; longitudes: Float64Array; vertices: Uint32Array; closed: boolean }
interface DashAtlasRow { y: number; height: number; width: number }
function tileLocalToMercatorFraction(tile: CanonicalTileID, x: number, y: number) {
  return { x: (tile.x + x / 8192) / 2 ** tile.z, y: (tile.y + y / 8192) / 2 ** tile.z };
}
const LINE_CORNER_REGULAR = 0;
const LINE_CORNER_BUTT_PREV = 1;
const LINE_CORNER_BUTT_NEXT = 2;
const LINE_CORNER_JOIN_FAN = 3;
const LINE_CORNER_ROUND_CAP = 4;
const LINE_CORNER_SQUARE = 5;
const LINE_CORNER_ANCHOR = 6;
// The two unused byte roles identify regular endpoint pairs, which provide
// flat cap coordinates to the cap quad and its adjacent strip segment.
const LINE_CORNER_ROUND_END = 30;
const LINE_CORNER_ROUND_BOTH_ENDS = 31;
const MAX_FAN_VERTICES = 9;

const DEG_PER_TRIANGLE = 20;
const MAX_FAN_ERROR_PX = 0.15;

/** Choose up to nine fan slices for a 0.15 CSS px arc approximation. */
function roundFanSegments(widthPx: number): number {
  const radius = widthPx * 0.5;
  const maximumStep = 2 * Math.acos(1 - Math.min(1, MAX_FAN_ERROR_PX / radius));
  return Math.min(MAX_FAN_VERTICES, Math.max(2, Math.ceil(Math.PI / maximumStep)));
}

export interface LineStripBakeOptions {
  join: string;
  cap: string;
  miterLimit: number;
  roundLimit: number;
  /** CSS line width used to choose round cap/join detail. */
  widthPx: number;
  /** Dash atlas rows; when both are present the vertices carry dash attributes. */
  dashFrom?: DashAtlasRow;
  dashTo?: DashAtlasRow;
}

function effectiveLineMiterLimit(options: LineStripBakeOptions): number {
  return options.join === 'bevel' ? 1.05 : options.miterLimit;
}

export interface ReferenceLineBake {
  positions: Float64Array;
  /** Source-backed planar bakes map expanded vertices to real source points. */
  projection?: ReferenceSource;
  /** Retained only for 3D bakes; avoids four absolute high/low attributes. */
  prevOffsets?: Float32Array;
  nextOffsets?: Float32Array;
  /** expandAndWidth with the width slot at unit width (±1). */
  expandAndWidthUnit: Float32Array;
  corners: Float32Array;
  cornerParams: Float32Array;
  lineDistances?: Float32Array;
  dashFrom?: Float32Array;
  dashTo?: Float32Array;
  indices: Uint16Array | Uint32Array;
  boundingSphere: BoundingSphere;
}

const MIN_SEGMENT_LENGTH_METERS = 1e-8;

export function bakeReferenceLine(
  positions: Cartesian3[],
  options: LineStripBakeOptions,
  planar = false,
  source?: { tileID: CanonicalTileID; tilePositions: Float64Array },
): ReferenceLineBake | undefined {
  if (planar && !source)
    throw new TypeError('planar line bake requires source coordinates');
  const { join, cap, roundLimit } = options;
  const joinFanCount = join === 'round' ? roundFanSegments(options.widthPx) : 0;
  // MapLibre clamps a miter join to `line-miter-limit` line widths and
  // hard-codes 1.05 for bevel joins (line_bucket.addLine). The construction
  // parameter preserves the raw FLOAT bake; the production geometry packs
  // fan/cap roles into one byte and keeps this limit in the instance table.
  const effectiveMiterLimit = effectiveLineMiterLimit(options);
  // Sanitize the centerline first: drop consecutive duplicates (zero-length
  // legs) and refuse non-finite coordinates. A corrupt point poisons every
  // downstream computation, so the strip is dropped whole — reconnecting
  // across the gap would streak across the map, while a missing feature is
  // a tile-local gap. Callers treat undefined as "skip this feature".
  const clean: Cartesian3[] = [];
  const coordinates: number[] = [];
  if (source && source.tilePositions.length !== positions.length * 2)
    throw new TypeError('line source coordinates must match its ECEF point count');
  for (let index = 0; index < positions.length; index++) {
    const point = positions[index];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
      return undefined;
    }
    const previous = clean[clean.length - 1];
    const x = source?.tilePositions[index * 2];
    const y = source?.tilePositions[index * 2 + 1];
    if (previous && (source && planar
      ? coordinates[coordinates.length - 2] === x && coordinates[coordinates.length - 1] === y
      : Cartesian3.distanceSquared(previous, point) < MIN_SEGMENT_LENGTH_METERS * MIN_SEGMENT_LENGTH_METERS)) {
      continue;
    }
    clean.push(point);
    if (source)
      coordinates.push(x!, y!);
  }
  const dashed = options.dashFrom !== undefined && options.dashTo !== undefined;
  // A closed ring repeats its first point at the end. Drop the duplicate and
  // treat the remaining vertices as a cycle: the ring then has no endpoints,
  // every vertex - the seam included - is an ordinary interior join, and the
  // wrap quad below closes the strip. Keeping the duplicate instead made the
  // seam two mirrored endpoints whose butt ends left a wedge-shaped gap that
  // grew with the turn angle.
  const closed = clean.length > 3
    && (source
      ? coordinates[0] === coordinates[coordinates.length - 2] && coordinates[1] === coordinates[coordinates.length - 1]
      : Cartesian3.equalsEpsilon(clean[0], clean[clean.length - 1], 0.0, 1e-9));
  if (closed) {
    clean.pop();
    coordinates.splice(-2);
  }
  const pts = clean;
  const n = pts.length;
  if (n < 2) {
    return undefined;
  }

  // Dash phase follows source tile coordinates in the normalized Mercator
  // world. Solid strips need no cumulative distance channel.
  const linesofar = dashed ? new Float64Array(n) : undefined;
  let perimeter = 0;
  if (linesofar) {
    const projection = source ? undefined : new WebMercatorProjection();
    const circumference = source ? 1 : 2 * Math.PI * projection!.ellipsoid.maximumRadius;
    const distancePoints = source
      ? pts.map((_, index) => {
          const point = tileLocalToMercatorFraction(source.tileID, coordinates[index * 2], coordinates[index * 2 + 1]);
          return new Cartesian3(point.x, point.y, 0);
        })
      : pts.map(point => projection!.project(Ellipsoid.WGS84.cartesianToCartographic(point)!));
    const distance = (a: Cartesian3, b: Cartesian3): number => {
      const x = a.x - b.x;
      const dx = source ? x : x - circumference * Math.round(x / circumference);
      return Math.hypot(dx, a.y - b.y) / circumference;
    };
    for (let j = 1; j < n; j++) {
      linesofar[j] = linesofar[j - 1] + distance(distancePoints[j - 1], distancePoints[j]);
    }
    // A closed ring's first incoming pair carries the full perimeter, so
    // the closing segment retains its phase across the seam.
    if (closed) {
      perimeter = linesofar[n - 1] + distance(distancePoints[n - 1], distancePoints[0]);
    }
  }

  // Fan slice count per joined vertex (0 = regular miter/bevel join). A closed
  // ring joins every vertex; an open strip leaves its two mirrored endpoints
  // to the cap branches.
  const fanCounts = new Int16Array(n);
  const fanSides = new Int8Array(n);
  const planarSource = planar && source;
  const fanPoints = planarSource
    ? pts.map((_, index) => new Cartesian3(coordinates[index * 2], -coordinates[index * 2 + 1], 0))
    : pts;
  let vertexCount = closed ? 4 * n : 4 * n - 4;
  for (let j = closed ? 0 : 1; j < (closed ? n : n - 1); j++) {
    if (join === 'round') {
      const prevPoint = closed ? fanPoints[(j - 1 + n) % n] : fanPoints[j - 1];
      const nextPoint = closed ? fanPoints[(j + 1) % n] : fanPoints[j + 1];
      const incoming = Cartesian3.subtract(fanPoints[j], prevPoint, new Cartesian3());
      const outgoing = Cartesian3.subtract(nextPoint, fanPoints[j], new Cartesian3());
      Cartesian3.normalize(incoming, incoming);
      Cartesian3.normalize(outgoing, outgoing);
      const turnAngle = Cartesian3.angleBetween(incoming, outgoing);
      const cosHalf = Math.cos(turnAngle / 2);
      const miterLength = cosHalf > 1e-9 ? 1 / cosHalf : Infinity;
      if (miterLength >= roundLimit) {
        // MapLibre's approximate turn angle (line_bucket.ts) drives the
        // number of pie slices; cap it for degenerate input.
        const approxAngle = 2 * Math.sqrt(2 - 2 * Math.max(-1, Math.min(1, cosHalf)));
        const mapLibreCount = Math.max(1, Math.round(approxAngle * 180 / Math.PI / DEG_PER_TRIANGLE));
        const segments = Math.max(1, Math.ceil(turnAngle * joinFanCount / Math.PI));
        // One fan vertex makes one chord (the next butt edge is its end).
        // With two or more chords, both arc endpoints need fan vertices.
        const detailCount = segments === 1 ? 1 : segments + 1;
        fanCounts[j] = Math.min(MAX_FAN_VERTICES, mapLibreCount, detailCount);
        // A left turn's outer edge is on the right, and vice versa. The
        // radial normal gives a stable local orientation on the globe.
        const cross = Cartesian3.cross(incoming, outgoing, new Cartesian3());
        const turn = planarSource ? cross.z : Cartesian3.dot(cross, pts[j]);
        fanSides[j] = turn > 0 ? -1 : 1;
        // Round join set: buttA (2) + fan + buttB (2) + anchor (1) vs the
        // regular 4-vertex pair.
        vertexCount += fanCounts[j] + 1;
      }
    }
  }
  if (!closed && (cap === 'round' || cap === 'square')) {
    // A cap quad reuses the endpoint's butt pair and adds two outer corners.
    vertexCount += 4;
  }

  const pos = new Float64Array(vertexCount * 3);
  const prevOffsets = planar ? undefined : new Float32Array(pos.length);
  const nextOffsets = planar ? undefined : new Float32Array(pos.length);
  const expandAndWidth = new Float32Array(vertexCount * 2);
  const corners = new Float32Array(vertexCount);
  const cornerParams = new Float32Array(vertexCount);
  const lineDistances = dashed ? new Float32Array(vertexCount) : undefined;
  const dashFrom = dashed ? new Float32Array(vertexCount * 3) : undefined;
  const dashTo = dashed ? new Float32Array(vertexCount * 3) : undefined;
  const indices: number[] = [];
  const sourceVertices = planarSource ? new Uint32Array(vertexCount) : undefined;

  let count = 0;
  const emit = (
    position: Cartesian3,
    prevPosition: Cartesian3,
    nextPosition: Cartesian3,
    expandDir: number,
    usePrev: boolean,
    corner: number,
    cornerParam: number,
    j: number,
    distance: number = linesofar?.[j] ?? 0,
  ): number => {
    const i = count++;
    const offset = i * 3;
    pos[offset] = position.x;
    pos[offset + 1] = position.y;
    pos[offset + 2] = position.z;
    if (sourceVertices) {
      sourceVertices[i] = j;
    }
    else {
      // Subtract in double precision before storing FLOAT directions.
      prevOffsets![offset] = prevPosition.x - position.x;
      prevOffsets![offset + 1] = prevPosition.y - position.y;
      prevOffsets![offset + 2] = prevPosition.z - position.z;
      nextOffsets![offset] = nextPosition.x - position.x;
      nextOffsets![offset + 1] = nextPosition.y - position.y;
      nextOffsets![offset + 2] = nextPosition.z - position.z;
    }
    expandAndWidth[i * 2] = expandDir;
    expandAndWidth[i * 2 + 1] = usePrev ? -1 : 1;
    corners[i] = corner;
    cornerParams[i] = cornerParam;
    if (dashFrom && dashTo && lineDistances) {
      lineDistances[i] = distance;
      dashFrom[i * 3] = options.dashFrom!.y;
      dashFrom[i * 3 + 1] = options.dashFrom!.height;
      dashFrom[i * 3 + 2] = options.dashFrom!.width;
      dashTo[i * 3] = options.dashTo!.y;
      dashTo[i * 3 + 1] = options.dashTo!.height;
      dashTo[i * 3 + 2] = options.dashTo!.width;
    }
    return i;
  };

  const mirrorPosition = (at: Cartesian3, toward: Cartesian3): Cartesian3 => {
    const delta = Cartesian3.subtract(at, toward, new Cartesian3());
    return Cartesian3.add(at, delta, new Cartesian3());
  };

  /**
   * Emitted vertex indices per strip vertex. Each vertex has up to two
   * pairs: `prevPair` faces vertex j-1 (its quad side, usePrev = true) and
   * `nextPair` faces vertex j+1. Round joins replace both pairs with butt
   * pairs plus the fan and the centerline anchor; caps add two tangent
   * extension vertices, with round corners clipped in the fragment shader.
   */
  interface VertexRole {
    prevL: number;
    prevR: number;
    nextL: number;
    nextR: number;
    fanStart: number;
    fanEnd: number;
    anchor: number;
    capL: number;
    capR: number;
  }
  const roles: VertexRole[] = [];

  for (let j = 0; j < n; j++) {
    const p = pts[j];
    // Open strips mirror the missing neighbour off the adjacent point (a flat
    // butt end); a closed ring wraps to the real neighbours, so the seam is
    // an ordinary joined corner.
    const prevPosition = closed
      ? pts[(j - 1 + n) % n]
      : (j === 0 ? mirrorPosition(p, pts[1]) : pts[j - 1]);
    const nextPosition = closed
      ? pts[(j + 1) % n]
      : (j === n - 1 ? mirrorPosition(p, pts[n - 2]) : pts[j + 1]);
    // The first vertex's prev pair draws the wrap segment, which ends at the
    // perimeter distance.
    const prevDistance = closed && j === 0 ? perimeter : linesofar?.[j] ?? 0;
    const role: VertexRole = {
      prevL: -1,
      prevR: -1,
      nextL: -1,
      nextR: -1,
      fanStart: -1,
      fanEnd: -1,
      anchor: -1,
      capL: -1,
      capR: -1,
    };

    const nFan = fanCounts[j];

    if (j === 0 && !closed && (cap === 'round' || cap === 'square')) {
      const corner = cap === 'round' ? LINE_CORNER_ROUND_CAP : LINE_CORNER_SQUARE;
      role.capL = emit(p, prevPosition, nextPosition, 1, false, corner, -1, j);
      role.capR = emit(p, prevPosition, nextPosition, -1, false, corner, -1, j);
    }

    if (nFan > 0) {
      const outerSide = fanSides[j];
      // Round join: butt-close the previous segment, sweep the fan along the
      // outer side of the turn, butt-close the next segment, anchor at the
      // centerline.
      role.prevL = emit(p, prevPosition, nextPosition, 1, true, LINE_CORNER_BUTT_PREV, 0, j, prevDistance);
      role.prevR = emit(p, prevPosition, nextPosition, -1, true, LINE_CORNER_BUTT_PREV, 0, j, prevDistance);
      role.fanStart = count;
      for (let f = 0; f < nFan; f++) {
        // nFan can be 1, and 0/0 would put NaN in the corner parameter and
        // poison the shader's cos/sin for that vertex.
        emit(p, prevPosition, nextPosition, outerSide, false, LINE_CORNER_JOIN_FAN, f / Math.max(1, nFan - 1), j);
      }
      role.fanEnd = count - 1;
      role.nextL = emit(p, prevPosition, nextPosition, 1, false, LINE_CORNER_BUTT_NEXT, 0, j);
      role.nextR = emit(p, prevPosition, nextPosition, -1, false, LINE_CORNER_BUTT_NEXT, 0, j);
      role.anchor = emit(p, prevPosition, nextPosition, 0, false, LINE_CORNER_ANCHOR, 0, j);
    }
    else {
      // Regular pairs: `prevL/prevR` face vertex j-1 (usePrev = true, like
      // Cesium's k = 0,1 vertices), `nextL/nextR` face vertex j+1. The
      // endpoint pairs that no quad references are not emitted; a closed ring
      // has no endpoints, so every pair exists.
      const emitPrev = closed || j > 0;
      const emitNext = closed || j < n - 1;
      const corner = !closed && cap === 'round' && (j === 0 || j === n - 1)
        ? n === 2 ? LINE_CORNER_ROUND_BOTH_ENDS : LINE_CORNER_ROUND_END
        : LINE_CORNER_REGULAR;
      role.prevL = emitPrev ? emit(p, prevPosition, nextPosition, 1, true, corner, effectiveMiterLimit, j, prevDistance) : -1;
      role.prevR = emitPrev ? emit(p, prevPosition, nextPosition, -1, true, corner, effectiveMiterLimit, j, prevDistance) : -1;
      role.nextL = emitNext ? emit(p, prevPosition, nextPosition, 1, false, corner, effectiveMiterLimit, j) : -1;
      role.nextR = emitNext ? emit(p, prevPosition, nextPosition, -1, false, corner, effectiveMiterLimit, j) : -1;
    }

    if (j === n - 1 && !closed && (cap === 'round' || cap === 'square')) {
      const corner = cap === 'round' ? LINE_CORNER_ROUND_CAP : LINE_CORNER_SQUARE;
      role.capL = emit(p, prevPosition, nextPosition, 1, true, corner, 1, j);
      role.capR = emit(p, prevPosition, nextPosition, -1, true, corner, 1, j);
    }

    roles.push(role);
  }

  const triangle = (i0: number, i1: number, i2: number): void => {
    indices.push(i0, i1, i2);
  };

  for (let j = 0; j < n; j++) {
    const role = roles[j];
    if (j > 0) {
      // Quad from vertex j-1 to j: the next pair of j-1 and the prev pair
      // of j. Round-join vertices use their butt pairs on both sides.
      const prevRole = roles[j - 1];
      if (!closed && cap === 'round' && j === n - 1) {
        // Cyclic rotation preserves geometry/winding and selects the end
        // pair as the flat-varying provoking vertex for this strip segment.
        triangle(prevRole.nextR, prevRole.nextL, role.prevL);
        triangle(prevRole.nextR, role.prevL, role.prevR);
      }
      else {
        triangle(prevRole.nextL, role.prevL, prevRole.nextR);
        triangle(role.prevL, role.prevR, prevRole.nextR);
      }
    }
    if (role.fanStart >= 0) {
      // Round join wedges, all anchored at the centerline vertex.
      const outerSide = fanSides[j];
      const prevOuter = outerSide > 0 ? role.prevL : role.prevR;
      const nextOuter = outerSide > 0 ? role.nextL : role.nextR;
      triangle(role.prevL, role.prevR, role.anchor);
      triangle(prevOuter, role.fanStart, role.anchor);
      for (let f = role.fanStart; f < role.fanEnd; f++) {
        triangle(f, f + 1, role.anchor);
      }
      triangle(role.fanEnd, nextOuter, role.anchor);
      triangle(role.nextL, role.nextR, role.anchor);
    }
    if (role.capL >= 0) {
      if (j === 0) {
        triangle(role.nextL, role.capL, role.nextR);
        triangle(role.capL, role.capR, role.nextR);
      }
      else {
        triangle(role.prevL, role.capL, role.prevR);
        triangle(role.capL, role.capR, role.prevR);
      }
    }
  }

  if (closed) {
    // Close the ring: the last vertex's next pair joins the first vertex's
    // prev pair across the seam. The two pairs are at the same location but
    // carry the wrap segment's end directions, so the shader expands the
    // corner exactly like any other join.
    const lastRole = roles[n - 1];
    const firstRole = roles[0];
    triangle(lastRole.nextL, firstRole.prevL, lastRole.nextR);
    triangle(firstRole.prevL, firstRole.prevR, lastRole.nextR);
  }

  const indexArray = count < 65536
    ? new Uint16Array(indices)
    : new Uint32Array(indices);

  return {
    positions: pos,
    projection: sourceVertices && {
      positions: Float64Array.from(pts.flatMap(point => [point.x, point.y, point.z])),
      longitudes: Float64Array.from(pts, (_, index) => {
        const { x } = tileLocalToMercatorFraction(source!.tileID, coordinates[index * 2], coordinates[index * 2 + 1]);
        return (x - 0.5) * 2 * Math.PI;
      }),
      vertices: sourceVertices,
      closed,
    },
    prevOffsets,
    nextOffsets,
    expandAndWidthUnit: expandAndWidth,
    corners,
    cornerParams,
    lineDistances,
    dashFrom: dashFrom ?? undefined,
    dashTo: dashTo ?? undefined,
    indices: indexArray,
    boundingSphere: BoundingSphere.fromVertices(pos),
  };
}

const LINE_COMMON_SHADER = `
void clipLineSegmentToNearPlane(
    vec3 p0,
    vec3 p1,
    out vec4 positionWC,
    out bool clipped,
    out bool culledByNearPlane,
    out vec4 clippedPositionEC)
{
    culledByNearPlane = false;
    clipped = false;

    vec3 p0ToP1 = p1 - p0;
    float magnitude = length(p0ToP1);
    vec3 direction = normalize(p0ToP1);

    // Distance that p0 is behind the near plane. Negative means p0 is
    // in front of the near plane.
    float endPoint0Distance =  czm_currentFrustum.x + p0.z;

    // Camera looks down -Z.
    // When moving a point along +Z: LESS VISIBLE
    //   * Points in front of the camera move closer to the camera.
    //   * Points behind the camrea move farther away from the camera.
    // When moving a point along -Z: MORE VISIBLE
    //   * Points in front of the camera move farther away from the camera.
    //   * Points behind the camera move closer to the camera.

    // Positive denominator: -Z, becoming more visible
    // Negative denominator: +Z, becoming less visible
    // Nearly zero: parallel to near plane
    float denominator = -direction.z;

    if (endPoint0Distance > 0.0 && abs(denominator) < czm_epsilon7)
    {
        // p0 is behind the near plane and the line to p1 is nearly parallel to
        // the near plane, so cull the segment completely.
        culledByNearPlane = true;
    }
    else if (endPoint0Distance > 0.0)
    {
        // p0 is behind the near plane, and the line to p1 is moving distinctly
        // toward or away from it.

        // t = (-plane distance - dot(plane normal, ray origin)) / dot(plane normal, ray direction)
        float t = endPoint0Distance / denominator;
        if (t < 0.0 || t > magnitude)
        {
            // Near plane intersection is not between the two points.
            // We already confirmed p0 is behind the naer plane, so now
            // we know the entire segment is behind it.
            culledByNearPlane = true;
        }
        else
        {
            // Segment crosses the near plane, update p0 to lie exactly on it.
            p0 = p0 + t * direction;

            // Numerical noise might put us a bit on the wrong side of the near plane.
            // Don't let that happen.
            p0.z = min(p0.z, -czm_currentFrustum.x);

            clipped = true;
        }
    }

    clippedPositionEC = vec4(p0, 1.0);
    positionWC = czm_eyeToWindowCoordinates(clippedPositionEC);
}

`;

function referenceLineShader(dash: boolean, planar = false): string {
  const positionInputs = planar
    ? 'in vec3 position2DHigh;\nin vec3 position2DLow;\nin vec3 prevOffset;\nin vec3 nextOffset;'
    : 'in vec3 position3DHigh;\nin vec3 position3DLow;\nin vec3 prevOffset;\nin vec3 nextOffset;';
  const positions = planar
    ? `    vec4 p = czm_translateRelativeToEye(position2DHigh.zxy, position2DLow.zxy);
    vec4 prev = p + vec4(prevOffset.zxy, 0.0);
    vec4 next = p + vec4(nextOffset.zxy, 0.0);
    p.x += u_line_layer_offset;
    prev.x += u_line_layer_offset;
    next.x += u_line_layer_offset;`
    : '    vec4 p = czm_translateRelativeToEye(position3DHigh, position3DLow);\n    vec4 prev = p + vec4(prevOffset, 0.0);\n    vec4 next = p + vec4(nextOffset, 0.0);';
  return `
${LINE_COMMON_SHADER}

${positionInputs}
in vec2 expandAndWidth;
in float a_corner;
in float a_cornerParam;
uniform float u_line_width;
uniform vec4 u_line_color;
${planar ? 'uniform float u_line_layer_offset;' : ''}

${dash ? 'in float a_linesofar;\nin vec3 a_dashFrom;\nin vec3 a_dashTo;' : ''}
in vec4 color;
in float batchId;

out vec4 v_color;
out float v_expandDir;
flat out vec4 v_lineCap;
flat out vec3 v_otherCap;
out float v_width;
#ifdef LINE_TILE_CLIP
out vec3 v_lineClipEye;
#endif
${dash ? 'out float v_linesofar;\nout vec3 v_dashFrom;\nout vec3 v_dashTo;' : ''}

void main()
{
    float expandDir = expandAndWidth.x;
    bool usePrev = expandAndWidth.y < 0.0;
    float width = czm_batchTable_lineWidth(batchId) * u_line_width;
    // The AA boundary is half a device pixel outside the painted width.
    // One more device pixel covers every sample in an intersecting pixel,
    // including diagonals, without changing the fragment coverage.
    float outset = width * 0.5 + 1.5 / czm_pixelRatio;

    // Cesium projects the center; both tracks store relative neighbours.
${positions}

    v_color = color * u_line_color;
    v_color.a *= step(0.001, width);
    v_expandDir = expandDir;
    v_lineCap = vec4(0.0);
    v_otherCap = vec3(0.0);
    v_width = width;
${dash ? '    v_linesofar = a_linesofar;\n    v_dashFrom = a_dashFrom;\n    v_dashTo = a_dashTo;\n' : ''}

    vec4 positionEC = czm_modelViewRelativeToEye * p;
    vec4 prevEC = czm_modelViewRelativeToEye * prev;
    vec4 nextEC = czm_modelViewRelativeToEye * next;

    vec4 clippedPrevWC, clippedPrevEC;
    bool prevSegmentClipped, prevSegmentCulled;
    clipLineSegmentToNearPlane(prevEC.xyz, positionEC.xyz, clippedPrevWC, prevSegmentClipped, prevSegmentCulled, clippedPrevEC);

    vec4 clippedNextWC, clippedNextEC;
    bool nextSegmentClipped, nextSegmentCulled;
    clipLineSegmentToNearPlane(nextEC.xyz, positionEC.xyz, clippedNextWC, nextSegmentClipped, nextSegmentCulled, clippedNextEC);

    bool segmentClipped, segmentCulled;
    vec4 clippedPositionWC, clippedPositionEC;
    clipLineSegmentToNearPlane(positionEC.xyz, usePrev ? prevEC.xyz : nextEC.xyz, clippedPositionWC, segmentClipped, segmentCulled, clippedPositionEC);

    if (segmentCulled)
    {
        gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec2 directionToPrevWC = normalize(clippedPrevWC.xy - clippedPositionWC.xy);
    vec2 directionToNextWC = normalize(clippedNextWC.xy - clippedPositionWC.xy);
    if (prevSegmentCulled)
    {
        directionToPrevWC = -directionToNextWC;
    }
    else if (nextSegmentCulled)
    {
        directionToNextWC = -directionToPrevWC;
    }

    // Left normals of the incoming (prev -> position) and outgoing
    // (position -> next) segments, in window space.
    vec2 nPrev = vec2(directionToPrevWC.y, -directionToPrevWC.x);
    vec2 nNext = vec2(-directionToNextWC.y, directionToNextWC.x);

    // The endpoint pair provokes both cap and adjacent strip triangles.
    // Flat window coordinates give every MSAA sample the same analytic cap
    // distance even when its pixel center lies across their shared edge.
    if (a_corner >= 30.0)
    {
        v_lineCap = vec4(clippedPositionWC.xy, -(usePrev ? directionToPrevWC : directionToNextWC));
        v_otherCap = vec3(usePrev ? clippedPrevWC.xy : clippedNextWC.xy, a_corner == 31.0 ? 1.0 : 0.0);
    }

    vec2 thisSegmentForwardWC, otherSegmentForwardWC;
    if (usePrev)
    {
        thisSegmentForwardWC = -directionToPrevWC;
        otherSegmentForwardWC = directionToNextWC;
    }
    else
    {
        thisSegmentForwardWC = directionToNextWC;
        otherSegmentForwardWC = -directionToPrevWC;
    }

    vec2 offsetDir = vec2(0.0);
    float expandWidth = outset;

    if (a_corner == 1.0 || a_corner == 2.0)
    {
        // Butt vertex: half width along one segment's own normal, no miter.
        vec2 n = a_corner == 1.0 ? nPrev : nNext;
        offsetDir = n * expandDir;
    }
    else if (a_corner == 3.0)
    {
        // Round join fan: sweep the outer side of the turn from nPrev to
        // nNext, mirroring MapLibre's fakeround pie slices.
        float crossN = nPrev.x * nNext.y - nPrev.y * nNext.x;
        float phi = atan(crossN, dot(nPrev, nNext));
        float theta = phi * a_cornerParam;
        float c = cos(theta);
        float s = sin(theta);
        offsetDir = expandDir * vec2(nPrev.x * c - nPrev.y * s, nPrev.x * s + nPrev.y * c);
    }
    else if (a_corner == 4.0 || a_corner == 5.0)
    {
        // Both caps extend a quad by half a width. Round caps use the endpoint
        // pair's flat coordinates for fragment-space semicircle clipping.
        vec2 left = usePrev ? nPrev : nNext;
        vec2 fwd = usePrev ? -directionToPrevWC : directionToNextWC;
        // Square caps have no fragment clipping along the tangent, so their
        // painted length must exclude the transparent MSAA geometry margin.
        float capScale = a_corner == 5.0 ? (outset - 1.0 / czm_pixelRatio) / outset : 1.0;
        offsetDir = left * expandDir + fwd * a_cornerParam * capScale;
    }
    else if (a_corner == 6.0)
    {
        // Centerline anchor of the round-join fan wedges.
        offsetDir = vec2(0.0);
    }
    else
    {
        // Regular vertex: Cesium's miter expansion.
        vec2 thisSegmentLeftWC = vec2(-thisSegmentForwardWC.y, thisSegmentForwardWC.x);
        vec2 leftWC = thisSegmentLeftWC;
        if (!czm_equalsEpsilon(prevEC.xyz - positionEC.xyz, vec3(0.0), czm_epsilon1) && !czm_equalsEpsilon(nextEC.xyz - positionEC.xyz, vec3(0.0), czm_epsilon1))
        {
            vec2 otherSegmentLeftWC = vec2(-otherSegmentForwardWC.y, otherSegmentForwardWC.x);

            vec2 leftSumWC = thisSegmentLeftWC + otherSegmentLeftWC;
            float leftSumLength = length(leftSumWC);
            leftWC = leftSumLength < czm_epsilon6 ? thisSegmentLeftWC : (leftSumWC / leftSumLength);

            vec2 u = -thisSegmentForwardWC;
            vec2 v = leftWC;
            float sinAngle = abs(u.x * v.y - u.y * v.x);
            // Regular vertices read the feature's exact FLOAT miter limit
            // from Native's instance table.
            expandWidth = clamp(expandWidth / sinAngle, 0.0, outset * max(a_cornerParam, 1.0));
        }
        offsetDir = leftWC * expandDir;
    }

    vec4 positionWC = vec4(clippedPositionWC.xy + offsetDir * expandWidth * czm_pixelRatio, -clippedPositionWC.z, 1.0) * (czm_projection * clippedPositionEC).w;
    gl_Position = czm_viewportOrthographic * positionWC;
#ifdef LINE_TILE_CLIP
    // Native's inverseProjection is zero in 2D/orthographic views. Its
    // window helper also restores those views from the current frustum.
    vec4 lineClipWindow = czm_viewportTransformation * vec4(gl_Position.xyz / gl_Position.w, 1.0);
    lineClipWindow.w = 1.0 / gl_Position.w;
    vec4 lineClipPositionEC = czm_windowToEyeCoordinates(lineClipWindow);
    v_lineClipEye = lineClipPositionEC.xyz / lineClipPositionEC.w;
#endif
    // Coverage is a window-space distance. Cancel perspective interpolation
    // in the fragment shader so different endpoint depths do not skew it.
    v_expandDir *= gl_Position.w;
}
`;
}

const LINE_TILE_CLIP_FRAGMENT = `
#ifdef LINE_TILE_CLIP
in vec3 v_lineClipEye;
uniform vec4 u_line_clip_west;
uniform vec4 u_line_clip_east;
#ifdef LINE_TILE_CLIP_PLANAR
uniform vec4 u_line_clip_south;
uniform vec4 u_line_clip_north;
#else
uniform vec4 u_line_clip_edges;
uniform vec3 u_line_clip_south_origin;
uniform vec3 u_line_clip_north_origin;
uniform vec4 u_line_clip_south_shape;
uniform vec4 u_line_clip_north_shape;

float lineLatitudeSide(vec3 originEC, vec4 shape)
{
    vec3 delta = czm_inverseViewRotation * (v_lineClipEye - originEC);
    vec2 radial = delta.xy / shape.z;
    // rho-rho0 as a difference of squares avoids Earth-scale cancellation.
    float radialDelta = dot(2.0 * shape.xy + radial, delta.xy)
        / (length(shape.xy + radial) + 1.0);
    // Constant geodetic latitude at every height: z=tan(phi)*rho-e²N*sin(phi).
    // The origin is on that boundary, so its constant cancels exactly.
    return delta.z - shape.w * radialDelta;
}
#endif

void clipLineTile()
{
    vec4 positionEC = vec4(v_lineClipEye, 1.0);
#ifdef LINE_TILE_CLIP_PLANAR
    if (dot(u_line_clip_west, positionEC) < 0.0
        || dot(u_line_clip_east, positionEC) >= 0.0
        || dot(u_line_clip_south, positionEC) < 0.0
        || dot(u_line_clip_north, positionEC) >= 0.0)
        discard;
#else
    // A z1 longitude interval is a hemisphere; its two edges share a plane.
    // Its across axis distinguishes the inclusive and exclusive endpoints.
    if (u_line_clip_edges.x == 2.0)
    {
        float radial = dot(u_line_clip_west, positionEC);
        float across = dot(u_line_clip_east, positionEC);
        if (radial < 0.0 || (radial == 0.0 && across >= 0.0))
            discard;
    }
    if ((u_line_clip_edges.x == 1.0 && dot(u_line_clip_west, positionEC) < 0.0)
        || (u_line_clip_edges.y > 0.0 && dot(u_line_clip_east, positionEC) >= 0.0)
        || (u_line_clip_edges.z > 0.0 && lineLatitudeSide(u_line_clip_south_origin, u_line_clip_south_shape) < 0.0)
        || (u_line_clip_edges.w > 0.0 && lineLatitudeSide(u_line_clip_north_origin, u_line_clip_north_shape) >= 0.0))
        discard;
#endif
}
#endif
`;

const LINE_COVERAGE_SHADER = `
${LINE_TILE_CLIP_FRAGMENT}
float lineCoverage()
{
#ifdef LINE_TILE_CLIP
    clipLineTile();
#endif
    float halfWidth = v_width * czm_pixelRatio * 0.5;
    float tangent = max(dot(gl_FragCoord.xy - v_lineCap.xy, v_lineCap.zw), 0.0);
    if (v_otherCap.z > 0.0)
        tangent = max(tangent, dot(gl_FragCoord.xy - v_otherCap.xy, -v_lineCap.zw));
    float normal = v_expandDir * gl_FragCoord.w * (halfWidth + 1.5);
    return clamp(halfWidth + 0.5 - length(vec2(normal, tangent)), 0.0, 1.0);
}
`;

export const REFERENCE_LINE_AA_FS = `
in vec4 v_color;
in float v_expandDir;
flat in vec4 v_lineCap;
flat in vec3 v_otherCap;
in float v_width;

${LINE_COVERAGE_SHADER}

void main()
{
    float coverage = lineCoverage();
    out_FragColor = vec4(v_color.rgb, v_color.a * coverage);
}
`;

export const REFERENCE_LINE_AA_VS = referenceLineShader(false);
export const REFERENCE_PLANAR_LINE_AA_VS = referenceLineShader(false, true);
