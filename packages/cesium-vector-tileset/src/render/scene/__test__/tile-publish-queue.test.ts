import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { GeometryInstance } from 'cesium';
import type { FeatureCollection } from 'geojson';
import type { WorkerTileParameters, WorkerTileWithData } from '../../../source/worker-source';
import type { Style } from '../../../style/style';
import type { StyleLayer } from '../../../style/style-layer';
import type { WorkerMessageSender } from '../../../worker/worker-channel';
import type { GeometryPrepareBatchRequest } from '../../geometry/geometry-preparation';
import type { SymbolPrimitiveGeometry } from '../../symbol/symbol-geometry';
import type { SymbolBuildState, SymbolTileInput } from '../../symbol/symbol-renderer';
import type { Budget } from '../frame-budget';
import type { TilePublishOptions, TilePublishResult } from '../tile-publish-queue';
import Point from '@mapbox/point-geometry';
import * as Cesium from 'cesium';
import { buildModuleUrl, Color, GeographicProjection, Primitive, PrimitiveCollection, SceneMode, TaskProcessor } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FillExtrusionBucket, LineBucket } from '../../../data/bucket-runtime';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { SymbolBucket } from '../../../data/bucket/symbol-bucket';
import { FeatureIndex } from '../../../data/feature-index';
import { GeoJSONWorkerSource } from '../../../source/geojson-worker-source';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { StyleLayerIndex } from '../../../style/style-layer-index';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { SymbolStyleLayer } from '../../../style/style-layer/symbol-style-layer';
import { Tile } from '../../../tile/tile';
import { OverscaledTileID } from '../../../tile/tile-id';
import { createTileTransferRegistry } from '../../../worker/tile-transfer';
import { prepareGeometryBatch } from '../../geometry/geometry-preparation';
import { GeometryPrimitive } from '../../geometry/geometry-primitive';
import { isPatternStyleLayer } from '../../pattern/pattern-layer';
import { PatternTileRenderer } from '../../pattern/pattern-renderer';
import { RasterTileRenderer } from '../../raster/raster-renderer';
import { beginSymbolBuild, buildSymbolHalves, SymbolTileRenderer } from '../../symbol/symbol-renderer';
import { projectWorkerBuckets } from '../../vector/bucket-geometry';
import { VectorTileRenderer } from '../../vector/vector-tile-renderer';
import { UNBOUNDED_BUDGET } from '../frame-budget';
import { SceneCollections } from '../scene-collections';
import { TilePublishQueue } from '../tile-publish-queue';
import { TileResidency } from '../tile-residency';

const budget = { exhausted: false };
const minimumBudget = () => ({ exhausted: true, takeMinimumProgress: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) });

