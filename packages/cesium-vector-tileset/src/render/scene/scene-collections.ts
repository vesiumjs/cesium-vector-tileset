import type { PrimitiveCollection } from 'cesium';
import type { PatternTileUpdate } from '../pattern/pattern-renderer';
import type { RasterTileUpdate } from '../raster/raster-renderer';
import type { VectorCollection } from '../vector/vector-tile-renderer';
import type { Budget } from './frame-budget';
import type { RenderFrameState } from './render-frame';
import type { TilePublishResult } from './tile-publish-queue';
import { BufferPolygonCollection, PrimitiveCollection as CesiumPrimitiveCollection, Primitive } from 'cesium';
import { GeometryPrimitive, hasRunnableGeometryUpdate, updateGeometryWithBudget } from '../geometry/geometry-primitive';
import { destroyPatternResources } from '../pattern/pattern-renderer';
import { destroyRasterResources } from '../raster/raster-renderer';
import { isClampHeightReference } from '../vector/vector-tile-renderer';
import { allDrawLayersHidden, drawBatchForOwner, drawLayersForOwner } from './draw-batch';
import { captureUploadedPrimitiveBytes, primitiveResourceOwner } from './resource-memory';

export type SceneCollection = VectorCollection | PrimitiveCollection | Primitive;
export interface TileVisibility {
  hiddenLayers: ReadonlyMap<string, ReadonlySet<string>>;
  hiddenSymbols: ReadonlySet<string>;
}
interface FirstUpdate {
  index: number;
  staged: boolean;
  drawable: Set<number>;
}
interface SceneReplacement {
  kind: 'vector' | 'symbol';
  tileId: string;
  old: Set<SceneCollection>;
  next: Set<SceneCollection>;
  waiting: Set<SceneCollection>;
  visible: boolean;
  release: Array<() => void>;
  awaitingDetail?: boolean;
}

const updateCollection = (CesiumPrimitiveCollection.prototype as unknown as {
  update: (state: RenderFrameState) => void;
}).update;

function isSurface(collection: SceneCollection): boolean {
  return collection instanceof BufferPolygonCollection
    || (collection instanceof CesiumPrimitiveCollection
      && collection.length > 0
      && drawBatchForOwner(collection.get(0))?.kind === 'fill');
}

function stagedCollection(collection: SceneCollection): collection is CesiumPrimitiveCollection {
  return collection instanceof CesiumPrimitiveCollection
    && collection.constructor === CesiumPrimitiveCollection
    && collection.length > 1;
}

function readyPrimitives(collection: SceneCollection, submitted?: ReadonlySet<Primitive>): boolean {
  const owner = primitiveResourceOwner(collection);
  if (owner) {
    return owner.ready || submitted?.has(owner) === true;
  }
  if (collection instanceof CesiumPrimitiveCollection) {
    for (let index = 0; index < collection.length; index++) {
      if (!readyPrimitives(collection.get(index), submitted)) {
        return false;
      }
    }
  }
  return true;
}

function drawablePrimitives(collection: SceneCollection): boolean {
  const owner = primitiveResourceOwner(collection);
  if (owner)
    return owner instanceof GeometryPrimitive ? owner.hasDrawableGeometry : owner.ready;
  if (collection instanceof CesiumPrimitiveCollection) {
    for (let index = 0; index < collection.length; index++) {
      if (drawablePrimitives(collection.get(index)))
        return true;
    }
    return false;
  }
  // Buffer collections expose no separate cold/draw timing boundary.
  return true;
}

function pendingUploads(collection: SceneCollection): boolean {
  const owner = primitiveResourceOwner(collection);
  if (owner)
    return owner instanceof GeometryPrimitive && owner.hasPendingUpload;
  if (collection instanceof CesiumPrimitiveCollection) {
    for (let index = 0; index < collection.length; index++) {
      if (pendingUploads(collection.get(index)))
        return true;
    }
  }
  return false;
}

function runnablePrimitives(collection: SceneCollection): boolean {
  const owner = primitiveResourceOwner(collection);
  if (owner)
    return hasRunnableGeometryUpdate(owner);
  if (collection instanceof CesiumPrimitiveCollection) {
    for (let index = 0; index < collection.length; index++) {
      if (runnablePrimitives(collection.get(index)))
        return true;
    }
    return false;
  }
  // Buffer collections retain their synchronous Native upload path.
  return true;
}

/** Replay wrappers share their physical owner's one CPU continuation. */
function preparationOwners(collection: SceneCollection, owners: Set<GeometryPrimitive>): void {
  const owner = primitiveResourceOwner(collection);
  if (owner) {
    if (owner instanceof GeometryPrimitive && owner.hasRunnableIdlePreparation)
      owners.add(owner);
  }
  else if (collection instanceof CesiumPrimitiveCollection) {
    for (let index = 0; index < collection.length; index++)
      preparationOwners(collection.get(index), owners);
  }
}

function resourceUploadOwners(collection: SceneCollection, owners: Set<GeometryPrimitive>): void {
  const owner = primitiveResourceOwner(collection);
  if (owner) {
    if (owner instanceof GeometryPrimitive && owner.hasRunnableResourceUpload)
      owners.add(owner);
  }
  else if (collection instanceof CesiumPrimitiveCollection) {
    for (let index = 0; index < collection.length; index++)
      resourceUploadOwners(collection.get(index), owners);
  }
}

