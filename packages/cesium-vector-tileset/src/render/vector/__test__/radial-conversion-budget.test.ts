import type { FeatureCollection } from 'geojson';
import type { FillBucket } from '../../../data/bucket-runtime';
import type { WorkerTileParameters, WorkerTileWithData } from '../../../source/worker-source';
import type { Style } from '../../../style/style';
import type { WorkerMessageSender } from '../../../worker/worker-channel';
import { SceneMode } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { GeoJSONWorkerSource } from '../../../source/geojson-worker-source';
import { StyleLayerIndex } from '../../../style/style-layer-index';
import { Tile } from '../../../tile/tile';
import { OverscaledTileID } from '../../../tile/tile-id';
import { createTileTransferRegistry } from '../../../worker/tile-transfer';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { projectWorkerBuckets } from '../bucket-geometry';
import { advanceTileConversion, beginTileConversion } from '../tile-conversion';

describe('radial fill conversion budget', () => {
  it('resumes within one transferred polygon without publishing partial coordinates', async () => {
    const index = new StyleLayerIndex([{ id: 'land', type: 'fill', source: 'polygons', paint: { 'fill-color': '#338866' } }]);
    const worker = new GeoJSONWorkerSource({ sendAsync: vi.fn().mockResolvedValue({}) } as unknown as WorkerMessageSender, index, []);
    const ring = (count: number, radius: number, direction: number) => {
      const points = Array.from({ length: count }, (_value, point) => {
        const angle = point * Math.PI * 2 / count * direction;
        return [0.005493 + Math.cos(angle) * radius, -0.005493 + Math.sin(angle) * radius];
      });
      return [...points, points[0]];
    };
    const data: FeatureCollection = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(4096, 0.004, 1), ring(32, 0.001, -1)] } }] };
    await worker.loadData({ type: 'geojson', source: 'polygons', data, geojsonVtOptions: { extent: 8192, tolerance: 0, maxZoom: 15 } });
    const tileID = new OverscaledTileID(15, 0, 15, 16384, 16384);
    const parameters: WorkerTileParameters = { uid: 'large-fill', type: 'geojson', source: 'polygons', tileID, zoom: 15, tileSize: 512, pixelRatio: 1, promoteId: undefined, request: { url: '' }, encoding: 'mvt' };
    const parsed = await worker.loadTile(parameters) as WorkerTileWithData;
    projectWorkerBuckets(parsed.buckets, tileID);
    const transfers: Transferable[] = [];
    const received = createTileTransferRegistry().deserialize(structuredClone(createTileTransferRegistry().serialize(parsed, transfers), { transfer: transfers })) as WorkerTileWithData;
    const tile = new Tile(tileID, 512);
    tile.loadVectorData(received, { hasLayer: (id: string) => id in index._layers, getLayer: (id: string) => index._layers[id] } as unknown as Style);
    const bucket = tile.buckets.land as FillBucket;
    const primitive = bucket.projectedGeometry!.fill!.get(0);
    expect(primitive.positions.length / 3).toBeGreaterThan(4000);
    const sourcePositions = primitive.positions.slice();
    const sourceIndices = bucket.indexArray.uint16.slice();
    const expected = beginTileConversion(tile.buckets, tileID, 42, 'polygons', undefined, undefined, 15, SceneMode.SCENE3D);
    expect(advanceTileConversion(expected, UNBOUNDED_BUDGET)).toBe(true);
    const state = beginTileConversion(tile.buckets, tileID, 42, 'polygons', undefined, undefined, 15, SceneMode.SCENE3D);
    expect(advanceTileConversion(state, { exhausted: true })).toBe(false);
    expect(state.primIndex).toBe(0);
    expect(state.result.polygons).toHaveLength(0);
    expect(state.result.linePrimitives).toHaveLength(0);
    let frames = 1;
    while (!advanceTileConversion(state, { exhausted: true })) {
      frames++;
      expect(frames).toBeLessThan(200);
      if (state.familyIndex === 0 && state.layerIndex === 0 && state.primIndex === 0) {
        expect(state.result.polygons).toHaveLength(0);
        expect(state.result.linePrimitives).toHaveLength(0);
      }
    }
    expect(frames).toBeGreaterThan(100);
    expect(state.result).toEqual(expected.result);
    expect(state.result.polygons[0].triangles).toBe(primitive.triangles);
    expect(state.result.polygons[0].holes).toBe(primitive.holes);
    expect(primitive.positions).toEqual(sourcePositions);
    expect(bucket.indexArray.uint16).toEqual(sourceIndices);
  });
});
