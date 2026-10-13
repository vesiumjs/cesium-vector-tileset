import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { TestViewer } from './browser-types';
import { Cartesian3, Color, SceneMode, Viewer } from 'cesium';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { captureSymbolVertices } from './symbol-vertex-feedback';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const style: StyleSpecification = {
  version: 8,
  glyphs: '/unused-glyphs/{fontstack}/{range}.pbf',
  sources: {
    river: {
      type: 'geojson',
      maxzoom: 13,
      data: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[121.48753, 31.23726], [121.49153, 31.23726]] },
      },
    },
  },
  layers: [{
    id: 'river-text',
    type: 'symbol',
    source: 'river',
    layout: {
      'symbol-placement': 'line-center',
      'text-field': '黄浦江黄浦江黄浦江',
      'text-font': ['sans-serif'],
      'text-size': 14,
      'text-pitch-alignment': 'map',
      'text-rotation-alignment': 'map',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#ffffff' },
  }],
};

async function createLineTextZoom() {
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
  viewer.scene.globe.baseColor = Color.BLACK;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  // The public default generates all nine ideographs through GlyphSource/TinySDF.
  const tileset = new CesiumVectorTileset({ style });
  viewer.scene.primitives.add(tileset);
  const gl = viewer.scene.context._gl;
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
  let frames = 0;
  viewer.scene.postRender.addEventListener(() => frames++);
  const setHeight = (height: number) => {
    frames = 0;
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(121.48942, 31.23721, height),
      orientation: { heading: 60.6 * Math.PI / 180, pitch: -80.2 * Math.PI / 180, roll: 0 },
    });
    viewer.scene.requestRender();
  };
  setHeight(650.22);
  return {
    setHeight,
    ready: () => tileset.tilesLoaded && frames > 30,
    async capture() {
      const feedback = captureSymbolVertices(viewer.scene.context, 'river-text');
      let pixels: Uint8Array | undefined;
      const removeSample = viewer.scene.postRender.addEventListener(() => {
        if (feedback.result)
          pixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
      });
      try {
        for (let frame = 0; frame < 120 && !feedback.result && !feedback.error; frame++) {
          viewer.scene.requestRender();
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        if (feedback.error || !feedback.result || !pixels)
          throw new Error(feedback.error ?? 'No actual river text draw');
        // Retain framebuffer pixels from the same real draw to qualify SDF ink.
        let ink = 0;
        for (let pixel = 0; pixel < pixels.length; pixel += 4) {
          if (pixels[pixel] > 128 && pixels[pixel + 1] > 128 && pixels[pixel + 2] > 128)
            ink++;
        }
        return { height: viewer.camera.positionCartographic.height, gpu, errors, ink, ...feedback.result };
      }
      finally {
        removeSample();
        feedback.uninstall();
      }
    },
  };
}

declare global { interface Window { lineTextZoom: Awaited<ReturnType<typeof createLineTextZoom>> } }
void createLineTextZoom().then(value => window.lineTextZoom = value);
