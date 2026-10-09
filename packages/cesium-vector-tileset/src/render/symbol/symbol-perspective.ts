import { Cartesian3, Ellipsoid } from 'cesium';
import { WGS84_A, wgs84CartographicToCartesian } from '../geometry/tile-to-ecef';

/** MapLibre viewport-pitched point symbol ratio, in matching world units. */
export function symbolPerspectiveRatio(cameraToCenterDistance: number | undefined, clipW: number, orthographic: boolean): number | undefined {
  if (orthographic) {
    return 1;
  }
  if (cameraToCenterDistance === undefined || !Number.isFinite(cameraToCenterDistance) || cameraToCenterDistance <= 0
    || !Number.isFinite(clipW) || clipW <= 0) {
    return undefined;
  }
  return 0.5 + 0.5 * cameraToCenterDistance / clipW;
}

/** Mercator ground metres represented by one CSS pixel at the live style zoom. */
export function symbolMetersPerPixel(zoom: number): number {
  return 2 * Math.PI * WGS84_A / (512 * 2 ** zoom);
}

/** Map-pitched drawing uses the inverse distance ratio and the GPU four-times cap. */
export function symbolMapPerspectiveRatio(distance: number | undefined, clipW: number, orthographic: boolean): number | undefined {
  const ratio = symbolPerspectiveRatio(distance, clipW, orthographic);
  if (ratio === undefined)
    return undefined;
  return orthographic ? 1 : Math.min(4, 0.5 + 0.5 * clipW / distance!);
}

/** Absolute y-down Mercator label-plane coordinates, before camera projection. */
export function symbolMercatorPosition(x: number, y: number, z: number): { x: number; y: number } | undefined {
  const position = Ellipsoid.WGS84.cartesianToCartographic(new Cartesian3(x, y, z));
  if (!position || Math.abs(position.latitude) >= Math.PI / 2)
    return undefined;
  return { x: position.longitude * WGS84_A, y: -WGS84_A * Math.asinh(Math.tan(position.latitude)) };
}

/** Retain the local world copy when a line crosses the longitude seam. */
export function symbolMercatorDelta(x: number, referenceX: number): number {
  const circumference = 2 * Math.PI * WGS84_A;
  const delta = x - referenceX;
  return delta - circumference * Math.round(delta / circumference);
}

export function symbolGroundPosition(x: number, y: number): { x: number; y: number; z: number } {
  return wgs84CartographicToCartesian(x / WGS84_A, Math.atan(Math.sinh(-y / WGS84_A)));
}

/** MapLibre's viewport-rotated ground label axes: normalize each inverse column independently. */
export function symbolViewportGroundAxes(east: { x: number; y: number }, south: { x: number; y: number }): { east: { x: number; y: number }; south: { x: number; y: number } } {
  const normalize = (x: number, y: number) => {
    const length = Math.hypot(x, y);
    return length < 1e-9 ? { x: 0, y: 0 } : { x: x / length, y: y / length };
  };
  return { east: normalize(south.y, -east.y), south: normalize(-south.x, east.x) };
}
