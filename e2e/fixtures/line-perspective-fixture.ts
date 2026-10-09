import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection, LineString } from 'geojson';
import type { TestViewer } from './browser-types';
import { Cartesian3, Color, SceneMode, SceneTransforms, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const radius = 6378137;
const zoom = 14;
const fov = 45;
const width = 10;
const coordinate = (x: number, y: number): [number, number] => [x / radius * 180 / Math.PI, Math.atan(Math.sinh(y / radius)) * 180 / Math.PI];
const lines = [-1500, 0, 1500].flatMap((y, depth) => [
  { id: `east-${depth}`, direction: 'east', depth, center: coordinate(-450, y), coordinates: [coordinate(-750, y), coordinate(-150, y)] },
  { id: `north-${depth}`, direction: 'north', depth, center: coordinate(450, y), coordinates: [coordinate(450, y - 100), coordinate(450, y + 100)] },
]);
// Every camera view uses this same finite GeoJSON. No MVT fixture duplicates
// roads across tiles, and the reference draws through MapLibre's real worker.
const data: FeatureCollection<LineString> = {
  type: 'FeatureCollection',
  features: lines.map(line => ({ type: 'Feature', properties: { id: line.id }, geometry: { type: 'LineString', coordinates: line.coordinates } })),
};
const style: StyleSpecification = {
  version: 8,
  transition: { duration: 0, delay: 0 },
  sources: { roads: { type: 'geojson', data } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
    { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'butt', 'line-join': 'miter' }, paint: { 'line-color': '#ff0000', 'line-width': width, 'line-gap-width': 0, 'line-offset': 0, 'line-blur': 0 } },
  ],
};

function gpu(gl: WebGL2RenderingContext) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
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
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  viewer.scene.backgroundColor = Color.BLACK;
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const reference = new MapLibre({ container: 'maplibre', style: structuredClone(style), center: [0, 0], zoom, pitch: 0, maxPitch: 85, bearing: 0, interactive: false, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: false } });
  reference.on('error', event => errors.push(event.error.message));
  reference.setVerticalFieldOfView(fov);
  const tileset = new CesiumVectorTileset({ style: structuredClone(style) });
  viewer.scene.primitives.add(tileset);
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
  const setPitch = (pitch: number) => {
    const canvas = viewer.canvas;
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    frustum.fov = fov * Math.PI / 180;
    frustum.aspectRatio = canvas.clientWidth / canvas.clientHeight;
    const metersPerPixel = 2 * Math.PI * radius / (512 * 2 ** zoom);
    const distance = canvas.clientHeight / (2 * Math.tan(fov * Math.PI / 360)) * metersPerPixel;
    const angle = pitch * Math.PI / 180;
    // CV's public convert:false destination is east/north/height. Its world
    // axes and the production shader swizzle this into height/east/north.
    viewer.camera.setView({ destination: new Cartesian3(0, -distance * Math.sin(angle), distance * Math.cos(angle)), convert: false, orientation: { heading: 0, pitch: angle - Math.PI / 2, roll: 0 } });
    reference.jumpTo({ center: [0, 0], zoom, bearing: 0, pitch });
    nativePixels = undefined;
    referencePixels = undefined;
    nativeFrames = 0;
    referenceFrames = 0;
    viewer.scene.requestRender();
    reference.triggerRepaint();
  };
  const project = (position: [number, number]) => SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromDegrees(...position))!;
  const profile = (canvas: HTMLCanvasElement, pixels: Uint8Array, center: { x: number; y: number }, tangent: { x: number; y: number }) => {
    const ratio = canvas.width / canvas.clientWidth;
    const length = Math.hypot(tangent.x, tangent.y);
    const normal = { x: -tangent.y / length, y: tangent.x / length };
    // Integrate actual composited red alpha over black, averaging five
    // parallel profiles. Bilinear sampling accounts for oblique pixel phase.
    const sample = (x: number, y: number) => {
      const pixelX = x * ratio - 0.5;
      const pixelY = y * ratio - 0.5;
      const x0 = Math.floor(pixelX);
      const y0 = Math.floor(pixelY);
      const tx = pixelX - x0;
      const ty = pixelY - y0;
      let alpha = 0;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const px = x0 + dx;
          const py = y0 + dy;
          if (px >= 0 && px < canvas.width && py >= 0 && py < canvas.height)
            alpha += pixels[((canvas.height - 1 - py) * canvas.width + px) * 4] / 255 * (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
        }
      }
      return alpha;
    };
    const profiles = [-2, -1, 0, 1, 2].map((along) => {
      const rows = Array.from({ length: 241 }, (_, index) => {
        const across = (index - 120) * 0.25;
        return { across, alpha: sample(center.x + normal.x * across + tangent.x / length * along, center.y + normal.y * across + tangent.y / length * along) };
      });
      return { alphaWidth: rows.reduce((sum, row) => sum + row.alpha * 0.25, 0), maximum: Math.max(...rows.map(row => row.alpha)), rows };
    });
    return { alphaWidth: profiles.reduce((sum, item) => sum + item.alphaWidth, 0) / profiles.length, maximum: Math.max(...profiles.map(item => item.maximum)), profiles };
  };
  setPitch(0);
  return {
    setPitch,
    ready: () => tileset.tilesLoaded && reference.loaded() && !!nativePixels && !!referencePixels && nativeFrames > 2 && referenceFrames > 0,
    capture() {
      if (!nativePixels || !referencePixels)
        throw new Error('Both real renderers must produce a framebuffer');
      return {
        errors,
        camera: { pitch: reference.getPitch(), zoom: reference.getZoom(), fov: reference.getVerticalFieldOfView(), nativeFov: (viewer.camera.frustum as PerspectiveFrustum).fovy * 180 / Math.PI, nativePitch: 90 + viewer.camera.pitch * 180 / Math.PI, nativePosition: Cartesian3.clone(viewer.camera.positionWC) },
        gpu: { native: gpu(viewer.scene.context._gl), reference: gpu(reference.getCanvas().getContext('webgl2')!) },
        viewport: { native: [viewer.canvas.width, viewer.canvas.height, viewer.canvas.clientWidth, viewer.canvas.clientHeight], reference: [reference.getCanvas().width, reference.getCanvas().height, reference.getCanvas().clientWidth, reference.getCanvas().clientHeight] },
        lines: lines.map((line) => {
          const center = project(line.center);
          const expected = reference.project(line.center);
          const start = project(line.coordinates[0]);
          const end = project(line.coordinates[1]);
          const referenceStart = reference.project(line.coordinates[0]);
          const referenceEnd = reference.project(line.coordinates[1]);
          return { id: line.id, direction: line.direction, depth: line.depth, center, expected, start, end, referenceStart, referenceEnd, native: profile(viewer.canvas, nativePixels!, center, { x: end.x - start.x, y: end.y - start.y }), reference: profile(reference.getCanvas(), referencePixels!, expected, { x: referenceEnd.x - referenceStart.x, y: referenceEnd.y - referenceStart.y }) };
        }),
      };
    },
  };
}

declare global {
  interface Window { linePerspective: Awaited<ReturnType<typeof createPerspective>> }
}
void createPerspective().then(value => window.linePerspective = value);
