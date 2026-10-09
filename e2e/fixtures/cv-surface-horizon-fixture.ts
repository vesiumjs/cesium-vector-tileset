import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { NativeCommand, TestTileset, TestViewer } from './browser-types';
import * as Cesium from 'cesium';
import { Cartesian2, Cartesian3, Color, Ray, SceneMode, Viewer, WebMercatorProjection } from 'cesium';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { drawBatchForOwner, linePaintForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import { layerRadialOffsetMeters } from '../../packages/cesium-vector-tileset/src/render/vector/tile-conversion';
import 'cesium/Build/Cesium/Widgets/widgets.css';

type Layers = 'water' | 'road' | 'combined';
export interface SurfaceCase {
  layers: Layers;
  globeDraw: boolean;
  pitch: number;
  depthTest?: boolean;
  terrainDepth?: boolean;
  logDepth?: boolean;
}
const radius = 6378137;
const circumference = 2 * Math.PI * radius;
const water = { west: -800, east: 800, south: 500, north: 18000 };
const road = { east: 150, south: 800, north: 12000, width: 10 };
const coordinate = (x: number, y: number): [number, number] => [x / radius * 180 / Math.PI, Math.atan(Math.sinh(y / radius)) * 180 / Math.PI];
const offsets = Array.from({ length: 20 }, (_, index) => index === 0 ? 0 : (index % 2 ? 1 : -1) * Math.ceil(index / 2) * 0.002);
const layerOrder = new Map([['water', 0], ['road', 1]]);
const waterHeight = layerRadialOffsetMeters('water', layerOrder);

function style(layers: Layers): StyleSpecification {
  return {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: {
      finite: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: { kind: 'water' }, geometry: { type: 'Polygon', coordinates: [[coordinate(water.west, water.south), coordinate(water.east, water.south), coordinate(water.east, water.north), coordinate(water.west, water.north), coordinate(water.west, water.south)]] } },
            { type: 'Feature', properties: { kind: 'road' }, geometry: { type: 'LineString', coordinates: [coordinate(road.east, road.south), coordinate(road.east, road.north)] } },
          ],
        },
      },
    },
    layers: [
      // Retain the same layer order and radial height in the road-only oracle.
      { id: 'water', type: 'fill' as const, source: 'finite', filter: ['==', 'kind', 'water'] as ['==', string, string], layout: { visibility: layers === 'road' ? 'none' as const : 'visible' as const }, paint: { 'fill-color': '#0000ff', 'fill-opacity': 1, 'fill-antialias': false } },
      ...(layers === 'water' ? [] : [{ id: 'road', type: 'line' as const, source: 'finite', filter: ['==', 'kind', 'road'] as ['==', string, string], layout: { 'line-cap': 'butt' as const, 'line-join': 'miter' as const }, paint: { 'line-color': '#ff0000', 'line-width': road.width, 'line-blur': 0 } }]),
    ],
  };
}

interface DrawObservation {
  kind: 'water' | 'road';
  tile: string;
  near: number;
  far: number;
  depthTest: boolean;
  depthMask: boolean;
  logShader: boolean;
  bounds?: { west: number; east: number; south: number; north: number };
}
interface RowObservation {
  y: number;
  surfaceHeight: number;
  north: number;
  eyeDepth: number;
  expected: number;
  missing: number;
  runs: Array<[number, number]>;
  colors: number[][];
}

