import { Cartesian2, Cartesian3, GeographicProjection, IntersectionTests, SceneMode, WebMercatorProjection } from 'cesium';
import { describe, expect, it } from 'vitest';
/* eslint-disable antfu/no-import-node-modules-by-path -- Independent public camera oracle from the pinned MapLibre primary source. */
import { MercatorCoordinate } from '../../../../../../node_modules/maplibre-gl/src/geo/mercator_coordinate';
import { Camera as MapCamera } from '../../../../../../node_modules/maplibre-gl/src/ui/camera';
/* eslint-enable antfu/no-import-node-modules-by-path */
import { OverscaledTileID } from '../../../tile/tile-id';
import { columbusCameraFocus, globeCameraFocus } from '../camera-focus';
import { sourceTileLodForFrame, zoomForFrame } from '../render-frame';
import { sourceLodCamera } from '../source-tile-lod';
import { cameraFrame } from './camera-helper';

function officialCamera() {
  const camera = new MapCamera({
    minZoom: -20,
    maxZoom: 25,
    minPitch: 0,
    maxPitch: 180,
    bearingSnap: 0,
    zoomSnap: 0,
    renderWorldCopies: true,
    centerClampedToGround: false,
    terrain: null!,
    transformConstrain: null!,
    requestRenderFrame: () => 0,
    cancelRenderFrame: () => {},
    transformCameraUpdate: null,
  });
  camera.transform.resize(1569, 906);
  camera.transform.setFov(45);
  return camera;
}

describe('finite Columbus View camera focus', () => {
  it('rejects an out-of-range Geographic CV latitude without throwing', () => {
    const frame = cameraFrame({ mode: SceneMode.COLUMBUS_VIEW, projection: new GeographicProjection(), height: 120 });
    frame.camera.setView({ destination: new Cartesian3(0, 2 * Math.PI * frame.mapProjection.ellipsoid.maximumRadius, 120), convert: false, orientation: { heading: 0, pitch: 0, roll: 0 } });
    expect(() => columbusCameraFocus(frame.camera, frame.mapProjection, 800)).not.toThrow();
    expect(columbusCameraFocus(frame.camera, frame.mapProjection, 800)).toBeUndefined();
  });

  for (const projection of [new GeographicProjection(), new WebMercatorProjection()]) {
    it.each([0, 31.24, 51.5072, -60])(`agrees with the public MapLibre camera API at latitude %s in ${projection.constructor.name}`, (latitude) => {
      const map = officialCamera();
      for (const heading of [0, 45]) {
        for (const pitch of [89.9, 90, 95, 180]) {
          const frame = cameraFrame({ mode: SceneMode.COLUMBUS_VIEW, projection, longitude: 10, latitude, height: 120, heading: heading * Math.PI / 180, pitch: (pitch - 90) * Math.PI / 180, width: 1569, heightPixels: 906, fovY: Math.PI / 4 });
          const native = frame.camera;
          const location = projection.unproject(new Cartesian3(native.positionWC.y, native.positionWC.z, native.positionWC.x));
          // Independent actual-camera normalization: Native projected height
          // and Mercator east share one world; Geographic north needs its
          // actual projection's local Mercator differential.
          const coordinate = MercatorCoordinate.fromLngLat({ lng: location.longitude * 180 / Math.PI, lat: location.latitude * 180 / Math.PI });
          coordinate.z = native.positionWC.x / (2 * Math.PI * projection.ellipsoid.maximumRadius);
          const east = native.directionWC.y;
          const north = native.directionWC.z / (projection instanceof GeographicProjection ? Math.cos(location.latitude) : 1);
          const length = Math.hypot(east, north, native.directionWC.x);
          const effectivePitch = Math.acos(-native.directionWC.x / length) * 180 / Math.PI;
          const bearing = Math.atan2(east, north) * 180 / Math.PI;
          map.transform.setElevation(0);
          const expected = map.calculateCameraOptionsFromCameraLngLatAltRotation(coordinate.toLngLat(), coordinate.toAltitude(), bearing, effectivePitch);
          const focus = columbusCameraFocus(native, projection, 906)!;
          expect(focus.zoom).toBeCloseTo(expected.zoom!, 10);
          expect(focus.center.longitude).toBeCloseTo((expected.center as { lng: number }).lng, 10);
          expect(focus.center.latitude).toBeCloseTo((expected.center as { lat: number }).lat, 10);
          expect(focus.center.elevation).toBeCloseTo(expected.elevation!, 9);
          const actual = zoomForFrame({ getSource: () => ({ type: 'vector', maxzoom: 22 }) }, frame, new WeakMap())!;
          expect(actual.styleZoom).toBe(focus.zoom);
          expect(Number.isFinite(actual.styleZoom)).toBe(true);
        }
      }
    });
  }

  it.each([75, 85, 89.24])('preserves real ground sampling before the MapLibre horizon boundary at pitch %s', (pitch) => {
    const frame = cameraFrame({ mode: SceneMode.COLUMBUS_VIEW, projection: new WebMercatorProjection(), latitude: 51.5, height: 120, heading: 0, pitch: (pitch - 90) * Math.PI / 180 });
    expect(columbusCameraFocus(frame.camera, frame.mapProjection, 800)).toBeUndefined();
    expect(sourceLodCamera(frame, frame.mapProjection, 1280, 800)).toBeDefined();
  });

  it('keeps horizon LOD finite and conservative, then immediately restores the actual ground camera', () => {
    const frame = cameraFrame({ mode: SceneMode.COLUMBUS_VIEW, projection: new WebMercatorProjection(), latitude: 51.5, height: 120, heading: 0, pitch: 0 });
    const pyramid = { getSource: () => ({ type: 'vector', maxzoom: 22 }) };
    const cache = new WeakMap();
    const horizon = zoomForFrame(pyramid, frame, cache)!;
    expect(sourceLodCamera(frame, frame.mapProjection, 1280, 800)).toBeUndefined();
    const lod = sourceTileLodForFrame(pyramid, frame, cache, 0)!;
    const fine = new OverscaledTileID(22, 0, 22, 2 ** 21, 2 ** 21);
    expect(lod.select(fine)).toEqual(fine.scaledTo(horizon.zoom));
    frame.camera.setView({ orientation: { heading: 0, pitch: -15 * Math.PI / 180, roll: 0 } });
    const restored = zoomForFrame(pyramid, frame, cache)!;
    const cold = cameraFrame({ mode: SceneMode.COLUMBUS_VIEW, projection: new WebMercatorProjection(), latitude: 51.5, height: 120, heading: 0, pitch: -15 * Math.PI / 180 });
    expect(restored.styleZoom).toBe(zoomForFrame(pyramid, cold, new WeakMap())!.styleZoom);
    expect(restored.styleZoom).not.toBe(horizon.styleZoom);
    expect(sourceLodCamera(frame, frame.mapProjection, 1280, 800)).toBeDefined();
  });
});

