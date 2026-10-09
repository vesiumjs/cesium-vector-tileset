import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { WorkerTileWithData } from '../worker-source';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageAtlas } from '../../assets/image-atlas';
import { CollisionBoxArray, PosArray } from '../../data/array-types.g';
import { CircleBucket } from '../../data/bucket-runtime';
import { FeatureIndex } from '../../data/feature-index';
import { ProgramConfigurationSet } from '../../data/program-configuration';
import { circleStyleForFeature } from '../../render/vector/feature-attributes';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { Style } from '../../style/style';
import { StyleLayerIndex } from '../../style/style-layer-index';
import { Tile } from '../../tile/tile';
import { OverscaledTileID } from '../../tile/tile-id';
import { TilePyramid } from '../../tile/tile-pyramid';
import { AlphaImage } from '../../util/image';
import { MessageType } from '../../worker/messages';
import { createTileTransferRegistry } from '../../worker/tile-transfer';

const transport = vi.hoisted(() => ({
  requests: [] as Array<{ type: string; signal: AbortSignal; resolve: (data: unknown) => void; reject: (error: Error) => void }>,
  channel: {
    sendAsync: vi.fn(),
    notify: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../worker/dispatcher', () => ({
  getGlobalDispatcher: () => undefined,
  WorkerDispatcher: class {
    channels = [transport.channel];
    channelsReady = Promise.resolve(this.channels);
    broadcast = vi.fn().mockResolvedValue([]);
    registerMessageHandler = vi.fn().mockResolvedValue(undefined);
    unregisterMessageHandler = vi.fn().mockResolvedValue(undefined);
    waitForInitComplete = vi.fn().mockResolvedValue(undefined);
    getReadyChannel = () => transport.channel;
    getChannel = async () => transport.channel;
    remove = vi.fn();
  },
}));

const tileID = new OverscaledTileID(2, 0, 2, 1, 1);
const sourceRadius = ['number', ['get', 'radius'], 2];
const compositeRadius = ['interpolate', ['linear'], ['zoom'], 2, sourceRadius, 3, ['*', 2, sourceRadius]];
const sourceColor = ['case', ['==', ['get', 'radius'], 3], '#ff0000', '#0000ff'];
const compositeColor = ['interpolate', ['linear'], ['zoom'], 2, sourceColor, 3, '#0000ff'];
const styles: Style[] = [];

function specification(radius: unknown, color?: unknown): LayerSpecification {
  return { id: 'points', type: 'circle', source: 'vector', paint: { 'circle-radius': radius, 'circle-color': color } } as LayerSpecification;
}

function payload(radius: unknown, color?: unknown): WorkerTileWithData {
  const index = new StyleLayerIndex([specification(radius, color)]);
  const layer = index._layers.points as import('../../style/style-layer/circle-style-layer').CircleStyleLayer;
  layer.recalculate(new EvaluationParameters(2), []);
  const programConfigurations = new ProgramConfigurationSet([layer], 2);
  programConfigurations.populatePaintArrays(1, { id: 7, type: 1, properties: { radius: 3 } }, 0, { imagePositions: {} });
  const layoutVertexArray = new PosArray();
  layoutVertexArray.emplaceBack(2048, 2048);
  const bucket = Object.assign(new CircleBucket(), {
    zoom: 2,
    layerIds: ['points'],
    stateDependentLayerIds: [],
    geometryRanges: [{ featureIndex: 0, start: 0, end: 1 }],
    layoutVertexArray,
    programConfigurations,
  });
  const result: WorkerTileWithData = {
    buckets: [bucket],
    featureIndex: new FeatureIndex(tileID),
    collisionBoxArray: new CollisionBoxArray(),
    imageAtlas: new ImageAtlas({}, {}),
    glyphAtlasImage: new AlphaImage({ width: 1, height: 1 }),
    dashPositions: {},
  };
  const buffers: Transferable[] = [];
  const encoded = createTileTransferRegistry().serialize(result, buffers);
  return createTileTransferRegistry().deserialize(structuredClone(encoded, { transfer: buffers })) as WorkerTileWithData;
}

function fixture(type: 'vector' | 'geojson', radius: unknown = sourceRadius, color?: unknown) {
  const style = new Style();
  styles.push(style);
  style._loaded = true;
  style.stylesheet = { version: 8, sources: {}, layers: [], transition: { duration: 0 } };
  const options = type === 'vector'
    ? { type: 'vector' as const, tiles: ['https://example.test/{z}/{x}/{y}.pbf'] }
    : { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } };
  const pyramid = new TilePyramid('vector', options, style.dispatcher);
  const source = pyramid.getSource();
  source.style = style;
  pyramid.style = style;
  style.tilePyramids.vector = pyramid;
  style.addLayer(specification(radius, color), undefined, { validate: false });
  style.update(new EvaluationParameters(2));
  const tile = new Tile(tileID, 512);
  pyramid._activeTiles.setTile(tileID.key, tile);
  return { style, source, pyramid, tile };
}

