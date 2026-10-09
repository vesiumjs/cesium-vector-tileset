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
import { buildModuleUrl, Color, Event, GeographicProjection, PointPrimitiveCollection, Primitive, PrimitiveCollection, SceneMode, TaskProcessor } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageAtlas } from '../../../assets/image-atlas';
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
import { RGBAImage } from '../../../util/image';
import { createTileTransferRegistry } from '../../../worker/tile-transfer';
import { prepareGeometryBatch } from '../../geometry/geometry-preparation';
import { GeometryPrimitive } from '../../geometry/geometry-primitive';
import { isPatternStyleLayer } from '../../pattern/pattern-layer';
import { destroyPatternResources, PatternTileRenderer } from '../../pattern/pattern-renderer';
import { RasterTileRenderer } from '../../raster/raster-renderer';
import { beginSymbolBuild, buildSymbolHalves, SymbolTileRenderer } from '../../symbol/symbol-renderer';
import { projectWorkerBuckets } from '../../vector/bucket-geometry';
import { VectorTileRenderer } from '../../vector/vector-tile-renderer';
import { linePaintForOwner } from '../draw-batch';
import { UNBOUNDED_BUDGET } from '../frame-budget';
import { SceneCollections } from '../scene-collections';
import { acquireSceneFrameBudget } from '../scene-frame-budget';
import { TilePublishQueue } from '../tile-publish-queue';
import { TileResidency } from '../tile-residency';
import { viewPriority } from '../view-priority';
import { cityOrbitFrame } from './view-priority-helper';

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
    _getLayerOrder: () => [...layers.keys()],
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

  it.each([SceneMode.SCENE3D, SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW])('keeps early line identity and generation when real extrusion and points append (mode %s)', async (mode) => {
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, vi.fn(), () => false);
    const state = vectorFixture(result => scene.applyPublication(result));
    state.inputs.mode = mode;
    await loadTransferredVectors(state, true, true);
    try {
      const { build, publication, lines, owner } = advanceToLines(state);
      const tileId = publication.tileId;
      expect(state.published.map(result => result.stage)).toEqual(['surface', 'lines']);
      expect(publication.progress).toEqual({ vector: 'surface', pattern: false, symbol: true });
      expect(publication.previousVector).toEqual([]);
      expect(publication.retiredVector).toEqual([]);
      expect(root.contains(lines)).toBe(true);
      expect(state.vector.tileBuildLayers(tileId)?.complete).toBe(false);
      expect(build.result).toBeDefined();
      const standard = build.standard;
      if (mode !== SceneMode.SCENE3D) {
        expect(standard?.polygons).toHaveLength(1);
        expect(standard?.points).toEqual([]);
      }
      const destroy = vi.spyOn(owner, 'destroy');
      state.queue.drain(UNBOUNDED_BUDGET, 100);
      expect(build.phase).toBe('done');
      expect(state.queue.has(tileId)).toBe(false);
      expect(state.published.filter(result => result.stage === 'complete')).toHaveLength(1);
      expect(new Set(state.published.map(result => result.generationId))).toEqual(new Set([build.generationId]));
      const final = state.published.at(-1)!;
      expect(final.progress).toEqual({ vector: 'complete', pattern: true, symbol: true });
      expect(final.addedVector).not.toContain(lines);
      expect(state.vector.getTileCollections(tileId)).toContain(lines);
      expect(lines.get(0)).toBe(owner);
      expect(destroy).not.toHaveBeenCalled();
      expect(final.addedVector).toHaveLength(2);
      expect(final.addedVector.every(collection => root.contains(collection))).toBe(true);
      expect(state.vector.tileBuildLayers(tileId)?.complete).toBe(true);
      const extrusions = final.addedVector.find(collection => collection instanceof PrimitiveCollection) as PrimitiveCollection;
      expect(extrusions.length).toBe(1);
      const instances = extrusions.get(0).geometryInstances as GeometryInstance[];
      expect(instances).toHaveLength(64);
      expect(instances.every(instance => instance.id.generationId === build.generationId)).toBe(true);
      if (mode !== SceneMode.SCENE3D) {
        expect(standard?.points).toHaveLength(1);
        const pointGroup = final.addedVector.find(collection => collection instanceof PrimitiveCollection
          && collection.get(0) instanceof PointPrimitiveCollection) as PrimitiveCollection;
        expect(pointGroup).toBeInstanceOf(PrimitiveCollection);
        const points = pointGroup.get(0) as PointPrimitiveCollection;
        expect(points).toBeInstanceOf(PointPrimitiveCollection);
        expect(points.length).toBe(1);
        expect(points.get(0)).toBe(standard!.points[0]);
      }
      expect(build.result).toBeUndefined();
      expect(build.standard).toBeUndefined();
      destroy.mockRestore();
    }
    finally {
      scene.clearPendingReplacements();
      scene.flushRemovals();
      root.removeAll();
      root.destroy();
      state.close();
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

  it('refreshes actual early line paint before final append and keeps it afterwards', async () => {
    const state = vectorFixture();
    await loadTransferredVectors(state, true, true);
    try {
      const { build, publication, lines, owner } = advanceToLines(state);
      const uniforms = linePaintForOwner(owner)!;
      expect(uniforms.widthUniform()).toBe(4);
      const layer = state.layers.get('roads')!;
      layer.setPaintProperty('line-width', 18);
      layer.setPaintProperty('line-color', '#654321');
      layer.updateTransitions({ now: 100, transition: { duration: 0 } });
      layer.recalculate(new EvaluationParameters(0, { now: 100 }), []);
      const paint = state.vector.refreshCollectionPaint(lines, { zoom: 0, styleRevision: 1, budget: UNBOUNDED_BUDGET });
      expect(paint.ready).toBe(true);
      expect(paint.replacements).toEqual([]);
      expect(uniforms.widthUniform()).toBe(18);
      expect(uniforms.colorUniform().red).toBeCloseTo(0x65 / 255);
      expect(uniforms.colorUniform().green).toBeCloseTo(0x43 / 255);
      expect(uniforms.colorUniform().blue).toBeCloseTo(0x21 / 255);
      state.queue.drain(UNBOUNDED_BUDGET, 100);
      expect(build.phase).toBe('done');
      expect(state.vector.getTileCollections(publication.tileId)).toContain(lines);
      expect(lines.get(0)).toBe(owner);
      expect(state.vector.refreshCollectionPaint(lines, { zoom: 0, styleRevision: 1, budget: UNBOUNDED_BUDGET }).replacements).toEqual([]);
      expect(uniforms.widthUniform()).toBe(18);
      expect(uniforms.colorUniform().red).toBeCloseTo(0x65 / 255);
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

  it('advances stable detached lines without beginning an unbegun sibling', async () => {
    const state = vectorFixture();
    const control = vectorFixture();
    try {
      await Promise.all([loadTransferredVectors(state), loadTransferredVectors(control)]);
      const beginDetails = (current: typeof state) => {
        const build = beginPendingVector(current);
        for (let turn = 0; turn < 1024 && build.phase !== 'details'; turn++)
          current.queue.advanceBuilds(minimumBudget());
        expect(build.phase).toBe('details');
        expect(current.queue.inspectBuilds()).toEqual({ runnable: true, renderNeeded: false });
        expect(current.published).toEqual([]);
        return build;
      };
      const build = beginDetails(state);
      const controlBuild = beginDetails(control);
      // A real transferred line becomes a detached Native owner with this
      // allowance when the queue contains only the stable job.
      expect(control.queue.advanceBuilds(UNBOUNDED_BUDGET)).toEqual({ steps: 1, ready: 1, renderNeeded: true });
      expect(controlBuild.phase).toBe('extrusions');
      const controlLines = controlBuild.entries.find(([kind]) => kind === 'lines')![1] as PrimitiveCollection;
      expect(controlLines).toBeInstanceOf(PrimitiveCollection);
      expect(controlLines.get(0)).toBeInstanceOf(GeometryPrimitive);
      expect(control.published).toEqual([]);

      const sibling = new Tile(new OverscaledTileID(1, 0, 1, 1, 0), 512);
      sibling.state = 'loaded';
      const buckets = state.tile.buckets;
      const style = { ...state.style };
      state.queue.enqueue('source', sibling);
      const beginSymbolCalls = state.symbol.beginBuild.mock.calls.length;
      const stepSymbolCalls = state.symbol.stepBuild.mock.calls.length;

      // The sibling still needs render admission. It must not remove the
      // existing job's independent, already validated CPU admission.
      expect.soft(state.queue.inspectBuilds()).toEqual({ runnable: true, renderNeeded: true });
      // Independent admission does not grant a second or unbounded quota.
      expect(state.queue.advanceBuilds({ exhausted: true })).toEqual({ steps: 0, ready: 0, renderNeeded: true });
      expect(build.phase).toBe('details');
      expect(state.symbol.beginBuild).toHaveBeenCalledTimes(beginSymbolCalls);
      expect.soft(state.queue.advanceBuilds(UNBOUNDED_BUDGET)).toEqual({ steps: 1, ready: 1, renderNeeded: true });
      expect.soft(build.phase).toBe('extrusions');
      expect.soft(build.entries.find(([kind]) => kind === 'lines')?.[1]).toBeInstanceOf(PrimitiveCollection);
      expect(state.beginVector).toHaveBeenCalledOnce();
      expect(state.symbol.beginBuild).toHaveBeenCalledTimes(beginSymbolCalls);
      expect(state.symbol.stepBuild).toHaveBeenCalledTimes(stepSymbolCalls);
      expect(state.style).toEqual(style);
      expect(state.tile.buckets).toBe(buckets);
      expect(state.queue.size).toBe(2);
      expect(state.published).toEqual([]);
      expect(state.vector.getTileCollections(build.tileId)).toEqual([]);
      expect(state.vector.getTileCollections(`source/${sibling.tileID.key}`)).toEqual([]);
    }
    finally {
      state.close();
      control.close();
    }
  });

  it('stops real idle construction at detached lines and publishes only on render', async () => {
    const state = vectorFixture();
    await loadTransferredVectors(state);
    try {
      const build = beginPendingVector(state);
      let last = { steps: 0, ready: 0, renderNeeded: false };
      for (let turn = 0; turn < 1024 && build.phase !== 'extrusions'; turn++)
        last = state.queue.advanceBuilds(minimumBudget());
      expect(build.phase).toBe('extrusions');
      expect(last).toEqual({ steps: 1, ready: 1, renderNeeded: true });
      const lines = build.entries.find(([kind]) => kind === 'lines')![1];
      expect(lines).toBeInstanceOf(PrimitiveCollection);
      expect(state.published).toEqual([]);
      expect(state.vector.getTileCollections(build.tileId)).toEqual([]);
      expect(state.queue.inspectBuilds()).toEqual({ runnable: false, renderNeeded: true });
      expect(state.queue.advanceBuilds(UNBOUNDED_BUDGET)).toEqual({ steps: 0, ready: 0, renderNeeded: true });
      expect(build.extrusionBuild).toBeUndefined();
      state.queue.drain(minimumBudget(), 1, undefined, true);
      expect(state.published).toHaveLength(1);
      expect(state.published[0].stage).toBe('lines');
      expect(state.published[0].addedVector).toContain(lines);
      expect(build.entries).toEqual([]);
      expect(build.result).toBeDefined();
      expect(state.queue.inspectBuilds()).toEqual({ runnable: true, renderNeeded: false });
    }
    finally { state.close(); }
  });

  it('advances real CPU work without changing published owners or picks, then commits once on render', () => {
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
    try {
      state.tile.latestFeatureIndex = new FeatureIndex(state.tile.tileID);
      state.queue.enqueue('source', state.tile);
      state.queue.drain(budget, 100);
      const oldPublication = state.published.at(-1)!;
      const tileId = oldPublication.tileId;
      const owners = state.vector.getTileCollections(tileId);
      const owner = owners[0];
      if (!root.contains(owner))
        root.add(owner);
      const oldIndex = state.tile.latestFeatureIndex;
      const nextIndex = state.tile.latestFeatureIndex = new FeatureIndex(state.tile.tileID);
      const build = beginPendingVector(state);
      const phase = build.phase;
      const publications = [...state.published];
      const publishedOwners = state.vector.getTileCollections(tileId);
      const oldPick = residency.featureIndex(tileId, oldPublication.generationId);
      const nextPick = residency.featureIndex(tileId, build.generationId);
      const ownerShown = owner.show;
      expect(publishedOwners).toEqual(owners);
      expect(oldPick).toBe(oldIndex);
      expect(nextPick).toBeUndefined();
      const expectPublishedUnchanged = () => {
        expect(state.vector.getTileCollections(tileId)).toEqual(publishedOwners);
        expect(root.contains(owner)).toBe(true);
        expect(owner.show).toBe(ownerShown);
        expect(residency.featureIndex(tileId, oldPublication.generationId)).toBe(oldPick);
        expect(residency.featureIndex(tileId, build.generationId)).toBe(nextPick);
        expect(state.published).toEqual(publications);
      };
      expect(state.queue.inspectBuilds()).toEqual({ runnable: true, renderNeeded: false });
      expect(state.requestRender).not.toHaveBeenCalled();
      const prepared = state.queue.advanceBuilds(budget);
      expect(prepared.steps).toBe(1);
      expect(build.phase).not.toBe(phase);
      expectPublishedUnchanged();
      for (let tick = 0; tick < 10 && !state.queue.inspectBuilds().renderNeeded; tick++)
        state.queue.advanceBuilds(budget);
      expect(state.queue.inspectBuilds()).toEqual({ runnable: false, renderNeeded: true });
      expectPublishedUnchanged();
      expect(state.requestRender).toHaveBeenCalledOnce();
      expect(state.queue.advanceBuilds(budget)).toEqual({ steps: 0, ready: 0, renderNeeded: true });
      expectPublishedUnchanged();
      state.queue.drain(budget, 100);
      state.queue.drain(budget, 100);
      expect(state.published.slice(0, publications.length)).toEqual(publications);
      const committed = state.published.slice(publications.length);
      expect(committed).toHaveLength(1);
      expect(committed[0].stage).toBe('complete');
      expect(residency.featureIndex(tileId, build.generationId)).toBe(nextIndex);
      expect(state.vector.getTileCollections(tileId)[0]).not.toBe(owner);
    }
    finally {
      state.queue.clear();
      scene.clearPendingReplacements();
      scene.flushRemovals();
      root.removeAll();
      root.destroy();
      state.close();
    }
  });

  it('stops at the first real surface boundary before publishing it', () => {
    const state = vectorFixture();
    try {
      const build = beginPendingVector(state);
      const result = state.queue.advanceBuilds(budget);
      expect(result).toEqual({ steps: 1, ready: 1, renderNeeded: true });
      expect(build.phase).toBe('details');
      expect(build.entries.length).toBeGreaterThan(0);
      expect(state.vector.getTileCollections(`source/${state.tile.tileID.key}`)).toEqual([]);
      expect(state.published).toEqual([]);
      expect(state.queue.advanceBuilds(budget).steps).toBe(0);
      state.queue.drain(budget, 1);
      expect(state.published).toHaveLength(1);
      expect(state.published[0].stage).toBe('surface');
    }
    finally { state.close(); }
  });

  it('keeps real-render continuation without an enabled idle host', () => {
    const state = vectorFixture();
    try {
      state.queue.idlePreparationsEnabled = false;
      beginPendingVector(state);
      expect(state.requestRender).not.toHaveBeenCalled();
      state.queue.drain({ exhausted: true }, 4);
      expect(state.requestRender).toHaveBeenCalledOnce();
      expect(state.queue.inspectBuilds()).toEqual({ runnable: false, renderNeeded: true });
      expect(state.queue.advanceBuilds(budget)).toEqual({ steps: 0, ready: 0, renderNeeded: true });
    }
    finally { state.close(); }
  });

  for (const change of ['payload', 'style', 'render', 'zoom', 'paint', 'light', 'dpr', 'order', 'mode', 'transition', 'dirty', 'unknown'] as const) {
    it(`wakes render for ${change} changes without idle cancellation or restart`, () => {
      const state = vectorFixture();
      try {
        const build = beginPendingVector(state);
        const phase = build.phase;
        const discard = vi.spyOn(state.vector, 'discardTileBuild');
        const advance = vi.spyOn(state.vector, 'advanceTileBuild');
        if (change === 'payload')
          state.tile.buckets = { ...state.tile.buckets };
        if (change === 'style')
          state.style.styleRevision++;
        if (change === 'render')
          state.style.renderRevision++;
        if (change === 'zoom')
          state.style.z++;
        if (change === 'paint')
          state.layers.get('land')!.paintRevision++;
        if (change === 'light')
          state.inputs.lightRevision++;
        if (change === 'dpr')
          state.vector.pixelRatio = 2;
        if (change === 'order')
          state.inputs.layerOrder = new Map(state.inputs.layerOrder);
        if (change === 'mode')
          state.inputs.mode = SceneMode.SCENE2D;
        if (change === 'transition')
          state.style.getRenderTransitionFlags.mockReturnValue({ any: true });
        if (change === 'dirty')
          state.style._changed = true;
        if (change === 'unknown')
          state.vector.pixelRatio = Number.NaN;
        expect(state.queue.inspectBuilds()).toEqual({ runnable: false, renderNeeded: true });
        expect(state.queue.advanceBuilds(budget)).toEqual({ steps: 0, ready: 0, renderNeeded: true });
        expect(state.requestRender).toHaveBeenCalledOnce();
        expect(advance).not.toHaveBeenCalled();
        expect(discard).not.toHaveBeenCalled();
        expect(state.beginVector).toHaveBeenCalledOnce();
        expect(build.phase).toBe(phase);
        expect(state.queue.size).toBe(1);
        expect(state.published).toEqual([]);
      }
      finally { state.close(); }
    });
  }

  it('keeps symbols and pending pattern refreshes on real render ticks', () => {
    const state = fixture();
    state.queue.idlePreparationsEnabled = true;
    try {
      beginPendingVector(state);
      const symbolCalls = state.symbol.stepBuild.mock.calls.length;
      expect(state.queue.inspectBuilds().renderNeeded).toBe(true);
      expect(state.queue.advanceBuilds(budget).steps).toBe(0);
      expect(state.symbol.stepBuild).toHaveBeenCalledTimes(symbolCalls);
      state.queue.clear();
      const refresh = { styleMutationRevision: 0, buckets: state.tile.buckets, entries: [], staged: [] };
      vi.spyOn(state.pattern, 'beginPatternBuild').mockReturnValue({ status: 'resumable', state: refresh } as never);
      const step = vi.spyOn(state.pattern, 'stepPatternBuild').mockReturnValue(false);
      state.queue.refreshPattern('source', state.tile, [], false, { exhausted: true });
      expect(state.queue.inspectBuilds()).toEqual({ runnable: false, renderNeeded: true });
      expect(state.queue.advanceBuilds(budget).steps).toBe(0);
      expect(step).not.toHaveBeenCalled();
    }
    finally { state.close(); }
  });

  it('shares one minimum admission across idle CPU preparation and render publication', () => {
    const state = vectorFixture();
    try {
      beginPendingVector(state);
      const next = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
      next.state = 'loaded';
      next.buckets = state.tile.buckets;
      state.queue.enqueue('source', next);
      state.queue.drain(minimumBudget(), 1, undefined, true);
      const advance = vi.spyOn(state.vector, 'advanceTileBuild');
      const shared = minimumBudget();
      expect(state.queue.advanceBuilds(shared).steps).toBe(1);
      state.queue.drain(shared, 4, undefined, true);
      expect(advance).toHaveBeenCalledOnce();
      expect(state.published).toEqual([]);
      expect(state.queue.size).toBe(2);
    }
    finally { state.close(); }
  });
});

describe('visibility changes during tile publication', () => {
  for (const hidden of [false, true]) {
    it(`does not spend a publication slot on ${hidden ? 'zoom-hidden' : 'absent'} symbols when the symbol track has the first turn`, () => {
      const state = fixture();
      try {
        for (const id of ['labels', 'detail']) {
          if (hidden)
            state.layers.get(id)!.minzoom = 3;
          else
            state.layers.delete(id);
        }
        state.queue.enqueue('source', state.tile);
        state.queue.drain(budget, 100);
        const next = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
        next.state = 'loaded';
        next.buckets = state.tile.buckets;
        state.queue.enqueue('source', next);
        state.queue.drain(budget, 1);
        const results = state.published.filter(result => result.tileID === next.tileID);
        expect(results).toHaveLength(1);
        expect(results[0].addedVector).toHaveLength(1);
        expect(results[0].stage).not.toBe('symbol');
      }
      finally { state.close(); }
    });
  }
  it('accepts only reserved generation identities and keeps the allocator ahead of resumed work', () => {
    const state = fixture();
    const input = { tileId: `source/${state.tile.tileID.key}`, tileID: state.tile.tileID, buckets: state.tile.buckets, styleZoom: 0, mode: SceneMode.SCENE3D, styleRevision: 0 };
    try {
      const original = state.vector.beginTileBuild(input);
      const resumed = state.vector.beginTileBuild({ ...input, generationId: original.generationId });
      expect(resumed.generationId).toBe(original.generationId);
      expect(() => state.vector.beginTileBuild({ ...input, generationId: 1000000 })).toThrow();
      expect(() => state.vector.beginTileBuild({ ...input, generationId: original.generationId, buckets: { ...input.buckets } })).toThrow();
      expect(() => state.vector.beginTileBuild({ ...input, generationId: original.generationId, styleRevision: 1 })).toThrow();
      expect(() => state.vector.beginTileBuild({ ...input, generationId: original.generationId, tileId: 'other/tile' })).toThrow();
      const next = state.vector.beginTileBuild(input);
      expect(next.generationId).toBe(original.generationId + 1);
    }
    finally { state.close(); }
  });
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

  it('publishes Native symbols before a resumable pattern finishes and completes the generation once', () => {
    const state = fixture();
    const renderer = nativeSymbols(state);
    state.style.z = 2;
    const ImageDataClass = globalThis.ImageData;
    vi.stubGlobal('ImageData', class extends ImageDataClass {
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        super(width, height);
        this.data.set(data);
      }
    });
    const hatch = state.layers.get('hatch') as FillStyleLayer;
    hatch.recalculate(new EvaluationParameters(2), []);
    state.tile.imageAtlas = new ImageAtlas({}, { hatch: { data: new RGBAImage({ width: 1, height: 1 }), pixelRatio: 1, sdf: false, version: 0 } });
    const bucket = state.tile.buckets.hatch as FillBucket;
    for (let index = 1; index < 64; index++)
      bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], index, state.tile.tileID, {});
    vi.mocked(state.pattern.beginPatternBuild).mockRestore();
    state.pattern.setLayers([hatch], new Map([['hatch', 0]]));
    const step = state.pattern.stepPatternBuild.bind(state.pattern);
    const pendingPattern = vi.spyOn(state.pattern, 'stepPatternBuild').mockImplementation(build => step(build, { exhausted: true }));
    try {
      state.queue.enqueue('source', state.tile);
      state.queue.drain(budget, 100);
      const early = state.published.find(result => result.stage === 'symbol');
      expect(early).toBeDefined();
      expect(early!.progress.vector).toBe('complete');
      expect(early!.progress.pattern).toBe(false);
      expect(state.published.some(result => result.stage === 'complete')).toBe(false);
      pendingPattern.mockRestore();
      state.queue.drain(budget, 100);
      const complete = state.published.filter(result => result.stage === 'complete');
      expect(complete).toHaveLength(1);
      expect(complete[0].progress).toEqual({ vector: 'complete', pattern: true, symbol: true });
      expect(new Set(state.published.map(result => result.generationId)).size).toBe(1);
      expect(state.symbol.commitBuild).toHaveBeenCalledOnce();
    }
    finally {
      renderer.removeAll().forEach(collection => collection.destroy());
      state.close();
      destroyPatternResources(state.pattern.clear());
    }
  });

  it('alternates the normal shared deadline between incomplete vector and Native symbol work', () => {
    const state = fixture();
    const renderer = nativeSymbols(state);
    let spent = false;
    const quota = {
      get exhausted() {
        return spent;
      },
    };
    const advance = state.vector.advanceTileBuild.bind(state.vector);
    const prepare = vi.spyOn(state.vector, 'advanceTileBuild').mockImplementation((build) => {
      spent = true;
      return advance(build, quota);
    });
    const symbols = state.symbol.stepBuild.getMockImplementation()!;
    state.symbol.stepBuild.mockImplementation((build, budget) => {
      spent = true;
      return symbols(build, budget);
    });
    try {
      state.queue.enqueue('source', state.tile);
      state.queue.drain(quota, 100);
      expect(prepare).toHaveBeenCalledOnce();
      expect(state.symbol.stepBuild).not.toHaveBeenCalled();
      spent = false;
      state.queue.drain(quota, 100);
      expect(prepare).toHaveBeenCalledOnce();
      expect(state.symbol.stepBuild).toHaveBeenCalledOnce();
      expect(state.published.some(result => result.stage === 'symbol')).toBe(true);
    }
    finally {
      renderer.removeAll().forEach(collection => collection.destroy());
      state.close();
    }
  });

  it('consumes one overload token for one track and resumes the other track with the next admission', () => {
    const state = fixture();
    const prepare = vi.spyOn(state.vector, 'advanceTileBuild');
    try {
      state.queue.enqueue('source', state.tile);
      const quota = minimumBudget();
      state.queue.drain(quota, 100, undefined, true);
      expect(prepare).toHaveBeenCalledOnce();
      expect(state.symbol.stepBuild).not.toHaveBeenCalled();
      state.queue.drain(quota, 100, undefined, true);
      expect(prepare).toHaveBeenCalledOnce();
      expect(state.symbol.stepBuild).not.toHaveBeenCalled();
      state.queue.drain(minimumBudget(), 100, undefined, true);
      expect(prepare).toHaveBeenCalledOnce();
      expect(state.symbol.stepBuild).toHaveBeenCalledOnce();
    }
    finally { state.close(); }
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

  it('releases each uncommitted symbol build once when its job is cancelled', () => {
    const state = fixture();
    try {
      state.queue.enqueue('source', state.tile);
      state.queue.drain(budget, 100);
      expect(state.symbol.beginBuild).toHaveBeenCalledOnce();
      state.queue.clear();
      state.queue.clear();
      expect(state.symbol.releaseBuild).toHaveBeenCalledOnce();
      expect(state.symbol.commitBuild).not.toHaveBeenCalled();
    }
    finally { state.close(); }
  });

  for (const change of ['none', 'buckets', 'schema'] as const) {
    it(`restores early symbol publication with ${change === 'none' ? 'the same payload' : `changed ${change}`}`, () => {
      let residency: TileResidency;
      const state = fixture(result => residency.commit(result));
      const renderer = nativeSymbols(state);
      const root = new PrimitiveCollection({ destroyPrimitives: false });
      const scene = new SceneCollections(root, vi.fn(), id => renderer.isTilePlacementActive(id));
      residency = new TileResidency({
        vector: state.vector,
        symbol: renderer,
        scene,
        pattern: state.pattern,
        raster: new RasterTileRenderer(),
        publishQueue: state.queue,
        fadeDuration: () => 0,
        paintFrame: () => ({ zoom: state.style.z, styleRevision: state.style.styleRevision }),
      });
      state.tile.latestFeatureIndex = new FeatureIndex(state.tile.tileID);
      const pyramid = { getTileByID: (key: string) => key === state.tile.tileID.key ? state.tile : undefined, loaded: () => true };
      const advance = state.vector.advanceTileBuild.bind(state.vector);
      const prepare = vi.spyOn(state.vector, 'advanceTileBuild').mockImplementation(build => advance(build, { exhausted: true }));
      try {
        state.queue.enqueue('source', state.tile);
        residency.syncSource('source', pyramid, [state.tile.tileID.key], SceneMode.SCENE3D);
        state.queue.drain(budget, 100);
        const early = state.published.find(result => result.stage === 'symbol')!;
        const collection = early.addedSymbols[0];
        expect(early).toBeDefined();
        expect(residency.featureIndex(early.tileId, early.generationId)).toBe(state.tile.latestFeatureIndex);
        state.queue.clear();
        residency.syncSource('source', pyramid, [], SceneMode.SCENE3D);
        residency.syncHeldTileVisibility();
        scene.pumpFirstUpdates({ commandList: [], camera: {} } as never, budget);
        expect(renderer.getTileCollections(early.tileId)).toHaveLength(0);
        if (change === 'buckets') {
          state.tile.buckets = { ...state.tile.buckets };
          state.tile.latestFeatureIndex = new FeatureIndex(state.tile.tileID);
        }
        if (change === 'schema')
          state.style.styleRevision++;
        residency.syncSource('source', pyramid, [state.tile.tileID.key], SceneMode.SCENE3D);
        if (change === 'none') {
          expect(renderer.getTileCollections(early.tileId)).toEqual([collection]);
          expect(scene.hasPendingFirstUpdate(collection)).toBe(true);
        }
        prepare.mockRestore();
        state.queue.drain(budget, 100);
        expect(state.queue.size).toBe(0);
        expect(state.symbol.beginBuild).toHaveBeenCalledTimes(change === 'none' ? 1 : 2);
        const generations = new Set(state.published.map(result => result.generationId));
        expect(generations.size).toBe(change === 'none' ? 1 : 2);
        expect(state.published.filter(result => result.stage === 'complete')).toHaveLength(1);
        const complete = state.published.find(result => result.stage === 'complete')!;
        expect(residency.featureIndex(early.tileId, complete.generationId)).toBe(state.tile.latestFeatureIndex);
      }
      finally {
        state.queue.clear();
        scene.clearPendingReplacements();
        scene.flushRemovals();
        renderer.removeAll().forEach((collection) => {
          if (!collection.isDestroyed())
            collection.destroy();
        });
        root.removeAll();
        root.destroy();
        state.close();
      }
    });
  }

  it('publishes the current oblique view center before its lower edge with real fill geometry', () => {
    const frame = cityOrbitFrame();
    function firstPublished(position: ReturnType<typeof viewPriority>) {
      const state = fixture();
      try {
        for (const layer of ['labels', 'detail', 'hatch'])
          state.layers.delete(layer);
        for (const y of [2725, 2724]) {
          const tile = new Tile(new OverscaledTileID(13, 0, 13, 4093, y), 512);
          tile.state = 'loaded';
          tile.buckets.land = state.tile.buckets.land;
          state.queue.enqueue('source', tile);
        }
        state.queue.drain(budget, 1, position);
        expect(state.published).toHaveLength(1);
        return state.published[0].tileID.canonical.y;
      }
      finally {
        state.close();
      }
    }
    expect(firstPublished(frame.camera.positionCartographic)).toBe(2724);
    expect(firstPublished(viewPriority(frame))).toBe(2725);
  });

  it('publishes real cold fill geometry through minimum admission after the shared deadline is spent', () => {
    const state = fixture();
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const lease = acquireSceneFrameBudget(scene, state.queue);
    const stages = { upload: false, build: true, paint: false, placement: false };
    try {
      state.layers.delete('labels');
      state.layers.delete('detail');
      state.layers.delete('hatch');
      state.queue.enqueue('source', state.tile);
      scene.preUpdate.raiseEvent();
      const work = lease.frame(1);
      now = 50;
      expect(state.queue.drain(work.tileBudget, 4)).toBe(0);
      expect(state.beginVector).not.toHaveBeenCalled();
      for (let frame = 2; frame < 6 && state.queue.size > 0; frame++) {
        now = frame * 100;
        scene.preUpdate.raiseEvent();
        const work = lease.frame(frame);
        now += 50;
        const minimum = work.continuation('build', stages)!;
        work.measure(() => state.queue.drain(minimum, 4, undefined, true));
        scene.postRender.raiseEvent();
      }
      expect(state.queue.size).toBe(0);
      expect(state.beginVector).toHaveBeenCalledOnce();
      expect(state.vector.getTileCollections(`source/${state.tile.tileID.key}`)).toHaveLength(1);
      expect(state.published.some(result => result.stage === 'complete')).toBe(true);
    }
    finally {
      lease.release();
      clock.mockRestore();
      state.close();
    }
  });

  it('uses the admitted Scene quota across real cold tile phases and owners', () => {
    const state = fixture();
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const lease = acquireSceneFrameBudget(scene, state.queue);
    const advance = state.vector.advanceTileBuild.bind(state.vector);
    vi.spyOn(state.vector, 'advanceTileBuild').mockImplementation((build, quota) => {
      now += 0.2;
      return advance(build, quota);
    });
    try {
      for (const layer of ['labels', 'detail', 'hatch'])
        state.layers.delete(layer);
      state.queue.enqueue('source', state.tile);
      const next = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
      next.state = 'loaded';
      next.buckets = state.tile.buckets;
      state.queue.enqueue('source', next);
      scene.preUpdate.raiseEvent();
      const work = lease.frame(1);
      now = 50;
      const quota = work.continuation('build', { upload: false, build: true, paint: false, placement: false })!;
      work.measure(() => state.queue.drain(quota, 4, undefined, true));
      expect(state.queue.size).toBe(0);
      expect(state.published.filter(result => result.stage === 'complete')).toHaveLength(2);
      expect(state.beginVector).toHaveBeenCalledTimes(2);
      expect(work.continuation('build', { upload: false, build: true, paint: false, placement: false })).toBeUndefined();
    }
    finally {
      lease.release();
      clock.mockRestore();
      state.close();
    }
  });

  it('admits one pending pattern refresh even when its minimum allowance is already spent', () => {
    const state = fixture();
    const spent = minimumBudget();
    try {
      const refresh = { styleMutationRevision: 0, buckets: state.tile.buckets, entries: [], staged: [] };
      vi.spyOn(state.pattern, 'beginPatternBuild').mockReturnValue({ status: 'resumable', state: refresh } as never);
      const step = vi.spyOn(state.pattern, 'stepPatternBuild').mockReturnValue(true);
      vi.spyOn(state.pattern, 'commitPatternBuild').mockReturnValue({ removed: [], added: [], removedMaterials: [] });
      state.queue.refreshPattern('source', state.tile, [], false, spent);
      expect(state.queue.size).toBe(1);
      state.queue.drain(spent, 4);
      expect(step).not.toHaveBeenCalled();
      state.queue.drain(spent, 4, undefined, true);
      expect(step).toHaveBeenCalledOnce();
      expect(state.queue.size).toBe(0);
    }
    finally { state.close(); }
  });

  it('gives a symbol-stage job an admission turn while another tile is still preparing surfaces', () => {
    const state = fixture();
    try {
      state.queue.enqueue('source', state.tile);
      state.queue.drain(budget, 4);
      expect(state.symbol.stepBuild).toHaveBeenCalledOnce();
      const next = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
      next.state = 'loaded';
      next.buckets = state.tile.buckets;
      state.queue.enqueue('source', next);
      const prepare = vi.spyOn(state.vector, 'advanceTileBuild').mockReturnValue(false);
      state.queue.drain(minimumBudget(), 4, undefined, true);
      expect(state.symbol.stepBuild).toHaveBeenCalledTimes(2);
      expect(prepare).not.toHaveBeenCalled();
      state.queue.drain(minimumBudget(), 4, undefined, true);
      expect(prepare).toHaveBeenCalledOnce();
      expect(state.symbol.stepBuild).toHaveBeenCalledTimes(2);
    }
    finally { state.close(); }
  });

  it('leaves pattern refresh independent when no vector record was produced', () => {
    const state = fixture();
    try {
      state.layers.delete('land');
      state.layers.get('labels')!.minzoom = 1;
      state.queue.enqueue('source', state.tile);
      state.queue.drain(budget, 100);
      expect(state.queue.size).toBe(0);
      expect(state.vector.tileBuildLayers(`source/${state.tile.tileID.key}`)).toBeUndefined();
      state.style.z = 2;
      state.queue.ensureVisibleLayers('source', state.tile, new Set(['hatch']));
      state.queue.drain(budget, 100);
      expect(state.beginVector).toHaveBeenCalledOnce();
    }
    finally { state.close(); }
  });

  it('does not restart completed vector geometry when a pattern becomes visible during symbol work', () => {
    const state = fixture();
    try {
      state.queue.enqueue('source', state.tile);
      state.queue.drain(budget, 100);
      const before = [...state.vector.getTileCollections(`source/${state.tile.tileID.key}`)];
      expect(state.queue.size).toBe(1);
      expect(state.beginVector).toHaveBeenCalledOnce();
      state.style.z = 2;
      state.queue.ensureVisibleLayers('source', state.tile, new Set(['hatch']));
      state.queue.drain(budget, 100);
      expect(state.beginVector).toHaveBeenCalledOnce();
      expect(state.vector.getTileCollections(`source/${state.tile.tileID.key}`)).toEqual(before);
    }
    finally { state.close(); }
  });

  for (const pending of [false, true]) {
    it(`prepares only detail when a missing symbol becomes visible with ${pending ? 'pending' : 'finished'} vector publication`, () => {
      const state = fixture();
      try {
        state.queue.enqueue('source', state.tile);
        state.queue.drain(budget, 100);
        const before = [...state.vector.getTileCollections(`source/${state.tile.tileID.key}`)];
        if (!pending)
          state.queue.clear();
        state.style.z = 2;
        state.queue.ensureVisibleLayers('source', state.tile, new Set(['detail']));
        state.queue.drain(budget, 100);
        expect(state.symbol.beginBuild).toHaveBeenCalledTimes(2);
        expect(state.beginVector).toHaveBeenCalledOnce();
        expect(state.vector.getTileCollections(`source/${state.tile.tileID.key}`)).toEqual(before);
      }
      finally { state.close(); }
    });
  }

  for (const patternVisible of [false, true]) {
    it(`removes deleted symbols when completion ${patternVisible ? 'passes through pattern detail' : 'has no detail stage'}`, () => {
      const state = fixture();
      try {
        state.layers.delete('labels');
        state.layers.delete('detail');
        state.style.z = patternVisible ? 2 : 0;
        state.queue.enqueue('source', state.tile);
        state.queue.drain(budget, 100);
        expect(state.queue.size).toBe(0);
        expect(state.published.find(result => result.stage === 'complete')?.removedSymbols).toEqual(state.oldSymbols);
      }
      finally { state.close(); }
    });
  }

  for (const patternVisible of [false, true]) {
    it(`retains cached hidden symbols ${patternVisible ? 'through pattern detail' : 'without detail publication'}`, () => {
      const state = fixture();
      try {
        state.layers.get('labels')!.minzoom = 3;
        state.layers.get('detail')!.minzoom = 3;
        state.style.z = patternVisible ? 2 : 0;
        state.queue.enqueue('source', state.tile);
        state.queue.drain(budget, 100);
        expect(state.queue.size).toBe(0);
        expect(state.symbol.removeTile).not.toHaveBeenCalled();
        expect(state.published.find(result => result.stage === 'complete')?.removedSymbols).toEqual([]);
      }
      finally { state.close(); }
    });
  }
});
