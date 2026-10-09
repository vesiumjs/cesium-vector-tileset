import type { SymbolPrimitiveGeometry } from '../../symbol/symbol-geometry';
import type { PlacementView } from '../../symbol/symbol-placement';
import type { RenderFrameState } from '../render-frame';
import type { TilePublishQueue, TilePublishResult } from '../tile-publish-queue';
import Point from '@mapbox/point-geometry';
import { Color, Geometry, Material, Primitive, PrimitiveCollection, SceneMode } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollisionBoxArray } from '../../../data/array-types.g';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { SymbolBucket } from '../../../data/bucket/symbol-bucket';
import { FeatureIndex } from '../../../data/feature-index';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { SymbolStyleLayer } from '../../../style/style-layer/symbol-style-layer';
import { Tile } from '../../../tile/tile';
import { OverscaledTileID } from '../../../tile/tile-id';
import { PatternTileRenderer } from '../../pattern/pattern-renderer';
import { RasterTileRenderer } from '../../raster/raster-renderer';
import { beginSymbolBuild, buildSymbolHalves, mergeSymbolHalves, SymbolTileRenderer } from '../../symbol/symbol-renderer';
import { buildVectorTile } from '../../vector/__test__/vector-tile-helper';
import { VectorTileRenderer } from '../../vector/vector-tile-renderer';
import { UNBOUNDED_BUDGET } from '../frame-budget';
import { SceneCollections } from '../scene-collections';
import { TileResidency } from '../tile-residency';

const view: PlacementView = { viewProjection: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), width: 1000, height: 1000, pixelRatio: 1, cameraZoom: 14.5, orthographic: true, cameraToCenterDistance: undefined, mercatorProjection: false };

function pointGeometry(count = 1): SymbolPrimitiveGeometry {
  const geometry: SymbolPrimitiveGeometry = {
    positions: new Float64Array(count * 12),
    offsets: new Float32Array(count * 8),
    pxoffsets: new Float32Array(count * 8),
    minfontscales: new Float32Array(count * 8),
    tex: new Float32Array(count * 8),
    sizes: new Float32Array(count * 4).fill(512),
    sizesMax: new Float32Array(count * 4).fill(128),
    sizeZooms: new Float32Array(count * 8),
    colors: new Float32Array(count * 16),
    halos: new Float32Array(count * 16),
    dynamics: new Float32Array(count * 12),
    opacities: new Float32Array(count * 4),
    opacityDirty: false,
    viewportPerspective: true,
    mapPitch: false,
    sizePerspective: true,
    indices: new Uint32Array(count * 6),
    sdf: false,
    overlapMode: 'never',
    ignorePlacement: false,
    instances: [],
  };
  for (let index = 0; index < count; index++) {
    geometry.offsets.set([-2, -2, 2, -2, 2, 2, -2, 2], index * 8);
    geometry.indices.set([0, 1, 2, 0, 2, 3].map(vertex => vertex + index * 4), index * 6);
    for (let vertex = 0; vertex < 4; vertex++)
      geometry.positions[(index * 4 + vertex) * 3] = count > 1 ? 0.2 + index * 0.1 : 0;
    geometry.instances.push({ vertexStart: index * 4, vertexCount: 4, minX: -2, minY: -2, maxX: 2, maxY: 2 });
  }
  return geometry;
}

