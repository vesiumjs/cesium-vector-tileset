import type { LayerFeatureStates } from '../source/source-state';
import type { Style } from '../style/style';
import type { Tile } from './tile';
import type { OverscaledTileID } from './tile-id';
import { compareTileId } from './tile-id';

/** Tiles retained by a pyramid for loading, fallback coverage or fading, excluding its cache. */
export class ActiveTiles {
  private _tiles: Record<string, Tile> = {};

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
    const tiles: Record<string, Tile> = {};
    for (const id in this._tiles) {
      const tile = this._tiles[id];
      if (!tile) {
        continue;
      }
      tile.tileID = tile.tileID.unwrapTo(tile.tileID.wrap + wrapDelta);
      tiles[tile.tileID.key] = tile;
    }
    this._tiles = tiles;
    this._invalidateCaches();
  }

  public setFeatureState(featuresChanged: LayerFeatureStates, style: Style, revision: number): void {
    for (const id in this._tiles) {
      const tile = this._tiles[id];
      tile?.setFeatureState(featuresChanged, style, revision);
    }
  }

  public getAllTiles(): Tile[] {
    return this._allTilesCache ??= Object.values(this._tiles);
  }

  public getAllIds(): string[] {
    return Object.keys(this._tiles);
  }

  public getTileById(key: string): Tile | undefined {
    return this._tiles[key];
  }

  public setTile(key: string, tile: Tile): void {
    this._tiles[key] = tile;
    this._invalidateCaches();
  }

  public deleteTileById(key: string): void {
    delete this._tiles[key];
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
      let tileCount = 0;
      for (const id in this._tiles) {
        tileCount++;
        const tile = this._tiles[id];
        const snapshot = cached.snapshots.get(id);
        if (!tile || !snapshot
          || snapshot.tileID !== tile.tileID.key
          || snapshot.state !== tile.state
          || snapshot.fadeEndTime !== tile.fadeEndTime
          || snapshot.fadeOpacity !== tile.fadeOpacity
          || snapshot.symbolFadeHoldUntil !== tile.symbolFadeHoldUntil) {
          unchanged = false;
          break;
        }
      }
      if (unchanged && cached.snapshots.size === tileCount) {
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
    for (const id in this._tiles) {
      const tile = this._tiles[id];
      snapshots.set(id, {
        tileID: tile.tileID.key,
        state: tile.state,
        fadeEndTime: tile.fadeEndTime,
        fadeOpacity: tile.fadeOpacity,
        symbolFadeHoldUntil: tile.symbolFadeHoldUntil,
      });
      if (tile && tile.isRenderable(false)) {
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
