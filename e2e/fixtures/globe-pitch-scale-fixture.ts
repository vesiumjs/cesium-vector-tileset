import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { FeatureCollection } from 'geojson';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian3, Cartographic, Color, Matrix4, SceneMode, SceneTransforms, Transforms, Viewer } from 'cesium';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const longitude = 121.47454;
const latitude = 31.24313;
const height = 263.38;
const heading = 103.6 * Math.PI / 180;
const origin = Cartesian3.fromDegrees(longitude, latitude);
const local = Transforms.eastNorthUpToFixedFrame(origin);
function coordinate(ahead: number, right: number): [number, number] {
  const position = Matrix4.multiplyByPoint(local, new Cartesian3(ahead * Math.sin(heading) + right * Math.cos(heading), ahead * Math.cos(heading) - right * Math.sin(heading), 0), new Cartesian3());
  const location = Cartographic.fromCartesian(position);
  return [location.longitude * 180 / Math.PI, location.latitude * 180 / Math.PI];
}
const anchors = {
  text: coordinate(1200, -180),
  road: coordinate(1200, 0),
  building: coordinate(1200, 220),
};
const data: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { kind: 'text' }, geometry: { type: 'Point', coordinates: anchors.text } },
    { type: 'Feature', properties: { kind: 'road' }, geometry: { type: 'LineString', coordinates: [coordinate(900, 0), coordinate(1500, 0)] } },
    { type: 'Feature', properties: { kind: 'building' }, geometry: { type: 'Polygon', coordinates: [[coordinate(1150, 180), coordinate(1250, 180), coordinate(1250, 260), coordinate(1150, 260), coordinate(1150, 180)]] } },
  ],
};
const style: StyleSpecification = {
  version: 8,
  transition: { duration: 0, delay: 0 },
  glyphs: '/unused-glyphs/{fontstack}/{range}.pbf',
  sources: { features: { type: 'geojson', data } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
    { id: 'road', type: 'line', source: 'features', filter: ['==', 'kind', 'road'], paint: { 'line-color': '#ff0000', 'line-width': 24 } },
    { id: 'building', type: 'fill-extrusion', source: 'features', minzoom: 14, filter: ['==', 'kind', 'building'], paint: { 'fill-extrusion-color': '#0000ff', 'fill-extrusion-height': 60, 'fill-extrusion-opacity': 1 } },
    { id: 'text', type: 'symbol', source: 'features', filter: ['==', 'kind', 'text'], layout: { 'text-field': '中', 'text-font': ['sans-serif'], 'text-size': 14, 'text-pitch-alignment': 'viewport', 'text-rotation-alignment': 'viewport', 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } },
  ],
};

async function createGlobePitchScale() {
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
    sceneMode: SceneMode.SCENE3D,
  }) as unknown as TestViewer;
  const scene = viewer.scene;
  scene.globe.baseColor = Color.BLACK;
  scene.globe.depthTestAgainstTerrain = false;
  scene.skyAtmosphere!.show = false;
  scene.skyBox!.show = false;
  scene.backgroundColor = Color.BLACK;
  const errors: string[] = [];
  scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const tileset = new CesiumVectorTileset({ style }) as unknown as TestTileset;
  scene.primitives.add(tileset);
  let pixels: Uint8Array | undefined;
  let frames = 0;
  let extrusionDraws = 0;
  let pitch = -6.9;
  const draw = scene.context.draw;
  scene.context.draw = function (command, ...args) {
    const result = draw.call(this, command, ...args);
    if ((drawBatchForOwner(command) ?? drawBatchForOwner(command.owner))?.kind === 'extrusion')
      extrusionDraws++;
    return result;
  };
  scene.preRender.addEventListener(() => extrusionDraws = 0);
  scene.postRender.addEventListener(() => {
    frames++;
    pixels = scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
  });
  function setPitch(value: number) {
    pitch = value;
    frames = 0;
    pixels = undefined;
    viewer.camera.setView({ destination: Cartesian3.fromDegrees(longitude, latitude, height), orientation: { heading, pitch: pitch * Math.PI / 180, roll: 0 } });
    scene.requestRender();
  }
  const colored = (x: number, y: number, color: 'white' | 'red' | 'blue') => {
    if (!pixels || x < 0 || y < 0 || x >= viewer.canvas.width || y >= viewer.canvas.height)
      return false;
    const index = ((viewer.canvas.height - 1 - y) * viewer.canvas.width + x) * 4;
    const [r, g, b] = pixels.subarray(index, index + 3);
    return color === 'white' ? r > 128 && g > 128 && b > 128 : color === 'red' ? r > 128 && r > g + 80 && r > b + 80 : b > 80 && b > r + 40 && b > g + 40;
  };
  function ink(center: { x: number; y: number }, color: 'white' | 'blue', radius: number) {
    let count = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = Math.floor(center.y - radius); y <= Math.ceil(center.y + radius); y++) {
      for (let x = Math.floor(center.x - radius); x <= Math.ceil(center.x + radius); x++) {
        if (!colored(x, y, color))
          continue;
        count++;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    return { count, width: count ? x1 - x0 + 1 : 0, height: count ? y1 - y0 + 1 : 0 };
  }
  setPitch(-6.9);
  return {
    setPitch,
    ready: () => tileset.tilesLoaded && frames > 30 && !!pixels,
    capture() {
      if (!pixels)
        throw new Error('A rendered framebuffer is required');
      const centers = {
        text: SceneTransforms.worldToWindowCoordinates(scene, Cartesian3.fromDegrees(...anchors.text))!,
        road: SceneTransforms.worldToWindowCoordinates(scene, Cartesian3.fromDegrees(...anchors.road))!,
        building: SceneTransforms.worldToWindowCoordinates(scene, Cartesian3.fromDegrees(...anchors.building))!,
      };
      const roadProfile = [-1, 0, 1].map((offset) => {
        let width = 0;
        for (let x = Math.floor(centers.road.x - 100); x <= Math.ceil(centers.road.x + 100); x++)
          width += Number(colored(x, Math.round(centers.road.y) + offset, 'red'));
        return width;
      });
      const gl = scene.context._gl;
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return { pitch, height: viewer.camera.positionCartographic.height, errors, tilesLoaded: tileset.tilesLoaded, gpu: String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)), styleZoom: tileset._renderer.evaluation.zoom, centers, extrusionDraws, building: ink(centers.building, 'blue', 120), text: ink(centers.text, 'white', 70), road: { width: roadProfile.reduce((sum, value) => sum + value, 0) / roadProfile.length, profile: roadProfile } };
    },
  };
}
declare global { interface Window { globePitchScale: Awaited<ReturnType<typeof createGlobePitchScale>> } }
void createGlobePitchScale().then(value => window.globePitchScale = value);
