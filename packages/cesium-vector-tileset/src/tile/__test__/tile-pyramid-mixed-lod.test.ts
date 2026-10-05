import type { WorkerDispatcher } from '../../worker/dispatcher';
import { describe, expect, it, vi } from 'vitest';
import { Tile } from '../tile';
import { OverscaledTileID } from '../tile-id';
import { TilePyramid } from '../tile-pyramid';

describe('mixed LOD tile retention', () => {
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
