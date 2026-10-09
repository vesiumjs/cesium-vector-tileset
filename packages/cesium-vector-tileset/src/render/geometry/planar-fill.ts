import type { TilePoint } from './surface-subdivision';
import earcut from 'earcut';
import { EXTENT } from '../../data/extent';

interface BoundaryEdge {
  from: number;
  to: number;
}

function area(ring: TilePoint[]): number {
  return ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point[0] * next[1] - point[1] * next[0];
  }, 0) / 2;
}

function contains(ring: TilePoint[], point: TilePoint): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const from = ring[previous];
    const to = ring[index];
    if ((from[1] > point[1]) !== (to[1] > point[1])
      && point[0] < (to[0] - from[0]) * (point[1] - from[1]) / (to[1] - from[1]) + from[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function compact(ring: TilePoint[]): TilePoint[] {
  return ring.filter((point, index) => {
    const previous = ring[(index + ring.length - 1) % ring.length];
    const next = ring[(index + 1) % ring.length];
    const collinear = (point[0] - previous[0]) * (next[1] - point[1])
      === (point[1] - previous[1]) * (next[0] - point[0]);
    return !collinear;
  });
}

/** Clip source edges in their traversal order without quantizing intersections. */
function clipTriangle(triangle: TilePoint[]): TilePoint[] {
  let polygon = triangle;
  for (const [axis, boundary, greater] of [[0, 0, true], [0, EXTENT, false], [1, 0, true], [1, EXTENT, false]] as const) {
    if (!polygon.length)
      break;
    const clipped: TilePoint[] = [];
    const inside = (point: TilePoint) => greater ? point[axis] >= boundary : point[axis] <= boundary;
    let previous = polygon[polygon.length - 1];
    let previousInside = inside(previous);
    for (const point of polygon) {
      const pointInside = inside(point);
      if (pointInside !== previousInside) {
        // Shared source edges can be walked in opposite directions. Evaluate
        // their crossing in one canonical direction so both faces share the
        // exact same vertex, including duplicated source vertices in chunks.
        const [from, to] = previous[0] < point[0] || (previous[0] === point[0] && previous[1] < point[1]) ? [previous, point] : [point, previous];
        const t = (boundary - from[axis]) / (to[axis] - from[axis]);
        const intersection: TilePoint = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
        intersection[axis] = boundary;
        clipped.push(intersection);
      }
      if (pointInside)
        clipped.push(point);
      previous = point;
      previousInside = pointInside;
    }
    polygon = clipped;
  }
  const compacted: TilePoint[] = [];
  for (const point of polygon) {
    const last = compacted[compacted.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1])
      compacted.push(point);
  }
  if (compacted.length > 1 && compacted[0][0] === compacted[compacted.length - 1][0] && compacted[0][1] === compacted[compacted.length - 1][1])
    compacted.pop();
  return compacted;
}

/**
 * Recover a clipped fill's boundary from its authoritative triangle mesh.
 * Shared source edges use canonical interpolation and cancel exactly. Keep
 * their fractional crossings: integer rounding can invert a thin clipped face
 * or make its source boundary self-intersect. No proximity welding is needed.
 * Retriangulating the compact boundary removes source diagonals' collinear
 * tile-edge intersections, which otherwise produce unmatched raster edges.
 */
export function clipPlanarFill(points: TilePoint[], triangles: number[]): { points: TilePoint[]; indices: number[] } {
  const vertices: TilePoint[] = [];
  const vertexIndices = new Map<string, number>();
  const vertexIndex = (point: TilePoint): number => {
    const key = `${point[0]}:${point[1]}`;
    const existing = vertexIndices.get(key);
    if (existing !== undefined)
      return existing;
    const index = vertices.length;
    vertices.push(point);
    vertexIndices.set(key, index);
    return index;
  };
  const edges = new Map<string, BoundaryEdge>();
  const addEdge = (from: number, to: number): void => {
    const opposite = `${to}:${from}`;
    if (edges.has(opposite)) {
      edges.delete(opposite);
      return;
    }
    const key = `${from}:${to}`;
    if (edges.has(key))
      throw new TypeError('Planar fill triangles overlap along a directed boundary edge');
    edges.set(key, { from, to });
  };
  for (let index = 0; index < triangles.length; index += 3) {
    const source = triangles.slice(index, index + 3).map(vertex => points[vertex]);
    const sourceArea = area(source);
    if (sourceArea === 0)
      continue;
    if (sourceArea < 0)
      source.reverse();
    const ring = clipTriangle(source).map(vertexIndex);
    if (ring.length < 3)
      continue;
    for (let side = 0; side < ring.length; side++)
      addEdge(ring[side], ring[(side + 1) % ring.length]);
  }
  const outgoing = new Map<number, BoundaryEdge[]>();
  for (const edge of edges.values()) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const rings: TilePoint[][] = [];
  const remaining = new Set(edges.values());
  while (remaining.size) {
    const first = remaining.values().next().value!;
    const ring: TilePoint[] = [];
    let edge = first;
    do {
      ring.push(vertices[edge.from]);
      remaining.delete(edge);
      if (edge.to === first.from)
        break;
      const candidates = outgoing.get(edge.to)?.filter(candidate => remaining.has(candidate));
      if (!candidates?.length)
        throw new TypeError('Planar fill boundary must form closed rings');
      const point = vertices[edge.to];
      const previous = vertices[edge.from];
      const reverse = Math.atan2(previous[1] - point[1], previous[0] - point[0]);
      const turn = (candidate: BoundaryEdge) => {
        const next = vertices[candidate.to];
        return (reverse - Math.atan2(next[1] - point[1], next[0] - point[0]) + Math.PI * 2) % (Math.PI * 2);
      };
      // At a point contact, keep walking the face on the left of the edge
      // rather than joining otherwise disconnected clipped components.
      edge = candidates.reduce((best, candidate) => turn(candidate) < turn(best) ? candidate : best);
    } while (edge !== first);
    const reduced = compact(ring);
    if (reduced.length >= 3 && area(reduced) !== 0)
      rings.push(reduced);
  }
  const outers = rings.filter(ring => area(ring) > 0).map(ring => ({ ring, holes: [] as TilePoint[][] }));
  for (const hole of rings.filter(ring => area(ring) < 0)) {
    const owner = outers.filter(outer => contains(outer.ring, hole[0])).sort((a, b) => area(a.ring) - area(b.ring))[0];
    if (!owner)
      throw new TypeError('Planar fill hole must belong to a clipped outer boundary');
    owner.holes.push(hole);
  }
  const output: TilePoint[] = [];
  const indices: number[] = [];
  for (const { ring, holes } of outers) {
    const flattened = [...ring, ...holes.flat()];
    const starts: number[] = [];
    let count = ring.length;
    for (const hole of holes) {
      starts.push(count);
      count += hole.length;
    }
    const base = output.length;
    const triangulated = earcut(flattened.flat(), starts);
    for (const point of flattened)
      output.push(point);
    for (let index = 0; index < triangulated.length; index += 3)
      indices.push(base + triangulated[index + 2], base + triangulated[index + 1], base + triangulated[index]);
  }
  if (output.some(point => point[0] < 0 || point[0] > EXTENT || point[1] < 0 || point[1] > EXTENT))
    throw new TypeError('Planar fill clipping must stay inside its tile');
  return { points: output, indices };
}
