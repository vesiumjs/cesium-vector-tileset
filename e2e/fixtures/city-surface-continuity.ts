import type { MapGeoJSONFeature, Map as MapLibre } from 'maplibre-gl';
import type { OverscaledTileID } from '../../packages/cesium-vector-tileset/src/tile/tile-id';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian3, SceneTransforms } from 'cesium';
import { cameraZoom } from '../../packages/cesium-vector-tileset/src/render/scene/covering';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';

type Coordinate = [number, number];
interface MotionState { phase: string; poseIndex: number }
interface ScreenPoint { x: number; y: number }
const WATER_COLOR = [158, 189, 255];
const RIVER_POINT: Coordinate = [-0.12, 51.507];

function roi(canvas: HTMLCanvasElement, point: ScreenPoint | undefined, read: (x: number, y: number, width: number, height: number) => Uint8Array) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
    return { inViewport: false, waterPixels: 0, pixels: [] as number[] };
  const inViewport = point.x >= 0 && point.y >= 0 && point.x < canvas.clientWidth && point.y < canvas.clientHeight;
  if (!inViewport)
    return { inViewport, waterPixels: 0, pixels: [] as number[] };
  const centerX = Math.floor(point.x * canvas.width / canvas.clientWidth);
  const centerY = canvas.height - 1 - Math.floor(point.y * canvas.height / canvas.clientHeight);
  const x = Math.max(0, centerX - 8);
  const y = Math.max(0, centerY - 8);
  const width = Math.min(17, canvas.width - x);
  const height = Math.min(17, canvas.height - y);
  const pixels = read(x, y, width, height);
  let waterPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (WATER_COLOR.every((channel, index) => Math.abs(pixels[offset + index] - channel) <= 5))
      waterPixels++;
  }
  return { inViewport, x, y, width, height, waterPixels, pixels: Array.from(pixels) };
}

function feature(value: MapGeoJSONFeature) {
  return { id: value.id, layerId: value.layer.id, source: value.source, sourceLayer: value.sourceLayer, properties: value.properties };
}

function waterFeatures(map: MapLibre, point: ScreenPoint) {
  return map.queryRenderedFeatures([point.x, point.y], { layers: ['water'] }).map(feature);
}

function tileID(id: OverscaledTileID) {
  return { key: id.key, z: id.canonical.z, x: id.canonical.x, y: id.canonical.y, overscaledZ: id.overscaledZ, wrap: id.wrap };
}

