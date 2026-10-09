/**
 * LRU pool of retired (out-of-view, GPU-resident) tile entries, shared by
 * the bucket/symbol/pattern tracks. Retiring keeps a tile's GPU resources
 * alive for a cheap pan-back restore; only capacity overflow destroys.
 *
 * Mechanics mirror MapLibre's out-of-view TileCache (insertion-ordered LRU,
 * same-key replace) and Cesium's replacement queues (last-frame protection
 * lives with the caller: entries are only retired once they leave the
 * renderable set, so everything pooled is evictable).
 *
 * The pool owns no GPU semantics: insert/replace/trim return the entries
 * needing release, and each renderer maps them through its own release path
 * (undrape, material/atlas refcounting, tile-state drops). Replacing a
 * same-key entry releases the old one instead of dropping it silently - the
 * hand-rolled pools used to leak the replaced entry's refs when a tile was
 * rebuilt while retired.
 */
export class RetiredPool<T> {
  private _entries = new Map<string, T>();

  private _capacity: number;

  constructor(capacity: number) {
    this._capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number {
    return this._entries.size;
  }

  get capacity(): number {
    return this._capacity;
  }

  get(key: string): T | undefined {
    return this._entries.get(key);
  }

  values(): IterableIterator<T> {
    return this._entries.values();
  }

  /** Oldest-first entries (insertion order doubles as LRU order). */
  entries(): IterableIterator<[string, T]> {
    return this._entries.entries();
  }

  /** Remove an entry (restore, or direct drop); undefined when absent. */
  take(key: string): T | undefined {
    const entry = this._entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this._entries.delete(key);
    return entry;
  }

  /**
   * Insert an entry, evicting oldest-first past capacity. A replaced
   * same-key entry comes back first: it is gone for good and must be
   * released like an eviction, not leaked.
   *
   * @returns entries needing release, replaced-oldest first.
   */
  retire(key: string, value: T): Array<{ key: string; value: T }> {
    const replaced = this.take(key);
    this._entries.set(key, value);
    return [...(replaced === undefined ? [] : [{ key, value: replaced }]), ...this._trim()];
  }

  /**
   * Resize the pool; shrinking past the new capacity evicts oldest-first.
   *
   * @returns entries needing release.
   */
  setCapacity(capacity: number): Array<{ key: string; value: T }> {
    this._capacity = Math.max(1, Math.floor(capacity));
    return this._trim();
  }

  /**
   * @internal
   */
  private _trim(): Array<{ key: string; value: T }> {
    const evicted: Array<{ key: string; value: T }> = [];
    while (this._entries.size > this._capacity) {
      const [key, value] = this._entries.entries().next().value!;
      this._entries.delete(key);
      evicted.push({ key, value });
    }
    return evicted;
  }

  /** Drop everything without release (the caller releases first). */
  clear(): void {
    this._entries.clear();
  }
}
