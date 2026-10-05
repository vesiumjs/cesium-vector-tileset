/**
 * Global GPU memory budget, mirroring Cesium 3D Tiles' `cacheBytes` scheme:
 * every track reports its per-tile estimates when the resident set changes,
 * or a renderer changes its entries. The budget
 * keeps one total, and overflow evicts retired (out-of-view) tiles
 * oldest-first.
 *
 * Evictability is reported by the tracks, not derived by the tileset: an entry
 * is `pinned` when its tile is live/attached (never an eviction target) and
 * unpinned when it sits in a retired pool. The tracks already know which of
 * their entries are retired, so the tileset no longer builds a protected-key
 * set per frame - that set was a namespaced duplicate of "every live entry"
 * and cost a string build plus a Set clone on every frame.
 *
 * Recency is frame-stamped: pinned entries are touched every frame they are
 * reported, retired entries freeze at their last live frame, so a
 * long-visible tile that just retired evicts last. Symbol fades are attached
 * but out of view and are reported pinned for the same reason.
 *
 * Tracks report estimated allocations, not a GL meter: vector geometry uses
 * native buffer capacity and constructed Primitive inputs; pattern/symbol
 * geometry uses upload inputs, raster uses RGBA texture dimensions. Shared
 * atlas textures and Cesium terrain-owned draping textures are excluded.
 */
/** Report a resident allocation; live or attached entries are pinned. */
export type MemoryBudgetVisitor = (key: string, bytes: number, pinned?: boolean) => void;

/** Default budget: generous for vector tiles, raster textures dominate. */
export const DEFAULT_GPU_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

interface TrackedEntry {
  bytes: number;
  sequence: number;
  pinned: boolean;
}

export class GpuMemoryBudget {
  private _maxBytes: number;
  private _entries = new Map<string, TrackedEntry>();
  private _sequence = 0;
  private _evictions = 0;

  constructor(maxBytes: number = DEFAULT_GPU_MEMORY_BUDGET_BYTES) {
    this._maxBytes = Math.max(1, Math.floor(maxBytes));
  }

  get maxBytes(): number {
    return this._maxBytes;
  }

  setMaxBytes(maxBytes: number): void {
    this._maxBytes = Math.max(1, Math.floor(maxBytes));
  }

  get totalBytes(): number {
    let total = 0;
    for (const entry of this._entries.values()) {
      total += entry.bytes;
    }
    return total;
  }

  /** Whether a reported allocation survived the last complete budget update. */
  has(key: string): boolean {
    return this._entries.has(key);
  }

  stats(): { totalBytes: number; entries: number; evictions: number; maxBytes: number } {
    return {
      totalBytes: this.totalBytes,
      entries: this._entries.size,
      evictions: this._evictions,
      maxBytes: this._maxBytes,
    };
  }

  /**
   * Full-replace the tracked set and evict oldest-first past the budget.
   * The report must synchronously visit the complete resident set.
   * Unreported keys vanish (their tiles were destroyed through other paths);
   * entries reported `pinned` are never evicted. Callers must report retired
   * entries oldest-first so first sightings land in LRU order (the retired
   * pools iterate oldest-first by construction).
   *
   * @returns evicted keys, oldest-first, for the tileset to destroy.
   */
  update(report: (visit: MemoryBudgetVisitor) => void): string[] {
    const seen = new Set<string>();
    report((key, bytes, pinned) => {
      seen.add(key);
      const tracked = this._entries.get(key);
      if (tracked) {
        tracked.bytes = bytes;
        tracked.pinned = pinned ?? false;
        if (tracked.pinned) {
          tracked.sequence = ++this._sequence;
        }
      }
      else {
        this._entries.set(key, {
          bytes,
          pinned: pinned ?? false,
          sequence: ++this._sequence,
        });
      }
    });
    // Delete while iterating (allowed on Map) so no key array is allocated;
    // this runs on every evaluation, so the copy showed up in frame profiles.
    for (const key of this._entries.keys()) {
      if (!seen.has(key)) {
        this._entries.delete(key);
      }
    }
    const evicted: string[] = [];
    if (this.totalBytes <= this._maxBytes) {
      return evicted;
    }
    const candidates = [...this._entries]
      .filter(([, entry]) => !entry.pinned)
      .sort((a, b) => a[1].sequence - b[1].sequence);
    let total = this.totalBytes;
    for (const [key, entry] of candidates) {
      if (total <= this._maxBytes) {
        break;
      }
      total -= entry.bytes;
      this._entries.delete(key);
      this._evictions++;
      evicted.push(key);
    }
    return evicted;
  }
}
