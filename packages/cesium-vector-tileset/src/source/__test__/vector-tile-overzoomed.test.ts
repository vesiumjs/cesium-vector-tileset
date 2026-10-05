import type { VectorTileFeatureLike, VectorTileLayerLike } from '@maplibre/vt-pbf';
import Point from '@mapbox/point-geometry';
import { VectorTile } from '@mapbox/vector-tile';
import { classifyRings } from '@maplibre/maplibre-gl-style-spec';
import { fromVectorTileJs } from '@maplibre/vt-pbf';
import { PbfReader } from 'pbf';
import { describe, expect, it } from 'vitest';
import { loadGeometry } from '../../data/load-geometry';
import { CanonicalTileID } from '../../tile/tile-id';
import { sliceVectorTileLayer, VectorTileOverzoomed } from '../vector-tile-overzoomed';

type Coordinates = [number, number][][];

interface FixtureFeature {
  id: number;
  type: VectorTileFeatureLike['type'];
  geometry: Coordinates;
}

// Coordinates are expressed on a 64-unit grid, then encoded at each layer's
// extent. Every fixture therefore describes the same geographic geometry.
function parentLayer(extent: number, features: FixtureFeature[]): VectorTileLayerLike {
  const layer: VectorTileLayerLike = {
    name: 'geometry',
    version: 2,
    extent,
    length: features.length,
    feature(index) {
      const feature = features[index];
      return {
        id: feature.id,
        type: feature.type,
        extent,
        properties: { name: `feature ${feature.id}` },
        loadGeometry: () => feature.geometry.map(ring => ring.map(([x, y]) => new Point(x * extent / 64, y * extent / 64))),
      };
    },
  };
  return new VectorTile(new PbfReader(fromVectorTileJs({ layers: { geometry: layer } }))).layers.geometry;
}

const parentID = new CanonicalTileID(22, 3724544, 1651456);
const southeastID = new CanonicalTileID(23, parentID.x * 2 + 1, parentID.y * 2 + 1);

function slice(extent: number, features: FixtureFeature[]): VectorTileLayerLike {
  return sliceVectorTileLayer(parentLayer(extent, features), parentID, southeastID);
}

function coordinates(feature: VectorTileFeatureLike): Coordinates {
  return loadGeometry(feature).map(ring => ring.map(point => [point.x, point.y]));
}

