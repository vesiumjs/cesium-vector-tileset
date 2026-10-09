import type { WorkerDispatcher } from '../../worker/dispatcher';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tile } from '../tile';
import { OverscaledTileID } from '../tile-id';
import { TilePyramid } from '../tile-pyramid';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pendingPyramid() {
  const pyramid = new TilePyramid('source', {
    type: 'vector',
    tiles: ['https://example.invalid/{z}/{x}/{y}.pbf'],
  }, {} as WorkerDispatcher);
  pyramid._sourceLoaded = true;
  pyramid.used = true;
  const loadTile = vi.fn((_tile: Tile) => new Promise<never>(() => {}));
  pyramid._source.loadTile = loadTile;
  return { pyramid, loadTile };
}

function addLoaded(pyramid: TilePyramid, id: OverscaledTileID): void {
  const tile = new Tile(id, 512);
  tile.state = 'loaded';
  tile.uses = 1;
  pyramid._activeTiles.setTile(id.key, tile);
}

describe('mixed LOD tile retention', () => {
  it('retains the loaded western city branches while eastern coarse substitutes and ideal parents load', () => {
    const { pyramid } = pendingPyramid();
    const ideals = [
      new OverscaledTileID(11, 0, 11, 1023, 680),
      new OverscaledTileID(11, 0, 11, 1023, 681),
    ];
    const eastern = [
      new OverscaledTileID(12, 0, 12, 2047, 1361),
      new OverscaledTileID(12, 0, 12, 2047, 1362),
    ];
    const western = [8185, 8186, 8187].flatMap(x =>
      [5446, 5447, 5448, 5449].map(y => new OverscaledTileID(14, 0, 14, x, y)));
    for (const id of [...eastern, ...western]) addLoaded(pyramid, id);

    pyramid.update({ idealTileIDs: ideals, zoom: 11, centerLng: -0.12, width: 1280, height: 720 });

    for (const ideal of ideals)
      expect(pyramid.getTileByID(ideal.key)?.state).toBe('loading');
    expect(pyramid.getRenderableIds()).toEqual(expect.arrayContaining(western.map(id => id.key)));
    expect(pyramid.getRenderableIds()).toEqual(expect.arrayContaining(eastern.map(id => id.key)));
    for (const id of western)
      expect(pyramid._activeTiles.getLoadedTile(id)?.tileID).toBe(id);
    pyramid.clearTiles();
  });

  it('keeps disjoint finer branches while pruning loaded descendants covered by a selected ancestor', () => {
    const { pyramid } = pendingPyramid();
    const target = new OverscaledTileID(8, 0, 8, 100, 100);
    const ancestor = new OverscaledTileID(9, 0, 9, 200, 200);
    const covered = [400, 401].flatMap(x => [400, 401].map(y => new OverscaledTileID(10, 0, 10, x, y)));
    const disjoint = new OverscaledTileID(10, 0, 10, 402, 400);
    // Fine-first arrival must not decide which overlapping generation draws.
    for (const id of [...covered, disjoint, ancestor]) addLoaded(pyramid, id);

    pyramid.update({ idealTileIDs: [target], zoom: 8, centerLng: 0, width: 800, height: 600 });

    expect([...pyramid.getRenderableIds()].sort()).toEqual([ancestor.key, disjoint.key].sort());
    for (const id of covered)
      expect(pyramid.getRenderableIds()).not.toContain(id.key);
    expect(disjoint.isChildOf(ancestor)).toBe(false);
    pyramid.clearTiles();
  });

  it('defers a saturated ideal only when its mixed descendant branches completely cover it', () => {
    const { pyramid, loadTile } = pendingPyramid();
    const covered = new OverscaledTileID(8, 0, 8, 100, 100);
    const coarse = [
      new OverscaledTileID(9, 0, 9, 200, 200),
      new OverscaledTileID(9, 0, 9, 201, 200),
      new OverscaledTileID(9, 0, 9, 200, 201),
    ];
    const finer = [402, 403].flatMap(x => [402, 403].map(y => new OverscaledTileID(10, 0, 10, x, y)));
    const substitutes = [...coarse, ...finer];
    for (const id of substitutes) addLoaded(pyramid, id);
    const uncovered = new OverscaledTileID(8, 0, 8, 200, 200);
    const ideals = [
      ...Array.from({ length: TilePyramid.MAX_CONCURRENT_LOADS }, (_, x) => new OverscaledTileID(8, 0, 8, x, 0)),
      covered,
      uncovered,
    ];

    pyramid.update({ idealTileIDs: ideals, zoom: 8, centerLng: 0, width: 800, height: 600 });

    const requested = loadTile.mock.calls.map(([tile]) => tile.tileID.key);
    expect(requested).not.toContain(covered.key);
    expect(requested).toContain(uncovered.key);
    expect(pyramid.getRenderableIds()).toEqual(expect.arrayContaining(substitutes.map(id => id.key)));
    pyramid.clearTiles();
  });

  it('reuses a stable tile pyramid for small pans but updates after a world-copy jump', () => {
    const pyramid = new TilePyramid('source', {
      type: 'vector',
      tiles: ['https://example.invalid/{z}/{x}/{y}.pbf'],
    }, {} as WorkerDispatcher);
    pyramid._sourceLoaded = true;
    pyramid.used = true;
    pyramid._source.loadTile = () => new Promise(() => {});
    const hasTile = vi.fn(() => true);
    pyramid._source.hasTile = hasTile;
    const tile = new OverscaledTileID(6, 0, 6, 20, 20);
    const covering = (centerLng: number) => ({ idealTileIDs: [tile], zoom: 6, centerLng, width: 800, height: 600 });

    pyramid.update(covering(-64));
    pyramid.update(covering(-63.99));
    expect(hasTile).toHaveBeenCalledTimes(1);

    pyramid.update(covering(296.01));
    expect(hasTile).toHaveBeenCalledTimes(2);
  });

  it('restores a cached ancestor while a newly visible ideal is loading', () => {
    const pyramid = new TilePyramid('source', {
      type: 'vector',
      tiles: ['https://example.invalid/{z}/{x}/{y}.pbf'],
    }, {} as WorkerDispatcher);
    pyramid._sourceLoaded = true;
    pyramid.used = true;
    const loadTile = vi.fn(() => new Promise<never>(() => {}));
    pyramid._source.loadTile = loadTile;

    const parentID = new OverscaledTileID(5, 0, 5, 10, 10);
    const idealID = new OverscaledTileID(6, 0, 6, 20, 20);
    const parent = new Tile(parentID, 512);
    parent.state = 'loaded';
    pyramid._tileCache.setMaxSize(1);
    pyramid._tileCache.add(parentID, parent);

    pyramid.update({ idealTileIDs: [idealID], zoom: 6, centerLng: -64, width: 800, height: 600 });

    expect(pyramid.getRenderableIds()).toContain(parentID.key);
    expect(pyramid._tileCache.has(parentID)).toBe(false);
    expect(loadTile).toHaveBeenCalledTimes(1);
  });
});
