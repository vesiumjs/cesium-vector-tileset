import type { FeatureCollection } from 'geojson';
import type { GeoJSONWorkerSource } from '../../source/geojson-worker-source';
import type { VectorTileWorkerSource } from '../../source/vector-tile-worker-source';
import type { WorkerTileParameters } from '../../source/worker-source';
import type { TileWorkerScope } from '../scope';
import type { WorkerEndpoint } from '../worker-channel';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverscaledTileID } from '../../tile/tile-id';
import { getArrayBuffer } from '../../util/ajax';
import { RGBAImage } from '../../util/image';
import { MessageType } from '../messages';
import { TileWorker } from '../tile-worker';
import { WorkerChannel } from '../worker-channel';

vi.mock('../../util/ajax', async importOriginal => ({
  ...await importOriginal<typeof import('../../util/ajax')>(),
  getArrayBuffer: vi.fn(),
}));

type WireMessage = Parameters<WorkerChannel['receive']>[0]['data'];
const point: FeatureCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
};
const bytes = fromGeojsonVt({ points: new GeoJSONVT(point).getTile(0, 0, 0)! }, { version: 2 });
const vectorData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const fixtures: Array<{ client: WorkerChannel; worker: TileWorker }> = [];

async function fixture(type: 'vector' | 'geojson') {
  class Endpoint extends EventTarget {
    peer!: Endpoint;

    postMessage(message: WireMessage, options?: { transfer?: Transferable[] }): void {
      const data = structuredClone(message, { transfer: options?.transfer ?? [] });
      this.peer.dispatchEvent(new MessageEvent('message', { data: { ...data, mustQueue: true } }));
    }
  }
  const clientEndpoint = new Endpoint();
  const workerEndpoint = new Endpoint();
  clientEndpoint.peer = workerEndpoint;
  workerEndpoint.peer = clientEndpoint;
  const client = new WorkerChannel(clientEndpoint as unknown as WorkerEndpoint, 'map');
  const prepare = vi.fn();
  const worker = new TileWorker(workerEndpoint as unknown as TileWorkerScope & WorkerEndpoint, prepare);
  fixtures.push({ client, worker });
  await client.sendAsync({ type: MessageType.setImages, data: ['marker'] });
  await client.sendAsync({
    type: MessageType.setLayers,
    data: [{
      id: 'icons',
      type: 'symbol',
      source: 'source',
      ...(type === 'vector' ? { 'source-layer': 'points' } : {}),
      layout: { 'icon-image': 'marker' },
    }],
  });
  if (type === 'geojson') {
    await client.sendAsync({ type: MessageType.loadData, data: { type, source: 'source', data: point, geojsonVtOptions: {} } });
  }
  const dependencies: Array<{ controller: AbortController; resolve: () => void }> = [];
  client.registerMessageHandler(MessageType.getImages, (_map, _params, controller) => new Promise((resolve) => {
    dependencies.push({
      controller: controller!,
      resolve: () => resolve({ marker: { data: new RGBAImage({ width: 2, height: 2 }, new Uint8Array(16).fill(255)), pixelRatio: 1, sdf: false } }),
    });
  }));
  const params: WorkerTileParameters = {
    type,
    source: 'source',
    uid: 'tile',
    tileID: new OverscaledTileID(0, 0, 0, 0, 0),
    zoom: 0,
    tileSize: 512,
    pixelRatio: 1,
    promoteId: undefined,
    request: { url: 'https://example.test/0/0/0.pbf' },
  };
  return { client, worker, prepare, dependencies, params };
}

beforeEach(() => {
  vi.mocked(getArrayBuffer).mockReset();
  vi.mocked(getArrayBuffer).mockResolvedValue({ data: vectorData });
});

afterEach(async () => {
  for (const { client, worker } of fixtures.splice(0)) {
    await client.sendAsync({ type: MessageType.removeMap });
    client.remove();
    worker.channel.remove();
  }
  vi.restoreAllMocks();
});