describe('vector tile overzoom slicing', () => {
  it.each([64, 2048, 4096, 8192])('retains the same point buffer at extent %i', (extent) => {
    const layer = slice(extent, [
      { id: 1, type: 1, geometry: [[[48, 48]]] },
      { id: 2, type: 1, geometry: [[[31, 48]]] },
      { id: 3, type: 1, geometry: [[[30, 48]]] },
      { id: 4, type: 1, geometry: [[[65, 48]]] },
      { id: 5, type: 1, geometry: [[[66, 48]]] },
      { id: 6, type: 1, geometry: [[[48, 31]]] },
      { id: 7, type: 1, geometry: [[[48, 30]]] },
      { id: 8, type: 1, geometry: [[[48, 65]]] },
      { id: 9, type: 1, geometry: [[[48, 66]]] },
    ]);

    expect(Array.from({ length: layer.length }, (_, index) => layer.feature(index).id)).toEqual([1, 2, 4, 6, 8]);
    expect(Array.from({ length: layer.length }, (_, index) => coordinates(layer.feature(index)))).toEqual([
      [[[4096, 4096]]],
      [[[-256, 4096]]],
      [[[8448, 4096]]],
      [[[4096, -256]]],
      [[[4096, 8448]]],
    ]);
  });

  it.each([64, 2048, 4096, 8192])('clips crossing lines consistently at extent %i', (extent) => {
    const layer = slice(extent, [
      { id: 1, type: 2, geometry: [[[0, 48], [96, 48]]] },
      { id: 2, type: 2, geometry: [[[0, 0], [96, 96]]] },
      { id: 3, type: 2, geometry: [[[0, 30], [96, 30]]] },
    ]);

    expect(layer.length).toBe(2);
    expect(coordinates(layer.feature(0))).toEqual([[[-256, 4096], [8448, 4096]]]);
    expect(coordinates(layer.feature(1))).toEqual([[[-256, -256], [8448, 8448]]]);
  });

  it.each([64, 2048, 4096, 8192])('clips a polygon and preserves its hole at extent %i', (extent) => {
    const layer = slice(extent, [{
      id: 1,
      type: 3,
      geometry: [
        [[0, 0], [96, 0], [96, 96], [0, 96], [0, 0]],
        [[40, 40], [40, 56], [56, 56], [56, 40], [40, 40]],
        [[8, 8], [8, 16], [16, 16], [16, 8], [8, 8]],
      ],
    }]);

    const rings = coordinates(layer.feature(0));
    expect(rings).toHaveLength(2);
    expect(rings[0]).toHaveLength(5);
    expect(rings[0][0]).toEqual(rings[0][4]);
    expect(rings[0].slice(0, 4)).toEqual(expect.arrayContaining([
      [-256, -256],
      [8448, -256],
      [8448, 8448],
      [-256, 8448],
    ]));
    expect(rings[1]).toEqual([[2048, 2048], [2048, 6144], [6144, 6144], [6144, 2048], [2048, 2048]]);
    expect(classifyRings(loadGeometry(layer.feature(0)), 500).map(polygon => polygon.length)).toEqual([2]);
  });

  it.each([1, 2, 3])('keeps the normalized line buffer across %i overzoom levels', (zoomDelta) => {
    const scale = 2 ** zoomDelta;
    const targetID = new CanonicalTileID(parentID.z + zoomDelta, parentID.x * scale + scale - 1, parentID.y * scale + scale - 1);
    for (const extent of [64, 2048, 4096, 8192]) {
      const parent = parentLayer(extent, [{ id: 1, type: 2, geometry: [[[0, 64 - 32 / scale], [96, 64 - 32 / scale]]] }]);
      const layer = sliceVectorTileLayer(parent, parentID, targetID);

      expect(coordinates(layer.feature(0))).toEqual([[[-256, 4096], [8448, 4096]]]);
    }
  });

  it('keeps sibling slices and repeated bucket loads independent', () => {
    const parent = parentLayer(64, [{ id: 1, type: 2, geometry: [[[0, 48], [96, 48]]] }]);
    const northwestID = new CanonicalTileID(23, parentID.x * 2, parentID.y * 2);
    const westID = new CanonicalTileID(23, parentID.x * 2, parentID.y * 2 + 1);
    const southeast = sliceVectorTileLayer(parent, parentID, southeastID);
    const west = sliceVectorTileLayer(parent, parentID, westID);

    expect(sliceVectorTileLayer(parent, parentID, northwestID).length).toBe(0);
    expect(coordinates(southeast.feature(0))).toEqual([[[-256, 4096], [8448, 4096]]]);
    expect(coordinates(west.feature(0))).toEqual([[[0, 4096], [8448, 4096]]]);
    expect(coordinates(southeast.feature(0))).toEqual([[[-256, 4096], [8448, 4096]]]);
    expect(parent.feature(0).loadGeometry()).toEqual([[new Point(0, 48), new Point(96, 48)]]);
  });

  it('keeps layer extent and metadata when serializing an overzoomed tile', () => {
    const layer = slice(64, [{ id: 27, type: 2, geometry: [[[0, 48], [96, 48]]] }]);
    const tile = new VectorTileOverzoomed();
    tile.addLayer(layer);
    const decoded = new VectorTile(new PbfReader(fromVectorTileJs(tile))).layers.geometry;

    expect(decoded.extent).toBe(64);
    expect(decoded.feature(0).id).toBe(27);
    expect(decoded.feature(0).properties).toEqual({ name: 'feature 27' });
    expect(coordinates(decoded.feature(0))).toEqual(coordinates(layer.feature(0)));
    expect(coordinates(layer.feature(0))).toEqual([[[-256, 4096], [8448, 4096]]]);
  });
});