function fixture(publish?: (result: TilePublishResult) => void) {
  const land = new FillStyleLayer({ id: 'land', type: 'fill', source: 'source', paint: { 'fill-antialias': false } });
  const hatch = new FillStyleLayer({ id: 'hatch', type: 'fill', source: 'source', minzoom: 1, paint: { 'fill-pattern': 'hatch' } });
  const labels = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'source' }, {});
  const detail = new SymbolStyleLayer({ id: 'detail', type: 'symbol', source: 'source', minzoom: 1 }, {});
  const layers = new Map<string, StyleLayer>([land, hatch, labels, detail].map(layer => [layer.id, layer]));
  const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
  const tile = new Tile(tileID, 512);
  tile.state = 'loaded';
  for (const layer of layers.values()) {
    layer.recalculate(new EvaluationParameters(0), []);
    if (layer.type === 'symbol') {
      tile.buckets[layer.id] = new SymbolBucket({ layers: [layer as SymbolStyleLayer], zoom: 0 } as never);
    }
    else {
      const bucket = new FillBucket({ layers: [layer as FillStyleLayer], zoom: 0 } as never);
      bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
      tile.buckets[layer.id] = bucket;
    }
  }
  const style = {
    z: 0,
    _changed: false,
    styleRevision: 0,
    renderRevision: 0,
    getLayer: (id: string) => layers.get(id),
    getLayerOrder: () => [...layers.keys()],
    getRenderTransitionFlags: vi.fn(() => ({ any: false })),
  };
  const inputs = { lightRevision: 0, mode: SceneMode.SCENE3D, layerOrder: new Map([...layers.keys()].map((id, index) => [id, index])) };
  const requestRender = vi.fn();
  const vector = new VectorTileRenderer(1);
  const beginVector = vi.spyOn(vector, 'beginTileBuild');
  const oldSymbols = [new PrimitiveCollection()];
  const symbol = {
    // Keep a real publish job in its independent symbol stage. Geometry
    // extraction is controlled here; vector conversion remains real.
    beginBuild: vi.fn<(input: SymbolTileInput) => SymbolBuildState>(() => ({} as SymbolBuildState)),
    stepBuild: vi.fn<(state: SymbolBuildState, budget: Budget) => boolean>(() => false),
    releaseBuild: vi.fn<(state: SymbolBuildState) => void>(),
    commitBuild: vi.fn<SymbolTileRenderer['commitBuild']>(() => ({ added: [], removed: [] })),
    canRestoreTile: vi.fn<SymbolTileRenderer['canRestoreTile']>(() => false),
    restoreTile: vi.fn<SymbolTileRenderer['restoreTile']>(),
    setTilePlacementVisible: vi.fn<SymbolTileRenderer['setTilePlacementVisible']>(),
    hasTileLayer: vi.fn((_tileId: string, layerId: string) => layerId === 'labels'),
    removeTile: vi.fn(() => oldSymbols),
    getTileCollections: vi.fn<SymbolTileRenderer['getTileCollections']>(() => oldSymbols),
  };
  const pattern = new PatternTileRenderer();
  vi.spyOn(pattern, 'beginPatternBuild').mockReturnValue({ status: 'complete', update: { removed: [], added: [], removedMaterials: [] } });
  const published: TilePublishResult[] = [];
  const queue = new TilePublishQueue({
    vector,
    raster: new RasterTileRenderer(),
    pattern,
    symbol,
    style: () => style,
    styleZoom: () => style.z,
    lightRevision: () => inputs.lightRevision,
    sceneMode: () => inputs.mode,
    layerOrder: () => inputs.layerOrder,
    symbolLayers: () => [...layers.values()].filter(layer => layer.type === 'symbol' && !layer.isHidden(style.z)),
    patternLayers: () => [...layers.values()].filter(layer => isPatternStyleLayer(layer) && !layer.isHidden(style.z)),
    rasterLayers: () => [],
    rasterSource: () => ({ dynamic: false }),
    isRenderable: () => true,
    publish: (result) => {
      published.push(result);
      publish?.(result);
    },
    publishPattern: vi.fn(),
    requestRender,
  } as unknown as TilePublishOptions);
  const close = () => {
    queue.clear();
    for (const collection of [...vector.collections.values(), ...oldSymbols]) {
      if (!collection.isDestroyed())
        collection.destroy();
    }
    vector.removeAll();
  };
  return { queue, tile, style, layers, inputs, requestRender, vector, beginVector, symbol, published, oldSymbols, pattern, close };
}

function vectorFixture(publish?: (result: TilePublishResult) => void) {
  const state = fixture(publish);
  for (const id of ['labels', 'detail', 'hatch'])
    state.layers.delete(id);
  state.queue.idlePreparationsEnabled = true;
  return state;
}

function beginPendingVector(state: ReturnType<typeof fixture>) {
  state.queue.enqueue('source', state.tile);
  state.queue.drain(minimumBudget(), 1, undefined, true);
  state.requestRender.mockClear();
  return state.beginVector.mock.results.at(-1)!.value;
}

