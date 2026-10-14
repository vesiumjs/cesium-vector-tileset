import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection } from 'geojson';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian3, Cartesian4, Color, EllipsoidTerrainProvider, Matrix4, SceneMode, Viewer, WebMercatorProjection } from 'cesium';
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
interface ExtrusionDraw { globe: boolean; transition?: number; tileMercator?: number[] }

// Inspect the actual linked program, including MapLibre's std140 uniforms.
// Reading a projection declaration alone cannot qualify a real globe draw.
function uniformValues(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, count: number): number[] | undefined {
  const location = gl.getUniformLocation(program, name);
  if (location) {
    const value = gl.getUniform(program, location) as number | ArrayLike<number>;
    return typeof value === 'number' ? [value] : Array.from(value);
  }
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
    throw new Error('Actual extrusion projection uniform block is unbound');
  const start = gl.getIndexedParameter(gl.UNIFORM_BUFFER_START, binding) as number;
  const previous = gl.getParameter(gl.UNIFORM_BUFFER_BINDING) as WebGLBuffer | null;
  const value = new Float32Array(count);
  try {
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
    gl.getBufferSubData(gl.UNIFORM_BUFFER, start + offset, value);
  }
  finally {
    gl.bindBuffer(gl.UNIFORM_BUFFER, previous);
  }
  return Array.from(value);
}

function gpu(gl: WebGL2RenderingContext): string {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}

