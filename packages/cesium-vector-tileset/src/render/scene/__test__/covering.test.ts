import type { OrthographicOffCenterFrustum } from 'cesium';
import type { CoveringSource } from '../render-frame';
import { Cartesian2, Cartesian3, Ellipsoid, GeographicProjection, IntersectionTests, MapMode2D, OrthographicFrustum, Ray, SceneMode, WebMercatorProjection } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { MAPLIBRE_TILE_SIZE } from '../covering';
import { cameraPoseForFrame, zoomForFrame } from '../render-frame';
import { cameraFrame } from './camera-helper';

const CIRCUMFERENCE = 2 * Math.PI * Ellipsoid.WGS84.maximumRadius;
const FOVY = 0.6926049486499279;
const source = (values: CoveringSource = {}) => ({ getSource: () => ({ type: 'vector', minzoom: 0, maxzoom: 22, tileSize: 512, ...values }) });

/** Independent screen-space oracle using Cesium's actual camera rays. */
function screenMapZoom(frame: ReturnType<typeof cameraFrame>, y = frame.context.canvas.clientHeight / 2): number {
  const projected = (x: number): Cartesian3 => {
    const ray = frame.camera.getPickRay(new Cartesian2(x, y))!;
    let point: Cartesian3;
    if (frame.mode === SceneMode.SCENE3D) {
      const hit = IntersectionTests.rayEllipsoid(ray, frame.mapProjection.ellipsoid)!;
      point = Ray.getPoint(ray, hit.start, new Cartesian3());
      return new WebMercatorProjection().project(frame.mapProjection.ellipsoid.cartesianToCartographic(point)!);
    }
    point = Ray.getPoint(ray, -ray.origin.x / ray.direction.x, new Cartesian3());
    return new WebMercatorProjection().project(frame.mapProjection.unproject(new Cartesian3(point.y, point.z, 0)));
  };
  const centerX = frame.context.canvas.clientWidth / 2;
  const metersPerPixel = Cartesian3.distance(projected(centerX), projected(centerX + 1));
  return Math.log2(CIRCUMFERENCE / (metersPerPixel * MAPLIBRE_TILE_SIZE));
}

describe('covering zoom semantics', () => {
  it('reports a 512 CSS pixel Mercator world independently of source tile size', () => {
    const latitude = 31.24231787165;
    const height = 3880;
    const frame = cameraFrame({ longitude: 121.491455426333, latitude, height });
    const cache = new WeakMap();
    const wide = zoomForFrame(source(), frame, cache)!;
    const small = zoomForFrame(source({ tileSize: 256 }), frame, cache)!;
    const groundSampling = 2 * height * Math.tan(FOVY / 2) / 800;
    const expected = Math.log2(CIRCUMFERENCE * Math.cos(latitude * Math.PI / 180) / (groundSampling * MAPLIBRE_TILE_SIZE));
    expect(wide.styleZoom).toBeCloseTo(expected, 2);
    expect(wide.zoom).toBe(Math.floor(expected));
    expect(small.styleZoom).toBe(wide.styleZoom);
    expect(small.zoom).toBe(wide.zoom + 1);
  });

  it('floors vector source zoom and rounds raster source zoom', () => {
    const frame = cameraFrame({ latitude: 31.24231787165, height: 6000 });
    const vector = zoomForFrame(source(), frame, new WeakMap())!;
    const raster = zoomForFrame(source({ type: 'raster' }), frame, new WeakMap())!;
    expect(vector.styleZoom).toBeGreaterThan(13.5);
    expect(vector.zoom).toBe(13);
    expect(raster.zoom).toBe(14);
  });

  it('keeps style zoom independent of source limits and overscales only vectors', () => {
    const frame = cameraFrame({ height: 2000 });
    const vector = zoomForFrame(source({ minzoom: 5, maxzoom: 8 }), frame, new WeakMap(), 4)!;
    const raster = zoomForFrame(source({ type: 'raster', minzoom: 5, maxzoom: 8 }), frame, new WeakMap(), 4)!;
    expect(vector.styleZoom).toBeGreaterThan(12);
    expect(vector.styleZoom).toBe(raster.styleZoom);
    expect(vector.zoom).toBe(12);
    expect(raster.zoom).toBe(8);
    const belowMinimum = zoomForFrame(source({ minzoom: 20 }), frame, new WeakMap())!;
    expect(belowMinimum.styleZoom).toBe(vector.styleZoom);
    expect(belowMinimum.zoom).toBe(20);
  });
});

