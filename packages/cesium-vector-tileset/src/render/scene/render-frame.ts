import type { Camera, CullingVolume, MapProjection, Scene } from 'cesium';
import type { TileCovering } from '../../tile/tile-pyramid';
import type { VectorDrapingProvider } from '../vector/vector-tile-renderer';
import type { CameraFocus } from './camera-focus';
import type { CameraBounds } from './covering';
import type { GlobeLike } from './globe-covering';
import { Cartesian2, Cartesian3, Math as CesiumMath, GeographicProjection, IntersectionTests, SceneMode, WebMercatorProjection } from 'cesium';
import { MAX_TILE_ZOOM } from '../../geo/world-bounds';
import { columbusCameraFocus, globeCameraFocus } from './camera-focus';
import { cameraZoom, mapZoomToSourceZoom, planarCameraBounds, planarTileIDs } from './covering';
import { sourceLodCamera, SourceTileLod } from './source-tile-lod';

/** The Cesium frame fields consumed by tileset rendering. */
export interface RenderFrameState {
  newFrame?: boolean;
  mode?: SceneMode;
  scene3DOnly?: boolean;
  passes?: { render?: boolean; pick?: boolean };
  commandList?: Array<{ owner?: { appearance?: unknown }; pass: number }>;
  cullingVolume?: Pick<CullingVolume, 'computeVisibility'>;
  occluder?: unknown;
  camera: Pick<Camera, 'positionCartographic' | 'positionWC' | 'directionWC' | 'rightWC' | 'upWC' | 'frustum' | 'getPickRay'> & {
    viewMatrix?: ArrayLike<number>;
    /** Camera's owning scene supplies the rendered globe and CSS canvas size. */
    _scene?: Partial<Pick<Scene, 'primitives' | 'requestRender' | 'requestRenderMode' | 'mode' | 'preUpdate' | 'preRender' | 'postRender'>> & {
      globe?: GlobeLike;
      canvas?: HTMLCanvasElement;
      mapProjection?: MapProjection;
      vectorProvider?: VectorDrapingProvider;
      _frameState?: RenderFrameState;
    };
  };
  canvasHeight?: number;
  drawingBufferHeight?: number;
  pixelRatio?: number;
  frameNumber?: number;
  afterRender?: Array<() => boolean>;
  context?: {
    drawingBufferHeight?: number;
    drawingBufferWidth?: number;
  };
  mapProjection?: MapProjection;
}

export interface CoveringSource {
  type?: string;
  minzoom?: number;
  maxzoom?: number;
  tileSize?: number;
  reparseOverscaled?: boolean;
}

export interface CoveringTilePyramid {
  getSource: () => CoveringSource;
}

export type RenderCovering = TileCovering & { styleZoom: number };
export type RenderZoom = Omit<RenderCovering, 'idealTileIDs'>;
export type CoveringCache = WeakMap<object, RenderZoom>;

/** Full camera state shared by every viewport rendered within one scene frame. */
export interface CameraFrameSnapshot {
  readonly frameNumber: number;
  readonly mode: SceneMode;
  readonly viewMatrix: readonly number[];
  readonly positionWC: Readonly<Cartesian3>;
  readonly projectionMatrix: readonly number[];
  readonly centerLng: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly mapProjection: MapProjection;
  readonly cameraToCenterDistance: number | undefined;
  readonly orthographic: boolean;
}

interface CameraCache {
  frame: RenderFrameState;
  frameNumber?: number;
  position: Cartesian3;
  direction: Cartesian3;
  right: Cartesian3;
  mode: SceneMode;
  projection: MapProjection;
  width: number;
  height: number;
  centerLng: number;
  fovY?: number;
  aspectRatio?: number;
  frustumWidth?: number;
  frustumTop?: number;
  frustumBottom?: number;
  frustumLeft?: number;
  frustumRight?: number;
  bounds?: CameraBounds;
  coverings: WeakMap<object, { camera: CameraCache; zoom: RenderZoom; lod: SourceTileLod; covering: RenderCovering }>;
  sourceLodCamera: ReturnType<typeof sourceLodCamera>;
  sourceLodMeasured: boolean;
  focus?: CameraFocus;
  sourceLods: WeakMap<object, { camera: CameraCache; source: CoveringSource; sourceZoom: number; minZoom: number; maxZoom: number; round: boolean; reparse: boolean; lod: SourceTileLod }>;
  zoom?: number;
  styleZoom?: number;
  centerDistanceMeasured?: boolean;
  cameraToCenterDistance?: number;
}

