import type { Camera, MapProjection } from 'cesium';
import { Cartesian3, GeographicProjection, IntersectionTests, Ray, Transforms, WebMercatorProjection } from 'cesium';
import { altitudeFromMercatorZ, MercatorCoordinate } from '../../geo/mercator-coordinate';

export interface CameraFocus {
  zoom: number;
  /** Native world distance, in the same units as clip W. */
  cameraToCenterDistance: number;
  center: { longitude: number; latitude: number; elevation: number };
}

/**
 * MapLibre 6.12 TransformHelper.calculateCenterFromCameraLngLatAlt and
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
  const focus = finitePhysicalFocus(cameraCoordinate, altitude, east, north, direction.x, fov, height);
  return focus && { zoom: focus.zoom, center: focus.center, cameraToCenterDistance: circumference * focus.normalizedDistance / length };
}

/** Current ECEF camera focus when its center ray misses the ellipsoid. */
export function globeCameraFocus(camera: Pick<Camera, 'positionWC' | 'directionWC' | 'frustum'>, projection: MapProjection, width: number, height: number): CameraFocus | undefined {
  const fov = (camera.frustum as { fovy?: number }).fovy;
  const position = camera.positionWC;
  if (!(fov !== undefined && fov > 0 && fov < Math.PI && width > 0 && height > 0)
    || ![position.x, position.y, position.z].every(Number.isFinite)) {
    return undefined;
  }
  const location = projection.ellipsoid.cartesianToCartographic(position);
  if (!location || Math.abs(location.latitude) >= Math.PI / 2)
    return undefined;
  // Use Cesium's actual local camera basis, including its ellipsoid and roll.
  const basis = Transforms.eastNorthUpToFixedFrame(position, projection.ellipsoid);
  const direction = camera.directionWC;
  const east = basis[0] * direction.x + basis[1] * direction.y + basis[2] * direction.z;
  const north = basis[4] * direction.x + basis[5] * direction.y + basis[6] * direction.z;
  const vertical = basis[8] * direction.x + basis[9] * direction.y + basis[10] * direction.z;
  const coordinate = MercatorCoordinate.fromLngLat({ lng: location.longitude * 180 / Math.PI, lat: location.latitude * 180 / Math.PI });
  const focus = finitePhysicalFocus(coordinate, location.height, east, north, vertical, fov, height);
  if (!focus)
    return undefined;
  // Cesium getPickRayPerspective at the canvas center has x=y=0: the
  // optical ray is the actual world position and forward direction. Keep
  // classification pure so basis normalization cannot resample every source.
  const ray = new Ray(position, direction);
  if (IntersectionTests.rayEllipsoid(ray, projection.ellipsoid))
    return undefined;
  return { zoom: focus.zoom, center: focus.center, cameraToCenterDistance: focus.distance };
}

/** Shared pinned MapLibre physical focus and center-latitude iteration. */
function finitePhysicalFocus(cameraCoordinate: MercatorCoordinate, altitude: number, east: number, north: number, vertical: number, fov: number, height: number): { zoom: number; center: CameraFocus['center']; normalizedDistance: number; distance: number } | undefined {
  const length = Math.hypot(east, north, vertical);
  if (!(length > 0) || !Number.isFinite(length) || !Number.isFinite(altitude))
    return undefined;
  const pitch = Math.acos(Math.max(-1, Math.min(1, -vertical / length))) * 180 / Math.PI;
  const bearing = Math.atan2(east, north) * 180 / Math.PI;
  const pitchRadians = pitch * Math.PI / 180;
  const bearingRadians = bearing * Math.PI / 180;
  const dz = -Math.cos(pitchRadians);
  if (dz * altitude < 0 && Math.abs(dz) >= Math.cos(89.25 * Math.PI / 180))
    return undefined;
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
    ? { zoom, center: { longitude: lngLat.lng, latitude: lngLat.lat, elevation }, normalizedDistance, distance }
    : undefined;
}