/** Prepared worker quads enter the real merger, Native primitive and entry ownership. */
function nativeSymbols(state: ReturnType<typeof fixture>) {
  vi.stubGlobal('OffscreenCanvas', class {});
  const renderer = new SymbolTileRenderer();
  const geometry: SymbolPrimitiveGeometry = {
    positions: new Float64Array(12),
    offsets: new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]),
    pxoffsets: new Float32Array(8),
    minfontscales: new Float32Array(8),
    tex: new Float32Array(8),
    sizes: new Float32Array(4).fill(512),
    sizesMax: new Float32Array(4).fill(128),
    sizeZooms: new Float32Array(8),
    colors: new Float32Array(16),
    halos: new Float32Array(16),
    dynamics: new Float32Array(12),
    opacities: new Float32Array(4),
    opacityDirty: false,
    viewportPerspective: true,
    mapPitch: false,
    sizePerspective: true,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    sdf: false,
    overlapMode: 'never',
    ignorePlacement: false,
    instances: [{ vertexStart: 0, vertexCount: 4, minX: -2, minY: -2, maxX: 2, maxY: 2 }],
  };
  state.symbol.beginBuild.mockImplementation((input) => {
    const build = beginSymbolBuild({ ...input, layers: [] }, undefined, undefined);
    const batch = { icon: geometry, pairs: [{ text: -1, icon: 0 }] };
    build.batches.push(batch);
    build.layerIds.push('labels');
    build.halves.push(...buildSymbolHalves({
      tileId: build.input.tileId,
      layerId: 'labels',
      geometry: batch,
      iconAtlas: { canvas: document.createElement('canvas'), width: 1, height: 1, shareKey: 'prepared-icons' },
      textColor: Color.WHITE,
      iconColor: Color.WHITE,
      pixelRatio: 1,
    }));
    return build;
  });
  state.symbol.stepBuild.mockImplementation(renderer.stepBuild.bind(renderer));
  state.symbol.commitBuild.mockImplementation(renderer.commitBuild.bind(renderer));
  state.symbol.releaseBuild.mockImplementation(renderer.releaseBuild.bind(renderer));
  state.symbol.getTileCollections.mockImplementation(renderer.getTileCollections.bind(renderer));
  state.symbol.canRestoreTile.mockImplementation(renderer.canRestoreTile.bind(renderer));
  state.symbol.restoreTile.mockImplementation(renderer.restoreTile.bind(renderer));
  return renderer;
}

afterEach(() => vi.unstubAllGlobals());

