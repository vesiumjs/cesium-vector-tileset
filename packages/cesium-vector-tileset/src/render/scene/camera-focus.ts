import type { Camera, MapProjection, SceneMode } from 'cesium';
import { Cartesian2, Cartesian3, Math as CesiumMath, GeographicProjection, IntersectionTests, SceneMode as NativeSceneMode, Ray, WebMercatorProjection } from 'cesium';
import { altitudeFromMercatorZ, MercatorCoordinate } from '../../geo/mercator-coordinate';

export interface CameraFocus {
  zoom: number;
  /** Native world distance, in the same units as clip W. */
  cameraToCenterDistance: number;
  center: { longitude: number; latitude: number; elevation: number };
}

/** Map bearing in the actual ground frame; Native's nadir heading uses its up basis. */
export function cameraBearing(camera: Pick<Camera, 'positionWC' | 'directionWC' | 'upWC'>, mode: SceneMode, projection: MapProjection, center?: CameraFocus['center']): number | undefined {
  const direction = camera.directionWC;
  const up = camera.upWC;
  let east: number;
  let north: number;
  let vertical: number;
  let upEast: number;
  let upNorth: number;
  if (mode === NativeSceneMode.SCENE3D) {
    const location = center
      ? { longitude: center.longitude * Math.PI / 180, latitude: center.latitude * Math.PI / 180 }
      : projection.ellipsoid.cartesianToCartographic(camera.positionWC);
    if (!location)
      return undefined;
    const sinLongitude = Math.sin(location.longitude);
    const cosLongitude = Math.cos(location.longitude);
    const sinLatitude = Math.sin(location.latitude);
    const cosLatitude = Math.cos(location.latitude);
    east = -sinLongitude * direction.x + cosLongitude * direction.y;
    north = -sinLatitude * cosLongitude * direction.x - sinLatitude * sinLongitude * direction.y + cosLatitude * direction.z;
    vertical = cosLatitude * cosLongitude * direction.x + cosLatitude * sinLongitude * direction.y + sinLatitude * direction.z;
    upEast = -sinLongitude * up.x + cosLongitude * up.y;
    upNorth = -sinLatitude * cosLongitude * up.x - sinLatitude * sinLongitude * up.y + cosLatitude * up.z;
  }
  else {
    const position = camera.positionWC;
    const location = projection.unproject(new Cartesian3(position.y, position.z, position.x));
    const northScale = projection instanceof GeographicProjection ? Math.cos(location.latitude) : 1;
    east = direction.y;
    north = direction.z / northScale;
    vertical = direction.x;
    upEast = up.y;
    upNorth = up.z / northScale;
  }
  const length = Math.hypot(east, north, vertical);
  if (!(length > 0) || !Number.isFinite(length))
    return undefined;
  // This is Cesium Camera.getHeading's existing singularity rule, not a
  // camera-pitch clamp. It retains rotation when the look ray is vertical.
  return CesiumMath.equalsEpsilon(Math.abs(vertical) / length, 1, CesiumMath.EPSILON3)
    ? Math.atan2(upEast, upNorth)
    : Math.atan2(east, north);
}

/**
 * MapLibre 6.14 TransformHelper.calculateCenterFromCameraLngLatAlt and
 * _distanceToCenterFromAltElevationPitch define a finite physical focus when
 * ground cannot be the camera target. These are its 89.25-degree horizon,
 * 10000-metre focus and center-latitude iteration, not a width/pitch clamp.
 */
