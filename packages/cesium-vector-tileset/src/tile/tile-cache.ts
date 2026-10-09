import type { Tile } from './tile';
import type { OverscaledTileID } from './tile-id';

interface TileCacheEntry {
  value: Tile;
  timeout?: ReturnType<typeof setTimeout>;
}

/**
 * A [least-recently-used cache](https://en.wikipedia.org/wiki/Cache_algorithms)
 * with hash lookup made possible by keeping a list of keys in parallel to
 * an array of dictionary of values
 * TilePyramid offloads currently unused tiles to this cache, and when a tile gets used again,
 * it is also removed from this cache. Thus addition is the only operation that counts as "usage"
 * for the purposes of LRU behaviour.
 * @internal
 */
export class TileCache {
  max: number;
  data: Record<string, TileCacheEntry[]> = {};
  order: string[] = [];
  onRemove: (element: Tile) => void;
  /**
   * @param max - number of permitted values
   * @param onRemove - callback called with items when they expire
   */
  constructor(max: number, onRemove: (element: Tile) => void) {
    this.max = max;
    this.onRemove = onRemove;
    this.reset();
  }

  /**
   * Clear the cache
   *
   * @returns this cache
   */
  reset(): this {
    for (const key in this.data) {
      for (const removedData of this.data[key]) {
        if (removedData.timeout)
          clearTimeout(removedData.timeout);
        this.onRemove(removedData.value);
      }
    }

    this.data = {};
    this.order = [];

    return this;
  }

  /**
   * Add a key, value combination to the cache, trimming its size if this pushes
   * it over max length.
   *
   * @param tileID - lookup key for the item
   * @param data - tile data
   *
   * @returns this cache
   */
  add(tileID: OverscaledTileID, data: Tile, expiryTimeout?: number): this {
    const key = tileID.wrapped().key;
    this.data[key] ||= [];

    const dataWrapper: TileCacheEntry = {
      value: data,
    };

    if (expiryTimeout !== undefined) {
      dataWrapper.timeout = setTimeout(() => {
        this.remove(tileID, dataWrapper);
      }, expiryTimeout);
    }

    this.data[key].push(dataWrapper);
    this.order.push(key);

    if (this.order.length > this.max) {
      const removedData = this._getAndRemoveByKey(this.order[0]);
      if (removedData)
        this.onRemove(removedData);
    }

    return this;
  }

  /**
   * Determine whether the value attached to `key` is present
   *
   * @param tileID - the key to be looked-up
   * @returns whether the cache has this value
   */
  has(tileID: OverscaledTileID): boolean {
    return tileID.wrapped().key in this.data;
  }

  /**
   * Get the value attached to a specific key and remove data from cache.
   * If the key is not found, returns `null`
   *
   * @param tileID - the key to look up
   * @returns the tile data, or null if it isn't found
   */
  getAndRemove(tileID: OverscaledTileID): Tile | null {
    if (!this.has(tileID)) {
      return null;
    }
    return this._getAndRemoveByKey(tileID.wrapped().key) ?? null;
  }

  /*
     * Get and remove the value with the specified key.
     */

  private _getAndRemoveByKey(key: string): Tile | undefined {
    const entries = this.data[key];
    const data = entries?.shift();
    if (!data) {
      return undefined;
    }
    if (data.timeout)
      clearTimeout(data.timeout);

    if (entries.length === 0) {
      delete this.data[key];
    }
    this.order.splice(this.order.indexOf(key), 1);

    return data.value;
  }

  /*
     * Get the value with the specified (wrapped tile) key.
     */
  getByKey(key: string): Tile | undefined {
    const data = this.data[key];
    return data?.[0]?.value;
  }

  /**
   * Get the value attached to a specific key without removing data
   * from the cache. If the key is not found, returns `null`
   *
   * @param tileID - the key to look up
   * @returns the tile data, or null if it isn't found
   */
  get(tileID: OverscaledTileID): Tile | undefined {
    if (!this.has(tileID)) {
      return undefined;
    }

    return this.data[tileID.wrapped().key]?.[0]?.value;
  }

  /**
   * Remove a key/value combination from the cache.
   *
   * @param tileID - the key for the pair to delete
   * @param value - If a value is provided, remove that exact version of the value.
   * @param value.value - The tile value.
   * @param value.timeout - The timeout handle of the value.
   * @returns this cache
   */
  remove(tileID: OverscaledTileID, value?: {
    value: Tile;
    timeout?: ReturnType<typeof setTimeout>;
  }): this {
    if (!this.has(tileID)) {
      return this;
    }
    const key = tileID.wrapped().key;

    const entries = this.data[key];
    const dataIndex = value === undefined ? 0 : entries.indexOf(value);
    const data = entries[dataIndex];
    if (!data) {
      return this;
    }
    entries.splice(dataIndex, 1);
    if (data.timeout)
      clearTimeout(data.timeout);
    if (entries.length === 0) {
      delete this.data[key];
    }
    this.onRemove(data.value);
    this.order.splice(this.order.indexOf(key), 1);

    return this;
  }

  /**
   * Change the max size of the cache.
   *
   * @param max - the max size of the cache
   * @returns this cache
   */
  setMaxSize(max: number): this {
    this.max = max;

    while (this.order.length > this.max) {
      const oldestKey = this.order[0];
      if (oldestKey === undefined) {
        break;
      }
      const removedData = this._getAndRemoveByKey(oldestKey);
      if (removedData)
        this.onRemove(removedData);
    }

    return this;
  }

  /**
   * Remove entries that do not pass a filter function. Used for removing
   * stale tiles from the cache.
   *
   * @param filterFn - Determines whether the tile is filtered. If the supplied function returns false, the tile will be filtered out.
   */
  filter(filterFn: (tile: Tile) => boolean): void {
    const removed: TileCacheEntry[] = [];
    for (const key in this.data) {
      for (const entry of this.data[key]) {
        if (!filterFn(entry.value)) {
          removed.push(entry);
        }
      }
    }
    for (const r of removed) {
      this.remove(r.value.tileID, r);
    }
  }
}

export class BoundedLRUCache<K, V> {
  private maxEntries: number;

  private map: Map<K, V>;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move key to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    else if (this.map.size >= this.maxEntries) {
      // Delete oldest
      const oldestKey = this.map.keys().next();
      if (!oldestKey.done) {
        this.map.delete(oldestKey.value);
      }
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}
