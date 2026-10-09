import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection, LineString } from 'geojson';
import type { NativePrimitive, TestTileset, TestViewer } from './browser-types';
import { Cartesian2, Cartesian3, Color, SceneMode, SceneTransforms, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { drawBatchForOwner, linePaintForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const radius = 6378137;
const circumference = 2 * Math.PI * radius;
const height = 120;
const fov = 36.875112943;
const coordinate = (x: number, y: number): [number, number] => [x / radius * 180 / Math.PI, Math.atan(Math.sinh(y / radius)) * 180 / Math.PI];
const lines = [1500, 3000, 6000].flatMap((y, depth) => [
  { id: `east-${depth}`, direction: 'east', depth, center: coordinate(-200, y), coordinates: [coordinate(-350, y), coordinate(-50, y)] },
  { id: `north-${depth}`, direction: 'north', depth, center: coordinate(0, y + 300), coordinates: [coordinate(0, y + 50), coordinate(0, y + 550)] },
]);
const data: FeatureCollection<LineString> = { type: 'FeatureCollection', features: lines.map(line => ({ type: 'Feature', properties: { id: line.id }, geometry: { type: 'LineString', coordinates: line.coordinates } })) };
const style: StyleSpecification = {
  version: 8,
  transition: { duration: 0, delay: 0 },
  sources: { roads: { type: 'geojson', data } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
    { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'butt', 'line-join': 'miter' }, paint: { 'line-color': '#ff0000', 'line-width': 10, 'line-gap-width': 0, 'line-offset': 0, 'line-blur': 0 } },
  ],
};
type ReferenceMode = 'official' | 'ground';
function gpu(gl: WebGL2RenderingContext) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}
function redCount(pixels: Uint8Array) {
  let count = 0;
  let alpha = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] > pixels[index + 1] + 8 && pixels[index] > pixels[index + 2] + 8) {
      count++;
      alpha += pixels[index] / 255;
    }
  }
  return { count, alpha };
}
function profile(canvas: HTMLCanvasElement, pixels: Uint8Array, center: { x: number; y: number }, tangent: { x: number; y: number }) {
  const length = Math.hypot(tangent.x, tangent.y);
  const normal = { x: -tangent.y / length, y: tangent.x / length };
  const ratio = canvas.width / canvas.clientWidth;
  const sample = (x: number, y: number) => {
    const px = x * ratio - 0.5;
    const py = y * ratio - 0.5;
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    let alpha = 0;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const x1 = x0 + dx;
        const y1 = y0 + dy;
        if (x1 >= 0 && x1 < canvas.width && y1 >= 0 && y1 < canvas.height)
          alpha += pixels[((canvas.height - 1 - y1) * canvas.width + x1) * 4] / 255 * (dx ? px - x0 : 1 - px + x0) * (dy ? py - y0 : 1 - py + y0);
      }
    }
    return alpha;
  };
  const rows = Array.from({ length: 2001 }, (_, index) => {
    const across = (index - 1000) / 4;
    const x = center.x + normal.x * across;
    const y = center.y + normal.y * across;
    return { across, alpha: sample(x, y), inCanvas: x > 1 && x < canvas.clientWidth - 1 && y > 1 && y < canvas.clientHeight - 1 };
  });
  // Stop at the first empty interval on either side of this actual line,
  // avoiding another finite line at a different ground distance.
  let first = 1000;
  let last = 1000;
  while (first > 0 && (rows[first].alpha > 0.005 || rows.slice(Math.max(0, first - 8), first).some(row => row.alpha > 0.005))) first--;
  while (last < rows.length - 1 && (rows[last].alpha > 0.005 || rows.slice(last + 1, last + 9).some(row => row.alpha > 0.005))) last++;
  const selected = rows.slice(first, last + 1);
  return { alphaWidth: selected.reduce((sum, row) => sum + row.alpha / 4, 0), maximum: Math.max(...selected.map(row => row.alpha)), bounded: first > 0 && last < rows.length - 1 && selected.every(row => row.inCanvas), extent: [rows[first].across, rows[last].across], rows: selected };
}