describe('finite 3D camera focus', () => {
  it.each([0, 31.24, 51.5072, -60])('uses actual Cartographic and ENU pose with the public MapLibre camera at latitude %s', (latitude) => {
    const map = officialCamera();
    for (const heading of [0, 45]) {
      for (const roll of [0, Math.PI / 2]) {
        const frame = cameraFrame({ longitude: 10, latitude, height: 120, heading: heading * Math.PI / 180, pitch: -0.1 * Math.PI / 180, roll, width: 1569, heightPixels: 906, fovY: Math.PI / 4 });
        const location = frame.mapProjection.ellipsoid.cartesianToCartographic(frame.camera.positionWC)!;
        map.transform.setElevation(0);
        const expected = map.calculateCameraOptionsFromCameraLngLatAltRotation({ lng: location.longitude * 180 / Math.PI, lat: location.latitude * 180 / Math.PI }, location.height, heading, 89.9, roll * 180 / Math.PI);
        const actualCenterRay = frame.camera.getPickRay(new Cartesian2(1569 / 2, 906 / 2))!;
        expect(IntersectionTests.rayEllipsoid(actualCenterRay, frame.mapProjection.ellipsoid)).toBeUndefined();
        const focus = globeCameraFocus(frame.camera, frame.mapProjection, 1569, 906)!;
        expect(focus).toBeDefined();
        expect(focus.zoom).toBeCloseTo(expected.zoom!, 10);
        expect(focus.center.longitude).toBeCloseTo((expected.center as { lng: number }).lng, 10);
        expect(focus.center.latitude).toBeCloseTo((expected.center as { lat: number }).lat, 10);
        expect(focus.center.elevation).toBeCloseTo(expected.elevation!, 8);
        expect(focus.cameraToCenterDistance).toBe(10000);
      }
    }
  });

  it('preserves an actual center ellipsoid hit even inside the MapLibre finite-focus pitch domain', () => {
    const frame = cameraFrame({ height: 120, pitch: -0.7 * Math.PI / 180 });
    expect(IntersectionTests.rayEllipsoid(frame.camera.getPickRay(new Cartesian2(640, 400))!, frame.mapProjection.ellipsoid)).toBeDefined();
    expect(globeCameraFocus(frame.camera, frame.mapProjection, 1280, 800)).toBeUndefined();
  });
});

it('rejects an invalid 3D Cartesian position or viewport instead of inventing a focus', () => {
  const frame = cameraFrame({ height: 120, pitch: -0.1 * Math.PI / 180 });
  expect(globeCameraFocus(frame.camera, frame.mapProjection, 1280, 0)).toBeUndefined();
  const invalid = { positionWC: Cartesian3.ZERO, directionWC: frame.camera.directionWC, frustum: frame.camera.frustum, getPickRay: frame.camera.getPickRay.bind(frame.camera) };
  expect(globeCameraFocus(invalid, frame.mapProjection, 1280, 800)).toBeUndefined();
});