async function createWallComparison() {
  setWorkerUrl(workerUrl);
  const zoom = 12.25;
  const base = 3000;
  const height = 3080;
  const errors: string[] = [];
  const point = (x: number, y: number): [number, number] => [
    (32 + x / 8192) / 64 * 360 - 180,
    Math.atan(Math.sinh(Math.PI * (1 - 2 * (32 + y / 8192) / 64))) * 180 / Math.PI,
  ];
  const polygon: FeatureCollection = { type: 'FeatureCollection', features: [{
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[
      point(2048, 0),
      point(6144, 0),
      point(6144, 4096),
      point(2048, 4096),
      point(2048, 0),
    ]] },
  }] };
  const style: StyleSpecification = {
    version: 8,
    projection: { type: 'vertical-perspective' },
    light: { intensity: 0 },
    sources: { buildings: { type: 'geojson', data: polygon, maxzoom: 6, tolerance: 0 } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
      { id: 'buildings', type: 'fill-extrusion', source: 'buildings', paint: {
        'fill-extrusion-color': '#00ff00',
        'fill-extrusion-base': base,
        'fill-extrusion-height': height,
        'fill-extrusion-vertical-gradient': false,
      } },
    ],
  };
  const reference = new MapLibre({
    container: 'reference',
    style,
    center: [2.8125, 0],
    zoom,
    minZoom: 0,
    maxZoom: 25,
    maxPitch: 85,
    pitch: 65,
    bearing: 180,
    interactive: false,
    attributionControl: false,
    canvasContextAttributes: { antialias: false, preserveDrawingBuffer: true },
  });
  reference.setVerticalFieldOfView(45);
  reference.on('error', event => errors.push(event.error.message));
  const gl = reference.getCanvas().getContext('webgl2');
  if (!gl)
    throw new Error('Actual extrusion globe comparison requires WebGL2');
  const programs = new WeakMap<WebGLProgram, { extrusion: boolean; globe: boolean }>();
  let draws: ExtrusionDraw[] = [];
  let referenceDraws: ExtrusionDraw[] = [];
  const originalDraw = gl.drawElements;
  gl.drawElements = function (...args) {
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    let detail = programs.get(program);
    if (!detail) {
      const source = (gl.getAttachedShaders(program) ?? []).map(shader => gl.getShaderSource(shader) ?? '').join('\n');
      detail = { extrusion: gl.getAttribLocation(program, 'a_normal_ed') >= 0, globe: /^\s*#define\s+GLOBE\b/m.test(source) };
      programs.set(program, detail);
    }
    if (detail.extrusion)
      draws.push({ globe: detail.globe, transition: uniformValues(gl, program, 'u_projection_transition', 1)?.[0], tileMercator: uniformValues(gl, program, 'u_projection_tile_mercator_coords', 4) });
    return originalDraw.apply(this, args);
  };
  const roi = { x: 0, y: 0, width: 640, height: 720 };
  let referencePixels: Uint8Array | undefined;
  let referenceFrames = 0;
  reference.on('render', () => {
    referencePixels = new Uint8Array(roi.width * roi.height * 4);
    gl.readPixels(roi.x, roi.y, roi.width, roi.height, gl.RGBA, gl.UNSIGNED_BYTE, referencePixels);
    const error = gl.getError();
    if (error !== gl.NO_ERROR)
      errors.push(`Actual reference extrusion GL error: ${error}`);
    referenceDraws = draws;
    draws = [];
    referenceFrames = reference.loaded() ? referenceFrames + 1 : 0;
  });
  await new Promise<void>((resolve, reject) => {
    reference.once('load', () => resolve());
    reference.once('error', event => reject(event.error));
  });
  reference.jumpTo({ center: [2.8125, 0], zoom, pitch: 65, bearing: 180 });
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
  Cartesian3.clone(pose.position, viewer.camera.position);
  Cartesian3.clone(pose.direction, viewer.camera.direction);
  Cartesian3.clone(pose.up, viewer.camera.up);
  Cartesian3.normalize(Cartesian3.cross(pose.direction, pose.up, viewer.camera.right), viewer.camera.right);
  const tileset = new CesiumVectorTileset({ style: structuredClone(style) }) as unknown as TestTileset;
  tileset.errorEvent.addEventListener(error => errors.push(error.stack ?? error.message));
  await tileset.whenReady();
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
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
    sourceLoaded: tileset._renderer.style.tilePyramids.buildings.loaded(),
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
      const profile = Array.from({ length: roi.height }, (_, y) => {
        const offset = (y * roi.width + roi.width / 2) * 4;
        return { y: roi.height - y - 0.5, native: Array.from(nativePixels!.slice(offset, offset + 3)), reference: Array.from(referencePixels!.slice(offset, offset + 3)) };
      });
      // This whole-frame mask remains a diagnostic. The two Earth models'
      // outer edges are not accepted by inventing a large pixel tolerance.
      const silhouette = { native: 0, reference: 0, different: 0 };
      for (let index = 0; index < nativePixels.length; index += 4) {
        const native = nativePixels[index + 1] > 127;
        const reference = referencePixels[index + 1] > 127;
        silhouette.native += Number(native);
        silhouette.reference += Number(reference);
        silhouette.different += Number(native !== reference);
      }
      // The reference's formal globe shader elevates a unit sphere using
      // GLOBE_RADIUS=6371008.8. Project the known face boundaries using its
      // actual MVP; qualify interior roof/wall pixels independently of color.
      const project = (x: number, y: number, elevation: number) => {
        const [longitude, latitude] = point(x, y).map(value => value * Math.PI / 180);
        const radius = 1 + elevation / 6371008.8;
        const clip = Matrix4.multiplyByVector(Matrix4.fromArray(Array.from(transform.modelViewProjectionMatrix)), new Cartesian4(
          Math.sin(longitude) * Math.cos(latitude) * radius,
          Math.sin(latitude) * radius,
          Math.cos(longitude) * Math.cos(latitude) * radius,
          1,
        ), new Cartesian4());
        return { x: (1 + clip.x / clip.w) * roi.width / 2, y: (1 - clip.y / clip.w) * roi.height / 2 };
      };
      const facePoints = { wallTop: project(4096, 0, height), wallBase: project(4096, 0, base), roofFar: project(4096, 4096, height) };
      const nativeMvp = Matrix4.multiply(frustum.projectionMatrix, viewer.camera.viewMatrix, new Matrix4());
      const edgeModels = [
        { name: 'wall-top-center', x: 4096, y: 0, elevation: height },
        { name: 'wall-base-center', x: 4096, y: 0, elevation: base },
        { name: 'wall-top-left', x: 2048, y: 0, elevation: height },
        { name: 'wall-top-right', x: 6144, y: 0, elevation: height },
        { name: 'roof-far-center', x: 4096, y: 4096, elevation: height },
      ].map(({ name, x, y, elevation }) => {
        const [longitude, latitude] = point(x, y);
        const ecef = Cartesian3.fromDegrees(longitude, latitude, elevation);
        const clip = Matrix4.multiplyByVector(nativeMvp, new Cartesian4(ecef.x, ecef.y, ecef.z, 1), new Cartesian4());
        const native = { x: (1 + clip.x / clip.w) * roi.width / 2, y: (1 - clip.y / clip.w) * roi.height / 2 };
        const reference = project(x, y, elevation);
        return {
          name,
          longitude,
          latitude,
          elevation,
          native,
          reference,
          referenceEffectiveHeight: elevation * 6378137 / 6371008.8,
          difference: { x: reference.x - native.x, y: reference.y - native.y, distance: Math.hypot(reference.x - native.x, reference.y - native.y) },
        };
      });
      const faceRows = {
        wall: profile.filter(row => row.y > facePoints.wallTop.y + 1 && row.y < facePoints.wallBase.y - 1).map(row => row.y),
        roof: profile.filter(row => row.y > facePoints.roofFar.y + 1 && row.y < facePoints.wallTop.y - 1).map(row => row.y),
      };
      const pyramid = tileset._renderer.style.tilePyramids.buildings;
      const nativeCanonical = pyramid.getRenderableIds().map((id) => {
        const tile = pyramid.getTileByID(id)!;
        return { ...tile.tileID.canonical, buckets: Object.keys(tile.buckets) };
      });
      const referenceCanonical = referenceDraws.flatMap((draw) => {
        if (!draw.tileMercator)
          return [];
        const z = Math.round(Math.log2(1 / (8192 * draw.tileMercator[2])));
        return [{ z, x: Math.round(draw.tileMercator[0] * 2 ** z), y: Math.round(draw.tileMercator[1] * 2 ** z) }];
      });
      return {
        requestedZoom: zoom,
        base,
        height,
        center: reference.getCenter(),
        ...status(),
        silhouette,
        profile,
        faces: { points: facePoints, rows: faceRows },
        edgeModels,
        source: { nativeCanonical, referenceCanonical },
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
          referencePitch: reference.getPitch(),
          referenceBearing: reference.getBearing(),
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
        vectorTiles: tileset._renderer.vector.tileIds,
      };
    },
  };
}

declare global {
  interface Window { extrusionWall: Awaited<ReturnType<typeof createWallComparison>> }
}
void createWallComparison().then(value => window.extrusionWall = value);
