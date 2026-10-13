import { PrimitiveCollection } from 'cesium';

const NO_RETAINED_COLLECTIONS: ReadonlySet<PrimitiveCollection> = new Set();

/** Shared layer parents stay alive while their last tile generation is attached. */
export class LayerCollections {
  readonly collections = new Map<string, PrimitiveCollection>();

  private readonly _unused = new Set<string>();

  get hasUnused(): boolean {
    return this._unused.size > 0;
  }

  /** The track's complete declared layer set includes temporarily hidden layers. */
  setLayers(layerIds: Iterable<string>): void {
    const current = new Set(layerIds);
    this._unused.clear();
    for (const id of current) {
      if (!this.collections.has(id)) {
        this.collections.set(id, new PrimitiveCollection({ destroyPrimitives: false }));
      }
    }
    for (const id of this.collections.keys()) {
      // The ID can survive in the style while moving to another render track.
      if (!current.has(id))
        this._unused.add(id);
    }
  }

  /** Called after resource releases; the scene owner detaches and destroys the returned parents. */
  collectUnused(retained: ReadonlySet<PrimitiveCollection> = NO_RETAINED_COLLECTIONS): PrimitiveCollection[] {
    const unused: PrimitiveCollection[] = [];
    for (const id of this._unused) {
      const collection = this.collections.get(id)!;
      if (collection.length > 0 || retained.has(collection))
        continue;
      this.collections.delete(id);
      this._unused.delete(id);
      unused.push(collection);
    }
    return unused;
  }
}