function fixture(mode: SceneMode = SceneMode.SCENE3D) {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const root = new PrimitiveCollection({ destroyPrimitives: false });
  const vector = new VectorTileRenderer();
  const symbol = new SymbolTileRenderer();
  symbol.cameraZoom = view.cameraZoom;
  const scene = new SceneCollections(root, vi.fn(), id => symbol.isTilePlacementActive(id));
  const pending = new Set<string>();
  // Readiness is controlled at the publication boundary; builders and owner
  // placement remain the real renderers, and scene attachment is real.
  const queue = {
    get size() { return pending.size; },
    has: (id: string) => pending.has(id),
    hasPendingSurfaces: (id: string) => pending.has(id),
    hasPendingSymbols: () => false,
    cancelPatternRefreshesOutside: vi.fn(),
    enqueue: vi.fn(),
    enqueueDetails: vi.fn(),
  } as unknown as TilePublishQueue;
  const residency = new TileResidency({ vector, symbol, scene, pattern: new PatternTileRenderer(), raster: new RasterTileRenderer(), publishQueue: queue, fadeDuration: () => 0, paintFrame: () => ({ zoom: view.cameraZoom, styleRevision: 0 }) });
  const tiles = new Map<string, Tile>();
  const symbols = new Map<string, PrimitiveCollection>();
  const land = new FillStyleLayer({ id: 'land', type: 'fill', source: 'world', paint: { 'fill-antialias': false } });
  const labels = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'world', minzoom: 13 }, {});
  for (const layer of [land, labels])
    layer.recalculate(new EvaluationParameters(view.cameraZoom), []);
  const add = (tileID: OverscaledTileID, withSymbols: boolean, symbolLayer = labels, native = false, symbolCount = 1) => {
    if (native)
      vi.stubGlobal('OffscreenCanvas', class {});
    const tile = new Tile(tileID, 512);
    tile.state = 'loaded';
    const tileId = `world/${tileID.key}`;
    const bucket = new FillBucket({ layers: [land], zoom: tileID.overscaledZ } as never);
    bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
    tile.buckets.land = bucket;
    if (withSymbols) {
      tile.buckets[symbolLayer.id] = new SymbolBucket({ layers: [symbolLayer], zoom: tileID.overscaledZ } as never);
      const state = beginSymbolBuild({ tileId, tileKey: tileID.key, tileID: tileID.canonical, buckets: tile.buckets, collisionBoxArray: new CollisionBoxArray(), layers: [symbolLayer], pixelRatio: 1 }, undefined, undefined);
      const icon = pointGeometry(symbolCount);
      const batch = { icon, pairs: icon.instances.map((_, icon) => ({ text: -1, icon })) };
      const halves = native
        ? buildSymbolHalves({
            tileId,
            layerId: symbolLayer.id,
            geometry: batch,
            iconAtlas: { canvas: document.createElement('canvas'), width: 1, height: 1, shareKey: 'prepared-icons' },
            textColor: Color.WHITE,
            iconColor: Color.WHITE,
            pixelRatio: 1,
          })
        : [];
      const merged = mergeSymbolHalves(tileId, halves);
      const collection = merged?.collection ?? new PrimitiveCollection();
      const material = new Material({ fabric: { source: 'czm_material czm_getMaterial(czm_materialInput materialInput) { return czm_getDefaultMaterial(materialInput); }' } });
      if (native)
        material.destroy();
      const entryHalves = native ? halves : [{ layerId: symbolLayer.id, part: 'icon' as const, geometry: new Geometry({ attributes: {} }), material }];
      state.entry = { input: state.input, batches: [batch], layerIds: [symbolLayer.id], halves: entryHalves, collections: [collection], primitives: merged?.primitives ?? [], key: tileId, materials: new Set(entryHalves.map(half => half.material)), atlasKeys: [], placed: false, bytes: 0 };
      symbol.commitBuild(state);
      scene.add(collection);
      symbols.set(tileId, collection);
    }
    buildVectorTile(vector, { tileId, buckets: tile.buckets, tileID, mode });
    for (const collection of vector.getTileCollections(tileId))
      scene.add(collection);
    tiles.set(tileID.key, tile);
    residency.commit({
      sourceId: 'world',
      tileId,
      tileID,
      generationId: vector.tileBuildLayers(tileId)!.generationId,
      stage: 'complete',
      progress: { vector: 'complete', pattern: true, symbol: true },
      buckets: tile.buckets,
      styleRevision: 0,
      mode,
      featureIndex: tile.latestFeatureIndex,
      retainPreviousGeneration: false,
      previousVector: [],
      retiredVector: [],
      addedVector: [],
      raster: { added: [], removed: [], removedMaterials: [] },
      addedSymbols: [],
      removedSymbols: [],
      firstUpdateSymbols: [],
    });
    return tileId;
  };
  const sync = (ids: OverscaledTileID[]) => residency.syncSource('world', { getTileByID: id => tiles.get(id), loaded: () => true }, ids.map(id => id.key), mode);
  const settle = () => {
    for (let frame = 0; frame < 4; frame++) {
      symbol.update(view, false);
      residency.syncHeldTileVisibility();
    }
  };
  const close = () => {
    const collections = [...vector.collections.values(), ...symbols.values()];
    symbol.removeAll();
    vector.removeAll();
    root.removeAll();
    for (const collection of collections) {
      if (!collection.isDestroyed())
        collection.destroy();
    }
    root.destroy();
  };
  return { add, sync, settle, close, pending, symbol, symbols, residency, vector, scene, tiles };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('independent symbol coverage', () => {
  it('keeps the previous feature index and surface owner through independent symbol and vector publications', () => {
    const state = fixture();
    const tileID = new OverscaledTileID(14, 0, 14, 8184, 5444);
    try {
      const tileId = state.add(tileID, false);
      const tile = state.tiles.get(tileID.key)!;
      const old = state.vector.getTileCollections(tileId);
      const previousGeneration = state.vector.tileBuildLayers(tileId)!.generationId;
      const previousIndex = new FeatureIndex(tileID);
      const currentIndex = new FeatureIndex(tileID);
      const publication = (generationId: number, featureIndex: FeatureIndex, stage: TilePublishResult['stage'], progress: TilePublishResult['progress'], resources: Partial<TilePublishResult> = {}): TilePublishResult => ({
        sourceId: 'world',
        tileId,
        tileID,
        generationId,
        featureIndex,
        stage,
        progress,
        buckets: tile.buckets,
        styleRevision: 0,
        mode: SceneMode.SCENE3D,
        retainPreviousGeneration: stage !== 'complete',
        previousVector: [],
        retiredVector: [],
        addedVector: [],
        raster: { added: [], removed: [], removedMaterials: [] },
        addedSymbols: [],
        removedSymbols: [],
        firstUpdateSymbols: [],
        ...resources,
      });
      state.residency.commit(publication(previousGeneration, previousIndex, 'complete', { vector: 'complete', pattern: true, symbol: true }));
      const build = state.vector.beginTileBuild({ tileId, tileID, buckets: tile.buckets, styleZoom: 14, mode: SceneMode.SCENE3D, styleRevision: 0 });
      state.pending.add(tileId);
      state.residency.commit(publication(build.generationId, currentIndex, 'symbol', { vector: 'pending', pattern: false, symbol: true }));
      expect(state.residency.featureIndex(tileId, previousGeneration)).toBe(previousIndex);
      expect(state.residency.featureIndex(tileId, build.generationId)).toBe(currentIndex);
      while (!state.vector.advanceTileBuild(build, UNBOUNDED_BUDGET)) { /* finish actual vector geometry */ }
      state.vector.commitTileBuild(build);
      const next = state.vector.getTileCollections(tileId);
      state.residency.commit(publication(build.generationId, currentIndex, 'vector', { vector: 'complete', pattern: false, symbol: true }, { previousVector: old, addedVector: next }));
      for (const collection of next)
        vi.spyOn(collection, 'update').mockImplementation(() => {});
      state.scene.pumpFirstUpdates({ commandList: [] } as never, UNBOUNDED_BUDGET);
      expect(old[0].show).toBe(true);
      expect(next[0].show).toBe(false);
      state.residency.releaseReplacedFeatureIndices();
      expect(state.residency.featureIndex(tileId, previousGeneration)).toBe(previousIndex);
      state.pending.delete(tileId);
      state.residency.commit(publication(build.generationId, currentIndex, 'complete', { vector: 'complete', pattern: true, symbol: true }));
      expect(old[0].show).toBe(false);
      expect(next[0].show).toBe(true);
      expect(state.residency.featureIndex(tileId, build.generationId)).toBe(currentIndex);
      expect(state.residency.featureIndex(tileId, previousGeneration)).toBeUndefined();
      state.scene.flushRemovals();
    }
    finally { state.close(); }
  });
  it('requeues unfinished Native symbol preparation when an early publication returns from cache', () => {
    const state = fixture();
    const tileID = new OverscaledTileID(14, 0, 14, 8184, 5444);
    const frame = { commandList: [], camera: {} } as RenderFrameState;
    try {
      const tileId = state.add(tileID, true, undefined, true);
      const collection = state.symbols.get(tileId)!;
      expect(collection.get(0)).toBeInstanceOf(Primitive);
      expect(collection.get(0).ready).toBe(false);
      state.sync([tileID]);
      state.scene.queueFirstUpdate([collection], false);
      state.sync([]);
      state.settle();
      state.scene.pumpFirstUpdates(frame, UNBOUNDED_BUDGET);
      expect(state.scene.pendingFirstUpdateCount).toBe(0);
      state.sync([tileID]);
      expect(state.symbol.getTileCollections(tileId)).toEqual([collection]);
      expect(state.scene.hasPendingFirstUpdate(collection), 'cached CPU completion is not Native readiness').toBe(true);
    }
    finally { state.close(); }
  });
  it('restores unfinished native preparation when the same cached tile returns', () => {
    const state = fixture(SceneMode.SCENE2D);
    const tileID = new OverscaledTileID(14, 0, 14, 8184, 5444);
    const frame = { commandList: [], camera: {} } as RenderFrameState;
    try {
      const tileId = state.add(tileID, false);
      const before = state.vector.getTileCollections(tileId);
      expect(before[0]).toBeInstanceOf(PrimitiveCollection);
      expect((before[0] as PrimitiveCollection).get(0).ready).toBe(false);
      state.sync([tileID]);
      state.scene.queueFirstUpdate(before);
      expect(state.scene.pendingFirstUpdateCount).toBeGreaterThan(0);
      state.sync([]);
      state.scene.pumpFirstUpdates(frame, UNBOUNDED_BUDGET);
      expect(state.scene.pendingFirstUpdateCount).toBe(0);
      expect(state.vector.getTileCollections(tileId)).toEqual([]);
      state.sync([tileID]);
      expect(state.vector.getTileCollections(tileId)).toEqual(before);
      expect(state.scene.pendingFirstUpdateCount, 'a cached CPU-complete tile still needs its unfinished Native preparation').toBeGreaterThan(0);
      state.sync([]);
      state.scene.pumpFirstUpdates(frame, UNBOUNDED_BUDGET);
      // Native ready is the engine boundary; already uploaded owners must
      // restore immediately without acquiring another preparation allowance.
      Object.assign((before[0] as PrimitiveCollection).get(0), { _ready: true });
      state.sync([tileID]);
      expect(state.vector.getTileCollections(tileId)).toEqual(before);
      expect(state.scene.pendingFirstUpdateCount).toBe(0);
    }
    finally { state.close(); }
  });

  it('does not let a held surface below symbol minzoom hide its symbol descendants', () => {
    const state = fixture();
    const parent = new OverscaledTileID(12, 0, 12, 2046, 1361);
    const child = new OverscaledTileID(14, 0, 14, 8184, 5444);
    try {
      state.add(parent, false);
      const childId = state.add(child, true);
      state.pending.add(childId);
      state.sync([parent, child]);
      state.settle();
      expect(state.symbols.get(childId)!.show).toBe(true);
      expect(state.symbol.isTilePlacementActive(childId)).toBe(true);
    }
    finally { state.close(); }
  });

  it('prevents a masked held descendant from hiding its held ancestor in return', () => {
    const state = fixture();
    const parent = new OverscaledTileID(13, 0, 13, 4092, 2722);
    const child = new OverscaledTileID(14, 0, 14, 8184, 5444);
    try {
      const parentId = state.add(parent, true);
      const childId = state.add(child, true);
      state.pending.add(parentId);
      state.pending.add(childId);
      state.sync([parent, child]);
      state.settle();
      expect(state.symbols.get(parentId)!.show).toBe(true);
      expect(state.symbols.get(childId)!.show).toBe(false);
    }
    finally { state.close(); }
  });

  it('does not let cached symbols from a hidden parent layer mask visible descendants', () => {
    const state = fixture();
    const parent = new OverscaledTileID(13, 0, 13, 4092, 2722);
    const child = new OverscaledTileID(14, 0, 14, 8184, 5444);
    const hidden = new SymbolStyleLayer({ id: 'hidden', type: 'symbol', source: 'world', minzoom: 15 }, {});
    hidden.recalculate(new EvaluationParameters(view.cameraZoom), []);
    try {
      state.add(parent, true, hidden);
      const childId = state.add(child, true);
      state.pending.add(childId);
      state.sync([parent, child]);
      state.settle();
      expect(state.symbols.get(childId)!.show).toBe(true);
    }
    finally { state.close(); }
  });

  it('keeps the displayed parent when a frozen offscreen successor finishes empty in the returned view', () => {
    const state = fixture();
    const parent = new OverscaledTileID(13, 0, 13, 4092, 2722);
    const child = new OverscaledTileID(14, 0, 14, 8184, 5444);
    const spent = { exhausted: true, remainingMs: 0, takeMinimumProgress: () => true };
    let offscreenPairs = 0;
    const offscreen: PlacementView = { ...view, cameraZoom: 14.6, isPointVisible: (x) => {
      if (x > 0.1)
        offscreenPairs++;
      return x <= 0.1;
    } };
    try {
      const parentId = state.add(parent, true);
      state.sync([parent]);
      state.settle();
      const old = state.symbols.get(parentId)!;
      const release = vi.spyOn(state.symbol, 'retireTile');
      const childId = state.add(child, true, undefined, false, 3);
      state.symbol.setTilePlacementVisible(childId, false);
      state.symbols.get(childId)!.show = false;
      state.sync([child]);
      expect(state.symbol.isTilePlaced(childId)).toBe(false);
      for (let frame = 0; frame < 3; frame++) {
        state.symbol.update(offscreen, frame === 0, undefined, advance => advance(spent));
        if (offscreenPairs >= 1)
          break;
      }
      expect(offscreenPairs).toBe(1);
      for (let frame = 0; frame < 12; frame++) {
        state.symbol.update(view, frame === 0, undefined, advance => advance(spent));
        state.residency.syncHeldTileVisibility();
        if (offscreenPairs >= 3)
          break;
      }
      expect(offscreenPairs).toBe(3);
      expect(old.show).toBe(true);
      expect(release).not.toHaveBeenCalled();
      expect(state.symbols.get(childId)!.show).toBe(false);
      state.settle();
      expect(state.symbols.get(childId)!.show).toBe(true);
      expect(old.show).toBe(false);
    }
    finally { state.close(); }
  });

  it('retires the parent when the current-view successor legitimately selects no symbols', () => {
    const state = fixture();
    const parent = new OverscaledTileID(13, 0, 13, 4092, 2722);
    const child = new OverscaledTileID(14, 0, 14, 8184, 5444);
    try {
      const parentId = state.add(parent, true);
      state.sync([parent]);
      state.settle();
      const old = state.symbols.get(parentId)!;
      const retire = vi.spyOn(state.symbol, 'retireTile');
      const childId = state.add(child, true, undefined, false, 3);
      state.symbol.setTilePlacementVisible(childId, false);
      state.symbols.get(childId)!.show = false;
      state.sync([child]);
      state.symbol.update({ ...view, isPointVisible: x => x <= 0.1 }, true);
      expect(state.symbol.isTilePlaced(childId)).toBe(true);
      state.residency.syncHeldTileVisibility();
      expect(old.show).toBe(false);
      expect(state.symbols.get(childId)!.show).toBe(true);
      expect(retire).toHaveBeenCalledWith(parentId, 0);
    }
    finally { state.close(); }
  });

  it('keeps displayed symbols until the whole prospective layout can activate', () => {
    const state = fixture();
    const parent = new OverscaledTileID(13, 0, 13, 4092, 2722);
    const child = new OverscaledTileID(14, 0, 14, 8184, 5444);
    try {
      const parentId = state.add(parent, true);
      state.sync([parent]);
      state.settle();
      expect(state.symbols.get(parentId)!.show).toBe(true);
      const childId = state.add(child, true);
      state.symbol.setTilePlacementVisible(childId, false);
      state.symbols.get(childId)!.show = false;
      const preparing = vi.spyOn(state.symbol, 'prepareVisiblePlacement').mockReturnValue(false);
      state.sync([child]);
      state.residency.syncHeldTileVisibility();
      expect(state.symbols.get(parentId)!.show).toBe(true);
      expect(state.symbols.get(childId)!.show).toBe(false);
      preparing.mockRestore();
      state.settle();
      expect(state.symbols.get(childId)!.show).toBe(true);
      expect(state.symbols.get(parentId)!.show).toBe(false);
    }
    finally { state.close(); }
  });

  it('does not report a visibility change while a stale empty successor waits for recency', () => {
    const state = fixture();
    const parent = new OverscaledTileID(13, 0, 13, 4092, 2722);
    const child = new OverscaledTileID(14, 0, 14, 8184, 5444);
    const onePair = { exhausted: true, takeMinimumProgress: () => true };
    try {
      const parentId = state.add(parent, true);
      state.sync([parent]);
      state.settle();
      const old = state.symbols.get(parentId)!;
      const retire = vi.spyOn(state.symbol, 'retireTile');
      const childId = state.add(child, true, undefined, false, 3);
      state.symbol.setTilePlacementVisible(childId, false);
      state.symbols.get(childId)!.show = false;
      state.sync([child]);
      const offscreen = new Float64Array(view.viewProjection);
      offscreen[12] = 3;
      state.symbol.update({ ...view, viewProjection: offscreen }, true, undefined, operation => operation(onePair));
      for (let frame = 0; frame < 24 && !state.symbol.isTilePlaced(childId); frame++)
        state.symbol.update(view, frame === 0, undefined, operation => operation(onePair));
      expect(state.symbol.isTilePlaced(childId)).toBe(true);
      state.residency.syncHeldTileVisibility();
      for (let frame = 0; frame < 24 && state.symbol.hasRunnableWork; frame++) {
        state.symbol.update(view, false, undefined, operation => operation(onePair));
        state.residency.syncHeldTileVisibility();
      }
      expect(state.symbol.hasPendingWork).toBe(true);
      expect(state.symbol.hasRunnableWork).toBe(false);
      expect(state.symbol.nextPlacementTime).toBe(300);
      expect(state.scene.pendingFirstUpdateCount).toBe(0);
      expect(old.show).toBe(true);
      expect(state.symbols.get(childId)!.show).toBe(false);
      expect(retire).not.toHaveBeenCalled();
      expect(state.residency.syncHeldTileVisibility()).toBe(false);
      expect(state.residency.syncHeldTileVisibility()).toBe(false);
      vi.mocked(performance.now).mockReturnValue(300);
      state.symbol.update(view, false);
      expect(state.residency.syncHeldTileVisibility()).toBe(true);
      expect(state.symbols.get(childId)!.show).toBe(true);
      expect(old.show).toBe(false);
      expect(retire).toHaveBeenCalledWith(parentId, 0);
      state.symbol.update(view, false);
      expect(state.residency.syncHeldTileVisibility()).toBe(false);
      expect(state.symbol.hasPendingWork).toBe(false);
    }
    finally { state.close(); }
  });
});