async function loadTransferredVectors(state: ReturnType<typeof vectorFixture>, points = false, surface = false): Promise<void> {
  const specifications: LayerSpecification[] = [
    { id: 'roads', type: 'line', source: 'source', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-width': 4, 'line-color': '#123456' } },
    { id: 'buildings', type: 'fill-extrusion', source: 'source', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-extrusion-height': 100, 'fill-extrusion-color': '#ffffff' } },
  ];
  if (surface)
    specifications.push({ id: 'land', type: 'fill', source: 'source', filter: ['==', ['get', 'surface'], true], paint: { 'fill-antialias': false, 'fill-color': '#123456' } });
  if (points)
    specifications.push({ id: 'points', type: 'circle', source: 'source', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#123456' } });
  const index = new StyleLayerIndex(specifications);
  state.layers.clear();
  state.inputs.layerOrder.clear();
  for (const [position, specification] of specifications.entries()) {
    const layer = index._layers[specification.id];
    layer.recalculate(new EvaluationParameters(0), []);
    state.layers.set(layer.id, layer);
    state.inputs.layerOrder.set(layer.id, position);
  }
  const workerSource = new GeoJSONWorkerSource({ sendAsync: vi.fn().mockResolvedValue({}) } as unknown as WorkerMessageSender, index, []);
  const data: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-10, 20], [-8, 21], [-7, 20]] } },
      ...Array.from({ length: 64 }, (_, featureIndex) => {
        const x = featureIndex / 10;
        return { type: 'Feature' as const, properties: { surface: featureIndex === 0 }, geometry: { type: 'Polygon' as const, coordinates: [[[x, 10], [x + 0.05, 10], [x + 0.05, 10.05], [x, 10.05], [x, 10]]] } };
      }),
      ...(points ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [-8, 21] } }] : []),
    ],
  };
  await workerSource.loadData({ type: 'geojson', source: 'source', data, geojsonVtOptions: { extent: 8192, tolerance: 0 } });
  const parameters: WorkerTileParameters = { uid: 'early-lines', type: 'geojson', source: 'source', tileID: state.tile.tileID, zoom: 0, tileSize: 512, pixelRatio: 1, promoteId: undefined, request: { url: '' }, encoding: 'mvt' };
  const parsed = await workerSource.loadTile(parameters) as WorkerTileWithData;
  projectWorkerBuckets(parsed.buckets, state.tile.tileID);
  const transfers: Transferable[] = [];
  const serialized = createTileTransferRegistry().serialize(parsed, transfers);
  const restored = createTileTransferRegistry().deserialize(structuredClone(serialized, { transfer: transfers })) as WorkerTileWithData;
  state.tile.loadVectorData(restored, { hasLayer: (id: string) => state.layers.has(id), getLayer: (id: string) => state.layers.get(id) } as unknown as Style);
  expect(state.tile.buckets.roads).toBeInstanceOf(LineBucket);
  const buildings = state.tile.buckets.buildings as FillExtrusionBucket;
  expect(buildings).toBeInstanceOf(FillExtrusionBucket);
  expect(buildings.geometryRanges).toHaveLength(64);
}

function advanceToLines(state: ReturnType<typeof vectorFixture>) {
  const build = beginPendingVector(state);
  for (let turn = 0; turn < 1024 && !state.published.some(result => result.stage === 'lines'); turn++)
    state.queue.drain(minimumBudget(), 1, undefined, true);
  expect(build.phase).toBe('extrusions');
  const publication = state.published.find(result => result.stage === 'lines')!;
  expect(publication).toBeDefined();
  const lines = publication.addedVector.find(collection => collection instanceof PrimitiveCollection
    && collection.length > 0 && collection.get(0) instanceof GeometryPrimitive) as PrimitiveCollection;
  expect(lines).toBeInstanceOf(PrimitiveCollection);
  return { build, publication, lines, owner: lines.get(0) as GeometryPrimitive };
}

