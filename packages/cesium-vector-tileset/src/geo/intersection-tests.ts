import type Point from '@mapbox/point-geometry';

// Code from https://stackoverflow.com/a/1501725/331379.
export function distToSegmentSquared(p: Point, v: Point, w: Point): number {
  const l2 = v.distSqr(w);
  if (l2 === 0)
    return p.distSqr(v);
  const t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  if (t < 0)
    return p.distSqr(v);
  if (t > 1)
    return p.distSqr(w);
  return p.distSqr(w.sub(v)._mult(t)._add(v));
}