function renderPrimitives(collection: SceneCollection): boolean {
  const owner = primitiveResourceOwner(collection);
  if (owner) {
    // Ready siblings draw on real viewports; CPU preparation alone does not
    // require repeatedly rendering them while a cold sibling advances.
    if (owner.ready)
      return false;
    return owner instanceof GeometryPrimitive ? owner.needsRenderUpdate : hasRunnableGeometryUpdate(owner);
  }
  if (collection instanceof CesiumPrimitiveCollection) {
    for (let index = 0; index < collection.length; index++) {
      if (renderPrimitives(collection.get(index)))
        return true;
    }
    return false;
  }
  return true;
}

function captureUploadedBytes(collection: SceneCollection): void {
  const owner = primitiveResourceOwner(collection);
  if (owner) {
    captureUploadedPrimitiveBytes(owner);
  }
  else if (collection instanceof CesiumPrimitiveCollection) {
    for (let index = 0; index < collection.length; index++) {
      captureUploadedBytes(collection.get(index));
    }
  }
}

/**
 * Owns the handoff between renderer resources and Cesium's scene collection.
 * Renderers retain committed tiles; this owner attaches their collections,
 * budgets first GPU updates, and destroys replaced resources after the frame.
 */
export class SceneCollections {
  /** Enabled by a Scene that services idle ticks without drawing. */
  idlePreparationsEnabled = false;
  private readonly _root: PrimitiveCollection;
  private readonly _requestRender: () => void;
  private readonly _releaseDrapedCollection: (collection: VectorCollection) => void;
  private readonly _isSymbolPlaced: (tileId: string) => boolean;
  private readonly _preparePaint: (collection: SceneCollection, budget?: Budget) => boolean;
  private readonly _pendingDestroy = new Set<SceneCollection>();
  private readonly _firstUpdates = [new Map<SceneCollection, FirstUpdate>(), new Map<SceneCollection, FirstUpdate>()];
  private _resourceUploadTurn?: object;
  private readonly _parents = new WeakMap<SceneCollection, PrimitiveCollection>();
  private readonly _replacements = new Set<SceneReplacement>();
  private readonly _replacementForCollection = new WeakMap<SceneCollection, SceneReplacement>();
  private readonly _vectorVisibility = new WeakMap<SceneCollection, boolean>();
  private _layerVisibility: ReadonlyMap<string, boolean> = new Map();
  private _hiddenLayers: TileVisibility['hiddenLayers'] = new Map();
  private readonly _pendingRelease: Array<() => void> = [];
  private _pendingRaster: RasterTileUpdate = { removed: [], added: [], removedMaterials: [] };
  private _pendingPattern: PatternTileUpdate = { removed: [], added: [], removedMaterials: [] };

  constructor(
    root: PrimitiveCollection,
    requestRender: () => void,
    isSymbolPlaced: (tileId: string) => boolean,
    releaseDrapedCollection: (collection: VectorCollection) => void = () => {},
    preparePaint: (collection: SceneCollection, budget?: Budget) => boolean = () => true,
  ) {
    this._root = root;
    this._requestRender = requestRender;
    this._releaseDrapedCollection = releaseDrapedCollection;
    this._isSymbolPlaced = isSymbolPlaced;
    this._preparePaint = preparePaint;
  }

  add(collection: SceneCollection): void {
    if (!this._root.contains(collection)) {
      this._root.add(collection);
    }
  }

  /** Cached CPU-complete tiles can still own unfinished Native preparation. */
  restoreVector(collections: readonly VectorCollection[]): void {
    const pending: VectorCollection[] = [];
    for (const collection of collections) {
      this.setVectorVisibility(collection, true);
      this.add(collection);
      if (!readyPrimitives(collection))
        pending.push(collection);
    }
    this.queueFirstUpdate(pending);
  }

  /** Early symbol publications can retire before their first Native upload. */
  restoreSymbols(collections: readonly PrimitiveCollection[]): void {
    for (const collection of collections) {
      collection.show = true;
      this.add(collection);
    }
    this.queueFirstUpdate(collections.filter(collection => !readyPrimitives(collection)), false);
  }

  /** Coverage intent survives style hiding and hidden successor uploads. */
  setVectorVisibility(collection: SceneCollection, visible: boolean): void {
    this._vectorVisibility.set(collection, visible);
    collection.show = visible && !this._replacementForCollection.has(collection)
      && !this._pendingDestroy.has(collection);
    if (collection instanceof BufferPolygonCollection && isClampHeightReference(collection.heightReference)) {
      this._syncDrapedCollection(collection);
    }
  }

  /** Native discovers draped polygons from show before the next tileset update. */
  syncDrapedVisibility(layerVisibility: ReadonlyMap<string, boolean>): void {
    this._layerVisibility = layerVisibility;
    for (let index = 0; index < this._root.length; index++) {
      const collection = this._root.get(index);
      if (collection instanceof BufferPolygonCollection && isClampHeightReference(collection.heightReference)) {
        this._syncDrapedCollection(collection);
      }
    }
  }

