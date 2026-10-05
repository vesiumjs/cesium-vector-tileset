import type { Budget } from '../scene/frame-budget';
import type { SymbolTileGeometry } from './symbol-geometry';
import type { PlacementView, SymbolPlacementOptions } from './symbol-placement';
import { SymbolCollisionIndex, SymbolTilePlacement } from './symbol-placement';

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

  /** Bound the largest tile as well as a frame containing many small tiles. */
  advance(budget: Budget, maxInstances: number): boolean {
    let processed = 0;
    while (!this.done) {
      // Make progress even with a spent clock budget, then yield per instance.
      if (processed >= maxInstances || (processed > 0 && budget.exhausted)) {
        return false;
      }
      let placement = this._placements[this._batchIndex];
      if (!placement) {
        const batch = this._batches[this._batchIndex];
        placement = new SymbolTilePlacement(batch.geometry.text, batch.geometry.icon, this._view, this._collision, batch.options);
        this._placements.push(placement);
      }
      processed += placement.advance(1);
      if (placement.done) {
        this._batchIndex++;
      }
    }
    return true;
  }

  /** Commit only after every batch has finished, preserving the last full layout. */
  commit(shouldCommit: (batchIndex: number) => boolean, onChanged: (batchIndex: number) => void): void {
    if (!this.done) {
      throw new Error('Cannot commit unfinished symbol placement generation');
    }
    for (let i = 0; i < this._placements.length; i++) {
      if (shouldCommit(i) && this._placements[i].commit()) {
        onChanged(i);
      }
    }
  }
}