describe('real Cesium camera zoom', () => {
  it('selects exact vector zoom 14 from a native Mercator 2D frustum at London', () => {
    const span = CIRCUMFERENCE * 1280 / (512 * 2 ** 14);
    const frame = cameraFrame({ mode: SceneMode.SCENE2D, projection: new WebMercatorProjection(), longitude: -0.1276, latitude: 51.5072, height: span });
    frame.context.mapMode2D = MapMode2D.INFINITE_SCROLL;
    const frustum = frame.camera.frustum as OrthographicOffCenterFrustum;
    frustum.right = span / 2;
    frustum.left = -span / 2;
    frustum.top = span * 800 / 1280 / 2;
    frustum.bottom = -frustum.top;
    const result = zoomForFrame(source(), frame, new WeakMap())!;
    expect(result.styleZoom).toBe(14);
    expect(result.zoom).toBe(14);
  });

  it('uses CSS canvas dimensions regardless of drawing buffer scale', () => {
    const normal = cameraFrame({ latitude: 60, height: 100_000 });
    const scaled = cameraFrame({ latitude: 60, height: 100_000, pixelRatio: 2 });
    // An explicitly provided canvasHeight is already CSS pixels.
    const result = zoomForFrame(source(), { ...scaled, canvasHeight: 800 }, new WeakMap())!;
    expect(result.styleZoom).toBe(zoomForFrame(source(), normal, new WeakMap())!.styleZoom);
    expect(result.styleZoom).toBeCloseTo(screenMapZoom(scaled), 6);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(800);
  });

  it('handles portrait and resized canvases independently of resolution scale', () => {
    const cache = new WeakMap();
    const pyramid = source();
    zoomForFrame(pyramid, cameraFrame(), cache);
    const portrait = cameraFrame({ width: 640, heightPixels: 1024, pixelRatio: 3 });
    // Cesium resolutionScale can alter buffers independently of CSS size.
    portrait.context.drawingBufferWidth *= 1.5;
    portrait.context.drawingBufferHeight *= 1.5;
    const result = zoomForFrame(pyramid, portrait, cache)!;
    expect(result.styleZoom).toBeCloseTo(screenMapZoom(portrait), 6);
    expect(result.width).toBe(640);
    expect(result.height).toBe(1024);
  });

  for (const projection of [new GeographicProjection(), new WebMercatorProjection()]) {
    for (const mode of [SceneMode.SCENE3D, SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW]) {
      it(`measures centre resolution in mode ${mode} with ${projection.constructor.name}`, () => {
        const frame = cameraFrame({ mode, projection, longitude: 10, latitude: 60, height: 100_000, heading: Math.PI / 2, pitch: -Math.PI / 4, roll: 0.2 });
        const result = zoomForFrame(source(), frame, new WeakMap())!;
        expect(result.styleZoom).toBeCloseTo(screenMapZoom(frame), 6);
      });
    }
  }

  it('keeps Mercator 2D scale independent of latitude', () => {
    const projection = new WebMercatorProjection();
    const atEquator = zoomForFrame(source(), cameraFrame({ mode: SceneMode.SCENE2D, projection }), new WeakMap())!;
    const atLatitude = zoomForFrame(source(), cameraFrame({ mode: SceneMode.SCENE2D, projection, latitude: 60 }), new WeakMap())!;
    expect(atLatitude.styleZoom).toBeCloseTo(atEquator.styleZoom, 6);
  });

  for (const mode of [SceneMode.SCENE3D, SceneMode.COLUMBUS_VIEW]) {
    it(`measures a real orthographic frustum in mode ${mode}`, () => {
      const frame = cameraFrame({ mode, projection: new WebMercatorProjection(), latitude: 60 });
      frame.camera.frustum = new OrthographicFrustum({ width: 50_000, aspectRatio: 1.6 });
      expect(zoomForFrame(source(), frame, new WeakMap())!.styleZoom).toBeCloseTo(screenMapZoom(frame), 6);
    });
  }

  it('measures continuous world scale across the antimeridian', () => {
    const nearDateLine = zoomForFrame(source(), cameraFrame({ longitude: 179.999999 }), new WeakMap())!;
    const primeMeridian = zoomForFrame(source(), cameraFrame(), new WeakMap())!;
    expect(nearDateLine.styleZoom).toBeCloseTo(primeMeridian.styleZoom, 6);
  });

  it('keeps initial horizon views usable when only the lower screen hits ground', () => {
    const frame = cameraFrame({ height: 5000, pitch: 0.02 });
    const centerRay = frame.camera.getPickRay(new Cartesian2(640, 400))!;
    expect(IntersectionTests.rayEllipsoid(centerRay, Ellipsoid.WGS84)).toBeUndefined();
    const expected = screenMapZoom(frame, 799);
    expect(Number.isFinite(expected)).toBe(true);
    expect(zoomForFrame(source(), frame, new WeakMap())?.styleZoom).toBeCloseTo(expected, 6);
  });

  it('reuses the last valid zoom when no screen surface can be sampled', () => {
    const frame = cameraFrame();
    const cache = new WeakMap();
    const pyramid = source();
    const initial = zoomForFrame(pyramid, frame, cache)!;
    frame.camera.setView({ orientation: { pitch: Math.PI / 2 } });
    expect(zoomForFrame(pyramid, frame, cache)?.styleZoom).toBe(initial.styleZoom);
  });
});

