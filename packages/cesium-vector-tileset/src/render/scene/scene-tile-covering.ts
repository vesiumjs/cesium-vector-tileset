import type { Occluder } from 'cesium';
import type { OverscaledTileID } from '../../tile/tile-id';
import type { TilePyramid } from '../../tile/tile-pyramid';
import type { GlobeLike } from './globe-covering';
import type { CameraFrameSnapshot, CoveringCache, CoveringTilePyramid, RenderCovering, RenderFrameState, RenderZoom } from './render-frame';
import { Intersect, SceneMode } from 'cesium';
import { compareTileId } from '../../tile/tile-id';
import { tileBoundingSphere } from '../geometry/tile-bounding-sphere';
import { globeVisibleTileIDs } from './globe-covering';
import { cameraPoseForFrame, captureCameraForFrame, planarCoveringForFrame, zoomForFrame } from './render-frame';

export interface CoveringScene {
  globe?: GlobeLike;
  mode?: SceneMode;
  _frameState?: RenderFrameState;
  preRender?: { addEventListener: (listener: () => void) => () => void };
  postRender?: { addEventListener: (listener: () => void) => () => void };
  isVisible?: (cullingVolume: unknown, command: unknown, occluder?: unknown) => boolean;
}

interface GlobeCoveringCacheEntry {
  zoom: RenderZoom;
  revision: number;
  minZoom: number;
  supplementalPose?: object;
  tileIds: OverscaledTileID[];
  covering: RenderCovering;
}

function sameTileIDs(a: readonly OverscaledTileID[], b: readonly OverscaledTileID[]): boolean {
  return a.length === b.length && a.every((tile, index) => tile.key === b[index].key);
}

/** Observes the complete 2D camera and rendered 3D globe for source coverage. */
export class SceneTileCovering {
  private _scene?: CoveringScene;
  private _mode?: SceneMode;
  private _globeReady = false;
  private _removePreRender?: () => void;
  private _removePostRender?: () => void;
  private _cameraFrame?: CameraFrameSnapshot;
  private _cameraPose?: object;
  private _observedCamera?: object;
  private _supplemented = false;
  private _observedGlobe?: GlobeLike;
  private _observedTiles = new Set<string>();
  private _renderedGlobe: GlobeLike = { _surface: { _tilesToRender: [] } };
  private _revision = 0;
  private _cameraCoverings: CoveringCache = new WeakMap();
  private _globeCoverings = new WeakMap<object, GlobeCoveringCacheEntry>();
  private readonly _requestRender: () => void;

  constructor(requestRender: () => void) {
    this._requestRender = requestRender;
  }

  get scene(): CoveringScene | undefined {
    return this._scene;
  }

  get cameraFrame(): CameraFrameSnapshot | undefined {
    return this._cameraFrame;
  }

  observe(scene: CoveringScene | undefined): void {
    if (scene !== this._scene) {
      this._removePreRender?.();
      this._removePostRender?.();
      this._scene = scene;
      this._mode = scene?.mode;
      this._globeReady = false;
      this._cameraFrame = undefined;
      this._cameraPose = undefined;
      this._observedCamera = undefined;
      this._supplemented = false;
      this._cameraCoverings = new WeakMap();
      this._removePreRender = scene?.preRender?.addEventListener(() => {
        if (this._mode !== scene.mode) {
          this._mode = scene.mode;
          this._globeReady = false;
          this._globeCoverings = new WeakMap();
          this._observedCamera = undefined;
          this._supplemented = false;
        }
        const frame = scene._frameState;
        this._cameraPose = frame ? cameraPoseForFrame(frame, this._cameraCoverings, scene.mode) : undefined;
        this._cameraFrame = frame && scene.mode !== undefined
          ? captureCameraForFrame(frame, this._cameraCoverings, scene.mode)
          : undefined;
      });
      this._removePostRender = scene?.postRender?.addEventListener(() => {
        if (scene.mode === this._mode && (scene.mode === SceneMode.SCENE3D || scene.mode === SceneMode.COLUMBUS_VIEW)) {
          const becameReady = !this._globeReady;
          const changed = this._captureGlobe();
          this._globeReady = true;
          if (becameReady || changed)
            this._requestRender();
        }
      });
      this._globeCoverings = new WeakMap();
      if (scene?.mode === SceneMode.SCENE3D || scene?.mode === SceneMode.COLUMBUS_VIEW) {
        this._captureGlobe();
        this._globeReady = true;
      }
    }
  }

