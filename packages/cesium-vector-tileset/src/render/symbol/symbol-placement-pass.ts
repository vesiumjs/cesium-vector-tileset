import type { Budget } from '../scene/frame-budget';
import type { SymbolTileGeometry } from './symbol-geometry';
import type { PlacementView, SymbolPlacementOptions, SymbolProjectionContext, SymbolTileSelection } from './symbol-placement';
import { sameViewProjection, SymbolCollisionIndex, SymbolTilePlacement } from './symbol-placement';

export interface SymbolPlacementBatch {
  geometry: SymbolTileGeometry;
  options: SymbolPlacementOptions;
}

/** Own a frozen view, collision index and unpublished visibility generation. */
export class SymbolPlacementPass {
  private readonly _batches: readonly SymbolPlacementBatch[];
  private readonly _view: PlacementView;
  private readonly _collision = new SymbolCollisionIndex();
  private readonly _placements: SymbolTilePlacement[] = [];
  private _batchIndex = 0;

  constructor(
    batches: readonly SymbolPlacementBatch[],
    view: PlacementView,
  ) {
    this._batches = batches;
    this._view = view;
  }

  get done(): boolean {
    return this._batchIndex === this._batches.length;
  }

  /** Spend the clock allowance across tile boundaries, yielding per pair. */
  advance(budget: Budget, projections: SymbolProjectionContext, minimumProgress = true): boolean {
    let processed = 0;
    while (!this.done) {
      // Make progress even with a spent clock budget, then yield per instance.
      if ((processed > 0 || !minimumProgress) && budget.exhausted) {
        return false;
      }
      let placement = this._placements[this._batchIndex];
      if (!placement) {
        const batch = this._batches[this._batchIndex];
        placement = new SymbolTilePlacement(batch.geometry.text, batch.geometry.icon, this._view, this._collision, batch.options);
        this._placements.push(placement);
      }
      processed += placement.advance(1, projections);
      if (placement.done) {
        this._batchIndex++;
      }
    }
    return true;
  }

  /** Inspect complete decisions without publishing opacity to an owner. */
  hasSelectedCandidates(batchIndex: number): boolean {
    if (!this.done) {
      throw new Error('Cannot inspect unfinished symbol placement generation');
    }
    return this._placements[batchIndex].hasCandidates;
  }

  /** Commit only after every batch has finished, preserving the last full layout. */
  commit(shouldCommit: (batchIndex: number, selection: SymbolTileSelection) => boolean, onChanged: (batchIndex: number) => void, onSelected?: (batchIndex: number, selection: SymbolTileSelection) => void): void {
    if (!this.done) {
      throw new Error('Cannot commit unfinished symbol placement generation');
    }
    for (let i = 0; i < this._placements.length; i++) {
      const selection = this._placements[i].selection;
      if (shouldCommit(i, selection)) {
        if (this._placements[i].commit()) {
          onChanged(i);
        }
        onSelected?.(i, selection);
      }
    }
  }
}

export function copyPlacementView(view: PlacementView): PlacementView {
  return { ...view, viewProjection: new Float64Array(view.viewProjection), viewport: view.viewport && { ...view.viewport } };
}

export function samePlacementParameters(a: PlacementView, b: PlacementView): boolean {
  return a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio
    && a.mercatorProjection === b.mercatorProjection
    && a.cameraToCenterDistance === b.cameraToCenterDistance && a.orthographic === b.orthographic
    && a.cameraZoom === b.cameraZoom && !!a.projectPosition === !!b.projectPosition
    && !!a.isPointVisible === !!b.isPointVisible
    && a.viewport?.x === b.viewport?.x && a.viewport?.y === b.viewport?.y
    && a.viewport?.width === b.viewport?.width && a.viewport?.height === b.viewport?.height;
}