describe('camera and source caching', () => {
  it('ignores native orientation normalization roundoff while detecting real rotations and translations', () => {
    const frame = { ...cameraFrame({ longitude: -0.1276, latitude: 51.5072, height: 5000, heading: 0.6, pitch: -Math.PI / 4 }), frameNumber: 1 };
    const cache = new WeakMap();
    const initialPose = cameraPoseForFrame(frame, cache);
    const initialDirection = Cartesian3.clone(frame.camera.directionWC);
    const initialRight = Cartesian3.clone(frame.camera.rightWC);
    frame.camera.direction.x += Number.EPSILON;
    frame.camera.right.x -= Number.EPSILON;
    frame.frameNumber++;
    expect(Cartesian3.equals(initialDirection, frame.camera.directionWC)
      && Cartesian3.equals(initialRight, frame.camera.rightWC)).toBe(false);
    expect(cameraPoseForFrame(frame, cache)).toBe(initialPose);
    const position = Cartesian3.clone(frame.camera.positionWC);
    frame.camera.lookRight(1e-10);
    frame.frameNumber++;
    expect(Cartesian3.equals(frame.camera.positionWC, position)).toBe(true);
    const rotatedPose = cameraPoseForFrame(frame, cache);
    expect(rotatedPose).not.toBe(initialPose);
    frame.camera.moveRight(1e-8);
    frame.frameNumber++;
    expect(cameraPoseForFrame(frame, cache)).not.toBe(rotatedPose);
  });

  it('distinguishes heading changes at the same source zoom without treating near/far changes as a new pose', () => {
    const frame = { ...cameraFrame(), frameNumber: 1 };
    const cache = new WeakMap();
    const pyramid = source();
    const initialZoom = zoomForFrame(pyramid, frame, cache);
    const initialPose = cameraPoseForFrame(frame, cache);
    frame.frameNumber++;
    frame.camera.setView({ orientation: { heading: Math.PI } });
    expect(zoomForFrame(pyramid, frame, cache)).toBe(initialZoom);
    const turned = cameraPoseForFrame(frame, cache);
    expect(turned).not.toBe(initialPose);
    frame.frameNumber++;
    frame.camera.frustum.near = 2;
    frame.camera.frustum.far /= 2;
    expect(cameraPoseForFrame(frame, cache)).toBe(turned);
  });

  it('shares camera rays across sources and stationary frames while honoring source edits', () => {
    const frame = cameraFrame();
    const getPickRay = vi.spyOn(frame.camera, 'getPickRay');
    const cache = new WeakMap();
    const definition = { type: 'vector', maxzoom: 22, tileSize: 512 };
    const pyramid = { getSource: () => definition };
    const initial = zoomForFrame(pyramid, frame, cache)!;
    zoomForFrame(source({ tileSize: 256 }), frame, cache);
    expect(zoomForFrame(pyramid, frame, cache)).toBe(initial);
    expect(getPickRay).toHaveBeenCalledTimes(2);
    definition.tileSize = 256;
    expect(zoomForFrame(pyramid, frame, cache)?.zoom).toBe(initial.zoom + 1);
    expect(getPickRay).toHaveBeenCalledTimes(2);
    frame.camera.moveUp(1000);
    zoomForFrame(pyramid, frame, cache);
    expect(getPickRay).toHaveBeenCalledTimes(4);
  });

  it('measures moving frames once even when many sources share the frame', () => {
    const frame = { ...cameraFrame(), frameNumber: 1 };
    const getPickRay = vi.spyOn(frame.camera, 'getPickRay');
    const cache = new WeakMap();
    zoomForFrame(source(), frame, cache);
    zoomForFrame(source(), frame, cache);
    expect(getPickRay).toHaveBeenCalledTimes(2);
    frame.frameNumber++;
    frame.camera.moveBackward(100);
    zoomForFrame(source(), frame, cache);
    zoomForFrame(source(), frame, cache);
    expect(getPickRay).toHaveBeenCalledTimes(4);
  });

  it('holds style zoom through tiny pans and advances after cumulative change', () => {
    const frame = cameraFrame({ latitude: 31, height: 6000 });
    const cache = new WeakMap();
    const pyramid = source();
    const initial = zoomForFrame(pyramid, frame, cache)!.styleZoom;
    frame.camera.moveRight(0.02);
    expect(zoomForFrame(pyramid, frame, cache)!.styleZoom).toBe(initial);
    frame.camera.moveBackward(1);
    expect(zoomForFrame(pyramid, frame, cache)!.styleZoom).not.toBe(initial);
  });

  it('does not hide source integer boundaries inside the style zoom tolerance', () => {
    const frame = cameraFrame({ mode: SceneMode.SCENE2D, projection: new WebMercatorProjection(), height: CIRCUMFERENCE * 1280 / (512 * 2 ** 9.999975) });
    const pyramid = source();
    const cache = new WeakMap();
    const initial = zoomForFrame(pyramid, frame, cache)!;
    const frustum = frame.camera.frustum as OrthographicOffCenterFrustum;
    frustum.right *= 2 ** -0.00005;
    frustum.left = -frustum.right;
    const crossed = zoomForFrame(pyramid, frame, cache)!;
    expect(initial.zoom).toBe(9);
    expect(crossed.zoom).toBe(10);
    expect(crossed.styleZoom).toBe(initial.styleZoom);
  });
});
