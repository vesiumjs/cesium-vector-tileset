import type { Camera, CullingVolume, MapProjection } from 'cesium';
import type { TileCovering } from '../../tile/tile-pyramid';
import type { CameraBounds } from './covering';
import type { GlobeLike } from './globe-covering';
import { Cartesian3, Math as CesiumMath, SceneMode } from 'cesium';
import { cameraZoom, mapZoomToSourceZoom, planarCameraBounds, planarTileIDs } from './covering';

/** The Cesium frame fields consumed by tileset rendering. */
export interface RenderFrameState {
  mode?: SceneMode;
  scene3DOnly?: boolean;
  passes?: { render?: boolean; pick?: boolean };
  commandList?: Array<{ owner?: { appearance?: unknown }; pass: number }>;
  cullingVolume?: Pick<CullingVolume, 'computeVisibility'>;
  occluder?: unknown;
  camera: Pick<Camera, 'positionCartographic' | 'positionWC' | 'directionWC' | 'rightWC' | 'upWC' | 'frustum' | 'getPickRay'> & {
    viewMatrix?: ArrayLike<number>;
    /** Camera's owning scene supplies the rendered globe and CSS canvas size. */
    _scene?: { globe?: GlobeLike; canvas?: HTMLCanvasElement; mapProjection?: MapProjection };
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
  coverings: WeakMap<object, { camera: CameraCache; zoom: RenderZoom; covering: RenderCovering }>;
  zoom?: number;
  styleZoom?: number;
}

// One camera measurement per cache/frame, shared by every source.
const cameras = new WeakMap<CoveringCache, CameraCache>();
const STYLE_ZOOM_TOLERANCE = 1e-4;

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
    && Cartesian3.equalsEpsilon(previous.right, camera.rightWC, CesiumMath.EPSILON14)) {
    previous.frame = frame;
    previous.frameNumber = frame.frameNumber;
    return previous;
  }
  const input = { camera, mode, projection, width, height };
  // Retain the centre scale through sky views. On an initial horizon view,
  // the bottom row provides a surface scale without defining visible tiles.
  const zoom = cameraZoom(input) ?? previous?.zoom ?? cameraZoom({ ...input, sampleY: height - 1 });
  const styleZoom = zoom !== undefined && previous?.styleZoom !== undefined
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
    zoom,
    styleZoom,
  };
  cameras.set(cache, current);
  return current;
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
  const zoom = Math.max(minzoom, Math.min((source.type === 'raster' ? Math.round : Math.floor)(sourceZoom), maxzoom + overscale));
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

/** Full projected camera covering, independent of terrain geometry LOD. */
export function planarCoveringForFrame(tilePyramid: CoveringTilePyramid, frame: RenderFrameState, cache: CoveringCache, overscale: number): RenderCovering | undefined {
  const camera = zoomForCamera(frame, cache);
  const zoom = zoomForFrame(tilePyramid, frame, cache, overscale);
  if (!camera?.bounds || camera.zoom === undefined || !zoom)
    return undefined;
  const previous = camera.coverings.get(tilePyramid);
  if (previous?.camera === camera && previous.zoom === zoom)
    return previous.covering;
  const source = tilePyramid.getSource();
  const sourceZoom = mapZoomToSourceZoom(camera.zoom, source.tileSize);
  const selectedZoom = (source.type === 'raster' ? Math.round : Math.floor)(sourceZoom);
  const selected = selectedZoom < (source.minzoom ?? 0) ? [] : planarTileIDs(camera.bounds, zoom.zoom);
  const sameTiles = previous && previous.covering.idealTileIDs.length === selected.length
    && previous.covering.idealTileIDs.every((tile, index) => tile.key === selected[index].key);
  const idealTileIDs = sameTiles ? previous.covering.idealTileIDs : selected;
  const covering = previous?.zoom === zoom && sameTiles ? previous.covering : { ...zoom, idealTileIDs };
  camera.coverings.set(tilePyramid, { camera, zoom, covering });
  return covering;
}
