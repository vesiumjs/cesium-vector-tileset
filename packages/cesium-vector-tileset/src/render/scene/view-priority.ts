import type { RenderFrameState } from './render-frame';
import { Cartesian2, Cartesian3, IntersectionTests, Ray, SceneMode } from 'cesium';

/** Geographic point used only to order pending tile publication. */
export function viewPriority(frame: RenderFrameState) {
  const { camera } = frame;
  const fallback = camera.positionCartographic;
  if (frame.mode !== SceneMode.SCENE3D)
    return fallback;
  const canvas = camera._scene?.canvas;
  const projection = frame.mapProjection ?? camera._scene?.mapProjection;
  if (!canvas || !projection || canvas.clientWidth <= 0 || canvas.clientHeight <= 0)
    return fallback;
  const ray = camera.getPickRay(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
  const intersection = ray && IntersectionTests.rayEllipsoid(ray, projection.ellipsoid);
  if (!ray || !intersection)
    return fallback;
  const distance = intersection.start > 0 ? intersection.start : intersection.stop;
  const ground = Ray.getPoint(ray, distance, new Cartesian3());
  return projection.ellipsoid.cartesianToCartographic(ground) ?? fallback;
}