/** Read once, after actual missing pixels; never advances or shows an owner. */
function nativeOwnerSnapshot(viewer: TestViewer, tileset: TestTileset, frame: number | undefined, poseIndex: number) {
  const started = performance.now();
  const identities = new WeakMap<object, number>();
  let nextIdentity = 1;
  const identify = (value: object) => {
    let id = identities.get(value);
    if (id === undefined) {
      id = nextIdentity++;
      identities.set(value, id);
    }
    return id;
  };
  const commandCounts = { water: 0, waterway_river: 0 };
  const commands = viewer.scene._frameState.commandList.flatMap((command) => {
    const batch = drawBatchForOwner(command) ?? drawBatchForOwner(command.owner);
    if (batch?.layerId !== 'water' && batch?.layerId !== 'waterway_river')
      return [];
    commandCounts[batch.layerId]++;
    return [{ ...batch, ownerId: identify(command.owner), vertexArrayId: command.vertexArray && identify(command.vertexArray), pass: command.pass }];
  });
  interface Owner {
    show?: boolean;
    ready?: boolean;
    isDestroyed?: () => boolean;
    _state?: number;
    _va?: object[];
    _renderContext?: { vertexArray?: object };
    // Native PrimitiveCollection's stored children, without calling get().
    _primitives?: object[];
  }
  const owners: Array<{
    tileId: string;
    tileID?: ReturnType<typeof tileID>;
    ownerId: number;
    origin: string;
    live?: boolean;
    show?: boolean;
    ancestorVisible: boolean;
    attached: boolean;
    destroyed?: boolean;
    ready?: boolean;
    nativeState?: number;
    vertexArrayIds: number[];
    rootPendingFirstUpdate: boolean;
    rootDrawableIndices?: number[];
  }> = [];
  const inspect = (root: object, origin: string) => {
    const visited = new Set<object>();
    const attached = tileset._renderer.collections._root.contains(root as Parameters<typeof tileset._renderer.collections._root.contains>[0]);
    const firstUpdate = tileset._renderer.collections._firstUpdates[0].get(root as Parameters<typeof tileset._renderer.collections._firstUpdates[0]['get']>[0])
      ?? tileset._renderer.collections._firstUpdates[1].get(root as Parameters<typeof tileset._renderer.collections._firstUpdates[1]['get']>[0]);
    const visit = (value: object, ancestorVisible: boolean) => {
      if (visited.has(value))
        return;
      visited.add(value);
      const owner = value as Owner;
      const destroyed = owner.isDestroyed?.();
      const batch = drawBatchForOwner(value);
      if (batch?.layerId === 'water') {
        const id = batch.tileId ?? 'unknown';
        const sceneTile = tileset._renderer.residency._tiles.get(id);
        owners.push({
          tileId: id,
          tileID: sceneTile && tileID(sceneTile.tileID),
          ownerId: identify(value),
          origin,
          live: sceneTile?.live,
          show: owner.show,
          ancestorVisible,
          attached,
          destroyed,
          ready: owner.ready,
          nativeState: owner._state,
          vertexArrayIds: destroyed ? [] : (owner._va ?? (owner._renderContext?.vertexArray ? [owner._renderContext.vertexArray] : [])).map(identify),
          rootPendingFirstUpdate: firstUpdate !== undefined,
          rootDrawableIndices: firstUpdate && [...firstUpdate.drawable],
        });
      }
      if (!batch && !destroyed && Array.isArray(owner._primitives)) {
        for (const child of owner._primitives)
          visit(child, ancestorVisible && owner.show !== false);
      }
    };
    visit(root, true);
  };
  for (const [id, record] of tileset._renderer.vector._records) {
    for (const [kind, collection] of record.collections) {
      if (kind.startsWith('polygons') || drawBatchForOwner(collection)?.layerId === 'water')
        inspect(collection, `current:${id}`);
    }
  }
  for (const [id, record] of tileset._renderer.vector._retired.entries()) {
    for (const [kind, collection] of record.collections) {
      if (kind.startsWith('polygons') || drawBatchForOwner(collection)?.layerId === 'water')
        inspect(collection, `retired:${id}`);
    }
  }
  for (const replacement of tileset._renderer.collections._replacements) {
    if (replacement.kind === 'vector') {
      for (const collection of replacement.old) inspect(collection, `replacement-old:${replacement.tileId}`);
      for (const collection of replacement.next) inspect(collection, `replacement-next:${replacement.tileId}`);
    }
  }
  const sources = Object.entries(tileset._renderer.style.tilePyramids).filter(([id]) => id === 'openmaptiles').map(([sourceId, pyramid]) => {
    const sync = tileset._renderer.residency._sources.get(sourceId);
    const covering = pyramid._covering;
    const globe = tileset._renderer.covering._globeCoverings.get(pyramid);
    const active = pyramid._activeTiles.getAllTiles().map(tile => ({
      ...tileID(tile.tileID),
      state: tile.state,
      bucketCount: Object.keys(tile.buckets).length,
      waterBucket: Boolean(tile.buckets.water),
      waterwayBucket: Boolean(tile.buckets.waterway_river),
    }));
    return {
      sourceId,
      coveringZoom: covering?.zoom,
      desiredZoom: globe?.zoom.zoom,
      primaryZoom: globe?.primaryZoom,
      primaryRevision: globe?.primaryRevision,
      deferred: globe?.deferred,
      cameraConfirmed: tileset._renderer.covering._cameraPose === tileset._renderer.covering._observedCamera,
      ideal: covering?.idealTileIDs.map(tileID),
      renderable: sync?.renderableIds.map(key => ({ key, id: pyramid.getTileByID(key) && tileID(pyramid.getTileByID(key)!.tileID) })),
      held: sync && [...sync.held],
      active,
    };
  });
  return {
    diagnosticOnly: true as const,
    fairTiming: false as const,
    boundary: 'One postRender snapshot after a real in-viewport zero-water ROI at pose 19/20; command counts are queued commands, not actual GPU draws',
    frame,
    poseIndex,
    at: started,
    styleZoom: tileset._renderer.evaluation.zoom,
    commandCounts,
    commands,
    owners,
    sources,
    hiddenSurfaceLayers: [...tileset._renderer.residency.hiddenSurfaceLayers].map(([id, layers]) => ({ tileId: id, layers: [...layers] })),
    jobs: [...tileset._renderer.publishQueue._jobs].map(([id, job]) => ({ tileId: id, surfaces: job.surfaces, symbols: job.symbols, progress: { ...job.progress } })),
    observerCpuMs: performance.now() - started,
  };
}