/** Continuous camera motion is stale; representation changes bypass recency. */
function samePlacementStructure(a: PlacementView, b: PlacementView): boolean {
  return a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio
    && a.mercatorProjection === b.mercatorProjection && a.orthographic === b.orthographic
    && (a.cameraToCenterDistance === undefined) === (b.cameraToCenterDistance === undefined)
    && !!a.projectPosition === !!b.projectPosition && !!a.isPointVisible === !!b.isPointVisible
    && a.viewport?.x === b.viewport?.x && a.viewport?.y === b.viewport?.y
    && a.viewport?.width === b.viewport?.width && a.viewport?.height === b.viewport?.height;
}

export function samePlacementView(a: PlacementView | undefined, b: PlacementView): boolean {
  return !!a && samePlacementParameters(a, b) && sameViewProjection(a.viewProjection, b.viewProjection);
}

export interface SymbolPlacementGeneration<Batch extends SymbolPlacementBatch> {
  pass: SymbolPlacementPass;
  batches: readonly Batch[];
  view: PlacementView;
  revision: number;
}

/**
 * Schedule one collision scope against immutable input and a frozen view.
 * Current, future and handoff scopes share this invalidation/recency policy;
 * the renderer alone decides when their complete results may reach the GPU.
 */
export class SymbolPlacementScope<Batch extends SymbolPlacementBatch> {
  private readonly _sameBatch: (a: Batch, b: Batch) => boolean;
  private readonly _recencyMs: number;
  private _batches: readonly Batch[] = [];
  private _revision = 0;
  private _job: SymbolPlacementGeneration<Batch> | undefined;
  private _complete: SymbolPlacementGeneration<Batch> | undefined;
  private _view: PlacementView | undefined;
  private _dirty = false;
  private _urgent = false;
  private _lastCommitMs = Number.NEGATIVE_INFINITY;
  private _recencyDeadline = Number.NEGATIVE_INFINITY;
  private _currentZoom: number | undefined;
  private _zoomAtLastRecencyCheck: number | undefined;

  constructor(sameBatch: (a: Batch, b: Batch) => boolean, recencyMs: number) {
    this._sameBatch = sameBatch;
    this._recencyMs = recencyMs;
  }

  get batches(): readonly Batch[] { return this._batches; }
  get job(): SymbolPlacementGeneration<Batch> | undefined { return this._job; }
  get complete(): SymbolPlacementGeneration<Batch> | undefined { return this._complete; }
  get pending(): boolean { return !!this._job || this._dirty; }

  /** Active jobs and urgent inputs can advance; recency waits cannot. */
  get runnable(): boolean {
    return !!this._job || (this._dirty
      && (this._urgent || performance.now() >= this._recencyDeadline));
  }

  /** The next nonurgent layout becomes runnable at this monotonic time. */
  get nextPlacementTime(): number | undefined {
    if (!this._dirty || this._job || this._urgent)
      return undefined;
    const time = this._recencyDeadline;
    return performance.now() < time ? time : undefined;
  }

  /** An idle Native tick can shorten the deadline without drawing a frame. */
  observeIdle(): boolean {
    if (!this._dirty || this._job || this._urgent)
      return false;
    return this._observeRecency(this._currentZoom);
  }

  private _observeRecency(zoom: number | undefined): boolean {
    const placedZoom = this._view?.cameraZoom;
    // MapLibre Placement.stillRecent reduces recency only once zoom stops.
    const adjustment = this._zoomAtLastRecencyCheck === zoom && placedZoom !== undefined && zoom !== undefined
      ? Math.max(0, (placedZoom - zoom) / 1.5)
      : 0;
    this._zoomAtLastRecencyCheck = zoom;
    const deadline = this._lastCommitMs + this._recencyMs * (1 - adjustment);
    const changed = deadline !== this._recencyDeadline;
    this._recencyDeadline = deadline;
    return changed;
  }

