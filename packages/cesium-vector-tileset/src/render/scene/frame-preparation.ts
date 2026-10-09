import type { PrimitiveCollection } from 'cesium';
import type { Style } from '../../style/style';
import type { SymbolTileRenderer } from '../symbol/symbol-renderer';
import type { VectorTileRenderer } from '../vector/vector-tile-renderer';
import type { FrameBudget } from './frame-budget';
import type { CoveringCache, RenderFrameState } from './render-frame';
import type { SceneCollections } from './scene-collections';
import type { SceneFrameBudgetLease, SceneFrameWork } from './scene-frame-budget';
import type { SceneRenderWake } from './scene-render-wake';
import type { TilePublishQueue } from './tile-publish-queue';
import { GeographicProjection, SceneMode, WebMercatorProjection } from 'cesium';
import { browser } from '../../util/browser';
import { cameraPoseForFrame } from './render-frame';
import { acquireSceneFrameBudget } from './scene-frame-budget';

/**
 * State shared by all viewports in one admitted physical frame.
 * @internal
 */
export interface AdmittedFrame {
  frameNumber?: number;
  budget: FrameBudget;
  requestGeneration: number;
  successfulUpdate: boolean;
}

/**
 * CSS-pixel widths compensate for Cesium's scene pixel ratio.
 * @internal
 */
export function pixelRatioCompensation(frameState: RenderFrameState): number {
  const ratio = frameState.pixelRatio ?? 0;
  return browser.devicePixelRatio / (ratio > 0 ? ratio : 1);
}

/**
 * Owns per-tileset frame admission and preparation during idle and post-render ticks.
 * @internal
 */
export class FramePreparation {
  private readonly root: PrimitiveCollection;
  private readonly style: Style;
  private readonly vector: VectorTileRenderer;
  private readonly collections: SceneCollections;
  private readonly publishQueue: TilePublishQueue;
  private readonly symbol: SymbolTileRenderer;
  private readonly wake: SceneRenderWake;

  constructor(
    root: PrimitiveCollection,
    style: Style,
    vector: VectorTileRenderer,
    collections: SceneCollections,
    publishQueue: TilePublishQueue,
    symbol: SymbolTileRenderer,
    wake: SceneRenderWake,
  ) {
    this.root = root;
    this.style = style;
    this.vector = vector;
    this.collections = collections;
    this.publishQueue = publishQueue;
    this.symbol = symbol;
    this.wake = wake;
  }

  admit(frameState: RenderFrameState, generation: number): SceneFrameWork {
    const work = this.bind(frameState.camera._scene).frame(frameState.frameNumber);
    // Budget identity, rather than frameNumber, also covers Native's date-line viewports.
    if (this.frameRecord?.budget !== work.tileBudget) {
      this.frameRecord = {
        frameNumber: frameState.frameNumber,
        budget: work.tileBudget,
        requestGeneration: generation,
        successfulUpdate: false,
      };
      this.style.images.beginFrame();
    }
    return work;
  }

  release(): void {
    this._loadingCameraPose = undefined;
    this.continuationMs = 0;
    this.frameRecord = undefined;
    this._sceneBudget?.release();
    this._sceneBudget = undefined;
    this._budgetScene = undefined;
    this.collections.idlePreparationsEnabled = false;
    this.publishQueue.idlePreparationsEnabled = false;
  }

  private readonly _fallbackBudgetScene = {};

  private _budgetScene?: object;

  private _sceneBudget?: SceneFrameBudgetLease;

  private readonly _loadingCameraCache: CoveringCache = new WeakMap();

  private _loadingCameraPose?: object;

  private _loadingCameraChangedAt = 0;

  continuationMs = 0;

  frameRecord?: AdmittedFrame;

  cpuEnabled(frameState: RenderFrameState): boolean {
    const scene = frameState.camera._scene;
    if (scene?.requestRenderMode !== true || scene.mode !== frameState.mode)
      return false;
    if (frameState.mode === SceneMode.SCENE3D)
      return true;
    const projection = frameState.mapProjection ?? scene.mapProjection;
    return frameState.mode === SceneMode.COLUMBUS_VIEW && frameState.scene3DOnly !== true
      && (projection instanceof GeographicProjection || projection instanceof WebMercatorProjection);
  }

  updateLoading(frame: RenderFrameState): void {
    this.continuationMs = 0;
    const supportedMode = frame.mode === SceneMode.SCENE3D || frame.mode === SceneMode.COLUMBUS_VIEW;
    const pose = this.wake.enabled && supportedMode && frame.camera._scene?.mode === frame.mode
      ? cameraPoseForFrame(frame, this._loadingCameraCache, frame.mode)
      : undefined;
    const now = performance.now();
    if (pose !== this._loadingCameraPose) {
      this._loadingCameraPose = pose;
      this._loadingCameraChangedAt = now;
    }
    // A paused load can trade a larger work slice for fewer redraws. Restore
    // ordinary service immediately when the actual camera or viewport moves.
    if (pose && now - this._loadingCameraChangedAt >= 200
      && !this.style._changed && !this.style.getRenderTransitionFlags().any
      && (this.collections.pendingFirstUpdateCount > 0 || this.publishQueue.size > 0)) {
      this.continuationMs = 12;
    }
  }