function createRecorder(requestFrame: () => void) {
  let coordinate = RIVER_POINT;
  let armed = false;
  let initialPending = false;
  let observerCpuMs = 0;
  const frames: SurfaceFrame[] = [];
  return {
    get coordinate() { return coordinate; },
    get armed() { return armed; },
    frames,
    setCoordinate(value: Coordinate) {
      coordinate = [...value];
      frames.length = 0;
      armed = true;
      initialPending = true;
      observerCpuMs = 0;
      requestFrame();
    },
    sample(state: MotionState) {
      const sampled = initialPending || state.poseIndex === 19 || state.poseIndex === 20;
      initialPending = false;
      return sampled;
    },
    record(frame: SurfaceFrame, started: number) {
      frames.push(frame);
      frame.observerCpuMs = performance.now() - started;
      observerCpuMs += frame.observerCpuMs;
    },
    snapshot() {
      return {
        diagnosticOnly: true as const,
        fairTiming: false as const,
        sampling: 'Initial frame once and every actual rendered frame at poses 19/20; all other frames have metadata only, without owner or Source scans',
        observerCpuMs,
        observerCpuBoundary: 'Armed render callbacks, including synchronous ROI readback; excludes pre-arm Map point confirmation',
        coordinate,
        color: WATER_COLOR,
        roiRadiusFramebufferPixels: 8,
        frames,
      };
    },
  };
}

interface SurfaceFrame extends MotionState {
  at: number;
  sampled: boolean;
  observerCpuMs: number;
  zoom?: number;
  projected?: ScreenPoint;
  roi?: ReturnType<typeof roi>;
  frame?: number;
  camera?: { destination: number[]; direction: number[]; up: number[] };
  waterFeatures?: ReturnType<typeof waterFeatures>;
  mapFrame?: number;
  defaultFramebuffer?: boolean;
  mapCamera?: { center: Coordinate; bearing: number; pitch: number };
  ownerSnapshot?: ReturnType<typeof nativeOwnerSnapshot>;
}