// One camera measurement per cache/frame, shared by every source.
const cameras = new WeakMap<CoveringCache, CameraCache>();
const STYLE_ZOOM_TOLERANCE = 1e-4;

function focusForCamera(camera: RenderFrameState['camera'], mode: SceneMode, projection: MapProjection, width: number, height: number): CameraFocus | undefined {
  return mode === SceneMode.COLUMBUS_VIEW
    ? columbusCameraFocus(camera, projection, height)
    : mode === SceneMode.SCENE3D ? globeCameraFocus(camera, projection, width, height) : undefined;
}

function zoomForCamera(frame: RenderFrameState, cache: CoveringCache, sceneMode?: SceneMode): CameraCache | undefined {
  const previous = cameras.get(cache);
  if (sceneMode === undefined && frame.frameNumber !== undefined && previous?.frame === frame && previous.frameNumber === frame.frameNumber) {
    return previous;
  }
  const { camera } = frame;
  const canvas = camera._scene?.canvas;
  const projection = frame.mapProjection ?? camera._scene?.mapProjection;
  if (!canvas || !projection) {
    return undefined;
  }
  const mode = sceneMode ?? frame.mode ?? SceneMode.SCENE3D;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const frustum = camera.frustum as { fovy?: number; aspectRatio?: number; width?: number; left?: number; right?: number; top?: number; bottom?: number };
  const fovY = frustum.fovy;
  const aspectRatio = frustum.aspectRatio;
  const frustumWidth = frustum.width ?? (frustum.right !== undefined && frustum.left !== undefined ? frustum.right - frustum.left : undefined);
  if (previous && previous.mode === mode && previous.projection === projection
    && previous.width === width && previous.height === height
    && previous.fovY === fovY && previous.aspectRatio === aspectRatio && previous.frustumWidth === frustumWidth
    && previous.frustumTop === frustum.top && previous.frustumBottom === frustum.bottom
    && previous.frustumLeft === frustum.left && previous.frustumRight === frustum.right
    && Cartesian3.equals(previous.position, camera.positionWC)
    // Cesium normalizes the world basis when local axes change.
    && Cartesian3.equalsEpsilon(previous.direction, camera.directionWC, CesiumMath.EPSILON14)
    && Cartesian3.equalsEpsilon(previous.right, camera.rightWC, CesiumMath.EPSILON14)
    // Near-identical bases can cross the finite-focus boundary. Preserve
    // normalization reuse only while the actual projection/focus agrees.
    && (mode === SceneMode.SCENE2D || Cartesian3.equals(previous.direction, camera.directionWC)
      || Boolean(previous.focus) === Boolean(focusForCamera(camera, mode, projection, width, height)))) {
    previous.frame = frame;
    previous.frameNumber = frame.frameNumber;
    return previous;
  }
  const input = { camera, mode, projection, width, height };
  const focus = focusForCamera(camera, mode, projection, width, height);
  // Near-horizon scale belongs to the current finite focus. Unsupported sky
  // views retain the last surface scale, or initially sample the bottom row.
  const zoom = focus?.zoom ?? cameraZoom(input) ?? previous?.zoom ?? cameraZoom({ ...input, sampleY: height - 1 });
  const styleZoom = !focus && zoom !== undefined && previous?.styleZoom !== undefined
    && previous.mode === mode && previous.projection === projection
    && previous.width === width && previous.height === height
    && Math.abs(zoom - previous.styleZoom) < STYLE_ZOOM_TOLERANCE
    ? previous.styleZoom
    : zoom;
  const current: CameraCache = {
    frame,
    frameNumber: frame.frameNumber,
    position: Cartesian3.clone(camera.positionWC),
    direction: Cartesian3.clone(camera.directionWC),
    right: Cartesian3.clone(camera.rightWC),
    mode,
    projection,
    width,
    height,
    centerLng: camera.positionCartographic.longitude * 180 / Math.PI,
    fovY,
    aspectRatio,
    frustumWidth,
    frustumTop: frustum.top,
    frustumBottom: frustum.bottom,
    frustumLeft: frustum.left,
    frustumRight: frustum.right,
    bounds: mode === SceneMode.SCENE2D ? planarCameraBounds(camera, projection) : undefined,
    coverings: previous?.coverings ?? new WeakMap(),
    sourceLodCamera: undefined,
    sourceLodMeasured: false,
    focus,
    sourceLods: previous?.sourceLods ?? new WeakMap(),
    zoom,
    styleZoom,
  };
  cameras.set(cache, current);
  return current;
}