beforeEach(() => {
  transport.requests.length = 0;
  transport.channel.sendAsync.mockImplementation(({ type }: { type: string }, controller?: AbortController) => {
    if (type !== MessageType.loadTile && type !== MessageType.reloadTile)
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      transport.requests.push({ type, signal: controller!.signal, resolve, reject });
      controller!.signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
    });
  });
});

afterEach(() => {
  for (const style of styles.splice(0))
    style.destroy();
  vi.restoreAllMocks();
});

describe.each(['vector', 'geojson'] as const)('%s tile load generations', (type) => {
  it.each([
    ['source', sourceRadius, sourceColor],
    ['composite', compositeRadius, compositeColor],
  ])('renders current constant radius and color after a nonzero %s transition', async (_name, radius, color) => {
    const { style, source, tile } = fixture(type, radius, color);
    const published = vi.spyOn(tile, 'loadVectorData');
    const first = source.loadTile!(tile);
    let settled = false;
    void first.then(() => settled = true);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    style.setPaintProperty('points', 'circle-radius', 10, { validate: false });
    style.setPaintProperty('points', 'circle-color', '#00ff00', { validate: false });
    style.update(new EvaluationParameters(2, { now: 100, transition: { duration: 300 } }));
    transport.requests[0].resolve(payload(radius, color));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(transport.requests).toHaveLength(1);
    for (const now of [250, 400]) {
      expect(style.update(new EvaluationParameters(2, { now })).vector).toBe(true);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(transport.requests).toHaveLength(1);
      expect(settled).toBe(false);
      expect(published).not.toHaveBeenCalled();
    }
    style.update(new EvaluationParameters(2, { now: 401 }));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    transport.requests[1].resolve(payload(10, '#00ff00'));
    await first;
    const paint = circleStyleForFeature(tile.buckets.points as CircleBucket, 0);
    expect(paint.sizePx).toBe(20);
    expect([paint.color.red, paint.color.green, paint.color.blue, paint.color.alpha]).toEqual([0, 1, 0, 1]);
  });

  it.each([
    ['source to composite', sourceRadius, compositeRadius, 9],
    ['composite to source', compositeRadius, sourceRadius, 6],
    ['constant to source', 10, sourceRadius, 6],
    ['source to a different source expression', sourceRadius, ['*', 2, sourceRadius], 12],
  ])('publishes snapped data paint without waiting for constant transitions: %s', async (_name, previous, current, sizePx) => {
    const { style, source, tile } = fixture(type, previous);
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    style.setPaintProperty('points', 'circle-radius', current as never, { validate: false });
    style.setPaintProperty('points', 'circle-opacity', 0.5, { validate: false });
    style.update(new EvaluationParameters(2.5, { now: 100, transition: { duration: 300 } }));
    transport.requests[0].resolve(payload(previous));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    transport.requests[1].resolve(payload(current));
    await first;
    expect(style.getLayer('points')!.hasTransition()).toBe(true);
    const paint = circleStyleForFeature(tile.buckets.points as CircleBucket, 0, 'points', 2.5);
    expect(paint.sizePx).toBe(sizePx);
    expect(paint.color.alpha).toBe(1);
  });

  it('keeps the worker acknowledgment independent of a completed paint transition', async () => {
    const { style, source, tile } = fixture(type);
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    let acknowledge!: () => void;
    const workerReady = new Promise<[]>(resolve => acknowledge = () => resolve([]));
    vi.mocked(style.dispatcher.broadcast).mockImplementation(() => workerReady);
    style.setPaintProperty('points', 'circle-radius', 10, { validate: false });
    style.update(new EvaluationParameters(2, { now: 100, transition: { duration: 300 } }));
    transport.requests[0].resolve(payload(sourceRadius));
    style.update(new EvaluationParameters(2, { now: 401 }));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(transport.requests).toHaveLength(1);
    acknowledge();
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    transport.requests[1].resolve(payload(10));
    await first;
    expect(circleStyleForFeature(tile.buckets.points as CircleBucket, 0).sizePx).toBe(20);
  });

  it('releases one source while another source retains data-driven paint', async () => {
    const { style, source, tile } = fixture(type);
    style.tilePyramids.other = new TilePyramid('other', { type: 'vector', tiles: ['https://example.test/other/{z}/{x}/{y}.pbf'] }, style.dispatcher);
    style.tilePyramids.other.style = style;
    style.tilePyramids.other.getSource().style = style;
    style.addLayer({ ...specification(sourceRadius), id: 'other-points', source: 'other' }, undefined, { validate: false });
    style.update(new EvaluationParameters(2));
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    style.setPaintProperty('points', 'circle-radius', compositeRadius as never, { validate: false });
    style.setPaintProperty('other-points', 'circle-radius', 10, { validate: false });
    style.update(new EvaluationParameters(2.5, { now: 100, transition: { duration: 300 } }));
    transport.requests[0].resolve(payload(sourceRadius));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    let otherReady = false;
    void style.getSourceParseState('other').ready.then(() => otherReady = true);
    transport.requests[1].resolve(payload(compositeRadius));
    await first;
    expect(otherReady).toBe(false);
    expect(circleStyleForFeature(tile.buckets.points as CircleBucket, 0, 'points', 2.5).sizePx).toBe(9);
    style.update(new EvaluationParameters(2.5, { now: 401 }));
    await style.getSourceParseState('other').ready;
    expect(otherReady).toBe(true);
  });

  it('rejects all current callers when the worker schema acknowledgment fails', async () => {
    const { style, source, tile } = fixture(type);
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const queued = source.loadTile!(tile);
    const results = Promise.allSettled([first, queued]);
    const error = new Error('Worker schema update failed');
    vi.mocked(style.dispatcher.broadcast).mockRejectedValueOnce(error);
    style.setPaintProperty('points', 'circle-radius', 10, { validate: false });
    style.update(new EvaluationParameters(2, { now: 100, transition: { duration: 300 } }));
    transport.requests[0].resolve(payload(sourceRadius));
    expect(await results).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    style.update(new EvaluationParameters(2, { now: 401 }));
    expect(transport.requests).toHaveLength(1);
    expect(tile.loadPromise).toBeUndefined();
  });

  it('retains an older data expression through an interrupted constant transition', async () => {
    const { style, source, tile } = fixture(type);
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    style.setPaintProperty('points', 'circle-radius', 10, { validate: false });
    style.update(new EvaluationParameters(2, { now: 100, transition: { duration: 300 } }));
    transport.requests[0].resolve(payload(sourceRadius));
    style.setPaintProperty('points', 'circle-radius', 20, { validate: false });
    style.update(new EvaluationParameters(2, { now: 200, transition: { duration: 300 } }));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(transport.requests).toHaveLength(1);
    style.update(new EvaluationParameters(2, { now: 401 }));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    transport.requests[1].resolve(payload(20));
    await first;
    // Both transition endpoints now have the constant schema. The current
    // interpolated paint, rather than the worker's target value, is rendered.
    const paint = circleStyleForFeature(tile.buckets.points as CircleBucket, 0);
    expect(paint.sizePx).toBeGreaterThan(20);
    expect(paint.sizePx).toBeLessThan(40);
  });

  it.each(['abort', 'remove'] as const)('settles %s while awaiting a nonconstant paint transition', async (action) => {
    const { style, source, tile } = fixture(type);
    const published = vi.spyOn(tile, 'loadVectorData');
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    style.setPaintProperty('points', 'circle-radius', 10, { validate: false });
    style.update(new EvaluationParameters(2, { now: 100, transition: { duration: 300 } }));
    const queued = source.loadTile!(tile);
    transport.requests[0].resolve(payload(sourceRadius));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (action === 'abort')
      await source.abortTile!(tile);
    else
      source.onRemove!();
    await Promise.all([first, queued]);
    style.update(new EvaluationParameters(2, { now: 401 }));
    expect(published).not.toHaveBeenCalled();
    expect(tile.loadPromise).toBeUndefined();
    expect(transport.requests).toHaveLength(1);
  });

  it.each([
    ['source to constant', sourceRadius, 10],
    ['source to composite', sourceRadius, compositeRadius],
    ['composite to source', compositeRadius, sourceRadius],
    ['removed property', compositeRadius, undefined],
  ])('publishes only the current schema and settles all callers after its real parse: %s', async (_name, previous, current) => {
    const { style, source, tile } = fixture(type, previous);
    const published = vi.spyOn(tile, 'loadVectorData');
    const first = source.loadTile!(tile);
    let settled = false;
    first.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    style.setPaintProperty('points', 'circle-radius', current as never, { validate: false });
    style.update(new EvaluationParameters(2));
    const second = source.loadTile!(tile);
    const third = source.loadTile!(tile);
    void second.catch(() => {});
    void third.catch(() => {});
    transport.requests[0].resolve(payload(previous));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    expect(settled).toBe(false);
    expect(published).not.toHaveBeenCalled();
    const newest = payload(current);
    transport.requests[1].resolve(newest);
    await Promise.all([first, second, third]);
    expect(tile.state).toBe('loaded');
    expect(published).toHaveBeenCalledExactlyOnceWith(newest, style, ...(type === 'geojson' ? [true] : []));
    const configuration = (tile.buckets.points as CircleBucket).programConfigurations.get('points');
    expect(configuration.isCompositeProperty('circle-radius')).toBe(current === compositeRadius);
    expect(configuration.getAttributeArray('circle-radius')?.length).toBe(Array.isArray(current) ? 1 : undefined);
    expect(tile.loadPromise).toBeUndefined();
  });

  it('discards a removed and readded layer before the next update and waits for worker synchronization', async () => {
    const { style, source, tile } = fixture(type);
    const first = source.loadTile!(tile);
    const published = vi.spyOn(tile, 'loadVectorData');
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    style.removeLayer('points');
    style.addLayer(specification(10), undefined, { validate: false });
    transport.requests[0].resolve(payload(sourceRadius));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(published).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);

    let acknowledge!: () => void;
    const workerReady = new Promise<[]>(resolve => acknowledge = () => resolve([]));
    vi.mocked(style.dispatcher.broadcast).mockImplementation(() => workerReady);
    style.update(new EvaluationParameters(2));
    const queued = source.loadTile!(tile);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(transport.requests).toHaveLength(1);
    acknowledge();
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    transport.requests[1].resolve(payload(10));
    await Promise.all([first, queued]);
    expect(published).toHaveBeenCalledOnce();
    expect((tile.buckets.points as CircleBucket).programConfigurations.get('points').getAttributeArray('circle-radius')).toBeUndefined();
  });

  it('invalidates the original source when a layer ID moves to another source', async () => {
    const { style, source, tile } = fixture(type);
    const first = source.loadTile!(tile);
    const published = vi.spyOn(tile, 'loadVectorData');
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    style.tilePyramids.other = new TilePyramid('other', { type: 'vector', tiles: ['https://example.test/other/{z}/{x}/{y}.pbf'] }, style.dispatcher);
    style.tilePyramids.other.style = style;
    style.tilePyramids.other.getSource().style = style;
    style.removeLayer('points');
    style.addLayer({ ...specification(10), source: 'other' }, undefined, { validate: false });
    style.update(new EvaluationParameters(2));
    transport.requests[0].resolve(payload(sourceRadius));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    expect(published).not.toHaveBeenCalled();
    const empty = payload(10);
    empty.buckets = [];
    transport.requests[1].resolve(empty);
    await first;
    expect(tile.buckets).toEqual({});
    expect(style.getLayer('points')!.source).toBe('other');
  });

  it.each(['abort', 'remove'] as const)('settles original and queued callers on %s and ignores late data', async (action) => {
    const { source, tile } = fixture(type);
    const published = vi.spyOn(tile, 'loadVectorData');
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const queued = source.loadTile!(tile);
    if (action === 'abort')
      await source.abortTile!(tile);
    else
      source.onRemove!();
    await Promise.all([first, queued]);
    transport.requests[0].resolve(payload(sourceRadius));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(published).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
    expect(tile.loadPromise).toBeUndefined();
    expect(tile.abortController).toBeUndefined();
  });

  it('keeps all callers pending through a superseded error and rejects them together on a current error', async () => {
    const { source, tile } = fixture(type);
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const second = source.loadTile!(tile);
    const third = source.loadTile!(tile);
    const results = Promise.allSettled([first, second, third]);
    const published = vi.spyOn(tile, 'loadVectorData');
    transport.requests[0].reject(new Error('Superseded parse failed'));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    const currentError = new Error('Current parse failed');
    transport.requests[1].reject(currentError);
    expect(await results).toEqual([
      { status: 'rejected', reason: currentError },
      { status: 'rejected', reason: currentError },
      { status: 'rejected', reason: currentError },
    ]);
    expect(published).not.toHaveBeenCalled();
    expect(tile.loadPromise).toBeUndefined();
  });

  it('settles cancellation while the next schema has not been flushed', async () => {
    const { style, source, tile } = fixture(type);
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    style.removeLayer('points');
    transport.requests[0].resolve(payload(sourceRadius));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await source.abortTile!(tile);
    await first;
    expect(tile.loadPromise).toBeUndefined();
    expect(transport.requests).toHaveLength(1);
  });
});

describe('vector tile 404 generations', () => {
  it('discards a superseded 404 and publishes an empty tile only for the current 404', async () => {
    const { source, tile } = fixture('vector');
    const published = vi.spyOn(tile, 'loadVectorData');
    const first = source.loadTile!(tile);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const queued = source.loadTile!(tile);
    transport.requests[0].reject(Object.assign(new Error('Missing old tile'), { status: 404 }));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    expect(published).not.toHaveBeenCalled();
    transport.requests[1].reject(Object.assign(new Error('Missing current tile'), { status: 404 }));
    await Promise.all([first, queued]);
    expect(published).toHaveBeenCalledOnce();
    expect(tile.state).toBe('loaded');
    expect(tile.buckets).toEqual({});
  });
});