  private _syncDrapedCollection(collection: BufferPolygonCollection): void {
    if (!this._vectorVisibility.has(collection)) {
      this._vectorVisibility.set(collection, true);
    }
    const layers = drawLayersForOwner(collection);
    const styleVisible = layers.size === 0 || [...layers].some(id => this._layerVisibility.get(id) !== false);
    collection.show = (this._vectorVisibility.get(collection) ?? true)
      && styleVisible && !this._replacementForCollection.has(collection)
      && !this._pendingDestroy.has(collection);
  }

  detach(collection: SceneCollection): void {
    const replacement = this._replacementForCollection.get(collection);
    if (replacement) {
      this._cancelReplacement(replacement);
    }
    const parent = this._parents.get(collection);
    if (parent) {
      parent.remove(collection);
    }
    else if (this._root.contains(collection)) {
      this._root.remove(collection);
    }
  }

  deferDestroy(collection: SceneCollection): void {
    if (!(collection instanceof Primitive)) {
      this._releaseDrapedCollection(collection);
    }
    this._pendingDestroy.add(collection);
  }

  detachForDestruction(collection: SceneCollection): void {
    this.detach(collection);
    this.deferDestroy(collection);
  }

  queueSymbolRemoval(collections: readonly PrimitiveCollection[]): void {
    for (const collection of collections) {
      this.detachForDestruction(collection);
    }
  }

  applyRasterUpdate(update: RasterTileUpdate): void {
    this._applyPrimitivePublication(update);
    this._pendingRaster.removed.push(...update.removed);
    this._pendingRaster.removedMaterials.push(...update.removedMaterials);
  }

  applyPatternUpdate(update: PatternTileUpdate): void {
    this._applyPrimitivePublication(update);
    this._pendingPattern.removed.push(...update.removed);
    this._pendingPattern.removedMaterials.push(...update.removedMaterials);
  }

  applyPublication(result: TilePublishResult): void {
    if (result.previousVector.length > 0 || result.retiredVector.length > 0 || result.addedVector.length > 0 || result.retainedSurfaces) {
      this._applyVectorPublication(result);
    }
    this.applyRasterUpdate(result.raster);
    if (result.pattern)
      this.applyPatternUpdate(result.pattern);
    if (result.removedSymbols.length > 0 || result.addedSymbols.length > 0 || result.retainedSymbols) {
      this._applySymbolPublication(result);
    }
    if (result.stage === 'complete') {
      for (const replacement of this._replacements) {
        if (replacement.kind === 'vector' && replacement.tileId === result.tileId) {
          replacement.awaitingDetail = false;
          this._finishReplacement(replacement, new Set());
        }
      }
    }
  }

  private _contains(collection: SceneCollection): boolean {
    const parent = this._parents.get(collection);
    return parent ? this._root.contains(parent) && parent.contains(collection) : this._root.contains(collection);
  }

  private _visible(collection: SceneCollection): boolean {
    return this._root.show && collection.show && this._parents.get(collection)?.show !== false;
  }

  private _applyPrimitivePublication(update: PatternTileUpdate | RasterTileUpdate): void {
    for (const [primitive, parent] of update.parents ?? []) {
      this._parents.set(primitive, parent);
    }
    for (const [primitive, parent] of update.retained?.parents ?? []) {
      this._parents.set(primitive, parent);
    }
    if (!update.tileId) {
      return;
    }
    let replacement = [...this._replacements].find(item => item.kind === 'vector' && item.tileId === update.tileId);
    if (!replacement && update.retained) {
      this._beginReplacement('vector', update.tileId, new Set(update.retained.parents.keys()), new Set());
      replacement = [...this._replacements].find(item => item.kind === 'vector' && item.tileId === update.tileId)!;
    }
    if (replacement) {
      let retainedVisible = false;
      for (const primitive of update.retained?.parents.keys() ?? []) {
        if (replacement.next.delete(primitive)) {
          // This committed generation never became visible. Cancel its GPU
          // preparation instead of blocking the next handoff on stale work.
          replacement.waiting.delete(primitive);
          this._replacementForCollection.delete(primitive);
          this._removeFirstUpdate(primitive);
          this.deferDestroy(primitive);
        }
        else {
          replacement.old.add(primitive);
          retainedVisible = true;
        }
      }
      if (update.retained) {
        (retainedVisible ? replacement.release : this._pendingRelease).push(update.retained.release);
      }
      for (const primitive of update.added) {
        replacement.next.add(primitive);
        replacement.waiting.add(primitive);
        this._replacementForCollection.set(primitive, replacement);
        primitive.show = false;
      }
      this._finishReplacement(replacement, new Set());
    }
    this.queueFirstUpdate(update.added, false);
  }