async function createHorizon() {
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
  const reference = new MapLibre({ container: 'maplibre', style: structuredClone(style), center: [0, 0], zoom: 14, pitch: 75, maxPitch: 180, bearing: 0, interactive: false, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: false } });
  reference.on('error', event => errors.push(event.error.message));
  reference.setCenterClampedToGround(false);
  reference.setVerticalFieldOfView(fov);
  const tileset = new CesiumVectorTileset({ style: structuredClone(style) }) as unknown as TestTileset;
  viewer.scene.primitives.add(tileset);
  const originalSurfaceOffsets = new Set<number>();
  // Compare the same zero-elevation ground plane as the real GeoJSON source.
  // Native normally lifts roads above the globe; at this low camera height
  // that separate surface changes both the actual pixel phase and width.
  viewer.scene.preRender.addEventListener(() => {
    for (const id of tileset._renderer.vector.tileIds) {
      for (const collection of tileset._renderer.vector.getTileCollections(id)) {
        for (let index = 0; index < ('length' in collection ? Number(collection.length) : 0); index++) {
          const entry = (collection as { get: (index: number) => NativePrimitive & { primitive?: NativePrimitive } }).get(index);
          const paint = linePaintForOwner(entry.primitive ?? entry);
          if (paint) {
            originalSurfaceOffsets.add(paint.offsetUniform());
            paint.offset = 0;
          }
        }
      }
    }
  });
  let nativePixels: Uint8Array | undefined;
  let referencePixels: Uint8Array | undefined;
  let nativeFrames = 0;
  let referenceFrames = 0;
  let pitch = 75;
  let mode: ReferenceMode = 'official';
  let issued: ReturnType<typeof reference.calculateCameraOptionsFromCameraLngLatAltRotation> | undefined;
  let lineDraws = 0;
  const originalDraw = viewer.scene.context.draw;
  viewer.scene.context.draw = function (command, ...args) {
    if (drawBatchForOwner(command.owner)?.kind === 'line')
      lineDraws++;
    return originalDraw.call(this, command, ...args);
  };
  viewer.scene.preRender.addEventListener(() => lineDraws = 0);
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
  const setView = (nextPitch: number, nextMode: ReferenceMode = 'official') => {
    pitch = nextPitch;
    mode = nextMode;
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    frustum.fov = fov * Math.PI / 180;
    frustum.aspectRatio = viewer.canvas.clientWidth / viewer.canvas.clientHeight;
    viewer.camera.setView({ destination: new Cartesian3(0, 0, height), convert: false, orientation: { heading: 0, pitch: pitch * Math.PI / 180 - Math.PI / 2, roll: 0 } });
    reference.jumpTo({ center: [0, 0], elevation: 0, zoom: 14, pitch: 0, bearing: 0, roll: 0 });
    if (mode === 'official') {
      // Convert EPSG:3857's projected height to MapLibre's physical altitude
      // using its public MercatorCoordinate, rather than Native's zoom code.
      const altitude = (height / circumference) / MercatorCoordinate.fromLngLat([0, 0], 1).z;
      issued = reference.calculateCameraOptionsFromCameraLngLatAltRotation([0, 0], altitude, 0, pitch, 0);
      reference.jumpTo(issued);
    }
    else {
      if (pitch >= 90)
        throw new Error('A horizontal camera has no finite zero-ground center');
      const distance = height / Math.cos(pitch * Math.PI / 180);
      const focal = reference.getCanvas().clientHeight / (2 * Math.tan(reference.getVerticalFieldOfView() * Math.PI / 360));
      issued = { center: coordinate(0, height * Math.tan(pitch * Math.PI / 180)), elevation: 0, zoom: Math.log2(focal * circumference / (512 * distance)), pitch, bearing: 0, roll: 0 };
      reference.jumpTo(issued);
    }
    nativePixels = undefined;
    referencePixels = undefined;
    nativeFrames = 0;
    referenceFrames = 0;
    viewer.scene.requestRender();
    reference.triggerRepaint();
  };
  const project = (position: [number, number]) => SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromDegrees(...position))!;
  setView(75);
  return {
    setView,
    ready: () => tileset.tilesLoaded && reference.loaded() && !!nativePixels && !!referencePixels && nativeFrames > 5 && referenceFrames > 0,
    capture() {
      if (!nativePixels || !referencePixels)
        throw new Error('Both real renderers must draw');
      const transform = (reference as unknown as { _camera: { transform: {
        getCameraLngLat: () => { lng: number; lat: number };
        getCameraAltitude: () => number;
        _pixelMatrix3D: number[];
        coordinatePoint: (point: MercatorCoordinate, elevation: number, matrix: number[]) => { x: number; y: number };
      }; }; })._camera.transform;
      // Map.project's 2D pixel matrix omits center elevation in MapLibre 6.12.
      // Use its actual 3D matrix, which the real ground draw also applies.
      const referenceProject = (position: [number, number]) => transform.coordinatePoint(MercatorCoordinate.fromLngLat(position), 0, transform._pixelMatrix3D);
      const cameraLngLat = transform.getCameraLngLat();
      // Transform altitude uses the center scale. Recover the actual camera Z
      // with that same official scale, not the camera latitude scale.
      const referencePosition = MercatorCoordinate.fromLngLat(cameraLngLat);
      referencePosition.z = MercatorCoordinate.fromLngLat(reference.getCenter(), transform.getCameraAltitude()).z;
      const nativePosition = { x: 0.5 + viewer.camera.positionWC.y / circumference, y: 0.5 - viewer.camera.positionWC.z / circumference, z: viewer.camera.positionWC.x / circumference };
      const paint = viewer.scene._frameState.commandList.flatMap((command) => {
        const value = linePaintForOwner(command.owner);
        return value ? [{ width: value.widthUniform(), metersPerPixel: value.metersPerPixelUniform(), surfaceOffset: value.offsetUniform() }] : [];
      });
      const root = tileset._renderer.collections._root;
      const ray = viewer.camera.getPickRay(new Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2))!;
      return {
        mode,
        requestedPitch: pitch,
        errors,
        issued,
        camera: { nativePosition, referencePosition, pitch: reference.getPitch(), nativePitch: 90 + viewer.camera.pitch * 180 / Math.PI, fov: reference.getVerticalFieldOfView(), nativeFov: (viewer.camera.frustum as PerspectiveFrustum).fovy * 180 / Math.PI, nativeRoll: viewer.camera.roll, nativeHeading: viewer.camera.heading, bearing: reference.getBearing(), roll: reference.getRoll(), elevation: reference.getCenterElevation(), zoom: reference.getZoom(), actualMaxPitch: reference.getMaxPitch() },
        diagnostics: { mercatorProjection: viewer.scene.mapProjection instanceof WebMercatorProjection, sceneRoot: { length: root.length, show: root.show }, originalSurfaceOffsets: Array.from(originalSurfaceOffsets), centerRay: { origin: ray.origin, direction: ray.direction, distance: -ray.origin.x / ray.direction.x }, paint, lineDraws },
        gpu: { native: gpu(viewer.scene.context._gl), reference: gpu(reference.getCanvas().getContext('webgl2')!) },
        viewport: { native: [viewer.canvas.width, viewer.canvas.height, viewer.canvas.clientWidth, viewer.canvas.clientHeight], reference: [reference.getCanvas().width, reference.getCanvas().height, reference.getCanvas().clientWidth, reference.getCanvas().clientHeight] },
        pixels: { native: redCount(nativePixels), reference: redCount(referencePixels) },
        lines: lines.map((line) => {
          const center = project(line.center);
          const expected = referenceProject(line.center);
          const start = project(line.coordinates[0]);
          const end = project(line.coordinates[1]);
          const referenceStart = referenceProject(line.coordinates[0]);
          const referenceEnd = referenceProject(line.coordinates[1]);
          return { id: line.id, direction: line.direction, depth: line.depth, center, expected, start, end, referenceStart, referenceEnd, native: profile(viewer.canvas, nativePixels!, center, { x: end.x - start.x, y: end.y - start.y }), reference: profile(reference.getCanvas(), referencePixels!, expected, { x: referenceEnd.x - referenceStart.x, y: referenceEnd.y - referenceStart.y }) };
        }),
      };
    },
  };
}
declare global { interface Window { lineHorizon: Awaited<ReturnType<typeof createHorizon>> } }
void createHorizon().then(value => window.lineHorizon = value);
