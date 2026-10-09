import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection, LineString } from 'geojson';
import type { NativePrimitive, TestTileset, TestViewer } from './browser-types';
import { Cartesian3, Color, Ellipsoid, HeadingPitchRange, Matrix4, SceneMode, SceneTransforms, Transforms, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { linePaintForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const query = new URLSearchParams(location.search);
const mode = query.get('mode')!;
const kind = query.get('kind')!;
const radius = Ellipsoid.WGS84.maximumRadius;
// The small high-latitude 3D patch lets a curved WGS84 scene qualify against
// MapLibre's flat ground to <0.05px. Every endpoint must pass that check;
// camera zoom, paint width and ground scale are never fitted to the pixels.
const latitude = mode === '3d' ? 84.8 : 0;
const mercatorY = radius * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
const coordinate = (x: number, y: number): [number, number] => [x / radius * 180 / Math.PI, Math.atan(Math.sinh((mercatorY + y) / radius)) * 180 / Math.PI];
const lines = [-600, 0, 600].map((y, depth) => ({ depth, coordinates: [coordinate(-450, y), coordinate(450, y)] }));
const data: FeatureCollection<LineString> = {
  type: 'FeatureCollection',
  features: lines.map(line => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line.coordinates } })),
};
const style: StyleSpecification = {
  version: 8,
  transition: { duration: 0, delay: 0 },
  sources: { roads: { type: 'geojson', data } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#224455' } },
    { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'miter' }, paint: { 'line-color': '#ff0000', 'line-width': 12, 'line-gap-width': 0, 'line-offset': 0, 'line-blur': 0, ...(kind === 'dash' ? { 'line-dasharray': [100000, 1] } : {}) } },
  ],
};

function gpu(gl: WebGL2RenderingContext) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}

