import type { WorkerDispatcher } from '../../worker/dispatcher';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tile } from '../tile';
import { OverscaledTileID } from '../tile-id';
import { TilePyramid } from '../tile-pyramid';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function loadedParent() {
  const pyramid = new TilePyramid('source', {
    type: 'vector',
    tiles: ['https://example.invalid/{z}/{x}/{y}.pbf'],
  }, {} as WorkerDispatcher);
  pyramid._sourceLoaded = true;
  pyramid.used = true;
  const parentID = new OverscaledTileID(13, 0, 13, 4093, 2724);
  const parent = new Tile(parentID, 512);
  parent.state = 'loaded';
  parent.uses = 1;
  pyramid._activeTiles.setTile(parentID.key, parent);
  pyramid._tileCache.setMaxSize(8);
  return { pyramid, parentID, parent };
}

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

  it('recognizes complete spatial coverage from coarse branches and four finer siblings', () => {
    const { pyramid } = pendingPyramid();
    const target = new OverscaledTileID(8, 0, 8, 100, 100);
    const coarse = [
      new OverscaledTileID(9, 0, 9, 200, 200),
      new OverscaledTileID(9, 0, 9, 201, 200),
      new OverscaledTileID(9, 0, 9, 200, 201),
    ];
    const finer = [402, 403].flatMap(x => [402, 403].map(y => new OverscaledTileID(10, 0, 10, x, y)));
    const expected = [...coarse, ...finer];
    for (const id of expected) addLoaded(pyramid, id);
    const retain: Record<string, OverscaledTileID> = {};

    const incomplete = pyramid.retainLoadedChildren(retain, new Set([target]));

    expect(Object.keys(retain).sort()).toEqual(expected.map(id => id.key).sort());
    expect(incomplete.size).toBe(0);
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

  it('computes completeness independently for adjacent targets without retaining neighboring coverage', () => {
    const { pyramid } = pendingPyramid();
    const complete = new OverscaledTileID(8, 0, 8, 100, 100);
    const partial = new OverscaledTileID(8, 0, 8, 101, 100);
    const completeChildren = [200, 201].flatMap(x => [200, 201].map(y => new OverscaledTileID(9, 0, 9, x, y)));
    const partialChildren = [
      new OverscaledTileID(9, 0, 9, 203, 200),
      new OverscaledTileID(10, 0, 10, 406, 402),
    ];
    const neighbor = new OverscaledTileID(9, 0, 9, 204, 200);
    for (const id of [...completeChildren, ...partialChildren, neighbor]) addLoaded(pyramid, id);
    const retain: Record<string, OverscaledTileID> = {};

    const incomplete = pyramid.retainLoadedChildren(retain, new Set([complete, partial]));

    expect(Object.keys(retain).sort()).toEqual([...completeChildren, ...partialChildren].map(id => id.key).sort());
    expect([...incomplete]).toEqual([partial]);
    expect(retain[neighbor.key]).toBeUndefined();
    pyramid.clearTiles();
  });

  it('retains one complete overscaled canonical branch and excludes other coordinates or world copies', () => {
    const { pyramid } = pendingPyramid();
    const target = new OverscaledTileID(15, 0, 14, 8186, 5448);
    const nearest = new OverscaledTileID(16, 0, 14, 8186, 5448);
    const deeper = new OverscaledTileID(17, 0, 14, 8186, 5448);
    const adjacent = new OverscaledTileID(16, 0, 14, 8187, 5448);
    const wrapped = new OverscaledTileID(16, 1, 14, 8186, 5448);
    for (const id of [deeper, adjacent, wrapped, nearest]) addLoaded(pyramid, id);
    const retain: Record<string, OverscaledTileID> = {};

    const incomplete = pyramid.retainLoadedChildren(retain, new Set([target]));

    expect(Object.keys(retain)).toEqual([nearest.key]);
    expect(incomplete.size).toBe(0);
    expect(nearest.isChildOf(target)).toBe(true);
    expect(adjacent.isChildOf(target)).toBe(false);
    expect(wrapped.isChildOf(target)).toBe(false);
    pyramid.clearTiles();
  });

  it.each([false, true])('keeps the three-level descendant bound for overscaled=%s', (overscaled) => {
    const { pyramid } = pendingPyramid();
    const target = overscaled
      ? new OverscaledTileID(15, 0, 14, 8186, 5448)
      : new OverscaledTileID(8, 0, 8, 100, 100);
    const beyond = overscaled
      ? new OverscaledTileID(19, 0, 14, 8186, 5448)
      : new OverscaledTileID(12, 0, 12, 1600, 1600);
    addLoaded(pyramid, beyond);
    const retain: Record<string, OverscaledTileID> = {};

    const incomplete = pyramid.retainLoadedChildren(retain, new Set([target]));

    expect(beyond.isChildOf(target)).toBe(true);
    expect(Object.keys(retain)).toHaveLength(0);
    expect([...incomplete]).toEqual([target]);
    expect(TilePyramid.maxOverzooming).toBe(3);
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

  it('reuses loaded covering candidates across camera changes and active-to-cache transfers', () => {
    const { pyramid, parentID } = loadedParent();
    const candidates = pyramid.getLoadedTileIDs(13, 14);
    expect(candidates).toEqual([parentID]);
    const enumerate = vi.spyOn(pyramid._activeTiles, 'getAllTiles');
    expect(pyramid.getLoadedTileIDs(13, 14)).toBe(candidates);
    pyramid.removeTile(parentID.key);
    expect(pyramid.getLoadedTileIDs(13, 14)).toBe(candidates);
    pyramid.addTile(parentID);
    expect(pyramid.getLoadedTileIDs(13, 14)).toBe(candidates);
    expect(enumerate).not.toHaveBeenCalled();
    pyramid.clearTiles();
  });

  it('refreshes the loaded snapshot after a new load and an unmodified reload, and excludes failed reloads', async () => {
    const { pyramid, parentID, parent } = loadedParent();
    const initial = pyramid.getLoadedTileIDs(13, 14);
    pyramid._source.loadTile = vi.fn(async (tile) => {
      tile.state = 'loaded';
    });
    const child = new OverscaledTileID(14, 0, 14, 8186, 5448);
    pyramid.addTile(child);
    await Promise.resolve();
    expect(pyramid.getLoadedTileIDs(13, 14)).toEqual([parentID, child]);

    let finish: () => void = () => {};
    pyramid._source.loadTile = vi.fn(() => new Promise<{ unmodified: boolean }>((resolve) => {
      finish = () => {
        parent.state = 'loaded';
        resolve({ unmodified: true });
      };
    }));
    const reload = pyramid.reloadTile(parentID.key, 'reloading');
    expect(pyramid.getLoadedTileIDs(13, 14)).toEqual([child]);
    finish();
    await reload;
    expect(pyramid.getLoadedTileIDs(13, 14)).toEqual([parentID, child]);
    expect(pyramid.getLoadedTileIDs(13, 14)).not.toBe(initial);

    pyramid._source.loadTile = vi.fn(async () => {
      throw Object.assign(new Error('missing'), { status: 404 });
    });
    await pyramid.reloadTile(parentID.key, 'reloading');
    expect(pyramid.getLoadedTileIDs(13, 14)).toEqual([child]);
    pyramid.clearTiles();
  });

  it.each(['unload', 'expiry', 'eviction', 'clear'] as const)('invalidates loaded cache candidates after %s', (reason) => {
    vi.useFakeTimers();
    const { pyramid, parentID, parent } = loadedParent();
    pyramid._activeTiles.deleteTileById(parentID.key);
    pyramid._tileCache.setMaxSize(1);
    pyramid._tileCache.add(parentID, parent, reason === 'expiry' ? 5 : undefined);
    expect(pyramid.getLoadedTileIDs(13, 14)).toEqual([parentID]);
    if (reason === 'unload') {
      pyramid._tileCache.remove(parentID);
    }
    else if (reason === 'expiry') {
      vi.advanceTimersByTime(5);
    }
    else if (reason === 'eviction') {
      const otherID = new OverscaledTileID(13, 0, 13, 4100, 2724);
      const other = new Tile(otherID, 512);
      other.state = 'loaded';
      pyramid._tileCache.add(otherID, other);
      expect(pyramid.getLoadedTileIDs(13, 14)).toEqual([otherID]);
    }
    else {
      pyramid.clearTiles();
    }
    expect(pyramid.getLoadedTileIDs(13, 14)).not.toContainEqual(parentID);
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

  it('keeps a loaded parent of a distant ideal even when the camera zoom is much higher', () => {
    const pyramid = new TilePyramid('source', {
      type: 'vector',
      tiles: ['https://example.invalid/{z}/{x}/{y}.pbf'],
    }, {} as WorkerDispatcher);
    pyramid._sourceLoaded = true;
    pyramid.used = true;
    pyramid._source.loadTile = () => new Promise(() => {});

    const parentID = new OverscaledTileID(5, 0, 5, 10, 10);
    const idealID = new OverscaledTileID(6, 0, 6, 20, 20);
    const parent = new Tile(parentID, 512);
    parent.state = 'loaded';
    pyramid._activeTiles.setTile(parentID.key, parent);

    pyramid.update({ idealTileIDs: [idealID], zoom: 18, centerLng: -64, width: 800, height: 600 });

    expect(pyramid.getRenderableIds()).toContain(parentID.key);
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

  it('defers only ideals covered by loaded children when requests are saturated', () => {
    const pyramid = new TilePyramid('source', {
      type: 'vector',
      tiles: ['https://example.invalid/{z}/{x}/{y}.pbf'],
    }, {} as WorkerDispatcher);
    pyramid._sourceLoaded = true;
    pyramid.used = true;
    const loadTile = vi.fn((_tile: Tile) => new Promise<never>(() => {}));
    pyramid._source.loadTile = loadTile;

    const covered = new OverscaledTileID(8, 0, 8, 100, 100);
    const children = [
      new OverscaledTileID(9, 0, 9, 200, 200),
      new OverscaledTileID(9, 0, 9, 201, 200),
      new OverscaledTileID(9, 0, 9, 200, 201),
      new OverscaledTileID(9, 0, 9, 201, 201),
    ];
    for (const childID of children) {
      const child = new Tile(childID, 512);
      child.state = 'loaded';
      pyramid._activeTiles.setTile(childID.key, child);
    }
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
    expect(pyramid.getRenderableIds()).toEqual(expect.arrayContaining(children.map(child => child.key)));
  });
});