  private _applySymbolPublication(result: TilePublishResult): void {
    const firstUpdates = result.firstUpdateSymbols.filter(collection => !readyPrimitives(collection));
    const old = new Set<PrimitiveCollection>();
    const abandoned = new Set<PrimitiveCollection>();
    const release: Array<() => void> = [];
    for (const replacement of [...this._replacements]) {
      if (replacement.kind !== 'symbol' || replacement.tileId !== result.tileId) {
        continue;
      }
      this._forgetReplacement(replacement);
      for (const collection of replacement.old) {
        old.add(collection as PrimitiveCollection);
      }
      for (const collection of replacement.next) {
        abandoned.add(collection as PrimitiveCollection);
        this.detachForDestruction(collection);
      }
      release.push(...replacement.release);
    }
    if (result.retainedSymbols) {
      let held = false;
      for (const collection of result.retainedSymbols.collections) {
        if (!abandoned.has(collection) && collection.show && this._root.contains(collection)) {
          old.add(collection);
          held = true;
        }
      }
      (held ? release : this._pendingRelease).push(result.retainedSymbols.release);
    }
    this.queueSymbolRemoval(result.removedSymbols.filter(collection => !old.has(collection)));
    if (old.size > 0 && result.addedSymbols.length > 0) {
      this._beginReplacement('symbol', result.tileId, old, new Set(result.addedSymbols), new Set(firstUpdates), release);
    }
    else {
      this.queueSymbolRemoval([...old]);
      this._pendingRelease.push(...release);
    }
    for (const collection of result.addedSymbols) {
      if (!this._replacementForCollection.has(collection)) {
        collection.show = true;
      }
      this.add(collection);
    }
    this.queueFirstUpdate(firstUpdates, false);
  }

  private _applyVectorPublication(result: TilePublishResult): void {
    // Detail stages append to the committed generation. They must join its
    // pending handoff instead of retiring the surface the renderer still owns.
    if (result.previousVector.length === 0 && result.retiredVector.length === 0) {
      for (const replacement of this._replacements) {
        if (replacement.kind !== 'vector' || replacement.tileId !== result.tileId) {
          continue;
        }
        for (const collection of result.addedVector) {
          replacement.next.add(collection);
          replacement.waiting.add(collection);
          this._replacementForCollection.set(collection, replacement);
          collection.show = false;
          this.add(collection);
        }
        this.queueFirstUpdate(result.addedVector);
        return;
      }
    }
    const old = new Set<SceneCollection>();
    const abandoned = new Set<SceneCollection>();
    const release: Array<() => void> = [];
    for (const replacement of [...this._replacements]) {
      if (replacement.kind !== 'vector' || replacement.tileId !== result.tileId) {
        continue;
      }
      this._forgetReplacement(replacement);
      release.push(...replacement.release);
      for (const collection of replacement.old) {
        old.add(collection);
      }
      for (const collection of replacement.next) {
        abandoned.add(collection);
        this.detachForDestruction(collection);
      }
    }
    for (const retained of result.retainedSurfaces ?? []) {
      release.push(retained.release);
      for (const [primitive, parent] of retained.parents) {
        this._parents.set(primitive, parent);
        old.add(primitive);
      }
    }
    for (const collection of result.previousVector) {
      if (!abandoned.has(collection) && this._root.contains(collection)) {
        old.add(collection);
      }
    }
    const replacing = old.size > 0 && (result.addedVector.length > 0 || result.retainPreviousGeneration);
    for (const collection of [...result.previousVector, ...result.retiredVector]) {
      if (!replacing || !old.has(collection)) {
        collection.show = false;
        this.deferDestroy(collection);
      }
    }
    if (replacing) {
      this._beginReplacement('vector', result.tileId, old, new Set(result.addedVector), undefined, release);
      const replacement = [...this._replacements].find(item => item.kind === 'vector' && item.tileId === result.tileId)!;
      replacement.awaitingDetail = result.retainPreviousGeneration;
    }
    else {
      for (const collection of old) {
        collection.show = false;
        this.deferDestroy(collection);
      }
      this._pendingRelease.push(...release);
    }
    for (const collection of result.addedVector) {
      this.add(collection);
    }
    this.queueFirstUpdate(result.addedVector);
  }

  private _beginReplacement(
    kind: SceneReplacement['kind'],
    tileId: string,
    old: Set<SceneCollection>,
    next: Set<SceneCollection>,
    waiting = new Set(next),
    release: Array<() => void> = [],
  ): SceneReplacement {
    const replacement: SceneReplacement = {
      kind,
      tileId,
      old,
      next,
      waiting,
      visible: [...old].some(collection => this._vectorVisibility.get(collection) ?? collection.show),
      release,
    };
    this._replacements.add(replacement);
    for (const collection of next) {
      this._replacementForCollection.set(collection, replacement);
      collection.show = false;
    }
    return replacement;
  }

  /** Restore resident buffers through the existing hidden-upload handoff. */
  restoreWhenReady(tileId: string, collections: readonly VectorCollection[]): void {
    let replacement = [...this._replacements].find(item => item.kind === 'vector' && item.tileId === tileId);
    if (!replacement) {
      replacement = this._beginReplacement('vector', tileId, new Set(), new Set(collections));
    }
    else {
      for (const collection of collections) {
        if (!replacement.next.has(collection)) {
          replacement.next.add(collection);
          replacement.waiting.add(collection);
          this._replacementForCollection.set(collection, replacement);
        }
        collection.show = false;
      }
    }
    replacement.visible = true;
    for (const collection of collections) {
      this.add(collection);
    }
    this.queueFirstUpdate(collections);
  }