export function columbusCameraFocus(camera: Pick<Camera, 'positionWC' | 'directionWC' | 'frustum'>, projection: MapProjection, height: number): CameraFocus | undefined {
  const fov = (camera.frustum as { fovy?: number }).fovy;
  if (!(fov !== undefined && fov > 0 && fov < Math.PI && height > 0)
    || !(projection instanceof GeographicProjection || projection instanceof WebMercatorProjection)) {
    return undefined;
  }
  const position = camera.positionWC;
  const location = projection.unproject(new Cartesian3(position.y, position.z, position.x));
  const cosLatitude = Math.cos(location.latitude);
  if (Math.abs(location.latitude) >= Math.PI / 2 || !(cosLatitude > 0)
    || ![location.longitude, location.latitude, position.x].every(Number.isFinite)) {
    return undefined;
  }
  // CV height is projected metres. Convert the actual Native camera into the
  // conformal Mercator coordinates used by MapLibre's public camera API.
  const circumference = 2 * Math.PI * projection.ellipsoid.maximumRadius;
  const cameraCoordinate = MercatorCoordinate.fromLngLat({ lng: location.longitude * 180 / Math.PI, lat: location.latitude * 180 / Math.PI });
  const altitude = altitudeFromMercatorZ(position.x / circumference, cameraCoordinate.y);
  const direction = camera.directionWC;
  const east = direction.y;
  const north = direction.z / (projection instanceof GeographicProjection ? cosLatitude : 1);
  const length = Math.hypot(east, north, direction.x);
  // Projected ground has MapLibre's flat-plane horizon. The 3D caller
  // instead classifies its actual ellipsoid ray, whose horizon varies with
  // altitude and can be reached before this flat-plane pitch boundary.
  const vertical = direction.x / length;
  if (vertical * altitude < 0 && Math.abs(vertical) >= Math.cos(89.25 * Math.PI / 180))
    return undefined;
  const focus = finitePhysicalFocus(cameraCoordinate, altitude, east, north, direction.x, fov, height);
  return focus && { zoom: focus.zoom, center: focus.center, cameraToCenterDistance: circumference * focus.normalizedDistance / length };
}

/**
 * MapLibre 6.14 VerticalPerspectiveTransform's sea-level optical focus.
 * A missed ray maps to the closest visible horizon point, as in its
 * unprojectScreenPoint. Scaled space extends its unit-sphere construction
 * to the actual ellipsoid; zoom and symbol distance use the same real focus.
 */
export function globeCameraFocus(camera: Pick<Camera, 'positionWC' | 'directionWC' | 'frustum'>, projection: MapProjection, width: number, height: number): CameraFocus | undefined {
  const fov = (camera.frustum as { fovy?: number }).fovy;
  const position = camera.positionWC;
  if (!(fov !== undefined && fov > 0 && fov < Math.PI && width > 0 && height > 0)
    || ![position.x, position.y, position.z].every(Number.isFinite)) {
    return undefined;
  }
  const ellipsoid = projection.ellipsoid;
  const ray = new Ray(position, camera.directionWC);
  const scaledPosition = ellipsoid.transformPositionToScaledSpace(position, new Cartesian3());
  const magnitude = Cartesian3.magnitude(scaledPosition);
  if (!(magnitude > 1))
    return undefined;
  const intersection = IntersectionTests.rayEllipsoid(ray, ellipsoid);
  let target: Cartesian3;
  if (intersection && intersection.start > 0) {
    target = Ray.getPoint(ray, intersection.start, new Cartesian3());
  }
  else {
    const scaledDirection = Cartesian3.multiplyComponents(ray.direction, ellipsoid.oneOverRadii, new Cartesian3());
    if (!(Cartesian3.magnitudeSquared(scaledDirection) > 0))
      return undefined;
    Cartesian3.normalize(scaledDirection, scaledDirection);
    const normal = Cartesian3.divideByScalar(scaledPosition, magnitude, new Cartesian3());
    const planeDistance = 1 / magnitude;
    const distanceToPlane = -(magnitude - planeDistance) / Cartesian3.dot(normal, scaledDirection);
    const point = Cartesian3.add(scaledPosition, Cartesian3.multiplyByScalar(scaledDirection, distanceToPlane > 0 && Number.isFinite(distanceToPlane) ? distanceToPlane : 2, new Cartesian3()), new Cartesian3());
    // The behind-camera/parallel case follows the upstream one-diameter ray
    // projection. Its subsequent radial clamp chooses the horizon surface.
    if (!(distanceToPlane > 0 && Number.isFinite(distanceToPlane))) {
      const signedDistance = Cartesian3.dot(normal, point) - planeDistance;
      Cartesian3.subtract(point, Cartesian3.multiplyByScalar(normal, signedDistance, new Cartesian3()), point);
    }
    const diskCenter = Cartesian3.multiplyByScalar(normal, planeDistance, new Cartesian3());
    Cartesian3.subtract(point, diskCenter, point);
    if (!(Cartesian3.magnitudeSquared(point) > 0))
      return undefined;
    Cartesian3.normalize(point, point);
    Cartesian3.multiplyByScalar(point, Math.sqrt(1 - planeDistance ** 2), point);
    Cartesian3.add(diskCenter, point, point);
    target = ellipsoid.transformPositionFromScaledSpace(point, new Cartesian3());
  }
  const location = ellipsoid.cartesianToCartographic(target);
  const distance = Cartesian3.distance(position, target);
  if (!location || !(distance > 0))
    return undefined;
  const pixels = camera.frustum.getPixelDimensions(width, height, distance, 1, new Cartesian2());
  // The upstream globe keeps its Mercator-equivalent radius at the limit.
  const latitude = Math.min(Math.abs(location.latitude), Math.atan(Math.sinh(Math.PI)));
  const zoom = Math.log2(2 * Math.PI * ellipsoid.maximumRadius * Math.cos(latitude) / (512 * pixels.x));
  return Number.isFinite(zoom) ? { zoom, cameraToCenterDistance: distance, center: { longitude: location.longitude * 180 / Math.PI, latitude: location.latitude * 180 / Math.PI, elevation: 0 } } : undefined;
}

