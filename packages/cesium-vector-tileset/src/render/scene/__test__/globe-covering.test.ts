import { GeographicTilingScheme, WebMercatorTilingScheme } from 'cesium';
import { describe, expect, it } from 'vitest';
import { globeVisibleTileIDs } from '../globe-covering';

function coordinates(tiles: ReturnType<typeof globeVisibleTileIDs>): string[] {
  return tiles.map(tile => tile.canonical.toString());
}

function terrainTile(scheme: GeographicTilingScheme | WebMercatorTilingScheme, x: number, y: number, level: number) {
  return { level, x, y, rectangle: scheme.tileXYToRectangle(x, y, level) };
}

describe('globe visible tile covering', () => {
  it('uses the globe render list without rendering queued preload tiles', () => {
    const scheme = new GeographicTilingScheme();
    const globe = {
      show: true,
      _surface: {
        _tilesToRender: [terrainTile(scheme, 0, 0, 0)],
        _tileLoadQueueLow: [terrainTile(scheme, 1, 0, 0)],
      },
    };

    expect(coordinates(globeVisibleTileIDs(globe, 0, 1))).toEqual(['1/0/0', '1/0/1']);
  });

  it('uses the rectangle of WebMercator terrain instead of assuming geographic roots', () => {
    const scheme = new WebMercatorTilingScheme();
    const globe = {
      show: true,
      _surface: { _tilesToRender: [terrainTile(scheme, 0, 0, 0)] },
    };

    expect(coordinates(globeVisibleTileIDs(globe, 0, 0))).toEqual(['0/0/0']);
  });

  it('selects the source zoom from a rendered terrain rectangle', () => {
    const scheme = new WebMercatorTilingScheme();
    const deep = {
      show: true,
      _surface: { _tilesToRender: [terrainTile(scheme, 4, 4, 3)] },
    };
    const shallow = {
      show: true,
      _surface: { _tilesToRender: [terrainTile(scheme, 0, 0, 0)] },
    };

    expect(coordinates(globeVisibleTileIDs(deep, 0, 2))).toEqual(['2/2/2']);
    expect(coordinates(globeVisibleTileIDs(shallow, 1, 2))).toEqual([]);
  });

  it('deduplicates overlapping terrain coverage and ignores a hidden globe', () => {
    const scheme = new WebMercatorTilingScheme();
    const tile = terrainTile(scheme, 1, 1, 2);
    const globe = { show: true, _surface: { _tilesToRender: [tile, tile] } };

    expect(coordinates(globeVisibleTileIDs(globe, 0, 2))).toEqual(['2/1/1']);
    globe.show = false;
    expect(globeVisibleTileIDs(globe, 0, 2)).toEqual([]);
  });

  it('stays within the tile ID zoom range when source overscaling extends above it', () => {
    const scheme = new WebMercatorTilingScheme();
    const globe = {
      show: true,
      _surface: { _tilesToRender: [terrainTile(scheme, 2 ** 25, 2 ** 25, 26)] },
    };

    expect(coordinates(globeVisibleTileIDs(globe, 0, 26))).toEqual(['25/16777216/16777216']);
  });
});