  /** Replace a paint collection after the new one completes its first GPU update. */
  replaceWhenReady(tileId: string, old: VectorCollection, next: VectorCollection): void {
    const replacement = this._replacementForCollection.get(old);
    if (replacement) {
      replacement.next.delete(old);
      replacement.waiting.delete(old);
      this._replacementForCollection.delete(old);
      this._removeFirstUpdate(old);
      this.detachForDestruction(old);
      replacement.next.add(next);
      replacement.waiting.add(next);
      this._replacementForCollection.set(next, replacement);
      next.show = false;
    }
    else if (this._root.contains(old)) {
      this._beginReplacement('vector', tileId, new Set([old]), new Set([next]));
    }
    else {
      this.detachForDestruction(old);
    }
    this.add(next);
    this.queueFirstUpdate([next]);
  }

  /** Apply one tile policy to every pending owner, including owners added since the previous call. */
  syncTileVisibility(current: TileVisibility, previous: TileVisibility): void {
    this._hiddenLayers = current.hiddenLayers;
    for (const replacement of this._replacements) {
      const tileId = replacement.tileId;
      if (replacement.kind === 'vector') {
        if (!current.hiddenLayers.has(tileId) && !previous.hiddenLayers.has(tileId)) {
          continue;
        }
        const hidden = current.hiddenLayers.get(tileId);
        let visible = false;
        for (const collection of replacement.old) {
          const covered = !allDrawLayersHidden(collection, hidden);
          this.setVectorVisibility(collection, covered);
          visible = covered || visible;
        }
        if (replacement.old.size === 0) {
          for (const collection of replacement.next) {
            if (!allDrawLayersHidden(collection, hidden)) {
              visible = true;
              break;
            }
          }
        }
        replacement.visible = visible;
      }
      else {
        if (!current.hiddenSymbols.has(tileId) && !previous.hiddenSymbols.has(tileId)) {
          continue;
        }
        replacement.visible = !current.hiddenSymbols.has(tileId);
        for (const collection of replacement.old) {
          collection.show = replacement.visible;
        }
      }
      for (const collection of replacement.next) {
        collection.show = false;
      }
    }
  }

  queueFirstUpdate(collections: readonly SceneCollection[], stagedVector = true): void {
    let queued = false;
    for (const collection of collections) {
      if (!collection.isDestroyed() && !this.hasPendingFirstUpdate(collection)) {
        this._firstUpdates[isSurface(collection) ? 0 : 1].set(collection, {
          index: 0,
          staged: stagedVector && stagedCollection(collection),
          drawable: new Set(),
        });
        queued = true;
      }
    }
    if (queued) {
      this._requestRender();
    }
  }

  hasPendingFirstUpdate(collection: SceneCollection): boolean {
    return this._firstUpdates[0].has(collection) || this._firstUpdates[1].has(collection);
  }

  /** Query drawable coverage, including partial uploads and every held predecessor. */
  someDrawableCollection(
    tileId: string,
    kind: SceneReplacement['kind'],
    queryCurrent: (predicate: (collection: SceneCollection) => boolean) => boolean,
    predicate: (collection: SceneCollection) => boolean,
  ): boolean {
    const query = (collection: SceneCollection): boolean => {
      const upload = this._firstUpdates[0].get(collection) ?? this._firstUpdates[1].get(collection);
      if (!upload) {
        return predicate(collection);
      }
      else if (collection instanceof CesiumPrimitiveCollection) {
        for (const index of upload.drawable) {
          if (predicate(collection.get(index)))
            return true;
        }
      }
      else if (upload.drawable.size > 0) {
        return predicate(collection);
      }
      return false;
    };
    // Prepared successors stay hidden until their generation's handoff.
    if (queryCurrent(collection => !this._replacementForCollection.has(collection) && query(collection))) {
      return true;
    }
    for (const replacement of this._replacements) {
      if (replacement.tileId === tileId && replacement.kind === kind) {
        for (const collection of replacement.old) {
          if (query(collection))
            return true;
        }
      }
    }
    return false;
  }

  get pendingFirstUpdateCount(): number {
    return this._firstUpdates[0].size + this._firstUpdates[1].size;
  }

  /** Waiting for worker results is excluded from overload admission turns. */
  get hasRunnableFirstUpdates(): boolean {
    for (const queue of this._firstUpdates) {
      for (const collection of queue.keys()) {
        if (readyPrimitives(collection))
          return true;
        if (!this.idlePreparationsEnabled) {
          if (runnablePrimitives(collection))
            return true;
          continue;
        }
        // Resource-only work retains the upload stage's admission for post-draw.
        if (renderPrimitives(collection))
          return true;
        const owners = new Set<GeometryPrimitive>();
        preparationOwners(collection, owners);
        if (owners.size > 0)
          return true;
      }
    }
    return false;
  }

  get hasRunnablePreparations(): boolean {
    const owners = new Set<GeometryPrimitive>();
    for (const queue of this._firstUpdates) {
      for (const collection of queue.keys()) {
        if (!collection.isDestroyed() && this._contains(collection)) {
          preparationOwners(collection, owners);
          if (owners.size > 0)
            return true;
        }
      }
    }
    return false;
  }

  get hasRunnableResourceUploads(): boolean {
    for (const queue of this._firstUpdates) {
      for (const collection of queue.keys()) {
        if (collection.isDestroyed() || !this._contains(collection))
          continue;
        const owners = new Set<GeometryPrimitive>();
        resourceUploadOwners(collection, owners);
        if (owners.size > 0)
          return true;
      }
    }
    return false;
  }

