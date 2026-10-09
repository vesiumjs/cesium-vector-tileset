import type { FeatureCollection } from 'geojson';
import type { WorkerMessageSender } from '../../worker/worker-channel';
import type { WorkerTileParameters } from '../worker-source';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StyleLayerIndex } from '../../style/style-layer-index';
import { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import { getArrayBuffer } from '../../util/ajax';
import { VectorTileWorkerSource } from '../vector-tile-worker-source';

vi.mock('../../util/ajax', async importOriginal => ({
  ...await importOriginal<typeof import('../../util/ajax')>(),
  getArrayBuffer: vi.fn(),
}));

function encodeParent(longitude: number): ArrayBuffer {
  const point: FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [longitude, 45] },
      properties: { name: 'shared parent' },
    }],
  };
  const tile = new GeoJSONVT(point).getTile(0, 0, 0)!;
  const bytes = fromGeojsonVt({ first: tile, later: tile }, { version: 2 });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const parentData = encodeParent(-90);

function layerIndex(layer: string): StyleLayerIndex {
  return new StyleLayerIndex([{
    'id': layer,
    'type': 'circle',
    'source': 'vector',
    'source-layer': layer,
  }]);
}

function params(uid: string, x: number): WorkerTileParameters {
  return {
    uid,
    type: 'vector',
    source: 'vector',
    tileID: new OverscaledTileID(1, 0, 1, x, 0),
    zoom: 1,
    tileSize: 512,
    pixelRatio: 1,
    promoteId: undefined,
    request: { url: `https://example.test/1/${x}/0.pbf` },
    encoding: 'mvt',
    overzoomParameters: {
      maxZoomTileID: new CanonicalTileID(0, 0, 0),
      overzoomRequest: { url: 'https://example.test/0/0/0.pbf' },
    },
  };
}

function source(index = layerIndex('first')): VectorTileWorkerSource {
  return new VectorTileWorkerSource({ sendAsync: vi.fn().mockResolvedValue({}) } as unknown as WorkerMessageSender, index, []);
}

beforeEach(() => {
  vi.mocked(getArrayBuffer).mockReset();
  vi.mocked(getArrayBuffer).mockResolvedValue({ data: parentData, cacheControl: 'public, max-age=60' });
});

describe('vectorTileWorkerSource overzooming', () => {
  it('downloads and decodes one shared parent once for concurrent children', async () => {
    const worker = source();
    const decode = vi.spyOn(worker, 'loadVectorTile');

    const [west, east] = await Promise.all([
      worker.loadTile(params('west', 0)),
      worker.loadTile(params('east', 1)),
    ]);

    expect(west?.etagUnmodified).not.toBe(true);
    expect(east?.etagUnmodified).not.toBe(true);
    expect(getArrayBuffer).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
  });

  it('keeps the shared request alive until its last child aborts', async () => {
    vi.mocked(getArrayBuffer).mockImplementation((_request, controller) => new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    }));
    const worker = source();
    const west = worker.loadTile(params('west', 0));
    const east = worker.loadTile(params('east', 1));
    const westRejected = expect(west).rejects.toBeDefined();
    const eastRejected = expect(east).rejects.toBeDefined();
    const networkAbort = vi.mocked(getArrayBuffer).mock.calls[0][1];

    await worker.abortTile({ uid: 'west', type: 'vector', source: 'vector' });
    await westRejected;
    expect(networkAbort.signal.aborted).toBe(false);

    await worker.abortTile({ uid: 'east', type: 'vector', source: 'vector' });
    await eastRejected;
    expect(networkAbort.signal.aborted).toBe(true);
    expect(getArrayBuffer).toHaveBeenCalledOnce();
  });

  it('uses newly downloaded parent content when a source tile changes', async () => {
    const worker = source();
    vi.mocked(getArrayBuffer)
      .mockResolvedValueOnce({ data: parentData, etag: 'old' })
      .mockResolvedValueOnce({ data: encodeParent(90), etag: 'new', cacheControl: 'max-age=60' });
    const first = await worker.loadTile(params('first', 0));
    const refreshed = params('refreshed', 0);
    refreshed.etag = 'old';

    const second = await worker.loadTile(refreshed);
    const laterSibling = await worker.loadTile(params('later-sibling', 0));

    expect(first && 'buckets' in first ? first.buckets[0]?.isEmpty() : true).toBe(false);
    expect(second && 'buckets' in second ? second.buckets.length : -1).toBe(0);
    expect(laterSibling && 'buckets' in laterSibling ? laterSibling.buckets.length : -1).toBe(0);
  });
});
