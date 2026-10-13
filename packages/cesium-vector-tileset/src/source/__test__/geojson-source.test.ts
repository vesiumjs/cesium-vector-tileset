import type { WorkerDispatcher } from '../../worker/dispatcher';
import type { WorkerChannel, WorkerMessageSender } from '../../worker/worker-channel';
import type { LoadGeoJSONParameters } from '../geojson-worker-source';
import { describe, expect, it, vi } from 'vitest';
import { StyleLayerIndex } from '../../style/style-layer-index';
import { OverscaledTileID } from '../../tile/tile-id';
import { Evented } from '../../util/evented';
import { MessageType } from '../../worker/messages';
import { GeoJSONSource } from '../geojson-source';
import { GeoJSONWorkerSource } from '../geojson-worker-source';
import { addProtocol, removeProtocol } from '../protocol-crud';

function points(values: number[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: values.map((value, index) => ({
      type: 'Feature',
      properties: { value },
      geometry: { type: 'Point', coordinates: [index * 0.001, 0] },
    })),
  };
}

describe('geoJSON source data', () => {
  it('retains style clustering, filters and aggregate properties when setData rebuilds the index', async () => {
    const worker = new GeoJSONWorkerSource({} as WorkerMessageSender, new StyleLayerIndex(), []);
    const channel = {
      sendAsync: vi.fn((message: { type: string; data: LoadGeoJSONParameters }) => {
        expect(message.type).toBe(MessageType.loadData);
        return worker.loadData(message.data);
      }),
    } as unknown as WorkerChannel;
    const dispatcher = { getChannel: () => Promise.resolve(channel) } as WorkerDispatcher;
    const source = new GeoJSONSource('points', {
      type: 'geojson',
      data: points([2, 3, -1]),
      cluster: true,
      clusterMaxZoom: 4,
      filter: ['all', ['>=', ['get', 'value'], 0], ['==', ['geometry-type'], 'Point']],
      clusterProperties: { total: ['+', ['get', 'value']] },
    }, dispatcher, new Evented());
    const tile = { tileID: new OverscaledTileID(0, 0, 0, 0, 0) } as Parameters<GeoJSONWorkerSource['loadVectorTile']>[0];

    await source.load();
    const clustered = worker.loadVectorTile(tile)!.vectorTile.layers._geojsonTileLayer;
    expect(clustered.length).toBe(1);
    expect(clustered.feature(0).properties).toMatchObject({ cluster: true, point_count: 2, total: 5 });

    const replacement = points([8]);
    await source.setData(replacement);
    const updated = worker.loadVectorTile(tile)!.vectorTile.layers._geojsonTileLayer;
    expect(updated.length).toBe(1);
    expect(updated.feature(0).properties).toEqual({ value: 8 });
    expect(source.serialize().data).toBe(replacement);
    expect(source.loaded()).toBe(true);
    await worker.removeSource({ type: 'geojson', source: 'points' });
  });

  it('discards stale custom-protocol data while preserving cancellation of the current load', async () => {
    const requests: Array<{ controller: AbortController; resolve: (value: { data: GeoJSON.GeoJSON }) => void }> = [];
    addProtocol('geojson-race', (_parameters, controller) => new Promise((resolve) => {
      requests.push({ controller, resolve });
    }));
    const worker = new GeoJSONWorkerSource({} as WorkerMessageSender, new StyleLayerIndex(), []);
    const params = { type: 'geojson' as const, source: 'points' };
    try {
      const first = worker.loadData({ ...params, request: { url: 'geojson-race://first' } });
      const second = worker.loadData({ ...params, request: { url: 'geojson-race://second' } });
      requests[0].resolve({ data: points([1]) });
      await expect(first).resolves.toEqual({ abandoned: true });

      await worker.loadData({ ...params, data: points([8]) });
      expect(requests[1].controller.signal.aborted).toBe(true);
      requests[1].resolve({ data: points([2]) });
      await expect(second).resolves.toEqual({ abandoned: true });

      const tile = { tileID: new OverscaledTileID(0, 0, 0, 0, 0) } as Parameters<GeoJSONWorkerSource['loadVectorTile']>[0];
      const result = worker.loadVectorTile(tile);
      expect(result?.vectorTile.layers._geojsonTileLayer.feature(0).properties).toEqual({ value: 8 });
    }
    finally {
      await worker.removeSource(params);
      removeProtocol('geojson-race');
    }
  });
});
