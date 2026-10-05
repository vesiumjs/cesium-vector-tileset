import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';

import type { FillExtrusionLayoutProps, FillExtrusionLayoutPropsPossiblyEvaluated, FillExtrusionPaintProps, FillExtrusionPaintPropsPossiblyEvaluated } from './fill-extrusion-style-layer-properties.g';
import Point from '@mapbox/point-geometry';
import { StyleLayer } from '../style-layer';
import properties from './fill-extrusion-style-layer-properties.g';

export class Point3D extends Point {
  z = 0;
}

export class FillExtrusionStyleLayer extends StyleLayer<
  FillExtrusionPaintProps,
  FillExtrusionLayoutProps,
  FillExtrusionPaintPropsPossiblyEvaluated,
  FillExtrusionLayoutPropsPossiblyEvaluated
> {
  constructor(layer: LayerSpecification, globalState: Record<string, any>) {
    super(layer, properties, globalState);
  }

  is3D(): boolean {
    return true;
  }
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

export function getIntersectionDistance(projectedQueryGeometry: Point3D[], projectedFace: Point3D[]): number {
  if (projectedQueryGeometry.length === 1) {
    // For point queries calculate the z at which the point intersects the face
    // using barycentric coordinates.

    // Find the barycentric coordinates of the projected point within the first
    // triangle of the face, using only the xy plane. It doesn't matter if the
    // point is outside the first triangle because all the triangles in the face
    // are in the same plane.
    //
    // Check whether points are coincident and use other points if they are.
    let i = 0;
    const a = projectedFace[i++];
    let b;
    while (!b || a.equals(b)) {
      b = projectedFace[i++];
      if (!b)
        return Infinity;
    }

    // Loop until point `c` is not colinear with points `a` and `b`.
    for (; i < projectedFace.length; i++) {
      const c = projectedFace[i];

      const p = projectedQueryGeometry[0];

      const ab = b.sub(a);
      const ac = c.sub(a);
      const ap = p.sub(a);

      const dotABAB = dot(ab, ab);
      const dotABAC = dot(ab, ac);
      const dotACAC = dot(ac, ac);
      const dotAPAB = dot(ap, ab);
      const dotAPAC = dot(ap, ac);
      const denom = dotABAB * dotACAC - dotABAC * dotABAC;

      const v = (dotACAC * dotAPAB - dotABAC * dotAPAC) / denom;
      const w = (dotABAB * dotAPAC - dotABAC * dotAPAB) / denom;
      const u = 1 - v - w;

      // Use the barycentric weighting along with the original triangle z coordinates to get the point of intersection.
      const distance = a.z * u + b.z * v + c.z * w;

      if (Number.isFinite(distance))
        return distance;
    }

    return Infinity;
  }
  else {
    // The counts as closest is less clear when the query is a box. This
    // returns the distance to the nearest point on the face, whether it is
    // within the query or not. It could be more correct to return the
    // distance to the closest point within the query box but this would be
    // more complicated and expensive to calculate with little benefit.
    let closestDistance = Infinity;
    for (const p of projectedFace) {
      closestDistance = Math.min(closestDistance, p.z);
    }
    return closestDistance;
  }
}

/*
 * Project the geometry using matrix `m`. This is essentially doing
 * `vec4.transformMat4([], [p.x, p.y, z, 1], m)` but the multiplication
 * is inlined so that parts of the projection that are the same across
 * different points can only be done once. This produced a measurable
 * performance improvement.
 */
