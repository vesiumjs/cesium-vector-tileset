import type { BoundingSphere, Occluder } from 'cesium';
import type { OverscaledTileID } from '../../tile/tile-id';
import type { GlobeLike } from './globe-covering';
import type { CameraFrameSnapshot, CoveringCache, CoveringSource, CoveringTilePyramid, RenderCovering, RenderFrameState, RenderZoom } from './render-frame';
import type { SourceTileLod } from './source-tile-lod';
import { Intersect, SceneMode } from 'cesium';
import { compareTileId } from '../../tile/tile-id';
import { TilePyramid } from '../../tile/tile-pyramid';
import { tileBoundingSphere } from '../geometry/tile-bounding-sphere';
import { globeVisibleTileIDs } from './globe-covering';
import { cameraPoseForFrame, captureCameraForFrame, planarCoveringForFrame, sourceTileLodForFrame, zoomForFrame } from './render-frame';

export interface CoveringScene {
  globe?: GlobeLike;
  mode?: SceneMode;
  _frameState?: RenderFrameState;
  preRender?: { addEventListener: (listener: () => void) => () => void };
  postRender?: { addEventListener: (listener: () => void) => () => void };
  isVisible?: (cullingVolume: unknown, command: unknown, occluder?: unknown) => boolean;
}

interface GlobeCoveringCacheEntry {
  source: CoveringSource;
  sourceType?: string;
  maxZoom?: number;
  tileSize?: number;
  reparseOverscaled?: boolean;
  overscale: number;
  pose?: object;
  zoom: RenderZoom;
  lod: SourceTileLod;
  revision: number;
  // Retained IDs can outlive both desired zoom and observed Globe changes.
  // Only actual primary sampling establishes these inputs; loaded extras do not.
  primaryZoom?: number;
  primaryRevision?: number;
  primaryLod?: SourceTileLod;
  minZoom: number;
  supplementalPose?: object;
  deferred: boolean;
  loadedTileIds?: readonly OverscaledTileID[];
  primaryTileIds: readonly OverscaledTileID[];
  tileIds: OverscaledTileID[];
  covering: RenderCovering;
}

function sameTileIDs(a: readonly OverscaledTileID[], b: readonly OverscaledTileID[]): boolean {
  return a.length === b.length && a.every((tile, index) => tile.key === b[index].key);
}