/** Shared pinned MapLibre physical focus and center-latitude iteration. */
function finitePhysicalFocus(cameraCoordinate: MercatorCoordinate, altitude: number, east: number, north: number, vertical: number, fov: number, height: number): { zoom: number; center: CameraFocus['center']; normalizedDistance: number } | undefined {
  const length = Math.hypot(east, north, vertical);
  if (!(length > 0) || !Number.isFinite(length) || !Number.isFinite(altitude))
    return undefined;
  const pitch = Math.acos(Math.max(-1, Math.min(1, -vertical / length))) * 180 / Math.PI;
  const bearing = Math.atan2(east, north) * 180 / Math.PI;
  const pitchRadians = pitch * Math.PI / 180;
  const bearingRadians = bearing * Math.PI / 180;
  const dz = -Math.cos(pitchRadians);
  const distance = 10000;
  const elevation = altitude + distance * dz;
  let metersPerMercatorUnit = altitudeFromMercatorZ(1, cameraCoordinate.y);
  let center = cameraCoordinate;
  let normalizedDistance = 0;
  // The installed primary implementation performs at most ten iterations and
  // keeps the last center/distance pair if the latitude scale has not converged.
  for (let index = 0; index < 10; index++) {
    normalizedDistance = distance / metersPerMercatorUnit;
    center = new MercatorCoordinate(cameraCoordinate.x + Math.sin(pitchRadians) * Math.sin(bearingRadians) * normalizedDistance, cameraCoordinate.y - Math.sin(pitchRadians) * Math.cos(bearingRadians) * normalizedDistance);
    metersPerMercatorUnit = 1 / center.meterInMercatorCoordinateUnits();
    if (Math.abs(distance - normalizedDistance * metersPerMercatorUnit) <= 1e-12)
      break;
  }
  const zoom = Math.log2(height / 2 / Math.tan(fov / 2) / normalizedDistance / 512);
  const lngLat = center.toLngLat();
  return [zoom, lngLat.lng, lngLat.lat, elevation].every(Number.isFinite)
    ? { zoom, center: { longitude: lngLat.lng, latitude: lngLat.lat, elevation }, normalizedDistance }
    : undefined;
}
