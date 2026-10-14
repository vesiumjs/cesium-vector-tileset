import type { LayerFeatureStates } from '../source/source-state';
import type { Style } from '../style/style';
import type { Tile } from './tile';
import type { OverscaledTileID } from './tile-id';
import { compareTileId } from './tile-id';

/** Tiles retained by a pyramid for loading, fallback coverage or fading, excluding its cache. */
export class ActiveTiles {
  private _tiles = new Map<string, Tile>();

  private _allTilesCache?: Tile[];

  private _renderableCache?: {
    ids: string[];
    snapshots: Map<string, {
      tileID: string;
      state: Tile['state'];
      fadeEndTime: number;
      fadeOpacity: number;
      symbolFadeHoldUntil?: number;
    }>;
  };

  /**
   * @internal
   */
  private _invalidateCaches(): void {
    this._allTilesCache = undefined;
    this._renderableCache = undefined;
  }

  public handleWrapJump(wrapDelta: number): void {
    const tiles = new Map<string, Tile>();
    for (const tile of this._tiles.values()) {
      tile.tileID = tile.tileID.unwrapTo(tile.tileID.wrap + wrapDelta);
      tiles.set(tile.tileID.key, tile);
    }
    this._tiles = tiles;
    this._invalidateCaches();
  }

  public setFeatureState(featuresChanged: LayerFeatureStates, style: Style, revision: number): void {
    for (const tile of this._tiles.values()) {
      tile.setFeatureState(featuresChanged, style, revision);
    }
  }

  public getAllTiles(): Tile[] {
    return this._allTilesCache ??= Array.from(this._tiles.values());
  }

  public loaded(): boolean {
    for (const tile of this._tiles.values()) {
      if (tile.state !== 'loaded' && tile.state !== 'errored')
        return false;
    }
    return true;
  }

  public getAllIds(): string[] {
    return Array.from(this._tiles.keys());
  }

  public getTileById(key: string): Tile | undefined {
    return this._tiles.get(key);
  }

  public setTile(key: string, tile: Tile): void {
    this._tiles.set(key, tile);
    this._invalidateCaches();
  }

  public deleteTileById(key: string): void {
    this._tiles.delete(key);
    this._invalidateCaches();
  }

  /**
   * Get an active tile with data. Cached tiles are excluded; active tiles
   * include loaded substitutes and tiles retained for fading.
   * @returns the active tile if it has data, undefined otherwise.
   */
  public getLoadedTile(tileID: OverscaledTileID): Tile | undefined {
    const tile = this.getTileById(tileID.key);
    if (tile?.hasData()) {
      return tile;
    }
    return undefined;
  }

  public isIdRenderable(id: string): boolean {
    return this.getTileById(id)?.isRenderable(false) ?? false;
  }

  public getRenderableIds(): string[] {
    const cached = this._renderableCache;
    if (cached) {
      let unchanged = true;
      for (const [id, tile] of this._tiles) {
        const snapshot = cached.snapshots.get(id);
        if (!snapshot
          || snapshot.tileID !== tile.tileID.key
          || snapshot.state !== tile.state
          || snapshot.fadeEndTime !== tile.fadeEndTime
          || snapshot.fadeOpacity !== tile.fadeOpacity
          || snapshot.symbolFadeHoldUntil !== tile.symbolFadeHoldUntil) {
          unchanged = false;
          break;
        }
      }
      if (unchanged && cached.snapshots.size === this._tiles.size) {
        // ActiveTiles is an internal collection; returning the stable array
        // avoids a per-frame sort/allocation in every Cesium render pass.
        return cached.ids;
      }
    }

    const renderables: Tile[] = [];
    const snapshots = new Map<string, {
      tileID: string;
      state: Tile['state'];
      fadeEndTime: number;
      fadeOpacity: number;
      symbolFadeHoldUntil?: number;
    }>();
    for (const [id, tile] of this._tiles) {
      snapshots.set(id, {
        tileID: tile.tileID.key,
        state: tile.state,
        fadeEndTime: tile.fadeEndTime,
        fadeOpacity: tile.fadeOpacity,
        symbolFadeHoldUntil: tile.symbolFadeHoldUntil,
      });
      if (tile.isRenderable(false)) {
        renderables.push(tile);
      }
    }
    const ids = renderables.map(tile => tile.tileID).sort(compareTileId).map(id => id.key);
    this._renderableCache = {
      ids,
      snapshots,
    };
    return ids;
  }
}