  private _commitRecency(view: PlacementView, current: PlacementView): void {
    this._lastCommitMs = performance.now();
    this._recencyDeadline = this._lastCommitMs + this._recencyMs;
    this._zoomAtLastRecencyCheck = view.cameraZoom;
    this._currentZoom = current.cameraZoom;
  }

  matches(batches: readonly Batch[]): boolean {
    return this._batches.length === batches.length && this._batches.every((batch, index) => this._sameBatch(batch, batches[index]));
  }

  /** Input changes queue the next generation without starving an active job. */
  prepare(batches: readonly Batch[]): void {
    if (this.matches(batches)) {
      return;
    }
    this._batches = batches;
    this._revision++;
    this._complete = undefined;
    this._dirty = true;
    this._urgent = true;
  }

  isCurrent(generation: SymbolPlacementGeneration<Batch>): boolean {
    return generation.revision === this._revision;
  }

  /** Finish at least one pair even if another scope has spent this frame's clock. */
  advance(view: PlacementView, budget: Budget, projections: SymbolProjectionContext, viewChanged = false, minimumProgress = true): SymbolPlacementGeneration<Batch> | undefined {
    this._currentZoom = view.cameraZoom;
    if (!this._job)
      this._observeRecency(view.cameraZoom);
    if (viewChanged || !samePlacementView(this._view, view)) {
      this._dirty = true;
      this._urgent ||= !!this._view && !samePlacementStructure(this._view, view);
    }
    if (!this._job && this._dirty && (this._urgent || performance.now() >= this._recencyDeadline)) {
      const frozen = copyPlacementView(view);
      this._job = { pass: new SymbolPlacementPass(this._batches, frozen), batches: this._batches, view: frozen, revision: this._revision };
      this._view = frozen;
      this._dirty = false;
      this._urgent = false;
    }
    const generation = this._job;
    if (!generation?.pass.advance(budget, projections, minimumProgress)) {
      return undefined;
    }
    this._job = undefined;
    this._commitRecency(generation.view, view);
    const current = this.isCurrent(generation);
    if (current) {
      this._complete = generation;
    }
    this._dirty = !current || !samePlacementView(generation.view, view);
    this._urgent = !current || !samePlacementStructure(generation.view, view);
    return generation;
  }

  /** Adopt another scope's complete result only when all desired batches match. */
  activate(generation: SymbolPlacementGeneration<Batch>, view: PlacementView): boolean {
    if (!this.matches(generation.batches)) {
      return false;
    }
    // The complete matching result replaces this scope's preparation, but
    // a stale adoption still owes its current-view layout.
    this._job = undefined;
    this._complete = { ...generation, revision: this._revision };
    this._view = generation.view;
    this._dirty = !samePlacementView(generation.view, view);
    this._urgent = this._dirty && !samePlacementStructure(generation.view, view);
    this._commitRecency(generation.view, view);
    return true;
  }

  /** Empty owners need no projection; discard obsolete work without advancing it. */
  completeEmpty(view: PlacementView): SymbolPlacementGeneration<Batch> {
    if (this._batches.length === 0 && !this._job && this._complete && this.isCurrent(this._complete)) {
      return this._complete;
    }
    this._revision++;
    this._batches = [];
    this._job = undefined;
    const frozen = copyPlacementView(view);
    this._complete = { pass: new SymbolPlacementPass([], frozen), batches: [], view: frozen, revision: this._revision };
    this._view = frozen;
    this._dirty = false;
    this._urgent = false;
    this._commitRecency(frozen, view);
    return this._complete;
  }

  clear(): void {
    this._batches = [];
    this._revision++;
    this._job = undefined;
    this._complete = undefined;
    this._view = undefined;
    this._dirty = false;
    this._urgent = false;
    this._lastCommitMs = Number.NEGATIVE_INFINITY;
    this._recencyDeadline = Number.NEGATIVE_INFINITY;
    this._currentZoom = undefined;
    this._zoomAtLastRecencyCheck = undefined;
  }
}
