import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection, Point } from 'geojson';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian3, Color, SceneMode, SceneTransforms, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const circumference = 2 * Math.PI * 6378137;
const fov = 36.875112943;
const height = 120;
const coordinate = (x: number, y: number): [number, number] => [x / circumference * 360, Math.atan(Math.sinh(y / 6378137)) * 180 / Math.PI];
const collision = new URLSearchParams(location.search).get('case') === 'collision';
const points = collision
  ? [{ id: 'pair-left', x: -10, y: 800 }, { id: 'pair-right', x: 10, y: 800 }, { id: 'control', x: -500, y: 2500 }]
  : [{ id: 'near', x: -144, y: 800 }, { id: 'mid', x: 0, y: 2500 }, { id: 'far', x: 1800, y: 10000 }, { id: 'ultra-40', x: -3200, y: 40000 }, { id: 'ultra-60', x: 4800, y: 60000 }];
const data: FeatureCollection<Point> = { type: 'FeatureCollection', features: points.map((point, index) => ({ type: 'Feature', id: index + 1, properties: { name: point.id }, geometry: { type: 'Point', coordinates: coordinate(point.x, point.y) } })) };
const style: StyleSpecification = {
  version: 8,
  transition: { duration: 0, delay: 0 },
  sources: { points: { type: 'geojson', data } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
    { id: 'icons', type: 'symbol', source: 'points', layout: { 'icon-image': 'square', 'icon-size': 1, 'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport', 'icon-padding': 0, 'icon-allow-overlap': false, 'icon-ignore-placement': false }, paint: { 'icon-opacity': 1 } },
  ],
};
function gpu(gl: WebGL2RenderingContext) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}
function measure(canvas: HTMLCanvasElement, pixels: Uint8Array, center: { x: number; y: number }, radius = 40) {
  const x0 = Math.floor(center.x - radius);
  const x1 = Math.ceil(center.x + radius);
  const y0 = Math.floor(center.y - radius);
  const y1 = Math.ceil(center.y + radius);
  let area = 0;
  let count = 0;
  const columns: number[] = [];
  for (let x = x0; x <= x1; x++) {
    let alpha = 0;
    for (let y = y0; y <= y1; y++) {
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height)
        continue;
      const index = ((canvas.height - 1 - y) * canvas.width + x) * 4;
      if (pixels[index] > pixels[index + 1] + 8 && pixels[index] > pixels[index + 2] + 8) {
        alpha += pixels[index] / 255;
        count++;
      }
    }
    area += alpha;
    columns.push(alpha);
  }
  let components = 0;
  for (let index = 0; index < columns.length; index++) {
    if (columns[index] > 0.1 && (index === 0 || columns[index - 1] <= 0.1))
      components++;
  }
  return { alphaWidth: Math.sqrt(area), area, count, components, columns, bounded: x0 > 0 && y0 > 0 && x1 < canvas.width && y1 < canvas.height };
}
async function createPerspective() {
  setWorkerUrl(workerUrl);
  const viewer = new Viewer('cesium', {
    baseLayer: false,
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    requestRenderMode: false,
    useBrowserRecommendedResolution: false,
    contextOptions: { webgl: { antialias: false } },
    msaaSamples: 1,
    mapProjection: new WebMercatorProjection(),
    sceneMode: SceneMode.COLUMBUS_VIEW,
  }) as unknown as TestViewer;
  viewer.scene.globe.baseColor = Color.BLACK;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  viewer.scene.backgroundColor = Color.BLACK;
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const reference = new MapLibre({ container: 'maplibre', style: structuredClone(style), center: [0, 0], zoom: 14, pitch: 75, maxPitch: 180, interactive: false, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: false } });
  reference.on('error', event => errors.push(event.error.message));
  reference.setCenterClampedToGround(false);
  reference.setVerticalFieldOfView(fov);
  const tileset = new CesiumVectorTileset({ style: structuredClone(style) }) as unknown as TestTileset;
  const image = { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) };
  for (let index = 0; index < image.data.length; index += 4) image.data.set([255, 0, 0, 255], index);
  tileset.addImage('square', image, { pixelRatio: 1 });
  viewer.scene.primitives.add(tileset);
  await new Promise<void>(resolve => reference.once('load', () => {
    reference.addImage('square', image, { pixelRatio: 1 });
    resolve();
  }));
  let nativePixels: Uint8Array | undefined;
  let referencePixels: Uint8Array | undefined;
  let nativeFrames = 0;
  let referenceFrames = 0;
  let draws = 0;
  let pitch = 75;
  let changedAt = performance.now();
  const originalDraw = viewer.scene.context.draw;
  viewer.scene.context.draw = function (command, ...args) {
    if (drawBatchForOwner(command.owner)?.kind === 'symbol')
      draws++;
    return originalDraw.call(this, command, ...args);
  };
  viewer.scene.preRender.addEventListener(() => draws = 0);
  viewer.scene.postRender.addEventListener(() => {
    nativePixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
    nativeFrames++;
  });
  reference.on('render', () => {
    const canvas = reference.getCanvas();
    const gl = canvas.getContext('webgl2')!;
    referencePixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, referencePixels);
    referenceFrames++;
  });
  const setView = (value: number) => {
    changedAt = performance.now();
    pitch = value;
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    frustum.fov = fov * Math.PI / 180;
    frustum.aspectRatio = viewer.canvas.clientWidth / viewer.canvas.clientHeight;
    const x = pitch === 0 ? points[0].x : 0;
    const y = pitch === 0 ? points[0].y : 0;
    viewer.camera.setView({ destination: new Cartesian3(x, y, height), convert: false, orientation: { heading: 0, pitch: pitch * Math.PI / 180 - Math.PI / 2, roll: 0 } });
    reference.jumpTo({ center: [0, 0], elevation: 0, zoom: 14, pitch: 0, bearing: 0, roll: 0 });
    const lngLat = coordinate(x, y);
    const altitude = (height / circumference) / MercatorCoordinate.fromLngLat(lngLat, 1).z;
    reference.jumpTo(reference.calculateCameraOptionsFromCameraLngLatAltRotation(lngLat, altitude, 0, pitch, 0));
    nativePixels = undefined;
    referencePixels = undefined;
    nativeFrames = 0;
    referenceFrames = 0;
    viewer.scene.requestRender();
    reference.triggerRepaint();
  };
  setView(0);
  return {
    setView,
    setReferenceOverlap(allow: boolean) {
      reference.setLayoutProperty('icons', 'icon-allow-overlap', allow);
      referenceFrames = 0;
      referencePixels = undefined;
      changedAt = performance.now();
      reference.triggerRepaint();
    },
    ready: () => performance.now() - changedAt > 350 && tileset.tilesLoaded && reference.loaded() && nativeFrames > 20 && referenceFrames > 0 && !!nativePixels && !!referencePixels,
    capture() {
      if (!nativePixels || !referencePixels)
        throw new Error('Both renderers must draw');
      const transform = (reference as unknown as { _camera: { transform: { getCameraLngLat: () => { lng: number; lat: number }; getCameraAltitude: () => number; _pixelMatrix3D: number[]; _viewProjMatrix: number[]; cameraToCenterDistance: number; worldSize: number; coordinatePoint: (point: MercatorCoordinate, elevation: number, matrix: number[]) => { x: number; y: number } } } })._camera.transform;
      const referencePosition = MercatorCoordinate.fromLngLat(transform.getCameraLngLat());
      referencePosition.z = MercatorCoordinate.fromLngLat(reference.getCenter(), transform.getCameraAltitude()).z;
      const actualNative = viewer.camera.positionWC;
      const nativePosition = { x: 0.5 + actualNative.y / circumference, y: 0.5 - actualNative.z / circumference, z: actualNative.x / circumference };
      const loaded = reference.querySourceFeatures('points').map(feature => String(feature.properties.name));
      const nativeGeometries = [...tileset._renderer.symbol._tiles.values()].flatMap(entry => entry.batches.flatMap(batch => batch.icon ? batch.icon.instances.map(instance => ({ opacity: batch.icon!.opacities[instance.vertexStart], anchor: Array.from(batch.icon!.positions.subarray(instance.vertexStart * 3, instance.vertexStart * 3 + 3)) })) : []));
      const pointRows = points.map((point) => {
        const lngLat = coordinate(point.x, point.y);
        const center = SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromDegrees(...lngLat))!;
        const coordinateMercator = MercatorCoordinate.fromLngLat(lngLat);
        const expected = transform.coordinatePoint(coordinateMercator, 0, transform._pixelMatrix3D);
        const m = transform._viewProjMatrix;
        const wx = coordinateMercator.x * transform.worldSize;
        const wy = coordinateMercator.y * transform.worldSize;
        const w = m[3] * wx + m[7] * wy + m[15];
        const depth = (m[2] * wx + m[6] * wy + m[14]) / w;
        const rawRatio = 0.5 + 0.5 * transform.cameraToCenterDistance / w;
        return { ...point, center, expected, depth, signedDistance: w, rawRatio, shaderRatio: Math.max(0, Math.min(4, rawRatio)), sourceLoaded: loaded.includes(point.id), native: measure(viewer.canvas, nativePixels!, center), reference: measure(reference.getCanvas(), referencePixels!, expected) };
      });
      const pairCenter = { x: (pointRows[0].center.x + pointRows[1].center.x) / 2, y: (pointRows[0].center.y + pointRows[1].center.y) / 2 };
      return {
        pitch,
        errors,
        collision,
        referenceOverlap: reference.getLayoutProperty('icons', 'icon-allow-overlap'),
        loaded,
        nativeGeometries,
        draws,
        camera: { nativePosition, referencePosition, pitch: reference.getPitch(), nativePitch: 90 + viewer.camera.pitch * 180 / Math.PI, fov: reference.getVerticalFieldOfView(), nativeFov: (viewer.camera.frustum as PerspectiveFrustum).fovy * 180 / Math.PI, bearing: reference.getBearing(), roll: reference.getRoll(), nativeHeading: viewer.camera.heading, nativeRoll: viewer.camera.roll, elevation: reference.getCenterElevation(), zoom: reference.getZoom() },
        gpu: { native: gpu(viewer.scene.context._gl), reference: gpu(reference.getCanvas().getContext('webgl2')!) },
        viewport: { native: [viewer.canvas.width, viewer.canvas.height, viewer.canvas.clientWidth, viewer.canvas.clientHeight], reference: [reference.getCanvas().width, reference.getCanvas().height, reference.getCanvas().clientWidth, reference.getCanvas().clientHeight] },
        points: pointRows,
        pair: collision ? { native: measure(viewer.canvas, nativePixels, pairCenter, 100), reference: measure(reference.getCanvas(), referencePixels, pairCenter, 100) } : undefined,
      };
    },
  };
}
declare global { interface Window { symbolPerspective: Awaited<ReturnType<typeof createPerspective>> } }
void createPerspective().then(value => window.symbolPerspective = value);
