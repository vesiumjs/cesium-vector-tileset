import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { FeatureCollection } from 'geojson';
import type { GeoJSONWorkerSource } from '../../source/geojson-worker-source';
import type { VectorTileWorkerSource } from '../../source/vector-tile-worker-source';
import type { WorkerTileParameters } from '../../source/worker-source';
import type { TileWorkerScope } from '../scope';
import type { WorkerEndpoint } from '../worker-channel';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { fromGeojsonVt, fromVectorTileJs, GeoJSONWrapper } from '@maplibre/vt-pbf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
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

async function fixture(type: 'vector' | 'geojson', options: { source?: string; layers?: LayerSpecification[]; updateLayers?: boolean } = {}) {
  const sourceId = options.source ?? 'source';
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
  const layers: LayerSpecification[] = options.layers ?? [{
    id: 'icons',
    type: 'symbol',
    source: sourceId,
    ...(type === 'vector' ? { 'source-layer': 'points' } : {}),
    layout: { 'icon-image': 'marker' },
  }];
  await client.sendAsync(options.updateLayers
    ? { type: MessageType.updateLayers, data: { layers, removedIds: [] } }
    : { type: MessageType.setLayers, data: layers });
  if (type === 'geojson') {
    await client.sendAsync({ type: MessageType.loadData, data: { type, source: sourceId, data: point, geojsonVtOptions: {} } });
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
    source: sourceId,
    uid: 'tile',
    tileID: new OverscaledTileID(0, 0, 0, 0, 0),
    zoom: 0,
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

  it('releases active parse dependencies when their source is removed', async () => {
    const { client, worker, prepare, dependencies, params } = await fixture(type);
    const load = client.sendAsync({ type: MessageType.loadTile, data: params });
    const rejected = expect(load).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(dependencies).toHaveLength(1));
    await client.sendAsync({ type: MessageType.removeSource, data: { type, source: 'source' } });
    await rejected;
    await vi.waitFor(() => expect(dependencies[0].controller.signal.aborted).toBe(true));
    dependencies[0].resolve();
    expect(worker.workerSources.map?.[type]?.source).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    await client.sendAsync({ type: MessageType.removeTile, data: params });
    await client.sendAsync({ type: MessageType.abortTile, data: params });
    expect(worker.workerSources.map?.[type]?.source, 'late cleanup must not recreate a removed source').toBeUndefined();
  });
});

describe('vector worker network cancellation', () => {
  it('preserves prototype-named MVT source layers and shared families through overzoom and source cache removal', async () => {
    const radius = (value: number) => {
      const data: FeatureCollection = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { radius: value }, geometry: { type: 'Point', coordinates: [-90, 45] } }] };
      const tile = new GeoJSONVT(data).getTile(0, 0, 0)!;
      // fromGeojsonVt's wrapper dictionary itself loses __proto__. Use the
      // public raw encoder so the network bytes contain both literal names.
      const encoded = fromVectorTileJs({ layers: Object.fromEntries(['__proto__', 'constructor'].map((name) => {
        const layer = new GeoJSONWrapper(tile.features as ConstructorParameters<typeof GeoJSONWrapper>[0], { version: 2, extent: 4096 });
        layer.name = name;
        return [name, layer];
      })) });
      return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
    };
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: radius(13), cacheControl: 'max-age=3600' });
    const { client, worker, params } = await fixture('vector', {
      source: '__proto__',
      updateLayers: true,
      layers: [
        { 'id': '__proto__', 'type': 'circle', 'source': '__proto__', 'source-layer': '__proto__', 'paint': { 'circle-radius': ['get', 'radius'] } },
        { 'id': 'constructor', 'type': 'circle', 'source': '__proto__', 'source-layer': '__proto__', 'paint': { 'circle-radius': 3 } },
        { 'id': 'valueOf', 'type': 'circle', 'source': '__proto__', 'source-layer': 'constructor', 'paint': { 'circle-radius': 5 } },
      ],
    });
    const assertTile = (result: Awaited<ReturnType<typeof client.sendAsync>>, expected: number) => {
      if (!result || !('buckets' in result))
        throw new Error('The actual parser must produce vector buckets');
      expect(result.buckets).toHaveLength(2);
      expect(result.buckets.map(bucket => bucket.layerIds)).toEqual([['__proto__', 'constructor'], ['valueOf']]);
      expect(result.buckets.every(bucket => !bucket.isEmpty())).toBe(true);
      expect(result.featureIndex.sourceLayerIds).toEqual(['__proto__', 'constructor']);
      expect(result.featureIndex.features.getFeature('__proto__', 0)?.properties).toEqual({ radius: expected });
    };
    assertTile(await client.sendAsync({ type: MessageType.loadTile, data: params }), 13);
    const child = {
      ...params,
      uid: 'overzoom-child',
      tileID: new OverscaledTileID(1, 0, 1, 0, 0),
      zoom: 1,
      overzoomParameters: { maxZoomTileID: new CanonicalTileID(0, 0, 0), overzoomRequest: params.request },
    };
    assertTile(await client.sendAsync({ type: MessageType.loadTile, data: child }), 13);
    const old = worker.workerSources.map.vector[params.source];
    await client.sendAsync({ type: MessageType.removeSource, data: { type: 'vector', source: '__proto__' } });
    expect(Object.hasOwn(worker.workerSources.map.vector, '__proto__')).toBe(false);
    await client.sendAsync({ type: MessageType.abortTile, data: params });
    await client.sendAsync({ type: MessageType.removeTile, data: params });
    expect(Object.hasOwn(worker.workerSources.map.vector, '__proto__')).toBe(false);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: radius(37), cacheControl: 'max-age=3600' });
    assertTile(await client.sendAsync({ type: MessageType.loadTile, data: child }), 37);
    expect(worker.workerSources.map.vector[params.source]).not.toBe(old);
  });

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