describe('detached vector preparation on idle ticks', () => {
  it('admits transferred Worker lines to Native while real extrusion construction is unfinished', async () => {
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    let state: ReturnType<typeof vectorFixture>;
    const scene = new SceneCollections(root, vi.fn(), () => false, () => {}, (collection, allowance) =>
      state.vector.refreshCollectionPaint(collection, { zoom: 0, styleRevision: 0, budget: allowance }).ready);
    state = vectorFixture(result => scene.applyPublication(result));
    await loadTransferredVectors(state);

    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const transfer = TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer?: boolean };
    const previousTransfer = transfer._canTransferArrayBuffer;
    transfer._canTransferArrayBuffer = true;
    const limits = (Cesium as unknown as { ContextLimits: { _maximumTextureSize: number } }).ContextLimits;
    const previousTextureSize = limits._maximumTextureSize;
    limits._maximumTextureSize = 4096;
    const received: Array<{ id: number; parameters: GeometryPrepareBatchRequest }> = [];
    const nativeWorker = Object.assign(new EventTarget(), {
      postMessage: vi.fn((message: { id: number; parameters: GeometryPrepareBatchRequest }, buffers: ArrayBuffer[]) => {
        received.push(structuredClone(message, { transfer: buffers }));
      }),
      terminate: vi.fn(),
    });
    const schedule = TaskProcessor.prototype.scheduleTask;
    const tasks = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (request, buffers) {
      Object.assign(this, { _worker: nativeWorker });
      return schedule.call(this, request, buffers);
    });
    // Only Cesium's GPU boundary is replaced. GeometryPrimitive copying,
    // admission, TaskProcessor dispatch and transferred kernel inputs stay real.
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function () {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
    });
    try {
      const build = beginPendingVector(state);
      for (let turn = 0; turn < 1024 && build.phase !== 'extrusions' && build.phase !== 'points' && build.phase !== 'done'; turn++)
        state.queue.drain(minimumBudget(), 1, undefined, true);
      expect(build.phase).toBe('extrusions');
      const tileId = `source/${state.tile.tileID.key}`;
      const staged = build.entries.find(([kind]) => kind === 'lines')?.[1];
      const lines = (staged ?? state.vector.getTileCollections(tileId).find(collection =>
        collection instanceof PrimitiveCollection && collection.length > 0 && collection.get(0) instanceof GeometryPrimitive)) as PrimitiveCollection;
      expect(lines).toBeInstanceOf(PrimitiveCollection);
      expect(lines.length).toBe(1);
      const owner = lines.get(0) as GeometryPrimitive;
      const instances = owner.geometryInstances as GeometryInstance[];
      const geometry = instances[0].geometry;
      const cachedPositions = geometry.attributes.position.values as Float64Array;
      const positionsBeforeAdmission = new Float64Array(cachedPositions);
      expect(instances[0].id).toMatchObject({ type: 'line', layerId: 'roads', tileId, generationId: build.generationId });
      expect(build.entries.some(([kind]) => kind === 'extrusions')).toBe(false);
      expect(state.queue.hasPendingSurfaces(tileId)).toBe(true);
      expect(state.published.some(result => result.progress.vector === 'complete')).toBe(false);

      // The old implementation has a real, finished line owner here, but
      // leaves it detached until every extrusion and point has been built.
      const publication = state.published.find(result => result.addedVector.includes(lines));
      expect.soft(publication, 'finished lines must publish before extrusion completion').toBeDefined();
      expect.soft(state.vector.getTileCollections(tileId)).toContain(lines);
      expect.soft(root.contains(lines), 'the published line must reach the actual Scene first-update queue').toBe(true);
      scene.pumpFirstUpdates({ mode: SceneMode.SCENE3D, mapProjection: new GeographicProjection(), scene3DOnly: false, context: { elementIndexUint: true, webgl2: true }, passes: { render: true, pick: false }, commandList: [], afterRender: [] } as never, UNBOUNDED_BUDGET);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect.soft(tasks).toHaveBeenCalledOnce();
      expect.soft(received).toHaveLength(1);
      for (const task of received) {
        expect(task.parameters.requests).toHaveLength(1);
        const outputs: ArrayBuffer[] = [];
        const combined = prepareGeometryBatch(task.parameters, outputs);
        expect(combined.results).toHaveLength(1);
        const result = combined.results[0];
        if ('error' in result)
          throw new Error(result.error.message);
        expect('result' in result).toBe(true);
        if ('result' in result)
          expect(result.result.combined).toBeDefined();
      }
      expect(owner.ready).toBe(false);
      expect(cachedPositions.byteLength).toBe(positionsBeforeAdmission.byteLength);
      expect(Array.from(cachedPositions)).toEqual(Array.from(positionsBeforeAdmission));
      expect(build.phase).toBe('extrusions');
      expect(state.queue.hasPendingSurfaces(tileId)).toBe(true);
      if (publication) {
        expect(publication.generationId).toBe(build.generationId);
        expect(publication.retainPreviousGeneration).toBe(true);
        expect(state.vector.tileBuildLayers(tileId)?.complete).toBe(false);
      }
    }
    finally {
      state.queue.clear();
      scene.clearPendingReplacements();
      scene.flushRemovals();
      root.removeAll();
      root.destroy();
      state.close();
      nativeUpdate.mockRestore();
      tasks.mockRestore();
      transfer._canTransferArrayBuffer = previousTransfer;
      limits._maximumTextureSize = previousTextureSize;
    }
  });

  it('cancels unfinished extrusion work without destroying the transferred line owner', async () => {
    const state = vectorFixture();
    await loadTransferredVectors(state);
    try {
      const { build, publication, lines, owner } = advanceToLines(state);
      const lineDestroy = vi.spyOn(owner, 'destroy');
      expect(build.entries).toEqual([]);
      state.queue.drain(minimumBudget(), 1, undefined, true);
      expect(build.phase).toBe('extrusions');
      const stagedExtrusions = build.extrusionBuild!.collection;
      const extrusionDestroy = vi.spyOn(stagedExtrusions, 'destroy');
      state.queue.clear();
      state.queue.clear();
      expect(extrusionDestroy).toHaveBeenCalledOnce();
      expect(lineDestroy).not.toHaveBeenCalled();
      expect(state.vector.getTileCollections(publication.tileId)).toEqual([lines]);
      expect(state.vector.tileBuildLayers(publication.tileId)?.complete).toBe(false);
      expect(state.vector.retireTile(publication.tileId, SceneMode.SCENE3D)).toEqual([lines]);
      expect(state.vector.restoreTile(publication.tileId, SceneMode.SCENE3D)).toBe(false);
      lines.destroy();
      expect(lineDestroy).toHaveBeenCalledOnce();
      lineDestroy.mockRestore();
      extrusionDestroy.mockRestore();
    }
    finally { state.close(); }
  });

  it('keeps the previous generation and picks while early replacement lines and final Native uploads wait', async () => {
    let residency: TileResidency;
    const state = vectorFixture(result => residency.commit(result));
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, vi.fn(), () => false);
    residency = new TileResidency({
      vector: state.vector,
      symbol: state.symbol as unknown as SymbolTileRenderer,
      scene,
      pattern: state.pattern,
      raster: new RasterTileRenderer(),
      publishQueue: state.queue,
      fadeDuration: () => 0,
      paintFrame: () => ({ zoom: state.style.z, styleRevision: state.style.styleRevision }),
    });
    await loadTransferredVectors(state, true, true);
    try {
      const tileId = `source/${state.tile.tileID.key}`;
      const oldIndex = state.tile.latestFeatureIndex = new FeatureIndex(state.tile.tileID);
      state.queue.enqueue('source', state.tile);
      state.queue.drain(UNBOUNDED_BUDGET, 100);
      state.queue.drain(UNBOUNDED_BUDGET, 100);
      const old = state.published.find(result => result.stage === 'complete')!;
      expect(old).toBeDefined();
      const oldOwners = [...state.vector.getTileCollections(tileId)];
      expect(oldOwners).toHaveLength(4);
      expect(oldOwners.every(collection => root.contains(collection) && collection.show)).toBe(true);
      state.published.length = 0;
      const nextIndex = state.tile.latestFeatureIndex = new FeatureIndex(state.tile.tileID);
      const { build, publication, lines } = advanceToLines(state);
      expect(publication.previousVector).toEqual(oldOwners);
      expect(publication.retainPreviousGeneration).toBe(true);
      expect(scene.hasPendingReplacement(tileId)).toBe(true);
      expect(lines.show).toBe(false);
      expect(oldOwners.every(collection => root.contains(collection) && collection.show)).toBe(true);
      expect(residency.featureIndex(tileId, old.generationId)).toBe(oldIndex);
      expect(residency.featureIndex(tileId, build.generationId)).toBe(nextIndex);
      state.queue.drain(UNBOUNDED_BUDGET, 100);
      expect(state.published.filter(result => result.stage === 'complete')).toHaveLength(1);
      expect(scene.hasPendingReplacement(tileId)).toBe(true);
      expect(oldOwners.every(collection => root.contains(collection) && collection.show)).toBe(true);
      expect(state.vector.getTileCollections(tileId).every(collection => !collection.show)).toBe(true);
      expect(residency.featureIndex(tileId, old.generationId)).toBe(oldIndex);
      expect(residency.featureIndex(tileId, build.generationId)).toBe(nextIndex);
    }
    finally {
      scene.clearPendingReplacements();
      scene.flushRemovals();
      root.removeAll();
      root.destroy();
      state.close();
    }
  });
});