export function nativeSurfaceContinuity(viewer: TestViewer, tileset: () => TestTileset | undefined, motion: () => MotionState) {
  const recorder = createRecorder(() => viewer.scene.requestRender());
  const observeOwners = new URLSearchParams(location.search).get('citySurfaceOwners') === '1';
  let ownersCaptured = false;
  viewer.scene.postRender.addEventListener(() => {
    const current = tileset();
    if (!recorder.armed || !current)
      return;
    const started = performance.now();
    const state = motion();
    const sampled = recorder.sample(state);
    const camera = viewer.camera;
    const frame: SurfaceFrame = {
      ...state,
      at: started,
      sampled,
      observerCpuMs: 0,
      frame: viewer.scene._frameState.frameNumber,
      camera: { destination: [camera.positionWC.x, camera.positionWC.y, camera.positionWC.z], direction: [camera.directionWC.x, camera.directionWC.y, camera.directionWC.z], up: [camera.upWC.x, camera.upWC.y, camera.upWC.z] },
    };
    if (sampled) {
      const projected = SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromDegrees(...recorder.coordinate));
      frame.projected = projected && { x: projected.x, y: projected.y };
      frame.roi = roi(viewer.canvas, projected, (x, y, width, height) => viewer.scene.context.readPixels({ x, y, width, height }));
      frame.zoom = cameraZoom({ camera, mode: viewer.scene.mode, projection: viewer.scene.mapProjection, width: viewer.canvas.clientWidth, height: viewer.canvas.clientHeight });
      if (observeOwners && !ownersCaptured && (state.poseIndex === 19 || state.poseIndex === 20)
        && frame.roi.inViewport && frame.roi.pixels.length > 0 && frame.roi.waterPixels === 0) {
        ownersCaptured = true;
        frame.ownerSnapshot = nativeOwnerSnapshot(viewer, current, frame.frame, state.poseIndex);
      }
    }
    recorder.record(frame, started);
  });
  return { setCoordinate: recorder.setCoordinate, snapshot: recorder.snapshot, riverPoint: () => undefined };
}

export function mapSurfaceContinuity(map: MapLibre, motion: () => MotionState) {
  const recorder = createRecorder(() => map.triggerRepaint());
  let confirmed: { coordinate: Coordinate; features: ReturnType<typeof waterFeatures> } | undefined;
  let mapFrame = 0;
  const canvas = map.getCanvas();
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl)
    throw new Error('Surface continuity requires the actual MapLibre WebGL context');
  const read = (x: number, y: number, width: number, height: number) => {
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };
  return {
    setCoordinate: recorder.setCoordinate,
    snapshot: recorder.snapshot,
    riverPoint: () => confirmed,
    sample() {
      mapFrame++;
      if (!confirmed && map.loaded() && gl.getParameter(gl.FRAMEBUFFER_BINDING) === null) {
        // Confirm actual rendered water near the requested River point. A
        // coordinate alone is never evidence that this source contains water.
        const offsets = [0, -0.001, 0.001, -0.002, 0.002, -0.004, 0.004];
        for (const latitude of offsets) {
          for (const longitude of offsets) {
            const coordinate: Coordinate = [RIVER_POINT[0] + longitude, RIVER_POINT[1] + latitude];
            const projected = map.project(coordinate);
            const features = waterFeatures(map, projected);
            if (features.length > 0 && roi(canvas, projected, read).waterPixels > 0) {
              confirmed = { coordinate, features };
              break;
            }
          }
          if (confirmed)
            break;
        }
      }
      if (!recorder.armed)
        return;
      // Loading frames remain part of the oracle. Every actual _render gets
      // metadata; only the initial frame and target poses perform readback.
      const started = performance.now();
      const state = motion();
      const sampled = recorder.sample(state);
      const center = map.getCenter();
      const frame: SurfaceFrame = {
        ...state,
        at: started,
        sampled,
        observerCpuMs: 0,
        mapFrame,
        mapCamera: { center: [center.lng, center.lat], bearing: map.getBearing(), pitch: map.getPitch() },
      };
      if (sampled) {
        const projected = map.project(recorder.coordinate);
        frame.defaultFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) === null;
        frame.zoom = map.getZoom();
        frame.projected = { x: projected.x, y: projected.y };
        frame.roi = roi(canvas, projected, read);
        frame.waterFeatures = waterFeatures(map, projected);
      }
      recorder.record(frame, started);
    },
  };
}

declare global {
  interface Window { citySurfaceContinuity?: Pick<ReturnType<typeof mapSurfaceContinuity>, 'setCoordinate' | 'snapshot' | 'riverPoint'> }
}