describe.each(['vector', 'geojson'] as const)('%s worker tile cancellation', (type) => {
  it('cancels actual parse dependencies and skips geometry preparation after the channel lease ends', async () => {
    const { client, prepare, dependencies, params } = await fixture(type);
    const controller = new AbortController();
    const load = client.sendAsync({ type: MessageType.loadTile, data: params }, controller);
    await vi.waitFor(() => expect(dependencies).toHaveLength(1));
    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(dependencies[0].controller.signal.aborted).toBe(true));
    dependencies[0].resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps a newer same-uid parse alive through old lease cleanup and cancels reload dependencies', async () => {
    const { client, worker, prepare, dependencies, params } = await fixture(type);
    const oldController = new AbortController();
    const first = client.sendAsync({ type: MessageType.loadTile, data: params }, oldController);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(dependencies).toHaveLength(1));
    const current = client.sendAsync({ type: MessageType.reloadTile, data: params }, new AbortController());
    await vi.waitFor(() => expect(dependencies).toHaveLength(2));
    await rejected;
    oldController.abort();
    dependencies[0].resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const source = worker.workerSources.map[type].source as VectorTileWorkerSource | GeoJSONWorkerSource;
    expect(source.tileState.loaded.tile.status).toBe('parsing');
    expect(dependencies[0].controller.signal.aborted).toBe(true);
    expect(dependencies[1].controller.signal.aborted).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    dependencies[1].resolve();
    const result = await current;
    expect(result && 'buckets' in result ? result.buckets : []).toHaveLength(1);
    expect(prepare).toHaveBeenCalledOnce();
    expect(source.tileState.loaded.tile.status).toBe('done');
    expect(source.tileState.loaded.tile.inFlightDependencies).toEqual([]);

    const controller = new AbortController();
    const reload = client.sendAsync({ type: MessageType.reloadTile, data: params }, controller);
    await vi.waitFor(() => expect(dependencies).toHaveLength(3));
    controller.abort();
    await expect(reload).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(dependencies[2].controller.signal.aborted).toBe(true));
    dependencies[2].resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each([MessageType.removeSource, MessageType.removeMap])('releases active parse dependencies on %s', async (remove) => {
    const { client, worker, prepare, dependencies, params } = await fixture(type);
    const load = client.sendAsync({ type: MessageType.loadTile, data: params });
    const rejected = expect(load).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(dependencies).toHaveLength(1));
    if (remove === MessageType.removeSource)
      await client.sendAsync({ type: remove, data: { type, source: 'source' } });
    else
      await client.sendAsync({ type: remove });
    await rejected;
    await vi.waitFor(() => expect(dependencies[0].controller.signal.aborted).toBe(true));
    dependencies[0].resolve();
    expect(worker.workerSources.map?.[type]?.source).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('vector worker network cancellation', () => {
  it('does not let a late canceled download delete a newer same-uid loading owner', async () => {
    const { client, worker, prepare, dependencies, params } = await fixture('vector');
    const downloads: Array<() => void> = [];
    vi.mocked(getArrayBuffer).mockImplementation(() => new Promise(resolve => downloads.push(() => resolve({ data: vectorData }))));
    const oldController = new AbortController();
    const first = client.sendAsync({ type: MessageType.loadTile, data: params }, oldController);
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    oldController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const current = client.sendAsync({ type: MessageType.loadTile, data: params }, new AbortController());
    await vi.waitFor(() => expect(downloads).toHaveLength(2));
    const source = worker.workerSources.map.vector.source as VectorTileWorkerSource;
    const loading = source.tileState.loading.tile;
    downloads[0]();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(source.tileState.loading.tile).toBe(loading);
    expect(loading.abort!.signal.aborted).toBe(false);
    expect(dependencies).toHaveLength(0);
    downloads[1]();
    await vi.waitFor(() => expect(dependencies).toHaveLength(1));
    dependencies[0].resolve();
    await current;
    expect(prepare).toHaveBeenCalledOnce();
    expect(source.tileState.loading).toEqual({});
  });

  it('passes the channel cancellation into the real network request', async () => {
    const { client, prepare, params } = await fixture('vector');
    vi.mocked(getArrayBuffer).mockImplementation((_request, controller) => new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    }));
    const controller = new AbortController();
    const load = client.sendAsync({ type: MessageType.loadTile, data: params }, controller);
    await vi.waitFor(() => expect(getArrayBuffer).toHaveBeenCalledOnce());
    const networkController = vi.mocked(getArrayBuffer).mock.calls[0][1];
    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
    expect(networkController.signal.aborted).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });
});
