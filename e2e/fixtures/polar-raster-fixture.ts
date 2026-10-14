import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian3, Color, EllipsoidTerrainProvider, Matrix4, SceneMode, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

interface ReferenceTransform {
  projectionMatrix: ArrayLike<number>;
  modelViewProjectionMatrix: ArrayLike<number>;
  cameraPosition: ArrayLike<number>;
}
interface RasterDraw { globe: boolean; transition?: number }

// Inspect the actual linked program, including MapLibre's std140 uniforms.
// Reading a projection declaration alone cannot qualify a real globe draw.
function projectionTransition(gl: WebGL2RenderingContext, program: WebGLProgram): number | undefined {
  const name = 'u_projection_transition';
  const location = gl.getUniformLocation(program, name);
  if (location)
    return gl.getUniform(program, location) as number;
  const index = gl.getUniformIndices(program, [name])?.[0];
  if (index === undefined || index === gl.INVALID_INDEX)
    return undefined;
  const block = gl.getActiveUniforms(program, [index], gl.UNIFORM_BLOCK_INDEX)[0] as number;
  if (block < 0)
    return undefined;
  const offset = gl.getActiveUniforms(program, [index], gl.UNIFORM_OFFSET)[0] as number;
  const binding = gl.getActiveUniformBlockParameter(program, block, gl.UNIFORM_BLOCK_BINDING) as number;
  const buffer = gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, binding) as WebGLBuffer | null;
  if (!buffer)
    throw new Error('Actual raster projection uniform block is unbound');
  const start = gl.getIndexedParameter(gl.UNIFORM_BUFFER_START, binding) as number;
  const previous = gl.getParameter(gl.UNIFORM_BUFFER_BINDING) as WebGLBuffer | null;
  const value = new Float32Array(1);
  try {
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
    gl.getBufferSubData(gl.UNIFORM_BUFFER, start + offset, value);
  }
  finally {
    gl.bindBuffer(gl.UNIFORM_BUFFER, previous);
  }
  return value[0];
}

function gpu(gl: WebGL2RenderingContext): string {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}

function greenPixels(pixels: Uint8Array): number {
  let green = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < 3 && pixels[index + 1] > 252 && pixels[index + 2] < 3)
      green++;
  }
  return green;
}