  /** Safe post-draw/idle boundary: Native update and presentation stay in render. */
  advanceResourceUploads(frameState: RenderFrameState, budget: Budget, turn: object, measure: <T>(operation: () => T) => T, minimumProgress: boolean): { units: number; renderNeeded: boolean } {
    let units = 0;
    let renderNeeded = false;
    if (this._resourceUploadTurn === turn)
      return { units, renderNeeded };
    const visited = new Set<GeometryPrimitive>();
    for (const queue of this._firstUpdates) {
      for (const collection of queue.keys()) {
        if (collection.isDestroyed() || !this._contains(collection))
          continue;
        const owners = new Set<GeometryPrimitive>();
        resourceUploadOwners(collection, owners);
        for (const owner of owners) {
          if (visited.has(owner) || owner.isDestroyed())
            continue;
          if (budget.exhausted && (!minimumProgress || units > 0))
            return { units, renderNeeded };
          visited.add(owner);
          this._resourceUploadTurn = turn;
          renderNeeded = measure(() => Reflect.apply(owner.advanceResourceUpload, owner, [frameState, budget, turn])) || renderNeeded;
          units++;
        }
      }
    }
    return { units, renderNeeded };
  }

  private _hasRenderFirstUpdates(): boolean {
    for (const queue of this._firstUpdates) {
      for (const collection of queue.keys()) {
        // A whole-ready queue still needs render-time cleanup and handoff.
        if (!collection.isDestroyed() && this._contains(collection)
          && (readyPrimitives(collection) || renderPrimitives(collection))) {
          return true;
        }
      }
    }
    return false;
  }

  private _requestFirstUpdateContinuation(): void {
    if (!this.idlePreparationsEnabled || this._hasRenderFirstUpdates())
      this._requestRender();
  }

  /** CPU only: no paint refresh, Native update, command submission or handoff. */
  advancePreparations(frameState: RenderFrameState, budget: Budget, measurePreparation: <T>(operation: () => T) => T, minimumProgress: boolean): { units: number; renderNeeded: boolean } {
    let units = 0;
    const visited = new Set<GeometryPrimitive>();
    for (const queue of this._firstUpdates) {
      for (const collection of queue.keys()) {
        if (collection.isDestroyed() || !this._contains(collection))
          continue;
        const owners = new Set<GeometryPrimitive>();
        preparationOwners(collection, owners);
        for (const owner of owners) {
          if (visited.has(owner) || owner.isDestroyed() || !owner.hasRunnableIdlePreparation)
            continue;
          if (budget.exhausted && (!minimumProgress || units > 0))
            return { units, renderNeeded: this._hasRenderFirstUpdates() };
          visited.add(owner);
          // Native's frame has geometry context/projection fields omitted by
          // the scene collection interface; idle retains that same frame.
          measurePreparation(() => Reflect.apply(owner.advancePreparation, owner, [frameState, budget]));
          units++;
        }
      }
    }
    return { units, renderNeeded: this._hasRenderFirstUpdates() };
  }

  private _removeFirstUpdate(collection: SceneCollection): void {
    for (const queue of this._firstUpdates) {
      queue.delete(collection);
    }
  }

  hasPendingReplacement(tileId: string): boolean {
    for (const replacement of this._replacements) {
      if (replacement.tileId === tileId) {
        return true;
      }
    }
    return false;
  }

