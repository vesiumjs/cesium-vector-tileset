import type { SymbolTileRenderer } from '../symbol/symbol-renderer';
import type { RenderFrameState } from './render-frame';
import type { SceneCollections } from './scene-collections';
import type { RunnableStages, SceneFrameWork } from './scene-frame-budget';
import type { SceneRenderWake } from './scene-render-wake';
import type { SceneTileCovering } from './scene-tile-covering';
import { symbolFrame } from '../symbol/symbol-frame';
import { sameViewProjection } from '../symbol/symbol-placement';

/**
 * Coordinates placement against one full camera snapshot and retires completed fades.
 * @internal
 */
export class SceneSymbolPlacement {
  private readonly symbol: SymbolTileRenderer;
  private readonly covering: SceneTileCovering;
  private readonly collections: SceneCollections;
  private readonly wake: SceneRenderWake;

  constructor(
    symbol: SymbolTileRenderer,
    covering: SceneTileCovering,
    collections: SceneCollections,
    wake: SceneRenderWake,
  ) {
    this.symbol = symbol;
    this.covering = covering;
    this.collections = collections;
    this.wake = wake;
  }

  release(): void {
    this._lastPlacementView = undefined;
    this._lastPlacementFrame = undefined;
  }

  private _lastPlacementView?: Float64Array;
  private _lastPlacementFrame?: number;

  /**
   * Tick symbol fade-outs: finished fades detach into the retired pool
   * (hide + remove, pooled inside the renderer), pool-overflow evictions go
   * out for destruction. Runs every frame; the renderer short-circuits an
   * empty fade set to one map lookup.
   */
  tickFades(): boolean {
    let changed = false;
    const { detach, destroy, active } = this.symbol.tickFades(performance.now());
    if (detach.length > 0 || destroy.length > 0) {
      changed = true;
    }
    for (const collection of detach) {
      collection.show = false;
      this.collections.detach(collection);
    }
    this.collections.queueSymbolRemoval(destroy);
    if (active) {
      // A fade animates over wall-clock time: keep frames coming until it
      // completes even though the camera and style are static.
      this.wake.request();
    }
    return changed;
  }

  update(frameState: RenderFrameState, frameWork: SceneFrameWork, runnable: RunnableStages, zoom: number, continuationMs: number): void {
    if (!this.symbol.hasDrawableSymbols) {
      this.wake.cancelPlacement();
      return;
    }
    if (frameState.frameNumber !== undefined && this._lastPlacementFrame === frameState.frameNumber) {
      return;
    }
    const snapshot = this.covering.cameraFrame;
    if (!snapshot || snapshot.frameNumber !== frameState.frameNumber) {
      // First observation happens inside a viewport update. Capture the
      // complete camera at the next preRender before placing any symbols.
      this.wake.request();
      return;
    }
    const view = symbolFrame(snapshot, zoom);
    const { viewProjection } = view;
    // The collision generation uses one full view; Cesium can draw that
    // generation through both of its date-line viewports.
    const viewChanged = !this._lastPlacementView || !sameViewProjection(viewProjection, this._lastPlacementView);
    if (viewChanged) {
      this._lastPlacementView = viewProjection;
    }
    // Drawing-buffer size in device pixels: the collision boxes are computed
    // in the same space the vertex shader offsets into (offsetPx uses
    // czm_pixelRatio, i.e. scene device pixels). A zero size (frameState
    // without a context, e.g. tests) would collapse every anchor onto one
    // point and hide all but the first label, so skip the pass instead.
    const { drawingBufferWidth: width, drawingBufferHeight: height } = snapshot;
    if (width <= 0 || height <= 0) {
      return;
    }
    // Composite symbol sizes interpolate in the vertex shader between the two
    // zoom stops packed per vertex; hand the live style zoom to the renderer.
    this.symbol.cameraZoom = zoom;
    this.symbol.update(view, viewChanged, frameState.context, operation => frameWork.run('placement', runnable, operation, continuationMs));
    this._lastPlacementFrame = frameState.frameNumber;
    this.wake.continuePlacement();
  }
}