async function createPolarComparison() {
  setWorkerUrl(workerUrl);
  const latitude = Number(new URLSearchParams(location.search).get('latitude'));
  if (latitude !== 90 && latitude !== -90)
    throw new Error('Polar coverage requires a public requested latitude of +90 or -90');
  const zoom = 4;
  const errors: string[] = [];
  const style: StyleSpecification = {
    version: 8,
    projection: { type: 'vertical-perspective' },
    sources: {
      imagery: { type: 'raster', tiles: [`${location.origin}${import.meta.env.BASE_URL}polar-tiles/{z}/{x}/{y}.png`], tileSize: 512, minzoom: 0, maxzoom: 4 },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
      { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 0 } },
    ],
  };
  // Request the pole through the public Map API. Its actual center clamps to
  // the Mercator limit; the visible spherical cap still extends past it.
  const reference = new MapLibre({
    container: 'reference',
    style,
    center: [0, latitude],
    zoom,
    minZoom: 0,
    maxZoom: 5,
    pitch: 0,
    interactive: false,
    attributionControl: false,
    canvasContextAttributes: { antialias: false, preserveDrawingBuffer: true },
  });
  reference.setVerticalFieldOfView(45);
  reference.on('error', event => errors.push(event.error.message));
  const gl = reference.getCanvas().getContext('webgl2');
  if (!gl)
    throw new Error('Actual raster globe comparison requires WebGL2');
  const programs = new WeakMap<WebGLProgram, { raster: boolean; globe: boolean }>();
  let draws: RasterDraw[] = [];
  let referenceDraws: RasterDraw[] = [];
  const originalDraw = gl.drawElements;
  gl.drawElements = function (...args) {
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    let detail = programs.get(program);
    if (!detail) {
      const source = (gl.getAttachedShaders(program) ?? []).map(shader => gl.getShaderSource(shader) ?? '').join('\n');
      detail = { raster: source.includes('u_image0') && source.includes('v_pos0'), globe: /^\s*#define\s+GLOBE\b/m.test(source) };
      programs.set(program, detail);
    }
    if (detail.raster)
      draws.push({ globe: detail.globe, transition: projectionTransition(gl, program) });
    return originalDraw.apply(this, args);
  };
  const roi = { x: 270, y: 310, width: 100, height: 100 };
  let referencePixels: Uint8Array | undefined;
  let referenceFrames = 0;
  reference.on('render', () => {
    referencePixels = new Uint8Array(roi.width * roi.height * 4);
    gl.readPixels(roi.x, roi.y, roi.width, roi.height, gl.RGBA, gl.UNSIGNED_BYTE, referencePixels);
    const error = gl.getError();
    if (error !== gl.NO_ERROR)
      errors.push(`Actual reference raster GL error: ${error}`);
    referenceDraws = draws;
    draws = [];
    referenceFrames = reference.loaded() ? referenceFrames + 1 : 0;
  });
  await new Promise<void>((resolve, reject) => {
    reference.once('load', () => resolve());
    reference.once('error', event => reject(event.error));
  });
  reference.jumpTo({ center: [0, latitude], zoom, pitch: 0 });
  const viewer = new Viewer('native', {
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    requestRenderMode: false,
    useBrowserRecommendedResolution: false,
    mapProjection: new WebMercatorProjection(),
    sceneMode: SceneMode.SCENE3D,
    contextOptions: { webgl: { antialias: false } },
    msaaSamples: 1,
  }) as unknown as TestViewer;
  viewer.scene.globe.baseColor = Color.BLACK;
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const transform = (reference as unknown as { _camera: { transform: ReferenceTransform } })._camera.transform;
  const view = Matrix4.multiply(Matrix4.inverse(Matrix4.fromArray(Array.from(transform.projectionMatrix)), new Matrix4()), Matrix4.fromArray(Array.from(transform.modelViewProjectionMatrix)), new Matrix4());
  const direction = Cartesian3.normalize(new Cartesian3(-view[2], -view[6], -view[10]), new Cartesian3());
  const up = Cartesian3.normalize(new Cartesian3(view[1], view[5], view[9]), new Cartesian3());
  const radius = 6378137;
  const pose = {
    position: new Cartesian3(transform.cameraPosition[2] * radius, transform.cameraPosition[0] * radius, transform.cameraPosition[1] * radius),
    direction: new Cartesian3(direction.z, direction.x, direction.y),
    up: new Cartesian3(up.z, up.x, up.y),
  };
  const frustum = viewer.camera.frustum as PerspectiveFrustum;
  frustum.fov = Math.PI / 4;
  frustum.aspectRatio = 640 / 720;
  frustum.near = 1;
  frustum.far = 1e9;
  // setView converts direction/up through ENU Euler angles and discards roll
  // near nadir. Copy the public basis to retain the actual reference pose.
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  Cartesian3.clone(pose.position, viewer.camera.position);
  Cartesian3.clone(pose.direction, viewer.camera.direction);
  Cartesian3.clone(pose.up, viewer.camera.up);
  Cartesian3.normalize(Cartesian3.cross(pose.direction, pose.up, new Cartesian3()), viewer.camera.right);
  const tileset = new CesiumVectorTileset({ style: structuredClone(style) }) as unknown as TestTileset;
  tileset.errorEvent.addEventListener(error => errors.push(error.stack ?? error.message));
  await tileset.whenReady();
  viewer.scene.primitives.add(tileset);
  let nativeFrames = 0;
  let nativePixels: Uint8Array | undefined;
  viewer.scene.postRender.addEventListener(() => {
    nativePixels = viewer.scene.context.readPixels(roi);
    nativeFrames = tileset.tilesLoaded && viewer.scene.globe.tilesLoaded ? nativeFrames + 1 : 0;
    if (referenceFrames < 20)
      reference.triggerRepaint();
  });
  const status = () => ({
    errors,
    nativeFrames,
    referenceFrames,
    tilesLoaded: tileset.tilesLoaded,
    sourceLoaded: tileset._renderer.style.tilePyramids.imagery.loaded(),
    terrainLoaded: viewer.scene.globe.tilesLoaded,
    referenceLoaded: reference.loaded(),
  });
  return {
    status,
    ready: () => nativeFrames >= 20 && referenceFrames >= 20 && status().sourceLoaded && status().referenceLoaded,
    capture: () => {
      if (!nativePixels || !referencePixels)
        throw new Error('Both renderers must supply actual post-render pixels');
      const nativeFov = frustum.fovy;
      if (nativeFov === undefined)
        throw new Error('The actual rendered camera must supply a vertical FOV');
      const nativeStyleZoom = tileset._renderer.evaluation.zoom;
      return {
        requestedLatitude: latitude,
        requestedZoom: zoom,
        center: reference.getCenter(),
        ...status(),
        green: { native: greenPixels(nativePixels), reference: greenPixels(referencePixels) },
        gpu: { native: gpu(viewer.scene.context._gl), reference: gpu(gl) },
        mode: viewer.scene.mode,
        viewport: {
          native: [viewer.canvas.width, viewer.canvas.height, viewer.canvas.clientWidth, viewer.canvas.clientHeight],
          reference: [reference.getCanvas().width, reference.getCanvas().height, reference.getCanvas().clientWidth, reference.getCanvas().clientHeight],
        },
        projection: { declared: reference.getProjection(), draws: referenceDraws },
        camera: {
          positionError: Cartesian3.distance(viewer.camera.positionWC, pose.position),
          directionError: Cartesian3.distance(viewer.camera.directionWC, pose.direction),
          upError: Cartesian3.distance(viewer.camera.upWC, pose.up),
          nativeFov: nativeFov * 180 / Math.PI,
          referenceFov: reference.getVerticalFieldOfView(),
          height: viewer.camera.positionCartographic.height,
          referenceZoom: reference.getZoom(),
          nativeStyleZoom,
          styleZoomDifference: nativeStyleZoom - reference.getZoom(),
        },
        terrain: {
          nativeEllipsoid: viewer.scene.terrainProvider instanceof EllipsoidTerrainProvider,
          reference: reference.getTerrain() ?? null,
          rectangles: viewer.scene.globe._surface._tilesToRender.map(tile => ({
            level: tile.level,
            x: tile.x,
            y: tile.y,
            north: tile.rectangle.north * 180 / Math.PI,
            south: tile.rectangle.south * 180 / Math.PI,
          })),
        },
        rasterTiles: tileset._renderer.raster.tileIds,
      };
    },
  };
}

declare global {
  interface Window { polarRaster: Awaited<ReturnType<typeof createPolarComparison>> }
}
void createPolarComparison().then(value => window.polarRaster = value);
