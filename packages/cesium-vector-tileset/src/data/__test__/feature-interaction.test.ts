import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { FeatureCollection } from 'geojson';
import type { WorkerTileParameters, WorkerTileWithData } from '../../source/worker-source';
import type { Style } from '../../style/style';
import type { WorkerMessageSender } from '../../worker/worker-channel';
import type { SymbolBucket } from '../bucket-runtime';
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { encodeTile } from '@maplibre/mlt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../../cesium-vector-tileset';
import { projectWorkerBuckets } from '../../render/vector/bucket-geometry';
import { GeoJSONWorkerSource } from '../../source/geojson-worker-source';
import { VectorTileWorkerSource } from '../../source/vector-tile-worker-source';
import { StyleLayerIndex } from '../../style/style-layer-index';
import { Tile } from '../../tile/tile';
import { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import { getArrayBuffer } from '../../util/ajax';
import { AlphaImage, RGBAImage } from '../../util/image';
import { MessageType } from '../../worker/messages';
import { createTileTransferRegistry } from '../../worker/tile-transfer';

vi.mock('../../util/ajax', async importOriginal => ({
  ...await importOriginal<typeof import('../../util/ajax')>(),
  getArrayBuffer: vi.fn(),
}));

const channel = { sendAsync: vi.fn().mockResolvedValue({}) } as unknown as WorkerMessageSender;
const measurements: object[] = [];
function params(id = new OverscaledTileID(0, 0, 0, 0, 0)): WorkerTileParameters {
  return {
    uid: 'interaction',
    type: 'vector',
    source: 'vector',
    tileID: id,
    zoom: id.overscaledZ,
    tileSize: 512,
    pixelRatio: 1,
    promoteId: undefined,
    request: { url: 'https://example.test/interaction.pbf' },
    encoding: 'mvt',
  };
}

function pointData(properties: Record<string, unknown> = {}, id = 7): FeatureCollection {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', id, properties, geometry: { type: 'Point', coordinates: [-90, 45] } }] };
}

function encode(layers: Record<string, FeatureCollection>): ArrayBuffer {
  const tiles = Object.fromEntries(Object.entries(layers).map(([name, data]) => [name, new GeoJSONVT(data, { extent: 8192 }).getTile(0, 0, 0)!]));
  const bytes = fromGeojsonVt(tiles, { version: 2, extent: 8192 });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function layer(id: string, paint: object = {}, sourceLayer = id): LayerSpecification {
  return { id, 'type': 'circle', 'source': 'vector', 'source-layer': sourceLayer, paint } as LayerSpecification;
}

function style(index: StyleLayerIndex): Style {
  return { hasLayer: (id: string) => id in index._layers, getLayer: (id: string) => index._layers[id] } as unknown as Style;
}

/** Logical payload bytes, including metadata; this is neither wire size nor heap. */
function payload(value: unknown) {
  const buffers = new Set<ArrayBuffer>();
  const metadata = JSON.stringify(value, (_key, input) => {
    if (typeof input === 'bigint')
      return { bigint: input.toString() };
    if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
      const buffer = input instanceof ArrayBuffer ? input : input.buffer;
      buffers.add(buffer as ArrayBuffer);
      return { binary: Object.prototype.toString.call(input), length: input.byteLength };
    }
    return input;
  });
  const binaryBackingBytes = [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
  const metadataUtf8Bytes = new TextEncoder().encode(metadata).byteLength;
  return { binaryBackingBytes, metadataUtf8Bytes, logicalSerializedPayloadBytes: binaryBackingBytes + metadataUtf8Bytes };
}

function transport(result: WorkerTileWithData, id: OverscaledTileID, label: string): WorkerTileWithData {
  projectWorkerBuckets(result.buckets, id);
  const started = performance.now();
  const transfer: Transferable[] = [];
  const encoded = createTileTransferRegistry().serialize(result, transfer);
  const serializeMs = performance.now() - started;
  const bytes = payload(encoded);
  const rawBytes = 'rawTileData' in result && result.rawTileData instanceof ArrayBuffer ? result.rawTileData.byteLength : 0;
  const cloned = structuredClone(encoded, { transfer });
  const restored = createTileTransferRegistry().deserialize(cloned) as WorkerTileWithData;
  measurements.push({ label, ...bytes, rawBytes, transfers: transfer.length, serializeMs, transferRestoreMs: performance.now() - started - serializeMs });
  return restored;
}

function pick(index: Tile['latestFeatureIndex'], layerId: string, featureIndex = 0) {
  const owner = { _tileResidency: { featureIndex: () => index } } as unknown as CesiumVectorTileset;
  return CesiumVectorTileset.prototype.pick.call(owner, { type: 'circle', tileId: 'interaction', generationId: 1, layerId, featureIndex });
}

function radius(tile: Tile, layerId: string) {
  return tile.buckets[layerId].programConfigurations.get(layerId).getAttributeArray('circle-radius').float32[0];
}

beforeEach(() => vi.mocked(getArrayBuffer).mockReset());
afterAll(() => {
  if (process.env.FEATURE_PAYLOAD_REPORT)
    writeFileSync(process.env.FEATURE_PAYLOAD_REPORT, JSON.stringify({ methodology: 'Actual source parsing, Cesium geometry projection, registry serialization and structuredClone transfer; logical payload bytes are unique binary backing allocations plus UTF-8 metadata. Timings exclude real Worker scheduling and GPU. Heap not measured.', measurements }, null, 2));
});

describe('worker feature interaction', () => {
  it('keeps original sparse feature indices through filtering, transfer and public picking', async () => {
    const data = pointData({ name: 'rendered', keep: true });
    data.features.unshift({ ...data.features[0], id: 1, properties: { name: 'filtered', keep: false } });
    const index = new StyleLayerIndex([{ ...layer('roads'), filter: ['==', ['get', 'keep'], true] } as LayerSpecification]);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: encode({ roads: data }) });
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = params();
    const result = await worker.loadTile(p) as WorkerTileWithData;
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(result, p.tileID, 'sparse-mvt'), style(index));
    expect(pick(tile.latestFeatureIndex, 'roads', 1)?.properties).toEqual({ name: 'rendered', keep: true });
    expect(pick(tile.latestFeatureIndex, 'roads', 0)).toBeUndefined();
  });

  it('uses the promoted ID in state expressions as it does in initial paint', async () => {
    const index = new StyleLayerIndex([layer('roads', { 'circle-radius': ['+', ['case', ['==', ['id'], 'road-A'], 2, 1], ['number', ['feature-state', 'radius'], 0]] })]);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: encode({ roads: pointData({ promoted: 'road-A' }) }) });
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = { ...params(), promoteId: 'promoted' };
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'promoted-mvt'), style(index));
    expect(radius(tile, 'roads')).toBe(2);
    tile.setFeatureState({ roads: [{ id: 'road-A', state: { radius: 10 } }] }, style(index), 1);
    expect(radius(tile, 'roads')).toBe(12);
  });

  it('uses the same available images in initial Worker paint and state updates', async () => {
    const imageName = ['to-string', ['coalesce', ['image', 'missing'], ['image', 'present']]];
    const index = new StyleLayerIndex([layer('roads', { 'circle-radius': ['+', ['number', ['feature-state', 'radius'], 0], ['case', ['==', imageName, 'present'], 4, 1]] })]);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: encode({ roads: pointData() }) });
    const worker = new VectorTileWorkerSource(channel, index, ['present']);
    const p = params();
    const tile = new Tile(p.tileID, 512);
    const mainStyle = style(index);
    mainStyle._availableImages = ['present'];
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'state-images'), mainStyle);
    expect(radius(tile, 'roads')).toBe(4);
    tile.setFeatureState({ roads: [{ id: '7', state: { radius: 10 } }] }, mainStyle, 1);
    expect(radius(tile, 'roads')).toBe(14);
  });

  it('reapplies the same state revision to newly parsed paint after reload', async () => {
    const index = new StyleLayerIndex([layer('roads', { 'circle-radius': ['number', ['feature-state', 'radius'], 2] })]);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: encode({ roads: pointData() }) });
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = params();
    const tile = new Tile(p.tileID, 512);
    const states = { roads: [{ id: '7', state: { radius: 10 } }] };
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'reload-first'), style(index));
    tile.setFeatureState(states, style(index), 3);
    expect(radius(tile, 'roads')).toBe(10);
    tile.loadVectorData(transport(await worker.reloadTile(p) as WorkerTileWithData, p.tileID, 'reload-next'), style(index));
    tile.setFeatureState(states, style(index), 3);
    expect(radius(tile, 'roads')).toBe(10);
  });

  it('uses each overzoom parse generation for later source-layer picks', async () => {
    const index = new StyleLayerIndex([layer('first')]);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: encode({ first: pointData({ name: 'first' }), later: pointData({ name: 'later' }) }), cacheControl: 'max-age=60' });
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = { ...params(new OverscaledTileID(1, 0, 1, 0, 0)), overzoomParameters: { maxZoomTileID: new CanonicalTileID(0, 0, 0), overzoomRequest: { url: 'https://example.test/parent.pbf' } } };
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'overzoom-first'), style(index));
    const previous = tile.latestFeatureIndex;
    expect(pick(previous, 'first')?.properties).toEqual({ name: 'first' });
    index.replace([layer('later')]);
    tile.loadVectorData(transport(await worker.reloadTile(p) as WorkerTileWithData, p.tileID, 'overzoom-later'), style(index));
    expect(pick(tile.latestFeatureIndex, 'later')?.properties).toEqual({ name: 'later' });
    expect(pick(previous, 'first')?.properties).toEqual({ name: 'first' });
    expect(getArrayBuffer).toHaveBeenCalledOnce();
  });

  it('preserves nested GeoJSON properties and ordinary prefix strings on each public pick', async () => {
    const properties = { nested: { values: [null, 1, true, 'name'] }, plain: '__$json__:{"value":1}', nil: null };
    const index = new StyleLayerIndex([{ id: 'roads', type: 'circle', source: 'vector' }]);
    const worker = new GeoJSONWorkerSource(channel, index, []);
    await worker.loadData({ type: 'geojson', source: 'vector', data: pointData(properties), geojsonVtOptions: { extent: 8192 } });
    const p = { ...params(), type: 'geojson' as const };
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'geojson-nested'), style(index));
    const first = pick(tile.latestFeatureIndex, 'roads')!;
    expect(first.properties).toEqual(properties);
    (first.properties.nested as unknown as { values: unknown[] }).values.push('caller');
    expect(pick(tile.latestFeatureIndex, 'roads')?.properties).toEqual(properties);
  });

  it('keeps MLT feature picking and state through the actual decoder and transfer', async () => {
    const bytes = Uint8Array.from(Buffer.from('HQEGbGF5ZXIxQAIABBACAQFkAjACAQEAE0ICAhpU', 'base64'));
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: bytes.buffer });
    const index = new StyleLayerIndex([layer('points', { 'circle-radius': ['number', ['feature-state', 'radius'], 2] }, 'layer1')]);
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = { ...params(), encoding: 'mlt' as const };
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'mlt-point'), style(index));
    expect(pick(tile.latestFeatureIndex, 'points')?.properties).toEqual({});
    tile.setFeatureState({ layer1: [{ id: '100', state: { radius: 12 } }] }, style(index), 1);
    expect(radius(tile, 'points')).toBe(12);
  });

  it('preserves scalar and nested 64-bit MLT properties through official encoding and transfer', async () => {
    const properties = { signed: -9007199254740993n, unsigned: 18446744073709551615n, nested: { amount: 9007199254740993n, list: [9007199254740995n, 'plain', true], $name: 'ordinary-property' } };
    const bytes = encodeTile([{ name: 'layer1', extent: 64, features: [{ id: 100, properties, geometry: { type: 'Point', coordinates: [13, 42] } }] }], { propertyTypes: { signed: 'int64', unsigned: 'uint64' } });
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    const index = new StyleLayerIndex([layer('points', {}, 'layer1')]);
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = { ...params(), encoding: 'mlt' as const };
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'mlt-int64'), style(index));
    const first = pick(tile.latestFeatureIndex, 'points')!;
    expect(first.properties).toEqual(properties);
    (first.properties.nested as typeof properties.nested).amount = 0n;
    expect(pick(tile.latestFeatureIndex, 'points')!.properties).toEqual(properties);
  });

  it('mLT IDs leave missing and nullable IDs unaddressable by NaN state', async () => {
    for (const features of [
      [{ properties: { name: 'missing' }, geometry: { type: 'Point' as const, coordinates: [13, 42] as [number, number] } }],
      [{ id: 0, properties: { name: 'zero' }, geometry: { type: 'Point' as const, coordinates: [12, 42] as [number, number] } }, { properties: { name: 'missing' }, geometry: { type: 'Point' as const, coordinates: [13, 42] as [number, number] } }],
    ]) {
      const bytes = encodeTile([{ name: 'layer1', extent: 64, features }]);
      vi.mocked(getArrayBuffer).mockResolvedValue({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
      const index = new StyleLayerIndex([layer('points', { 'circle-radius': ['number', ['feature-state', 'radius'], 2] }, 'layer1')]);
      const worker = new VectorTileWorkerSource(channel, index, []);
      const p = { ...params(), encoding: 'mlt' as const };
      const tile = new Tile(p.tileID, 512);
      tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'mlt-missing-id'), style(index));
      const missingIndex = features.length - 1;
      tile.setFeatureState({ layer1: [{ id: 'NaN', state: { radius: 10 } }] }, style(index), 1);
      const paint = tile.buckets.points.programConfigurations.get('points').getAttributeArray('circle-radius');
      expect(paint.float32[missingIndex]).toBe(2);
      expect(tile.latestFeatureIndex!.features.getFeature('layer1', missingIndex)!.id).toBeUndefined();
      expect(pick(tile.latestFeatureIndex, 'points', missingIndex)!.properties).toEqual({ name: 'missing' });
      if (features.length === 2) {
        tile.setFeatureState({ layer1: [{ id: '0', state: { radius: 7 } }] }, style(index), 2);
        expect(paint.float32[0]).toBe(7);
        expect(paint.float32[1]).toBe(2);
      }
    }
  });

  it('mLT IDs preserve adjacent unsafe UINT64 IDs through state, expressions, reload and public picking', async () => {
    const bytes = encodeTile([{ name: 'layer1', extent: 64, features: [
      { id: 9007199254740992n, properties: { name: 'first' }, geometry: { type: 'Point', coordinates: [12, 42] } },
      { id: 9007199254740993n, properties: { name: 'second' }, geometry: { type: 'Point', coordinates: [13, 42] } },
      { id: 18446744073709551615n, properties: { name: 'last' }, geometry: { type: 'Point', coordinates: [14, 42] } },
    ] }]);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    const index = new StyleLayerIndex([layer('points', { 'circle-radius': ['+', ['case', ['==', ['id'], '9007199254740993'], 3, 2], ['number', ['feature-state', 'radius'], 0]] }, 'layer1')]);
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = { ...params(), encoding: 'mlt' as const };
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'mlt-unsafe-id'), style(index));
    const radii = () => Array.from(tile.buckets.points.programConfigurations.get('points').getAttributeArray('circle-radius').float32.slice(0, 3));
    tile.setFeatureState({ layer1: [{ id: '9007199254740992', state: { radius: 10 } }] }, style(index), 1);
    expect(radii()).toEqual([12, 3, 2]);
    tile.setFeatureState({ layer1: [{ id: '9007199254740993', state: { radius: 20 } }] }, style(index), 2);
    expect(radii()).toEqual([12, 23, 2]);
    tile.setFeatureState({ layer1: [{ id: '18446744073709551615', state: { radius: 30 } }] }, style(index), 3);
    expect(radii()).toEqual([12, 23, 32]);
    for (const [featureIndex, name] of ['first', 'second', 'last'].entries())
      expect(pick(tile.latestFeatureIndex, 'points', featureIndex)!.properties).toEqual({ name });
    tile.loadVectorData(transport(await worker.reloadTile(p) as WorkerTileWithData, p.tileID, 'mlt-unsafe-id-reload'), style(index));
    tile.setFeatureState({ layer1: [{ id: '9007199254740993', state: { radius: 20 } }] }, style(index), 3);
    expect(radii()).toEqual([2, 23, 2]);
  });

  it.each([undefined, 'promoted'])('mLT IDs keep safe numeric semantics and normalize promoted BigInt integers without changing properties (%s)', async (promoteId) => {
    const ids = [4294967296n, 9007199254740991n, 9007199254740993n];
    const bytes = encodeTile([{ name: 'layer1', extent: 64, features: ids.map((id, index) => ({
      id,
      properties: { promoted: id, index },
      geometry: { type: 'Point' as const, coordinates: [12 + index, 42] as [number, number] },
    })) }]);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    const index = new StyleLayerIndex([layer('points', { 'circle-radius': ['+', ['case', ['==', ['id'], 4294967296], 4, ['==', ['id'], 9007199254740991], 5, ['==', ['id'], '9007199254740993'], 6, 1], ['number', ['feature-state', 'radius'], 0]] }, 'layer1')]);
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = { ...params(), encoding: 'mlt' as const, promoteId };
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'mlt-safe-promoted-id'), style(index));
    const paint = tile.buckets.points.programConfigurations.get('points').getAttributeArray('circle-radius');
    expect(Array.from(paint.float32.slice(0, 3))).toEqual([4, 5, 6]);
    tile.setFeatureState({ layer1: [{ id: '9007199254740993', state: { radius: 10 } }] }, style(index), 1);
    expect(Array.from(paint.float32.slice(0, 3))).toEqual([4, 5, 16]);
    expect(pick(tile.latestFeatureIndex, 'points', 2)!.properties).toEqual({ promoted: 9007199254740993n, index: 2 });
  });

  it('mLT IDs preserve signed promoted BigInt integers and their original properties', async () => {
    const bytes = encodeTile([{ name: 'layer1', extent: 64, features: [
      { id: 1, properties: { promoted: -9007199254740991n }, geometry: { type: 'Point', coordinates: [12, 42] } },
      { id: 2, properties: { promoted: -9007199254740993n }, geometry: { type: 'Point', coordinates: [13, 42] } },
    ] }]);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    const index = new StyleLayerIndex([layer('points', { 'circle-radius': ['+', ['case', ['==', ['id'], -9007199254740991], 4, ['==', ['id'], '-9007199254740993'], 6, 1], ['number', ['feature-state', 'radius'], 0]] }, 'layer1')]);
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = { ...params(), encoding: 'mlt' as const, promoteId: 'promoted' };
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'mlt-signed-promoted-id'), style(index));
    tile.setFeatureState({ layer1: [{ id: '-9007199254740993', state: { radius: 10 } }] }, style(index), 1);
    const paint = tile.buckets.points.programConfigurations.get('points').getAttributeArray('circle-radius');
    expect(Array.from(paint.float32.slice(0, 2))).toEqual([4, 16]);
    expect(pick(tile.latestFeatureIndex, 'points', 1)!.properties).toEqual({ promoted: -9007199254740993n });
  });

  it('retains normalized source geometry and canonical context for composite state expressions', async () => {
    const polygon = { type: 'Polygon', coordinates: [[[35, -50], [55, -50], [55, -30], [35, -30], [35, -50]]] };
    const amount = ['+', 2, ['number', ['feature-state', 'radius'], 0], ['case', ['within', polygon], 4, 0], ['/', ['distance', { type: 'Point', coordinates: [45, -40.979898069620134] }], 1000]];
    const index = new StyleLayerIndex([layer('roads', { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, amount, 2, ['*', 2, amount]] })]);
    const bytes = fromGeojsonVt({ roads: { features: [{ id: 42, type: 1, geometry: [[1024, 1024]], tags: { name: 'origin' } }] } }, { extent: 4096, version: 2 });
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = params(new OverscaledTileID(1, 0, 1, 1, 1));
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'state-geometry'), style(index));
    expect(tile.latestFeatureIndex!.features.getFeature('roads', 0)!.geometry).toEqual([[{ x: 2048, y: 2048 }]]);
    expect(radius(tile, 'roads')).toBeCloseTo(6, 5);
    tile.setFeatureState({ roads: [{ id: '42', state: { radius: 10 } }] }, style(index), 1);
    expect(radius(tile, 'roads')).toBeCloseTo(16, 5);
    const values = tile.buckets.roads.programConfigurations.get('roads').getAttributeArray('circle-radius').float32;
    expect(values[1]).toBeCloseTo(32, 5);
  });

  it('includes symbol-only features and updates each text section and icon after transfer', async () => {
    const index = new StyleLayerIndex([{
      'id': 'labels',
      'type': 'symbol',
      'source': 'vector',
      'source-layer': 'roads',
      'layout': { 'text-font': ['Test'], 'text-field': ['format', 'A', { 'text-color': '#ff0000' }, 'B', {}], 'icon-image': 'icon' },
      'paint': { 'text-color': ['case', ['boolean', ['feature-state', 'active'], false], '#00ff00', '#0000ff'], 'icon-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 0.8, 0.2] },
    }]);
    const dependencies = { sendAsync: async ({ type, data }: { type: MessageType; data: { stacks: Record<string, number[]> } }) => {
      if (type === MessageType.getGlyphs) {
        return Object.fromEntries(Object.entries(data.stacks).map(([font, ids]) => [font, Object.fromEntries(ids.map(id => [id, {
          id,
          bitmap: new AlphaImage({ width: 8, height: 8 }, new Uint8Array(64).fill(255)),
          metrics: { width: 2, height: 2, left: 0, top: 2, advance: 3 },
        }]))]));
      }
      if (type === MessageType.getImages)
        return { icon: { data: new RGBAImage({ width: 8, height: 8 }, new Uint8Array(256).fill(255)), pixelRatio: 1, sdf: false } };
      return {};
    } } as unknown as WorkerMessageSender;
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: encode({ roads: pointData({ name: 'symbol-only' }) }) });
    const worker = new VectorTileWorkerSource(dependencies, index, ['icon']);
    const p = params();
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'symbol-only'), style(index));
    expect(tile.latestFeatureIndex!.featureIndexArray.length).toBe(0);
    expect(tile.latestFeatureIndex!.features.getFeature('roads', 0)!.properties).toEqual({ name: 'symbol-only' });
    const bucket = tile.buckets.labels as SymbolBucket;
    expect(bucket.text.programConfigurations.getFeatureRanges()).toHaveLength(2);
    expect(bucket.icon.programConfigurations.getFeatureRanges()).toHaveLength(1);
    tile.setFeatureState({ roads: [{ id: '7', state: { active: true } }] }, style(index), 1);
    const colors = bucket.text.programConfigurations.get('labels').getAttributeArray('text-color')!.float32;
    for (const range of bucket.text.programConfigurations.getFeatureRanges()) {
      const expected = range.formattedSection?.textColor ? [65280, 255] : [255, 255];
      for (let slot = range.start; slot < range.end; slot++)
        expect([...colors.slice(slot * 2, slot * 2 + 2)]).toEqual(expected);
    }
    const opacity = bucket.icon.programConfigurations.get('labels').getAttributeArray('icon-opacity')!.float32;
    expect(opacity[0]).toBeCloseTo(0.8, 5);
  });

  it('transfers and picks the dense city used by the renderer performance comparison', async () => {
    const square = (x: number, y: number, size: number) => [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]];
    const bytes = fromGeojsonVt({
      ground: { features: [{ type: 3, geometry: square(0, 0, 4096), tags: {} }] },
      parcels: { features: Array.from({ length: 1024 }, (_, index) => ({ type: 3, geometry: square(index % 32 * 128 + 8, Math.floor(index / 32) * 128 + 8, 104), tags: { index } })) },
      roads: { features: Array.from({ length: 128 }, (_, index) => ({
        type: 2,
        geometry: [Array.from({ length: 33 }, (_, segment) => {
          const position = (index % 64 + 0.5) * 64;
          const bend = Math.sin(segment * Math.PI / 4) * 4;
          return index < 64 ? [segment * 128, position + bend] : [position + bend, segment * 128];
        })],
        tags: { index },
      })) },
    }, { version: 2, extent: 4096 });
    expect(bytes.byteLength).toBe(47378);
    vi.mocked(getArrayBuffer).mockResolvedValue({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    const index = new StyleLayerIndex([
      { 'id': 'ground', 'type': 'fill', 'source': 'vector', 'source-layer': 'ground', 'paint': { 'fill-antialias': false } },
      { 'id': 'parcels', 'type': 'fill', 'source': 'vector', 'source-layer': 'parcels', 'paint': { 'fill-antialias': false } },
      { 'id': 'roads', 'type': 'line', 'source': 'vector', 'source-layer': 'roads', 'layout': { 'line-cap': 'butt', 'line-join': 'miter' }, 'paint': { 'line-width': 3 } },
    ]);
    const worker = new VectorTileWorkerSource(channel, index, []);
    const p = params(new OverscaledTileID(14, 0, 14, 8186, 5447));
    const tile = new Tile(p.tileID, 512);
    tile.loadVectorData(transport(await worker.loadTile(p) as WorkerTileWithData, p.tileID, 'dense-city-z14'), style(index));
    expect(pick(tile.latestFeatureIndex, 'parcels', 1023)?.properties).toEqual({ index: 1023 });
    expect(pick(tile.latestFeatureIndex, 'roads', 127)?.properties).toEqual({ index: 127 });
  });
});