/** Symbol perspective distance uses the same units as the Native view clip W. */
function cameraCenterDistance(frame: RenderFrameState, camera: CameraCache): number | undefined {
  if (camera.focus)
    return camera.focus.cameraToCenterDistance;
  if (camera.mode === SceneMode.COLUMBUS_VIEW) {
    if (!(camera.projection instanceof GeographicProjection || camera.projection instanceof WebMercatorProjection)
      || camera.zoom === undefined || camera.fovY === undefined) {
      return undefined;
    }
    const focal = camera.height / 2 / Math.tan(camera.fovY / 2);
    let length = 1;
    if (camera.projection instanceof GeographicProjection) {
      const location = camera.projection.unproject(new Cartesian3(camera.position.y, camera.position.z, camera.position.x));
      const cosLatitude = Math.cos(location.latitude);
      if (!(cosLatitude > 0) || Math.abs(location.latitude) >= Math.PI / 2)
        return undefined;
      length = Math.hypot(camera.direction.x, camera.direction.y, camera.direction.z / cosLatitude);
    }
    const distance = 2 * Math.PI * camera.projection.ellipsoid.maximumRadius / (512 * 2 ** camera.zoom) * focal / length;
    return Number.isFinite(distance) && distance > 0 ? distance : undefined;
  }
  if (camera.mode !== SceneMode.SCENE3D)
    return undefined;
  const ray = frame.camera.getPickRay(new Cartesian2(camera.width / 2, camera.height / 2));
  if (!ray)
    return undefined;
  const intersection = IntersectionTests.rayEllipsoid(ray, camera.projection.ellipsoid);
  const distance = intersection?.start;
  return distance !== undefined && Number.isFinite(distance) && distance > 0 ? distance : undefined;
}

/** Measure before Cesium temporarily clips and moves its 2D viewport camera. */
export function captureCameraForFrame(frame: RenderFrameState, cache: CoveringCache, mode: SceneMode): CameraFrameSnapshot | undefined {
  const camera = zoomForCamera(frame, cache, mode);
  const viewMatrix = frame.camera.viewMatrix;
  const projectionMatrix = (frame.camera.frustum as { projectionMatrix?: ArrayLike<number> }).projectionMatrix;
  const drawingBufferWidth = frame.context?.drawingBufferWidth;
  const drawingBufferHeight = frame.context?.drawingBufferHeight;
  if (!camera || frame.frameNumber === undefined || !viewMatrix || !projectionMatrix
    || drawingBufferWidth === undefined || drawingBufferHeight === undefined || frame.pixelRatio === undefined) {
    return undefined;
  }
  const orthographic = mode === SceneMode.SCENE2D || projectionMatrix[15] === 1;
  if (!camera.centerDistanceMeasured) {
    camera.cameraToCenterDistance = orthographic ? undefined : cameraCenterDistance(frame, camera);
    camera.centerDistanceMeasured = true;
  }
  return Object.freeze({
    frameNumber: frame.frameNumber,
    mode,
    viewMatrix: Object.freeze(Array.from(viewMatrix)),
    positionWC: Object.freeze(Cartesian3.clone(frame.camera.positionWC)),
    projectionMatrix: Object.freeze(Array.from(projectionMatrix)),
    centerLng: camera.centerLng,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio: frame.pixelRatio,
    mapProjection: camera.projection,
    cameraToCenterDistance: camera.cameraToCenterDistance,
    orthographic,
  });
}

/** Stable identity of the camera pose and viewport, excluding near/far clipping. */
export function cameraPoseForFrame(frame: RenderFrameState, cache: CoveringCache, mode?: SceneMode): object | undefined {
  return zoomForCamera(frame, cache, mode);
}

