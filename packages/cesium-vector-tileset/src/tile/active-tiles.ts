import type { LayerFeatureStates } from '../source/source-state';
import type { Style } from '../style/style';
import type { Tile } from './tile';
import type { OverscaledTileID } from './tile-id';
import Point from '@mapbox/point-geometry';
import { compareTileId } from './tile-id';

/** Tiles retained by a pyramid for loading, fallback coverage or fading, excluding its cache. */
export class ActiveTiles {
  private _tiles: Record<string, Tile> = {};
  private _allTilesCache?: Tile[];
  private _renderableCache?: {
    bearingInRadians: number;
    symbolLayer: boolean;
    ids: string[];
    snapshots: Map<string, {
      tileID: string;
      state: Tile['state'];
      fadeEndTime: number;
      fadeOpacity: number;
      symbolFadeHoldUntil?: number;
    }>;
  };

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

  public getAllIds(sorted = false): string[] {
    if (sorted) {
      return Object.values(this._tiles).map(tile => tile.tileID).sort(compareTileId).map(id => id.key);
    }
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

  public isIdRenderable(id: string, symbolLayer: boolean = false): boolean {
    return this.getTileById(id)?.isRenderable(symbolLayer) ?? false;
  }

  public getRenderableIds(bearingInRadians: number = 0, symbolLayer?: boolean): string[] {
    const useSymbolLayer = symbolLayer ?? false;
    const cached = this._renderableCache;
    if (cached
      && cached.bearingInRadians === bearingInRadians
      && cached.symbolLayer === useSymbolLayer) {
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
      if (tile && tile.isRenderable(symbolLayer ?? false)) {
        renderables.push(tile);
      }
    }
    let ids: string[];
    if (symbolLayer) {
      ids = renderables.sort((a_: Tile, b_: Tile) => {
        const a = a_.tileID;
        const b = b_.tileID;
        const rotatedA = (new Point(a.canonical.x, a.canonical.y))._rotate(-bearingInRadians);
        const rotatedB = (new Point(b.canonical.x, b.canonical.y))._rotate(-bearingInRadians);
        return a.overscaledZ - b.overscaledZ || rotatedB.y - rotatedA.y || rotatedB.x - rotatedA.x;
      }).map(tile => tile.tileID.key);
    }
    else {
      ids = renderables.map(tile => tile.tileID).sort(compareTileId).map(id => id.key);
    }
    this._renderableCache = {
      bearingInRadians,
      symbolLayer: useSymbolLayer,
      ids,
      snapshots,
    };
    return ids;
  }
}
