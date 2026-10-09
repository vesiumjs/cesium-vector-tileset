import type { ExpiryData } from '../util/ajax';
import type { WorkerTile } from './worker-tile';

export interface ParsingState {
  cacheControl?: ExpiryData;
  resourceTiming?: any;
}

export class WorkerTileState {
  loading: Record<string, WorkerTile> = {};
  loaded: Record<string, WorkerTile> = {};
  parsing: Record<string, ParsingState> = {};

  startLoading(uid: string | number, tile: WorkerTile): void {
    this.loading[uid]?.abort?.abort();
    this.loaded[uid]?.abort?.abort();
    this.loading[uid] = tile;
  }

  finishLoading(uid: string | number, tile: WorkerTile): void {
    if (this.loading[uid] === tile)
      delete this.loading[uid];
  }

  abort(uid: string | number): void {
    const tile = this.loading[uid] ?? this.loaded[uid];
    const abortController = tile?.abort;
    if (!abortController)
      return;
    abortController.abort();
    if (this.loading[uid] === tile)
      delete this.loading[uid];
  }

  getParsing(uid: string | number): ParsingState | undefined {
    return this.parsing[uid];
  }

  setParsing(uid: string | number, state: ParsingState): void {
    this.parsing[uid] = state;
  }

  removeParsing(uid: string | number, state: ParsingState): void {
    if (this.parsing[uid] === state)
      delete this.parsing[uid];
  }

  markLoaded(uid: string | number, tile: WorkerTile): void {
    this.loaded[uid] = tile;
  }

  getLoaded(uid: string | number): WorkerTile | undefined {
    const tile = this.loaded[uid];
    if (!tile)
      return undefined;
    return tile;
  }

  removeLoaded(uid: string | number): void {
    this.loaded[uid]?.abort?.abort();
    delete this.loaded[uid];
  }

  clearLoaded(): void {
    this.loaded = {};
  }

  /** Cancel network and parse dependencies before releasing all tile data. */
  clear(): void {
    for (const tile of new Set([...Object.values(this.loading), ...Object.values(this.loaded)])) {
      tile.abort?.abort();
      for (const dependency of tile.inFlightDependencies) {
        dependency.abort();
      }
      tile.inFlightDependencies.length = 0;
    }
    this.loading = {};
    this.loaded = {};
    this.parsing = {};
  }
}