async function createSurfaceHorizon() {
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
  const tileset = new CesiumVectorTileset({ style: style('water') }) as unknown as TestTileset;
  viewer.scene.primitives.add(tileset);
  const defaultTerrainDepth = viewer.scene.globe.depthTestAgainstTerrain;
  const defaultLogDepth = viewer.scene.logarithmicDepthBuffer;
  const states = new WeakMap<object, object>();
  const nativeRenderState = (Cesium as unknown as { RenderState: { fromCache: (state: object) => object } }).RenderState;
  const draws: DrawObservation[] = [];
  let current: SurfaceCase = { layers: 'water', globeDraw: true, pitch: 89 };
  let globeDrawAttempts = 0;
  let globeDraws = 0;
  const globePass = (Cesium as unknown as { Pass: { GLOBE: number } }).Pass.GLOBE;
  let warmFrames = 0;
  let collecting = false;
  let sampleIndex = 0;
  let metersPerPixel = 0;
  let roadHeight = layerRadialOffsetMeters('road', layerOrder);
  const frames: ReturnType<typeof capture>[] = [];
  const roadReferences = new Map<string, Array<{ mask: Uint8Array; pitch: number; position: Cartesian3; direction: Cartesian3; metersPerPixel: number; surfaceHeight: number }>>();
  const setCamera = (pitch: number) => {
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    const aspect = viewer.canvas.clientWidth / viewer.canvas.clientHeight;
    frustum.aspectRatio = aspect;
    frustum.fov = 2 * Math.atan(Math.tan(36.875112943 * Math.PI / 360) * aspect);
    viewer.camera.setView({ destination: new Cartesian3(0, 0, 120), convert: false, orientation: { heading: 0, pitch: (pitch - 90) * Math.PI / 180, roll: 0 } });
  };
  const originalDraw = viewer.scene.context.draw;
  viewer.scene.context.draw = function (command: NativeCommand, ...args) {
    if (command.pass === globePass) {
      globeDrawAttempts++;
      // Keep the actual Globe and its tile authorization available to the
      // tileset. This control isolates only the Globe's executing GPU draws.
      if (!current.globeDraw)
        return;
      globeDraws++;
    }
    const batch = drawBatchForOwner(command.owner);
    if (batch?.layerId === 'water' || batch?.layerId === 'road') {
      if (current.depthTest !== undefined && command.renderState.depthTest.enabled !== current.depthTest) {
        let state = states.get(command.renderState);
        if (!state) {
          state = nativeRenderState.fromCache({ ...command.renderState, depthTest: { ...command.renderState.depthTest, enabled: current.depthTest } });
          states.set(command.renderState, state);
        }
        // The diagnostic changes only this actual executing command's state,
        // after Native has derived log depth. It cannot suppress shader discard.
        command = Object.assign(Object.create(Object.getPrototypeOf(command)), command, { renderState: state });
      }
      const frustum = (this as unknown as { uniformState: { currentFrustum: Cartesian2 } }).uniformState.currentFrustum;
      const id = tileset._renderer.vector._records.get(batch.tileId)?.tileID;
      const canonical = id && ('canonical' in id ? id.canonical : id);
      const world = canonical && 2 ** canonical.z;
      draws.push({
        kind: batch.layerId,
        tile: batch.tileId,
        near: frustum.x,
        far: frustum.y,
        depthTest: command.renderState.depthTest.enabled,
        depthMask: command.renderState.depthMask,
        logShader: command.shaderProgram.fragmentShaderSource.defines.includes('LOG_DEPTH'),
        bounds: canonical && world
          ? {
              west: (canonical.x / world - 0.5) * circumference,
              east: ((canonical.x + 1) / world - 0.5) * circumference,
              south: (0.5 - (canonical.y + 1) / world) * circumference,
              north: (0.5 - canonical.y / world) * circumference,
            }
          : undefined,
      });
      const paint = linePaintForOwner(command.owner);
      if (paint) {
        metersPerPixel = paint.metersPerPixelUniform();
        roadHeight = paint.offsetUniform();
      }
    }
    return originalDraw.call(this, command, ...args);
  };

  function capture() {
    const canvas = viewer.canvas;
    const width = canvas.width;
    const height = canvas.height;
    const pixels = viewer.scene.context.readPixels({ width, height });
    const pitch = 90 + viewer.camera.pitch * 180 / Math.PI;
    const referenceKey = `${current.pitch}/${current.globeDraw}`;
    const roadFrames = roadReferences.get(referenceKey);
    if (current.layers === 'road') {
      const mask = new Uint8Array(width * height);
      // The independent road-only render has primary red paint over black.
      // Any nonzero red channel is its actual GPU support, including AA and
      // the real surface offset; no invented geometric/epsilon margin.
      for (let index = 0; index < mask.length; index++) mask[index] = pixels[index * 4] > 0 ? 1 : 0;
      roadFrames![sampleIndex] = { mask, pitch, position: Cartesian3.clone(viewer.camera.positionWC), direction: Cartesian3.clone(viewer.camera.directionWC), metersPerPixel, surfaceHeight: roadHeight };
    }
    const overlay = current.layers === 'combined' ? roadFrames?.[sampleIndex] : undefined;
    const overlayPaired = !!overlay && overlay.pitch === pitch && overlay.metersPerPixel === metersPerPixel && overlay.surfaceHeight === roadHeight
      && Cartesian3.equals(overlay.position, viewer.camera.positionWC) && Cartesian3.equals(overlay.direction, viewer.camera.directionWC);
    let overlayExcluded = 0;
    const rows = { water: [] as RowObservation[], road: [] as RowObservation[] };
    const totals = { water: { expected: 0, missing: 0, rows: 0 }, road: { expected: 0, missing: 0, rows: 0 } };
    const controls = { water: 0, road: 0 };
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 2] > 200 && pixels[index] < 32 && pixels[index + 1] < 32)
        controls.water++;
      if (pixels[index] > 200 && pixels[index + 1] < 32 && pixels[index + 2] < 32)
        controls.road++;
    }
    const coverage = (kind: 'water' | 'road', east: number, north: number, depth: number) => draws.some(draw => draw.kind === kind && draw.bounds
      && depth > draw.near && depth < draw.far && east >= draw.bounds.west && east <= draw.bounds.east && north >= draw.bounds.south && north <= draw.bounds.north);
    const ground = (x: number, y: number, surfaceHeight: number) => {
      const ray = viewer.camera.getPickRay(new Cartesian2(x, y));
      if (!ray)
        return undefined;
      const distance = (surfaceHeight - ray.origin.x) / ray.direction.x;
      return Number.isFinite(distance) && distance > 0 ? Ray.getPoint(ray, distance, new Cartesian3()) : undefined;
    };
    // With qualified heading=roll=0, a screen row intersects this actual
    // projected plane affinely in east; north and eye depth stay constant.
    for (let y = 4; y < height - 4; y++) {
      for (const kind of ['water', 'road'] as const) {
        if (current.layers !== 'combined' && current.layers !== kind)
          continue;
        const surfaceHeight = kind === 'water' ? waterHeight : roadHeight;
        const center = ground(width / 2 + 0.5, y + 0.5, surfaceHeight);
        const neighbor = ground(width / 2 + 1.5, y + 0.5, surfaceHeight);
        const above = ground(width / 2 + 0.5, y - 3.5, surfaceHeight);
        const below = ground(width / 2 + 0.5, y + 4.5, surfaceHeight);
        if (!center || !neighbor || !above || !below)
          continue;
        const perPixel = neighbor.y - center.y;
        if (!(perPixel > 0) || !Number.isFinite(perPixel))
          continue;
        const depth = Cartesian3.dot(Cartesian3.subtract(center, viewer.camera.positionWC, new Cartesian3()), viewer.camera.directionWC);
        const bounds = kind === 'water' ? water : road;
        if (Math.min(above.z, below.z) <= bounds.south || Math.max(above.z, below.z) >= bounds.north)
          continue;
        const halfWidth = metersPerPixel * road.width / 2;
        const west = kind === 'water' ? water.west : road.east - halfWidth;
        const east = kind === 'water' ? water.east : road.east + halfWidth;
        const first = Math.max(4, Math.ceil(width / 2 + (west - center.y) / perPixel + 4));
        const last = Math.min(width - 5, Math.floor(width / 2 + (east - center.y) / perPixel - 4));
        const row: RowObservation = { y, surfaceHeight, north: center.z, eyeDepth: depth, expected: 0, missing: 0, runs: [], colors: [] };
        let start: number | undefined;
        for (let x = first; x <= last; x++) {
          const groundEast = center.y + (x - width / 2) * perPixel;
          if (!coverage(kind, groundEast, center.z, depth))
            continue;
          const index = ((height - 1 - y) * width + x) * 4;
          if (kind === 'water' && overlayPaired && overlay!.mask[index / 4]) {
            overlayExcluded++;
            continue;
          }
          row.expected++;
          const present = kind === 'water'
            ? pixels[index + 2] > 200 && pixels[index] < 32 && pixels[index + 1] < 32
            : pixels[index] > 200 && pixels[index + 1] < 32 && pixels[index + 2] < 32;
          if (!present) {
            row.missing++;
            start ??= x;
            if (row.colors.length < 4)
              row.colors.push([x, ...pixels.subarray(index, index + 4)]);
          }
          else if (start !== undefined) {
            row.runs.push([start, x - 1]);
            start = undefined;
          }
        }
        if (start !== undefined)
          row.runs.push([start, last]);
        if (row.expected) {
          totals[kind].expected += row.expected;
          totals[kind].missing += row.missing;
          totals[kind].rows++;
          if (row.missing)
            rows[kind].push(row);
        }
      }
    }
    const frusta = (viewer.scene as unknown as { frustumCommandsList: Array<{ near: number; far: number; indices: number[] }> }).frustumCommandsList;
    return {
      index: sampleIndex,
      offset: offsets[sampleIndex],
      pitch,
      overlayPaired,
      overlayReference: current.layers === 'combined' ? referenceKey : undefined,
      overlayExcluded,
      frameNumber: viewer.scene._frameState.frameNumber,
      tilesLoaded: tileset.tilesLoaded,
      viewport: [width, height, canvas.clientWidth, canvas.clientHeight],
      camera: { position: Cartesian3.clone(viewer.camera.positionWC), direction: Cartesian3.clone(viewer.camera.directionWC), heading: viewer.camera.heading, roll: viewer.camera.roll, fov: (viewer.camera.frustum as PerspectiveFrustum).fovy },
      useLogDepth: viewer.scene._frameState.useLogDepth,
      sourceGlobeShow: viewer.scene.globe.show,
      globeDrawEnabled: current.globeDraw,
      globeDrawAttempts,
      globeDraws,
      terrainDepth: viewer.scene.globe.depthTestAgainstTerrain,
      frusta: frusta.map(frustum => ({ near: frustum.near, far: frustum.far, counts: [...frustum.indices] })),
      draws: [...draws],
      metersPerPixel,
      surfaceHeights: { water: waterHeight, road: roadHeight },
      controls,
      totals,
      holes: rows,
    };
  }
  viewer.scene.preUpdate.addEventListener(() => {
    if (collecting) {
      sampleIndex = frames.length;
      setCamera(current.pitch + offsets[sampleIndex]);
    }
  });
  viewer.scene.preRender.addEventListener(() => {
    draws.length = 0;
    globeDrawAttempts = 0;
    globeDraws = 0;
  });
  viewer.scene.postRender.addEventListener(() => {
    warmFrames++;
    if (collecting) {
      frames.push(capture());
      if (frames.length === offsets.length)
        collecting = false;
    }
  });
  setCamera(current.pitch);
  return {
    setCase(next: SurfaceCase) {
      current = next;
      collecting = false;
      frames.length = 0;
      warmFrames = 0;
      metersPerPixel = 0;
      roadHeight = layerRadialOffsetMeters('road', layerOrder);
      if (next.layers === 'road')
        roadReferences.set(`${next.pitch}/${next.globeDraw}`, []);
      tileset.setStyle(style(next.layers));
      viewer.scene.globe.show = true;
      viewer.scene.globe.depthTestAgainstTerrain = next.terrainDepth ?? defaultTerrainDepth;
      viewer.scene.logarithmicDepthBuffer = next.logDepth ?? defaultLogDepth;
      setCamera(next.pitch);
    },
    ready: () => tileset.tilesLoaded && warmFrames > 8 && (current.layers === 'road' || draws.some(draw => draw.kind === 'water')) && (current.layers === 'water' || draws.some(draw => draw.kind === 'road')),
    start() {
      if (!this.ready())
        throw new Error('Finite Native owners must be loaded and actually draw');
      frames.length = 0;
      collecting = true;
    },
    done: () => frames.length === offsets.length,
    capture() {
      const gl = viewer.scene.context._gl;
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return { configuration: current, errors: [...errors], gpu: String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)), subpixelBits: gl.getParameter(gl.SUBPIXEL_BITS) as number, defaults: { terrainDepth: defaultTerrainDepth, logDepth: defaultLogDepth }, liveQualification: { tilesLoaded: tileset.tilesLoaded, warmFrames, sourceGlobeShow: viewer.scene.globe.show, globeDrawAttempts, globeDraws, draws: [...draws] }, frames: [...frames] };
    },
  };
}
declare global { interface Window { cvSurfaceHorizon: Awaited<ReturnType<typeof createSurfaceHorizon>> } }
void createSurfaceHorizon().then(value => window.cvSurfaceHorizon = value);
