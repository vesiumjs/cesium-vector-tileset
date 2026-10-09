import type { PrimitiveCollection } from 'cesium';
import type { SymbolTileRenderer } from '../symbol/symbol-renderer';
import type { AdmittedFrame } from './frame-preparation';
import type { RenderFrameState } from './render-frame';
import { PrimitiveCollection as Collection } from 'cesium';

const requestRemovalFrame = () => true;
function ownerCollections(root: PrimitiveCollection, target: PrimitiveCollection): PrimitiveCollection[] | undefined {
  if (root.contains(target))
    return [root];
  for (let index = 0; index < root.length; index++) {
    const child = root.get(index);
    if (child instanceof Collection) {
      const owners = ownerCollections(child, target);
      if (owners)
        return [root, ...owners];
    }
  }
  return undefined;
}

/**
 * Owns demand-render requests, removal observations and deferred placement wakes.
 * @internal
 */
export class SceneRenderWake {
  private readonly root: PrimitiveCollection;
  private readonly alive: () => boolean;
  private readonly visible: () => boolean;
  private readonly completedFrame: () => AdmittedFrame | undefined;
  private readonly symbols: () => SymbolTileRenderer;
  private readonly releaseOwner: () => void;

  constructor(
    root: PrimitiveCollection,
    alive: () => boolean,
    visible: () => boolean,
    completedFrame: () => AdmittedFrame | undefined,
    symbols: () => SymbolTileRenderer,
    releaseOwner: () => void,
  ) {
    this.root = root;
    this.alive = alive;
    this.visible = visible;
    this.completedFrame = completedFrame;
    this.symbols = symbols;
    this.releaseOwner = releaseOwner;
  }

  get enabled(): boolean {
    return this.alive() && this.visible();
  }

  /** Observe every ancestor collection so detaching a retained owner also releases its scene. */
  observe(scene: RenderFrameState['camera']['_scene']): boolean {
    if (scene === this.scene)
      return false;
    this.releaseOwner();
    this.scene = scene;
    const owners = (scene?.primitives && ownerCollections(scene.primitives, this.root)) ?? [];
    for (let index = 0; index < owners.length; index++) {
      const child = owners[index + 1] ?? this.root;
      this._removeSceneListeners.push(owners[index].primitiveRemoved.addEventListener((removed) => {
        if (removed === child) {
          this.requestRemoval();
          this.releaseOwner();
        }
      }));
    }
    return true;
  }

  release(): void {
    this.cancelPlacement();
    for (const remove of this._removeSceneListeners)
      remove();
    this._removeSceneListeners = [];
    if (this.afterRender) {
      const pending = this.afterRender.indexOf(this._requestNextFrame);
      if (pending !== -1)
        this.afterRender.splice(pending, 1);
    }
    this.afterRender = undefined;
    this.scene = undefined;
    this.requested = true;
  }

  afterRender?: RenderFrameState['afterRender'];

  scene?: RenderFrameState['camera']['_scene'];

  private _removeSceneListeners: Array<() => void> = [];

  requested = false;

  generation = 0;

  private _symbolPlacementWake?: ReturnType<typeof setTimeout>;

  private _symbolPlacementDeadline?: number;

  private readonly _requestNextFrame = () => {
    this.requested = false;
    const frame = this.completedFrame();
    // postRender runs after Native drains afterRender. A camera render can
    // already service that old request before its callback reaches this tick.
    return this.alive() && !(frame?.successfulUpdate
      && frame.requestGeneration === this.generation);
  };

  readonly request = () => {
    if (!this.alive())
      return;
    // Retain requests made before Cesium first observes the primitive. Idle
    // requestRenderMode scenes run prePassesUpdate but skip update entirely.
    this.requested = true;
    this.generation++;
    if (this.afterRender && !this.afterRender.includes(this._requestNextFrame)) {
      this.afterRender.push(this._requestNextFrame);
    }
    else if (!this.afterRender) {
      this.scene?.requestRender?.();
    }
  };

  requestRemoval(): void {
    if (this.afterRender) {
      if (!this.afterRender.includes(requestRemovalFrame))
        this.afterRender.push(requestRemovalFrame);
    }
    else {
      this.scene?.requestRender?.();
    }
  }

  cancelPlacement(): void {
    if (this._symbolPlacementWake !== undefined)
      clearTimeout(this._symbolPlacementWake);
    this._symbolPlacementWake = undefined;
    this._symbolPlacementDeadline = undefined;
  }

  continuePlacement(): boolean {
    // Read the deadline first: the clock may cross it before the runnable read.
    const deadline = this.symbols().nextPlacementTime;
    if (this.symbols().hasRunnableWork) {
      this.cancelPlacement();
      this.request();
      return true;
    }
    if (deadline === undefined || !this.enabled) {
      this.cancelPlacement();
      return false;
    }
    if (this._symbolPlacementDeadline === deadline)
      return false;
    this.cancelPlacement();
    this._symbolPlacementDeadline = deadline;
    const scene = this.scene;
    this._symbolPlacementWake = setTimeout(() => {
      this._symbolPlacementWake = undefined;
      this._symbolPlacementDeadline = undefined;
      if (!this.enabled || this.scene !== scene)
        return;
      // The deadline may have moved after another scope committed. Recompute
      // it; only runnable work wakes Native, without waiting for an idle tick.
      if (this.continuePlacement())
        scene?.requestRender?.();
    }, Math.max(0, deadline - performance.now()));
    return false;
  }
}