  advanceIdle(frameState: RenderFrameState): void {
    if (!this.wake.enabled || this.wake.requested
      || !this.cpuEnabled(frameState) || frameState.camera._scene !== this.wake.scene) {
      return;
    }
    const cpuUpload = this.collections.hasRunnablePreparations;
    const resources = this.collections.hasRunnableResourceUploads;
    const upload = cpuUpload || resources;
    const builds = this.publishQueue.inspectBuilds();
    if (!upload && !builds.runnable && !builds.renderNeeded)
      return;
    // Prepared resources are immutable; changed paint inputs only gate CPU work.
    const cpuAllowed = !this.style._changed && !this.style.getRenderTransitionFlags().any
      && this.vector.pixelRatio === pixelRatioCompensation(frameState);
    if (!cpuAllowed) {
      this.wake.request();
    }
    const frameWork = this.bind(frameState.camera._scene).frame(frameState.frameNumber);
    const runnable = {
      upload: (cpuAllowed && cpuUpload) || resources,
      build: cpuAllowed && builds.runnable,
      paint: this.vector.needsPaintUpdate,
      placement: this.symbol.hasRunnableWork,
    };
    if (runnable.upload) {
      const budget = frameWork.continuation('upload', runnable, this.continuationMs) ?? frameWork.tileBudget;
      const minimum = budget !== frameWork.tileBudget;
      const cpuProgress = cpuAllowed
        ? this.collections.advancePreparations(frameState, budget, operation => frameWork.measure(operation), minimum)
        : { units: 0, renderNeeded: false };
      const resourceProgress = this.collections.advanceResourceUploads(frameState, budget, frameWork.tileBudget, operation => frameWork.measure(operation), minimum && cpuProgress.units === 0);
      if (cpuProgress.renderNeeded || resourceProgress.renderNeeded)
        this.wake.request();
    }
    if (cpuAllowed && builds.runnable && !this.wake.requested) {
      const budget = frameWork.continuation('build', runnable, this.continuationMs) ?? frameWork.tileBudget;
      const progress = frameWork.measure(() => this.publishQueue.advanceBuilds(budget));
      if (progress.renderNeeded)
        this.wake.request();
    }
    if (builds.renderNeeded && !this.wake.requested)
      this.wake.request();
  }

  /** Spend the completed draw's remaining time on CPU preparation and resource writes. */
  afterPasses(frameState: RenderFrameState): void {
    const scene = frameState.camera._scene;
    const tileWork = this.frameRecord;
    if (!this.wake.enabled || frameState.newFrame !== true
      || !this.cpuEnabled(frameState) || scene !== this.wake.scene
      || !tileWork?.successfulUpdate || tileWork.frameNumber !== frameState.frameNumber) {
      return;
    }
    const frameWork = this.bind(scene).frame(frameState.frameNumber);
    if (tileWork.budget !== frameWork.tileBudget)
      return;
    const cpuAllowed = !this.style._changed && !this.style.getRenderTransitionFlags().any
      && this.vector.pixelRatio === pixelRatioCompensation(frameState);
    if (!cpuAllowed) {
      this.wake.request();
    }
    const prepared = frameWork.prepareAfterPasses((budget) => {
      const upload = (cpuAllowed && this.collections.hasRunnablePreparations) || this.collections.hasRunnableResourceUploads;
      const builds = this.publishQueue.inspectBuilds();
      if (upload) {
        const cpuProgress = cpuAllowed
          ? this.collections.advancePreparations(frameState, budget, operation => frameWork.measure(operation), false)
          : { units: 0, renderNeeded: false };
        const resourceProgress = this.collections.advanceResourceUploads(frameState, budget, frameWork.tileBudget, operation => frameWork.measure(operation), false);
        if (cpuProgress.renderNeeded || resourceProgress.renderNeeded)
          this.wake.request();
      }
      if (cpuAllowed && !budget.exhausted && builds.runnable) {
        const progress = frameWork.measure(() => this.publishQueue.advanceBuilds(budget));
        if (progress.renderNeeded)
          this.wake.request();
      }
    });
    if (!prepared && this.collections.hasRunnableResourceUploads) {
      // Reuse the physical tick's single overload token after all Native draws.
      const runnable = {
        upload: true,
        build: cpuAllowed && this.publishQueue.size > 0,
        paint: this.vector.needsPaintUpdate,
        placement: this.symbol.hasRunnableWork,
      };
      const budget = frameWork.continuation('upload', runnable, this.continuationMs);
      if (budget && budget !== frameWork.tileBudget) {
        const progress = this.collections.advanceResourceUploads(frameState, budget, frameWork.tileBudget, operation => frameWork.measure(operation), true);
        if (progress.renderNeeded)
          this.wake.request();
      }
    }
  }

  bind(scene: RenderFrameState['camera']['_scene']): SceneFrameBudgetLease {
    const owner = scene ?? this._fallbackBudgetScene;
    if (this._budgetScene !== owner) {
      this._sceneBudget?.release();
      this._budgetScene = owner;
      this._sceneBudget = acquireSceneFrameBudget(owner, this.root, () => this.wake.enabled);
      this.frameRecord = undefined;
    }
    return this._sceneBudget!;
  }
}