describe('visibility changes during tile publication', () => {
  it('publishes real Native symbols while real vector conversion is still incomplete', () => {
    const state = fixture();
    const renderer = nativeSymbols(state);
    const advance = state.vector.advanceTileBuild.bind(state.vector);
    vi.spyOn(state.vector, 'advanceTileBuild').mockImplementation(build => advance(build, { exhausted: true }));
    try {
      state.queue.enqueue('source', state.tile);
      state.queue.drain(budget, 100);
      const early = state.published.find(result => result.stage === 'symbol');
      expect(early, 'prepared symbols must not wait for vector conversion').toBeDefined();
      expect(early!.firstUpdateSymbols).toHaveLength(1);
      expect(early!.firstUpdateSymbols[0].get(0)).toBeInstanceOf(Primitive);
      expect(state.published.some(result => result.stage === 'complete')).toBe(false);
      expect(state.queue.hasPendingSurfaces(`source/${state.tile.tileID.key}`)).toBe(true);
      const material = early!.firstUpdateSymbols[0].get(0).appearance.material;
      const destroy = vi.spyOn(material, 'destroy');
      state.queue.clear();
      state.queue.clear();
      expect(state.symbol.releaseBuild, 'committed ownership belongs to the renderer').not.toHaveBeenCalled();
      expect(renderer.getTileCollections(`source/${state.tile.tileID.key}`)).toEqual(early!.addedSymbols);
      expect(destroy).not.toHaveBeenCalled();
      renderer.removeTile(`source/${state.tile.tileID.key}`);
      expect(destroy).toHaveBeenCalledOnce();
      renderer.removeAll();
      expect(destroy).toHaveBeenCalledOnce();
    }
    finally {
      const collections = state.published.flatMap(result => result.addedSymbols);
      renderer.removeAll();
      for (const collection of collections)
        collection.destroy();
      state.close();
    }
  });

  it('restarts only the symbol plan after early commit when a minzoom layer becomes visible', () => {
    const state = fixture();
    const renderer = nativeSymbols(state);
    const advance = state.vector.advanceTileBuild.bind(state.vector);
    const prepare = vi.spyOn(state.vector, 'advanceTileBuild').mockImplementation(build => advance(build, { exhausted: true }));
    try {
      state.queue.enqueue('source', state.tile);
      state.queue.drain(budget, 100);
      const vectorBuild = prepare.mock.calls[0][0];
      const generation = state.published[0].generationId;
      state.style.z = 2;
      state.queue.ensureVisibleLayers('source', state.tile, new Set(['detail']));
      state.queue.drain(budget, 100);
      expect(state.beginVector).toHaveBeenCalledOnce();
      expect(prepare.mock.calls.every(([build]) => build === vectorBuild)).toBe(true);
      expect(state.symbol.beginBuild).toHaveBeenCalledTimes(2);
      expect(state.symbol.releaseBuild).not.toHaveBeenCalled();
      expect(state.published.every(result => result.generationId === generation)).toBe(true);
      expect(state.published.filter(result => result.stage === 'symbol')).toHaveLength(2);
    }
    finally {
      renderer.removeAll();
      for (const collection of new Set(state.published.flatMap(result => result.addedSymbols)))
        collection.destroy();
      state.close();
    }
  });
});