/** Camera style zoom is shared; source selection has its own limits and size. */
export function zoomForFrame(
  tilePyramid: CoveringTilePyramid,
  frameState: RenderFrameState,
  cache: CoveringCache,
  zoomLevelsToOverscale = 0,
): RenderZoom | undefined {
  const camera = zoomForCamera(frameState, cache);
  if (camera?.zoom === undefined || camera.styleZoom === undefined) {
    return undefined;
  }
  const source = tilePyramid.getSource();
  const minzoom = Math.max(0, source.minzoom ?? 0);
  const maxzoom = Math.max(minzoom, source.maxzoom ?? 24);
  const overscale = (source.type ?? 'vector') === 'vector' ? Math.max(0, zoomLevelsToOverscale) : 0;
  const sourceZoom = mapZoomToSourceZoom(camera.zoom, source.tileSize);
  const zoom = Math.max(minzoom, Math.min((source.type === 'raster' ? Math.round : Math.floor)(sourceZoom), source.reparseOverscaled ? MAX_TILE_ZOOM : maxzoom + overscale));
  const centerLng = camera.centerLng;
  const cached = cache.get(tilePyramid);
  if (cached?.zoom === zoom && cached.styleZoom === camera.styleZoom && cached.centerLng === centerLng
    && cached.width === camera.width && cached.height === camera.height) {
    return cached;
  }
  const covering: RenderZoom = { zoom, styleZoom: camera.styleZoom, centerLng, width: camera.width, height: camera.height };
  cache.set(tilePyramid, covering);
  return covering;
}

/** Share source perspective rules and camera measurements until the pose changes. */
export function sourceTileLodForFrame(tilePyramid: CoveringTilePyramid, frame: RenderFrameState, cache: CoveringCache, overscale: number): SourceTileLod | undefined {
  const camera = zoomForCamera(frame, cache);
  const zoom = zoomForFrame(tilePyramid, frame, cache, overscale);
  if (!camera || camera.zoom === undefined || !zoom)
    return undefined;
  const source = tilePyramid.getSource();
  const sourceZoom = mapZoomToSourceZoom(camera.zoom, source.tileSize);
  const minZoom = Math.max(0, source.minzoom ?? 0);
  const maxZoom = Math.min(MAX_TILE_ZOOM, Math.max(minZoom, source.maxzoom ?? 24)
    + ((source.type ?? 'vector') === 'vector' ? Math.max(0, overscale) : 0));
  const round = source.type === 'raster';
  const reparse = source.reparseOverscaled === true;
  const previous = camera.sourceLods.get(tilePyramid);
  if (previous?.camera === camera && previous.source === source && previous.sourceZoom === sourceZoom
    && previous.minZoom === minZoom && previous.maxZoom === maxZoom && previous.round === round && previous.reparse === reparse) {
    return previous.lod;
  }
  if (!camera.sourceLodMeasured) {
    camera.sourceLodCamera = sourceLodCamera(frame, camera.projection, camera.width, camera.height, camera.focus ?? null);
    camera.sourceLodMeasured = true;
  }
  const lod = new SourceTileLod(camera.sourceLodCamera, sourceZoom, minZoom, maxZoom, round, reparse);
  camera.sourceLods.set(tilePyramid, { camera, source, sourceZoom, minZoom, maxZoom, round, reparse, lod });
  return lod;
}

/** Full projected camera covering, independent of terrain geometry LOD. */
export function planarCoveringForFrame(tilePyramid: CoveringTilePyramid, frame: RenderFrameState, cache: CoveringCache, overscale: number): RenderCovering | undefined {
  const camera = zoomForCamera(frame, cache);
  const zoom = zoomForFrame(tilePyramid, frame, cache, overscale);
  if (!camera?.bounds || camera.zoom === undefined || !zoom)
    return undefined;
  const lod = sourceTileLodForFrame(tilePyramid, frame, cache, overscale)!;
  const previous = camera.coverings.get(tilePyramid);
  if (previous?.camera === camera && previous.zoom === zoom && previous.lod === lod)
    return previous.covering;
  const source = tilePyramid.getSource();
  const sourceZoom = mapZoomToSourceZoom(camera.zoom, source.tileSize);
  const selectedZoom = (source.type === 'raster' ? Math.round : Math.floor)(sourceZoom);
  const selected = selectedZoom < (source.minzoom ?? 0) ? [] : planarTileIDs(camera.bounds, Math.min(zoom.zoom, lod.maxZoom)).flatMap(id => lod.select(id) ?? []);
  const sameTiles = previous && previous.covering.idealTileIDs.length === selected.length
    && previous.covering.idealTileIDs.every((tile, index) => tile.key === selected[index].key);
  const idealTileIDs = sameTiles ? previous.covering.idealTileIDs : selected;
  const covering = previous?.zoom === zoom && sameTiles ? previous.covering : { ...zoom, idealTileIDs };
  camera.coverings.set(tilePyramid, { camera, zoom, lod, covering });
  return covering;
}