  covering(tilePyramid: CoveringTilePyramid & Pick<TilePyramid, 'getLoadedTileIDs'>, frameState: RenderFrameState, overscale: number): RenderCovering | undefined {
    if (!this._scene) {
      return undefined;
    }
    if (frameState.mode === SceneMode.SCENE2D) {
      if (frameState.frameNumber !== undefined && (this._cameraFrame?.frameNumber !== frameState.frameNumber || this._cameraFrame.mode !== SceneMode.SCENE2D)) {
        this._requestRender();
        return undefined;
      }
      return planarCoveringForFrame(tilePyramid, frameState, this._cameraCoverings, overscale);
    }
    // A new surface mode must complete Globe.render before its selection can
    // replace the retained source coverage, including a return to the same 3D mode.
    if (!this._globeReady || frameState.mode !== this._mode) {
      return undefined;
    }
    const zoom = zoomForFrame(tilePyramid, frameState, this._cameraCoverings, overscale);
    if (!zoom) {
      return undefined;
    }
    const minZoom = tilePyramid.getSource().minzoom ?? 0;
    this._cameraPose = cameraPoseForFrame(frameState, this._cameraCoverings);
    const supplementalPose = frameState.mode === SceneMode.SCENE3D
      && this._scene.globe && this._scene.globe.show !== false
      && frameState.cullingVolume && this._cameraPose !== this._observedCamera
      ? this._cameraPose
      : undefined;
    const cached = this._globeCoverings.get(tilePyramid);
    let tileIds = cached?.tileIds;
    if (!cached || cached.revision !== this._revision || cached.zoom.zoom !== zoom.zoom || cached.minZoom !== minZoom
      || cached.supplementalPose !== supplementalPose) {
      const selected = globeVisibleTileIDs(this._renderedGlobe, minZoom, zoom.zoom);
      if (supplementalPose) {
        // Cesium updates primitives before Globe.render selects terrain for
        // this camera. Reuse loaded source data for the newly exposed view;
        // actual terrain remains the authority for fresh tile requests.
        const primary = selected.slice();
        for (const id of tilePyramid.getLoadedTileIDs(zoom.zoom)) {
          if (primary.some(tile => tile.equals(id) || id.isChildOf(tile))) {
            continue;
          }
          const sphere = tileBoundingSphere(id);
          if (frameState.cullingVolume!.computeVisibility(sphere) !== Intersect.OUTSIDE
            && (!frameState.occluder || !sphere.isOccluded(frameState.occluder as Occluder))) {
            selected.push(id);
            this._supplemented = true;
          }
        }
      }
      selected.sort(compareTileId);
      tileIds = cached && sameTileIDs(cached.tileIds, selected) ? cached.tileIds : selected;
    }
    if (cached?.zoom === zoom && cached.tileIds === tileIds) {
      cached.revision = this._revision;
      cached.supplementalPose = supplementalPose;
      return cached.covering;
    }
    const covering = { ...zoom, idealTileIDs: tileIds! };
    this._globeCoverings.set(tilePyramid, { zoom, revision: this._revision, minZoom, supplementalPose, tileIds: tileIds!, covering });
    return covering;
  }

  destroy(): void {
    this._removePreRender?.();
    this._removePreRender = undefined;
    this._removePostRender?.();
    this._removePostRender = undefined;
    this._scene = undefined;
    this._mode = undefined;
    this._globeReady = false;
    this._cameraFrame = undefined;
    this._cameraPose = undefined;
    this._observedCamera = undefined;
    this._supplemented = false;
    this._cameraCoverings = new WeakMap();
    this._observedGlobe = undefined;
    this._observedTiles.clear();
    this._renderedGlobe = { _surface: { _tilesToRender: [] } };
    this._globeCoverings = new WeakMap();
  }

  private _captureGlobe(): boolean {
    const globe = this._scene?.globe;
    const tiles = globe && globe.show !== false
      ? globe._surface._tilesToRender
      : [];
    const previous = this._observedTiles;
    const cameraChanged = this._cameraPose !== this._observedCamera;
    this._observedCamera = this._cameraPose;
    const supplemented = this._supplemented;
    this._supplemented = false;
    if (globe === this._observedGlobe && tiles.length === previous.size
      && tiles.every(tile => previous.has(`${tile.level}/${tile.x}/${tile.y}`))) {
      return cameraChanged && supplemented;
    }
    this._observedGlobe = globe;
    this._observedTiles = new Set(tiles.map(tile => `${tile.level}/${tile.x}/${tile.y}`));
    const snapshot = tiles.map(tile => Object.freeze({
      level: tile.level,
      x: tile.x,
      y: tile.y,
      rectangle: Object.freeze({ ...tile.rectangle }),
    }));
    this._renderedGlobe = Object.freeze({
      _surface: Object.freeze({ _tilesToRender: Object.freeze(snapshot) }),
    });
    this._revision++;
    return true;
  }
}