  pumpFirstUpdates(frameState: RenderFrameState, budget: Budget, measurePreparation: <T>(operation: () => T) => T = operation => operation(), minimumProgress = false, resourceTurn?: object): SceneCollection[] {
    const pumped: SceneCollection[] = [];
    const readyToDraw = new Set<SceneCollection>();
    for (const replacement of this._replacements) {
      measurePreparation(() => this._finishReplacement(replacement, readyToDraw, budget));
    }
    // Native emits commands before afterRender makes public ready true.
    // Those resources must draw in every viewport of the physical frame,
    // even when its shared allowance leaves first updates pending.
    const readyChildren = new Map<SceneCollection, ReadonlySet<number>>();
    for (const queue of this._firstUpdates) {
      for (const [collection, upload] of queue) {
        if (this._visible(collection) && this._contains(collection) && upload.drawable.size > 0) {
          readyChildren.set(collection, new Set(upload.drawable));
        }
      }
    }
    let admitted = false;
    const updatedCollections = new Set<SceneCollection>();
    const updatedChildren = new Map<SceneCollection, Set<number>>();
    const prepared = new Map<SceneCollection, boolean>();
    const preparePaint = (collection: SceneCollection): boolean => {
      if (!prepared.has(collection)) {
        prepared.set(collection, measurePreparation(() => this._preparePaint(collection, budget)));
      }
      return prepared.get(collection)!;
    };
    const finishUpdates = (): SceneCollection[] => {
      // A surface may preempt a partly uploaded line. Its completed children
      // still draw exactly once, after new uploads have had their allowance.
      for (const [collection, indices] of readyChildren) {
        if (this._visible(collection) && this._contains(collection) && !updatedCollections.has(collection)) {
          if (!preparePaint(collection)) {
            this._requestRender();
          }
          // Pending replacement geometry does not invalidate already visible
          // chunks of the old owner. Keep drawing those while uploads wait.
          if (!this._visible(collection) || collection.isDestroyed() || !this._contains(collection))
            continue;
          for (const index of indices) {
            if (updatedChildren.get(collection)?.has(index))
              continue;
            if (collection instanceof CesiumPrimitiveCollection)
              collection.get(index).update(frameState);
            else
              (collection as { update: (frameState: unknown) => void }).update(frameState);
          }
        }
      }
      // Hidden uploads emitted no commands. If residency reveals one later
      // this frame, updateChildren must still submit its first visible draw.
      return pumped.filter(collection => this._visible(collection) && !readyToDraw.has(collection));
    };
    for (const queue of this._firstUpdates) {
      for (const [collection, upload] of queue) {
        if (collection.isDestroyed() || !this._contains(collection)) {
          queue.delete(collection);
          const replacement = this._replacementForCollection.get(collection);
          if (replacement) {
            this._cancelReplacement(replacement);
          }
          continue;
        }
        if (!readyPrimitives(collection) && !runnablePrimitives(collection))
          continue;
        const length = collection instanceof CesiumPrimitiveCollection ? collection.length : 1;
        // Native marks public ready after a frame that already submitted all
        // these children. Completing its bookkeeping needs no cold admission.
        const completed = readyPrimitives(collection) && upload.drawable.size === length;
        if (!completed && budget.exhausted && (!minimumProgress || admitted)) {
          this._requestFirstUpdateContinuation();
          return finishUpdates();
        }
        admitted ||= !completed;
        if (!preparePaint(collection)) {
          this._requestRender();
          continue;
        }
        if (!queue.has(collection) || collection.isDestroyed() || !this._contains(collection))
          continue;
        let updated = false;
        do {
          const length = collection instanceof CesiumPrimitiveCollection ? collection.length : 1;
          const uploadTarget = upload.staged ? (collection as CesiumPrimitiveCollection).get(upload.index) : collection;
          if ((upload.staged ? upload.drawable.has(upload.index) : upload.drawable.size === length)
            && !pendingUploads(uploadTarget)) {
            upload.index++;
            continue;
          }
          if (upload.staged) {
            const child = (collection as CesiumPrimitiveCollection).get(upload.index);
            // A runnable sibling does not admit this worker-waiting owner.
            // Preserve the one minimum unit for a child that can advance.
            if (!readyPrimitives(child) && !runnablePrimitives(child)) {
              upload.index++;
              continue;
            }
          }
          // Required paint and the first Native update form one progress
          // unit. Yielding between them can repeat paint every frame without
          // ever starting an upload during a transition.
          if (updated && budget.exhausted) {
            this._requestFirstUpdateContinuation();
            return finishUpdates();
          }
          // Hidden replacements must upload before the held tile is released.
          const show = collection.show;
          const hidden = !this._visible(collection);
          const commandCount = frameState.commandList?.length ?? 0;
          if (hidden) {
            collection.show = true;
          }
          try {
            const update = (): void => updateGeometryWithBudget(frameState, budget, () => {
              if (upload.staged) {
                (collection as CesiumPrimitiveCollection).get(upload.index).update(frameState);
                let indices = updatedChildren.get(collection);
                if (!indices) {
                  indices = new Set();
                  updatedChildren.set(collection, indices);
                }
                indices.add(upload.index);
              }
              else {
                (collection as { update: (frameState: unknown) => void }).update(frameState);
                updatedCollections.add(collection);
              }
            }, { turn: resourceTurn, deferred: this.idlePreparationsEnabled });
            // Subtract only fully cold admissions. Ready draws and opaque
            // Buffer collection updates stay in the mandatory estimate.
            const target = upload.staged ? (collection as CesiumPrimitiveCollection).get(upload.index) : collection;
            if (!drawablePrimitives(target) && (upload.staged || upload.drawable.size === 0))
              measurePreparation(update);
            else
              update();
            const submitted = new Set<Primitive>();
            for (const command of frameState.commandList?.slice(commandCount) ?? []) {
              if (command.owner) {
                const owner = primitiveResourceOwner(command.owner);
                if (owner)
                  submitted.add(owner);
              }
            }
            if (upload.staged) {
              if (readyPrimitives((collection as CesiumPrimitiveCollection).get(upload.index), submitted))
                upload.drawable.add(upload.index);
            }
            else if (collection instanceof CesiumPrimitiveCollection) {
              for (let index = 0; index < collection.length; index++) {
                if (readyPrimitives(collection.get(index), submitted))
                  upload.drawable.add(index);
              }
            }
            else if (readyPrimitives(collection, submitted)) {
              upload.drawable.add(0);
            }
          }
          finally {
            if (hidden) {
              collection.show = show;
              frameState.commandList?.splice(commandCount);
            }
          }
          updated = true;
          upload.index++;
        } while (upload.staged && upload.index < (collection as CesiumPrimitiveCollection).length);
        if (!readyPrimitives(collection)) {
          upload.index = 0;
          if (runnablePrimitives(collection))
            this._requestFirstUpdateContinuation();
          continue;
        }
        // The tileset marked its memory budget dirty while this first-update
        // queue was nonempty. Capture once here; next frame uses real buffers,
        // and settled frames never walk Native VA resources.
        captureUploadedBytes(collection);
        queue.delete(collection);
        pumped.push(collection);
        const replacement = this._replacementForCollection.get(collection);
        if (replacement) {
          replacement.waiting.delete(collection);
          measurePreparation(() => this._finishReplacement(replacement, readyToDraw, budget));
        }
      }
    }
    if (pumped.length > 0) {
      // A held parent can be released only after its replacement uploads.
      // Request the frame that re-evaluates that hold in requestRenderMode.
      this._requestRender();
    }
    return finishUpdates();
  }