function loadedChildCovering(ancestor: OverscaledTileID, loaded: readonly OverscaledTileID[], lod: SourceTileLod): OverscaledTileID[] | undefined {
  const candidates = loaded.filter(id => id.isChildOf(ancestor) && lod.allows(id));
  candidates.sort((a, b) => a.canonical.z - b.canonical.z || a.overscaledZ - b.overscaledZ);
  const children: OverscaledTileID[] = [];
  for (const id of candidates) {
    if (!children.some(child => id.canonical.equals(child.canonical) || id.canonical.isChildOf(child.canonical)))
      children.push(id);
  }
  // Canonical footprints are dyadic. Count each branch once, including
  // mixed depths and overscaled generations sharing a canonical footprint.
  const coverage = children.reduce((area, id) => area + 4 ** (ancestor.canonical.z - id.canonical.z), 0);
  return coverage === 1 ? children : undefined;
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

  private _deferredCovering = false;

  private _observedGlobe?: GlobeLike;

  private _observedTiles = new Set<string>();

  private _renderedGlobe: GlobeLike = { _surface: { _tilesToRender: [] } };

  private _revision = 0;

  private _cameraCoverings: CoveringCache = new WeakMap();

  private _globeCoverings = new WeakMap<object, GlobeCoveringCacheEntry>();

  private _tileBounds = new WeakMap<OverscaledTileID, BoundingSphere>();

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
      this._deferredCovering = false;
      this._cameraCoverings = new WeakMap();
      this._removePreRender = scene?.preRender?.addEventListener(() => {
        if (this._mode !== scene.mode) {
          this._mode = scene.mode;
          this._globeReady = false;
          this._globeCoverings = new WeakMap();
          this._observedCamera = undefined;
          this._supplemented = false;
          this._deferredCovering = false;
        }
        const frame = scene._frameState;
        this._cameraPose = frame ? cameraPoseForFrame(frame, this._cameraCoverings, scene.mode) : undefined;
        this._cameraFrame = frame && scene.mode !== undefined
          ? captureCameraForFrame(frame, this._cameraCoverings, scene.mode)
          : undefined;
      });
      this._removePostRender = scene?.postRender?.addEventListener(() => {
        if (scene.mode === this._mode && (scene.mode === SceneMode.SCENE3D || scene.mode === SceneMode.COLUMBUS_VIEW)) {
          const frame = scene._frameState;
          this._cameraPose = frame ? cameraPoseForFrame(frame, this._cameraCoverings, scene.mode) : this._cameraPose;
          const becameReady = !this._globeReady;
          const deferred = this._deferredCovering;
          this._deferredCovering = false;
          const changed = this._captureGlobe();
          this._globeReady = true;
          if (becameReady || changed || deferred)
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
    const source = tilePyramid.getSource();
    const lod = sourceTileLodForFrame(tilePyramid, frameState, this._cameraCoverings, overscale)!;
    const minZoom = source.minzoom ?? 0;
    this._cameraPose = cameraPoseForFrame(frameState, this._cameraCoverings);
    const loaded = frameState.mode === SceneMode.SCENE3D
      && this._scene.globe && this._scene.globe.show !== false
      && frameState.cullingVolume
      ? tilePyramid.getLoadedTileIDs(
          Math.max(minZoom, zoom.zoom - TilePyramid.maxUnderzooming),
          zoom.zoom + TilePyramid.maxOverzooming,
        )
      : undefined;
    const supplementalPose = loaded && this._cameraPose !== this._observedCamera
      ? this._cameraPose
      : undefined;
    const cached = this._globeCoverings.get(tilePyramid);
    const sameSource = cached?.source === source && cached.minZoom === minZoom
      && cached.sourceType === source.type && cached.maxZoom === source.maxzoom
      && cached.tileSize === source.tileSize && cached.overscale === overscale && cached.reparseOverscaled === source.reparseOverscaled;
    // A completed Globe uses the desired source zoom of its observed pose,
    // even while the next pose is already moving. If that pairing is unknown,
    // retain source IDs until postRender; never resample old rectangles with
    // the new pose's zoom or indefinitely hold the initial IDs during motion.
    const deferred = Boolean(cached && sameSource && this._scene.globe?.show !== false
      && this._cameraPose !== this._observedCamera);
    let tileIds = cached?.tileIds;
    let primaryTileIds = cached?.primaryTileIds;
    let primaryZoom = cached?.primaryZoom;
    let primaryRevision = cached?.primaryRevision;
    let primaryLod = cached?.primaryLod;
    if (!cached || !sameSource || cached.revision !== this._revision || cached.zoom.zoom !== zoom.zoom
      || cached.pose !== this._cameraPose || cached.supplementalPose !== supplementalPose
      || cached.deferred !== deferred || cached.loadedTileIds !== loaded) {
      const confirmed = deferred && cached?.pose === this._observedCamera;
      const selectionZoom = confirmed ? cached!.zoom.zoom : zoom.zoom;
      const retained = deferred && !confirmed;
      primaryTileIds = retained
        ? cached!.primaryTileIds
        : globeVisibleTileIDs(this._renderedGlobe, minZoom, selectionZoom, confirmed ? cached!.lod : lod);
      // Retain only Globe-authorized requests across unconfirmed poses.
      // Loaded refinements are rechecked below, never promoted into requests.
      const selected = primaryTileIds.slice();
      if (!retained) {
        primaryZoom = selectionZoom;
        primaryRevision = this._revision;
        primaryLod = confirmed ? cached!.lod : lod;
      }
      if (loaded) {
        // A retained coarse owner masks its descendants by whole layer.
        // Replace it only with a complete loaded footprint: partial cached
        // branches cannot retire that owner without leaving a coverage hole.
        // Camera confirmation does not undo this complete hierarchy handoff.
        for (let index = selected.length - 1; index >= 0; index--) {
          const ancestor = selected[index];
          if (!this._isVisible(ancestor, frameState))
            continue;
          const children = loadedChildCovering(ancestor, loaded, lod);
          if (!children || !children.some(id => this._isVisible(id, frameState)))
            continue;
          selected.splice(index, 1);
          for (const child of children) {
            if (!selected.some(id => id.equals(child)))
              selected.push(child);
          }
          this._supplemented = true;
        }
      }
      if (supplementalPose && loaded) {
        // Cesium updates primitives before Globe.render selects terrain for
        // this camera. Reuse loaded source data for the newly exposed view;
        // actual terrain remains the authority for fresh tile requests.
        for (const id of loaded) {
          if (!lod.allows(id))
            continue;
          if (selected.some(tile => tile.equals(id) || id.isChildOf(tile) || tile.isChildOf(id))) {
            continue;
          }
          if (this._isVisible(id, frameState)) {
            selected.push(id);
            this._supplemented = true;
          }
        }
      }
      selected.sort(compareTileId);
      tileIds = cached && sameTileIDs(cached.tileIds, selected) ? cached.tileIds : selected;
    }
    // A new pose alone needs no confirmation frame when the primary IDs
    // already sampled this Globe at its desired source zoom. Unknown or
    // stale sampling and loaded extras still owe a frame; Globe changes
    // independently wake through postRender's capture.
    if (deferred && (primaryZoom !== zoom.zoom || primaryRevision !== this._revision || !primaryLod?.sameSelection(lod) || this._supplemented))
      this._deferredCovering = true;
    if (sameSource && cached?.zoom === zoom && cached.tileIds === tileIds) {
      cached.revision = this._revision;
      cached.primaryZoom = primaryZoom;
      cached.primaryRevision = primaryRevision;
      cached.primaryLod = primaryLod;
      cached.supplementalPose = supplementalPose;
      cached.deferred = deferred;
      cached.loadedTileIds = loaded;
      cached.primaryTileIds = primaryTileIds!;
      cached.pose = this._cameraPose;
      cached.lod = lod;
      return cached.covering;
    }
    const covering = { ...zoom, idealTileIDs: tileIds! };
    this._globeCoverings.set(tilePyramid, {
      source,
      sourceType: source.type,
      maxZoom: source.maxzoom,
      tileSize: source.tileSize,
      reparseOverscaled: source.reparseOverscaled,
      overscale,
      pose: this._cameraPose,
      zoom,
      lod,
      revision: this._revision,
      primaryZoom,
      primaryRevision,
      primaryLod,
      minZoom,
      supplementalPose,
      deferred,
      loadedTileIds: loaded,
      primaryTileIds: primaryTileIds!,
      tileIds: tileIds!,
      covering,
    });
    return covering;
  }

  /**
   * @internal
   */
  private _isVisible(id: OverscaledTileID, frameState: RenderFrameState): boolean {
    let sphere = this._tileBounds.get(id);
    if (!sphere) {
      sphere = tileBoundingSphere(id);
      this._tileBounds.set(id, sphere);
    }
    return frameState.cullingVolume!.computeVisibility(sphere) !== Intersect.OUTSIDE
      && (!frameState.occluder || !sphere.isOccluded(frameState.occluder as Occluder));
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
    this._deferredCovering = false;
    this._cameraCoverings = new WeakMap();
    this._observedGlobe = undefined;
    this._observedTiles.clear();
    this._renderedGlobe = { _surface: { _tilesToRender: [] } };
    this._globeCoverings = new WeakMap();
    this._tileBounds = new WeakMap();
  }

  /**
   * @internal
   */
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