async function createAntialias() {
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
    msaaSamples: 4,
    mapProjection: new WebMercatorProjection(),
    sceneMode: mode === '3d' ? SceneMode.SCENE3D : SceneMode.COLUMBUS_VIEW,
  }) as unknown as TestViewer;
  viewer.scene.globe.baseColor = Color.fromCssColorString('#224455');
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  viewer.scene.backgroundColor = Color.fromCssColorString('#224455');
  viewer.scene.debugShowFramesPerSecond = true;
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const reference = new MapLibre({
    container: 'maplibre',
    style: structuredClone(style),
    center: [0, latitude],
    zoom: 14,
    pitch: 45,
    bearing: 35,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    canvasContextAttributes: { antialias: false },
  });
  reference.on('error', event => errors.push(event.error.message));
  reference.setVerticalFieldOfView(45);
  const tileset = new CesiumVectorTileset({ style: structuredClone(style) }) as unknown as TestTileset;
  viewer.scene.primitives.add(tileset);
  // This coverage comparison isolates a common ground plane. The normal
  // globe separation lift is unrelated to line width and otherwise shifts
  // Native's pixel phase relative to MapLibre's zero-elevation source.
  viewer.scene.preRender.addEventListener(() => {
    for (const id of tileset._renderer.vector.tileIds) {
      for (const collection of tileset._renderer.vector.getTileCollections(id)) {
        for (let index = 0; index < ('length' in collection ? Number(collection.length) : 0); index++) {
          const entry = (collection as { get: (index: number) => NativePrimitive & { primitive?: NativePrimitive } }).get(index);
          const paint = linePaintForOwner(entry.primitive ?? entry);
          if (paint)
            paint.offset = 0;
        }
      }
    }
  });
  const frustum = viewer.camera.frustum as PerspectiveFrustum;
  frustum.fov = Math.PI / 4;
  frustum.aspectRatio = viewer.canvas.clientWidth / viewer.canvas.clientHeight;
  const distance = viewer.canvas.clientHeight / (2 * Math.tan(Math.PI / 8)) * 2 * Math.PI * radius / (512 * 2 ** 14);
  const angle = Math.PI / 4;
  const heading = 35 * Math.PI / 180;
  if (mode === '3d') {
    const sine = Math.sin(latitude * Math.PI / 180);
    const eccentricitySquared = 1 - (Ellipsoid.WGS84.minimumRadius / radius) ** 2;
    const eastScale = Math.cos(latitude * Math.PI / 180) / Math.sqrt(1 - eccentricitySquared * sine * sine);
    viewer.camera.lookAt(Cartesian3.fromDegrees(0, latitude), new HeadingPitchRange(heading, -angle, distance * eastScale));
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  }
  else {
    viewer.camera.setView({
      destination: new Cartesian3(-distance * Math.sin(angle) * Math.sin(heading), -distance * Math.sin(angle) * Math.cos(heading), distance * Math.cos(angle)),
      convert: false,
      orientation: { heading, pitch: -angle, roll: 0 },
    });
  }
  let nativePixels: Uint8Array | undefined;
  let referencePixels: Uint8Array | undefined;
  let nativeFrames = 0;
  let referenceFrames = 0;
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
  const reset = () => {
    nativePixels = undefined;
    referencePixels = undefined;
    nativeFrames = 0;
    referenceFrames = 0;
    viewer.scene.requestRender();
    reference.triggerRepaint();
  };
  const project = (position: number[]) => SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromDegrees(position[0], position[1]))!;
  const sample = (canvas: HTMLCanvasElement, pixels: Uint8Array, x: number, y: number) => Array.from(pixels.slice(((canvas.height - 1 - y) * canvas.width + x) * 4, ((canvas.height - 1 - y) * canvas.width + x) * 4 + 3));
  return {
    setWidth(width: number) {
      const next = structuredClone(style);
      next.layers[1].paint!['line-width'] = width;
      tileset.setStyle(next);
      reference.setPaintProperty('roads', 'line-width', width);
      reference.jumpTo({ zoom: tileset._renderer.evaluation.zoom });
      reset();
    },
    ready: () => tileset.tilesLoaded && reference.loaded() && !!nativePixels && !!referencePixels && nativeFrames > 2 && referenceFrames > 0,
    capture(width: number) {
      if (!nativePixels || !referencePixels)
        throw new Error('Both renderers must draw before coverage can be compared');
      const ratio = viewer.canvas.width / viewer.canvas.clientWidth;
      // MapLibre measures pitch/bearing in the target ground frame. Cesium's
      // camera.pitch/heading getters use the camera's local frame in 3D.
      const targetFrame = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, latitude)), new Matrix4());
      const direction = mode === '3d'
        ? Matrix4.multiplyByPointAsVector(targetFrame, viewer.camera.directionWC, new Cartesian3())
        : new Cartesian3(viewer.camera.directionWC.y, viewer.camera.directionWC.z, viewer.camera.directionWC.x);
      return {
        errors,
        stats: tileset.stats(),
        nativePaintedPixels: nativePixels.filter((value, index) => index % 4 === 0 && value > 80).length,
        fps: viewer.scene.debugShowFramesPerSecond,
        msaaSamples: viewer.scene.msaaSamples,
        mode: viewer.scene.mode,
        camera: { latitude, pitch: reference.getPitch(), nativePitch: Math.acos(-direction.z) * 180 / Math.PI, bearing: reference.getBearing(), nativeBearing: Math.atan2(direction.x, direction.y) * 180 / Math.PI, zoom: reference.getZoom(), nativeZoom: tileset._renderer.evaluation.zoom, fov: reference.getVerticalFieldOfView(), nativeFov: frustum.fovy * 180 / Math.PI },
        gpu: { native: gpu(viewer.scene.context._gl), reference: gpu(reference.getCanvas().getContext('webgl2')!) },
        viewport: { native: [viewer.canvas.width, viewer.canvas.height, viewer.canvas.clientWidth, viewer.canvas.clientHeight], reference: [reference.getCanvas().width, reference.getCanvas().height, reference.getCanvas().clientWidth, reference.getCanvas().clientHeight] },
        lines: lines.map((line) => {
          const start = project(line.coordinates[0]);
          const end = project(line.coordinates[1]);
          const referenceStart = reference.project(line.coordinates[0]);
          const referenceEnd = reference.project(line.coordinates[1]);
          const tangent = { x: end.x - start.x, y: end.y - start.y };
          const length = Math.hypot(tangent.x, tangent.y);
          const normal = { x: -tangent.y / length, y: tangent.x / length };
          return {
            depth: line.depth,
            ratio,
            start,
            end,
            referenceStart,
            referenceEnd,
            length,
            profiles: [0.2, 0.5, 0.8].map((progress) => {
              const center = { x: start.x + tangent.x * progress, y: start.y + tangent.y * progress };
              const samples = new Map();
              for (let across = -width - 4; across <= width + 4; across += 0.5) {
                for (const along of [-1, 0, 1]) {
                  const x = Math.floor((center.x + normal.x * across + tangent.x / length * along) * ratio);
                  const y = Math.floor((center.y + normal.y * across + tangent.y / length * along) * ratio);
                  const rgb = sample(viewer.canvas, nativePixels!, x, y);
                  const expected = sample(reference.getCanvas(), referencePixels!, x, y);
                  samples.set(`${x}/${y}`, { x, y, rgb, expected });
                }
              }
              return { progress, center, samples: [...samples.values()] as Array<{ x: number; y: number; rgb: number[]; expected: number[] }> };
            }),
          };
        }),
      };
    },
  };
}
declare global {
  interface Window { lineAntialias: Awaited<ReturnType<typeof createAntialias>> }
}
void createAntialias().then(value => window.lineAntialias = value);