  /** Placement can finish after this frame's first updates have run. */
  finishReplacements(budget?: Budget): void {
    for (const replacement of this._replacements) {
      this._finishReplacement(replacement, undefined, budget);
    }
  }

  private _finishReplacement(replacement: SceneReplacement, readyToDraw?: Set<SceneCollection>, budget?: Budget): void {
    if (replacement.awaitingDetail || replacement.waiting.size > 0
      || (replacement.kind === 'symbol' && !this._isSymbolPlaced(replacement.tileId))) {
      return;
    }
    if (replacement.kind === 'vector') {
      for (const collection of replacement.next) {
        if (!this._preparePaint(collection, budget)) {
          this._requestRender();
          return;
        }
      }
    }
    // Preparing paint can replace a blend-mode collection or cancel its handoff.
    if (!this._replacements.has(replacement) || replacement.awaitingDetail || replacement.waiting.size > 0) {
      return;
    }
    this._forgetReplacement(replacement);
    for (const next of replacement.next) {
      if (replacement.kind === 'vector') {
        this.setVectorVisibility(next, replacement.visible && !allDrawLayersHidden(next, this._hiddenLayers.get(replacement.tileId)));
      }
      else {
        next.show = replacement.visible;
      }
      readyToDraw?.add(next);
    }
    for (const old of replacement.old) {
      old.show = false;
      this.deferDestroy(old);
    }
    this._pendingRelease.push(...replacement.release);
    this._requestRender();
  }

  private _forgetReplacement(replacement: SceneReplacement): void {
    this._replacements.delete(replacement);
    for (const collection of replacement.next) {
      this._replacementForCollection.delete(collection);
    }
    for (const collection of replacement.next) {
      this._removeFirstUpdate(collection);
    }
  }

  private _cancelReplacement(replacement: SceneReplacement): void {
    this._forgetReplacement(replacement);
    for (const collection of replacement.old) {
      this.detachForDestruction(collection);
    }
    // The renderer owns committed successors, including collections parked
    // in its retired pool. Cancelling their scene handoff releases only the
    // held predecessor; eviction must request successor destruction itself.
    for (const collection of replacement.next) {
      this.detach(collection);
    }
    this._pendingRelease.push(...replacement.release);
  }

  /** Release held predecessors when the tileset is destroyed mid-upload. */
  clearPendingReplacements(): void {
    for (const replacement of [...this._replacements]) {
      this._cancelReplacement(replacement);
      for (const collection of replacement.next) {
        this.deferDestroy(collection);
      }
    }
  }

  updateChildren(frameState: RenderFrameState, pumped: readonly SceneCollection[] = []): void {
    if (this.pendingFirstUpdateCount === 0 && pumped.length === 0) {
      // The root is a CesiumVectorTileset, whose update drives this method.
      Reflect.apply(updateCollection, this._root, [frameState]);
      return;
    }
    if (!this._root.show) {
      return;
    }
    const waiting = new Set<unknown>(pumped);
    for (const queue of this._firstUpdates) {
      for (const collection of queue.keys()) {
        waiting.add(collection);
      }
    }
    for (const replacement of this._replacements) {
      for (const collection of replacement.next) {
        waiting.add(collection);
      }
    }
    const hidden: Array<[Primitive, boolean]> = [];
    for (const collection of waiting) {
      if (collection instanceof Primitive && this._parents.has(collection)) {
        hidden.push([collection, collection.show]);
        collection.show = false;
      }
    }
    try {
      for (let i = 0; i < this._root.length; i++) {
        const child = this._root.get(i) as { update: (state: RenderFrameState) => void };
        if (!waiting.has(child)) {
          child.update(frameState);
        }
      }
    }
    finally {
      for (const [primitive, show] of hidden) {
        primitive.show = show;
      }
    }
  }

  flushRasterRemovals(): void {
    destroyRasterResources(this._pendingRaster);
    this._pendingRaster = { removed: [], added: [], removedMaterials: [] };
  }

  flushPatternRemovals(): void {
    destroyPatternResources(this._pendingPattern);
    this._pendingPattern = { removed: [], added: [], removedMaterials: [] };
  }

  flushRemovals(): void {
    for (const replacement of [...this._replacements]) {
      if ([...replacement.next].some(collection => collection.isDestroyed()
        || !this._contains(collection) || this._pendingDestroy.has(collection))) {
        this._cancelReplacement(replacement);
      }
    }
    for (const collection of this._pendingDestroy) {
      this.detach(collection);
      if (!collection.isDestroyed()) {
        collection.destroy();
      }
    }
    this._pendingDestroy.clear();
    for (const release of this._pendingRelease.splice(0)) {
      release();
    }
    this.flushRasterRemovals();
    this.flushPatternRemovals();
  }
}
