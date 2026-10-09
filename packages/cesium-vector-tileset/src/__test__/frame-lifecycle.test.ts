import type { RenderFrameState } from '../render/scene/render-frame';
import type { StyleEvaluation } from '../render/scene/style-evaluation';
import type { TilePublishQueue } from '../render/scene/tile-publish-queue';
import type { TileResidency } from '../render/scene/tile-residency';
import type { SymbolTileRenderer } from '../render/symbol/symbol-renderer';
import type { VectorDrapingProvider, VectorTileRenderer } from '../render/vector/vector-tile-renderer';
import type { Style } from '../style/style';
import Point from '@mapbox/point-geometry';
import * as Cesium from 'cesium';
import { BufferPolygonCollection, Cartesian3, Event, HeightReference, Matrix4, PrimitiveCollection, Rectangle, SceneMode, WebMercatorTilingScheme } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../cesium-vector-tileset';
import { FillBucket } from '../data/bucket/fill-bucket';
import { cameraFrame } from '../render/scene/__test__/camera-helper';
import { drawBatchForOwner, registerDrawLayers } from '../render/scene/draw-batch';
import { UNBOUNDED_BUDGET } from '../render/scene/frame-budget';
import { zoomForFrame } from '../render/scene/render-frame';
import { SceneCollections } from '../render/scene/scene-collections';
import { buildVectorTile } from '../render/vector/__test__/vector-tile-helper';
import { EvaluationParameters } from '../style/evaluation-parameters';
import { FillStyleLayer } from '../style/style-layer/fill-style-layer';
import { Tile } from '../tile/tile';
import { OverscaledTileID } from '../tile/tile-id';

function frame(vectorProvider?: VectorDrapingProvider): RenderFrameState {
  return {
    mode: SceneMode.SCENE3D,
    frameNumber: 1,
    commandList: [],
    afterRender: [],
    camera: { _scene: { vectorProvider } } as RenderFrameState['camera'],
  };
}

/** Real Root coverage/paint owners; only the already uploaded GPU boundary is supplied. */
async function uploadedWaterLifecycle() {
  const mode = SceneMode.SCENE3D;
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const makeStyle = (color = '#9ebdff') => ({
    version: 8 as const,
    sources: { world: { type: 'vector' as const, tiles: ['http://example.invalid/{z}/{x}/{y}.pbf'] } },
    layers: [{ 'id': 'water', 'type': 'fill' as const, 'source': 'world', 'source-layer': 'water', 'paint': { 'fill-color': color, 'fill-antialias': false, 'fill-color-transition': { duration: 0, delay: 0 } } }],
  });
  const tileset = new CesiumVectorTileset({ style: makeStyle() });
  await tileset.whenReady();
  const internals = (tileset as unknown as { _renderer: { style: Style; vector: VectorTileRenderer; residency: TileResidency; collections: SceneCollections; publishQueue: TilePublishQueue; evaluation: StyleEvaluation; symbol: { hasPendingWork: boolean; hasDrawableSymbols: boolean } } })._renderer;
  const pyramid = internals.style.tilePyramids.world;
  pyramid._sourceLoaded = true;
  const load = vi.spyOn(pyramid.getSource(), 'loadTile').mockImplementation(() => new Promise(() => {}));
  const tileID = new OverscaledTileID(13, 0, 13, 4093, 2724);
  const { z, x, y } = tileID.canonical;
  const rectangle = new WebMercatorTilingScheme().tileXYToRectangle(x, y, z);
  const center = Rectangle.center(rectangle);
  const state: RenderFrameState = { ...cameraFrame({ mode, height: 3000 }), frameNumber: 0, commandList: [], afterRender: [], passes: { render: true, pick: false } };
  let renderRequested = true;
  const requestRender = vi.fn(() => {
    renderRequested = true;
  });
  const scene = Object.assign(state.camera._scene!, {
    mode,
    requestRenderMode: true,
    requestRender,
    preUpdate: new Event(),
    preRender: new Event(),
    postRender: new Event(),
    _frameState: state,
    globe: { show: true, tilesLoaded: true, _surface: { _tilesToRender: [{ level: z, x, y, rectangle }] } },
  });
  const position = (height: number, longitudeOffset = 0) => {
    state.camera.setView({ destination: Cartesian3.fromRadians(center.longitude + longitudeOffset, center.latitude, height), orientation: { pitch: -Math.PI / 2 } });
    state.cullingVolume = state.camera.frustum.computeCullingVolume(state.camera.positionWC, state.camera.directionWC, state.camera.upWC);
  };
  position(3000);
  internals.evaluation.evaluate(zoomForFrame(pyramid, state, new WeakMap())!.styleZoom);
  const layer = internals.style.getLayer('water') as FillStyleLayer;
  layer.recalculate(new EvaluationParameters(14), []);
  const bucket = new FillBucket({ layers: [layer], zoom: 13 } as never);
  bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
  const data = new Tile(tileID, 512);
  data.state = 'loaded';
  data.uses = 1;
  data.buckets.water = bucket;
  pyramid._activeTiles.setTile(tileID.key, data);
  const tileId = `world/${tileID.key}`;
  buildVectorTile(internals.vector, { mode, tileId, tileID, buckets: data.buckets, styleZoom: 14, styleRevision: internals.style.styleRevision });
  const [surface] = internals.vector.getTileCollections(tileId);
  tileset.add(surface);
  const native = Cesium as unknown as { DrawCommand: new (options: object) => NonNullable<RenderFrameState['commandList']>[number]; Pass: { OPAQUE: number } };
  const uploads = new WeakMap<BufferPolygonCollection, { vertexArray: object; command: NonNullable<RenderFrameState['commandList']>[number] }>();
  // No WebGL in jsdom: this represents a completed Native upload and reuses
  // its same VA/command. Root source, residency, paint and wake logic are real.
  let onDraw: (() => void) | undefined;
  const draw = function (this: BufferPolygonCollection, value: unknown) {
    expect(drawBatchForOwner(this)?.layerId, 'The only GPU boundary in this owner fixture is the real water bucket').toBe('water');
    let gpu = uploads.get(this);
    if (!gpu) {
      const vertexArray = { numberOfAttributes: 0, getAttribute: vi.fn(), isDestroyed: () => false, destroy: vi.fn() };
      const command = new native.DrawCommand({ owner: this, pass: native.Pass.OPAQUE, vertexArray });
      gpu = { vertexArray, command };
      uploads.set(this, gpu);
      Object.assign(this, { _renderContext: { vertexArray, command, destroy: vi.fn() } });
    }
    if (this.show) {
      (value as RenderFrameState).commandList!.push(gpu.command);
      const callback = onDraw;
      onDraw = undefined;
      callback?.();
    }
  };
  const upload = vi.spyOn(BufferPolygonCollection.prototype, 'update').mockImplementation(draw);
  internals.residency.commit({
    sourceId: 'world',
    tileId,
    tileID,
    generationId: internals.vector.tileBuildLayers(tileId)!.generationId,
    stage: 'complete',
    progress: { vector: 'complete', pattern: true, symbol: true },
    buckets: data.buckets,
    styleRevision: internals.style.styleRevision,
    mode: state.mode!,
    featureIndex: data.latestFeatureIndex,
    retainPreviousGeneration: false,
    previousVector: [],
    retiredVector: [],
    addedVector: [],
    raster: { added: [], removed: [], removedMaterials: [] },
    addedSymbols: [],
    removedSymbols: [],
    firstUpdateSymbols: [],
  });
  let previousView: Matrix4 | undefined;
  const tick = (viewports = 1) => {
    scene.preUpdate.raiseEvent(scene);
    const cameraChanged = !previousView || !Matrix4.equals(previousView, state.camera.viewMatrix);
    previousView = Matrix4.clone(state.camera.viewMatrix, previousView);
    const rendered = renderRequested || cameraChanged;
    state.newFrame = rendered;
    if (rendered) {
      state.frameNumber!++;
      renderRequested = false;
      state.commandList!.length = 0;
    }
    tileset.prePassesUpdate(state);
    let renderError: unknown;
    if (rendered) {
      scene.preRender.raiseEvent();
      try {
        for (let viewport = 0; viewport < viewports; viewport++) tileset.update(state);
      }
      catch (error) {
        // Native tryAndCatchError(render) still reaches afterRender/postRender.
        renderError = error;
      }
    }
    tileset.postPassesUpdate(state);
    // Native Scene.js consumes callbacks (including on idle ticks) before
    // raising postRender. Requests made by postRender owe a later tick.
    const callbacks = state.afterRender!.splice(0).map((callback) => {
      const requested = callback();
      if (requested)
        requestRender();
      return requested;
    });
    if (rendered)
      scene.postRender.raiseEvent();
    return { rendered, cameraChanged, callbacks, requested: renderRequested, renderError };
  };
  const renderScene = scene as typeof scene & { render: (viewports?: number) => ReturnType<typeof tick> };
  renderScene.render = tick;
  const quiet = () => {
    expect(internals.publishQueue.size).toBe(0);
    expect(internals.collections.pendingFirstUpdateCount).toBe(0);
    expect(internals.vector.needsPaintUpdate).toBe(false);
    expect(internals.symbol.hasDrawableSymbols).toBe(false);
    expect(internals.symbol.hasPendingWork).toBe(false);
    const collections = internals.vector.getTileCollections(tileId);
    const water = collections.filter(collection => drawBatchForOwner(collection)?.layerId === 'water');
    expect(water).toHaveLength(1);
    expect(water[0].show).toBe(true);
    expect(collections.every(collection => tileset.contains(collection))).toBe(true);
    expect(uploads.has(water[0] as BufferPolygonCollection)).toBe(true);
    expect(load).not.toHaveBeenCalled();
  };
  // Finish insertion/style bookkeeping before constructing the late wake.
  try {
    for (let index = 0; index < 8; index++) {
      if (index > 0 && !renderRequested && state.afterRender!.length === 0)
        break;
      expect(renderScene.render().renderError).toBeUndefined();
    }
    quiet();
    expect(renderScene.render().rendered).toBe(false);
  }
  catch (error) {
    tileset.destroy();
    vi.restoreAllMocks();
    throw error;
  }
  requestRender.mockClear();
  return {
    tileset,
    state,
    scene: renderScene,
    position,
    tick: (viewports = 1) => renderScene.render(viewports),
    quiet,
    surface,
    upload,
    requestRender,
    makeStyle,
    onDraw: (callback: () => void) => {
      onDraw = callback;
    },
  };
}

describe('primitive frame lifecycle', () => {
  it('waits until the placement deadline, wakes Native internally, and preserves the consumed request', async () => {
    const owner = await uploadedWaterLifecycle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    const internals = (owner.tileset as unknown as { _renderer: { symbol: SymbolTileRenderer; wake: { continuePlacement: () => boolean } } })._renderer;
    vi.mocked(performance.now).mockImplementation(() => now);
    vi.spyOn(internals.symbol, 'nextPlacementTime', 'get').mockImplementation(() => now < 300 ? 300 : undefined);
    vi.spyOn(internals.symbol, 'hasRunnableWork', 'get').mockImplementation(() => now >= 300);
    try {
      expect(internals.wake.continuePlacement()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      now = 299;
      vi.advanceTimersByTime(299);
      expect(owner.requestRender).not.toHaveBeenCalled();
      expect(owner.tick().rendered).toBe(false);
      // Reading the same absolute deadline never postpones the pending wake.
      expect(internals.wake.continuePlacement()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      now = 300;
      vi.advanceTimersByTime(1);
      expect(owner.requestRender).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      const served = owner.tick();
      expect(served.rendered).toBe(true);
      expect(served.renderError).toBeUndefined();
      expect(served.requested).toBe(false);
      expect(owner.tick().rendered).toBe(false);
    }
    finally {
      owner.tileset.destroy();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('recomputes a moved placement deadline without requesting an empty frame', async () => {
    const owner = await uploadedWaterLifecycle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    let deadline = 300;
    const internals = (owner.tileset as unknown as { _renderer: { symbol: SymbolTileRenderer; wake: { continuePlacement: () => boolean } } })._renderer;
    vi.mocked(performance.now).mockImplementation(() => now);
    vi.spyOn(internals.symbol, 'nextPlacementTime', 'get').mockImplementation(() => now < deadline ? deadline : undefined);
    vi.spyOn(internals.symbol, 'hasRunnableWork', 'get').mockImplementation(() => now >= deadline);
    try {
      internals.wake.continuePlacement();
      // Another scope can adopt a result before the existing timeout fires.
      deadline = 600;
      now = 300;
      vi.advanceTimersByTime(300);
      expect(owner.requestRender).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      now = 600;
      vi.advanceTimersByTime(300);
      expect(owner.requestRender).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
    finally {
      owner.tileset.destroy();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('cancels the owned placement wake on destroy', async () => {
    const owner = await uploadedWaterLifecycle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    const internals = (owner.tileset as unknown as { _renderer: { symbol: SymbolTileRenderer; wake: { continuePlacement: () => boolean } } })._renderer;
    vi.mocked(performance.now).mockImplementation(() => now);
    vi.spyOn(internals.symbol, 'nextPlacementTime', 'get').mockImplementation(() => now < 300 ? 300 : undefined);
    vi.spyOn(internals.symbol, 'hasRunnableWork', 'get').mockImplementation(() => now >= 300);
    try {
      internals.wake.continuePlacement();
      expect(vi.getTimerCount()).toBe(1);
      owner.tileset.destroy();
      expect(vi.getTimerCount()).toBe(0);
      owner.requestRender.mockClear();
      now = 300;
      vi.advanceTimersByTime(300);
      expect(owner.requestRender).not.toHaveBeenCalled();
    }
    finally {
      if (!owner.tileset.isDestroyed())
        owner.tileset.destroy();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('consumes a postRender covering wake already served by a camera render with 2 viewports', async () => {
    const viewports = 2;
    const owner = await uploadedWaterLifecycle();
    try {
      owner.position(6000);
      expect(owner.tick().rendered).toBe(true);
      owner.quiet();
      expect(owner.state.afterRender).toHaveLength(1);
      expect(owner.requestRender).not.toHaveBeenCalled();
      // This genuinely changed camera renders before the deferred callback;
      // Root now samples the preceding confirmed Globe/source zoom pair.
      owner.position(6000, 0.000001);
      const served = owner.tick(viewports);
      expect(served.cameraChanged).toBe(true);
      owner.quiet();
      expect(owner.state.commandList!.some(command => drawBatchForOwner(command.owner)?.layerId === 'water')).toBe(true);
      expect(owner.state.afterRender).toHaveLength(0);
      expect(served.requested, 'Old covering debt was consumed by this real render; no fresh work requests another').toBe(false);
      expect(owner.tick().rendered).toBe(false);
    }
    finally {
      owner.tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it('retains a postRender covering wake through an idle tick that cannot draw', async () => {
    const owner = await uploadedWaterLifecycle();
    try {
      owner.position(6000);
      expect(owner.tick().rendered).toBe(true);
      expect(owner.state.afterRender).toHaveLength(1);
      const calls = owner.upload.mock.calls.length;
      const idle = owner.tick();
      expect(idle.cameraChanged).toBe(false);
      expect(idle.rendered).toBe(false);
      expect(owner.upload.mock.calls.length).toBe(calls);
      expect(idle.requested).toBe(true);
      expect(owner.tick().rendered).toBe(true);
      owner.quiet();
    }
    finally {
      owner.tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it('preserves a fresh paint wake during the camera render that serves old covering debt with 2 viewports', async () => {
    const viewports = 2;
    const owner = await uploadedWaterLifecycle();
    try {
      owner.position(6000);
      expect(owner.tick().rendered).toBe(true);
      expect(owner.state.afterRender).toHaveLength(1);
      owner.position(6000, 0.000001);
      owner.onDraw(() => owner.tileset.setStyle(owner.makeStyle('#ff0000')));
      const served = owner.tick(viewports);
      expect(served.cameraChanged).toBe(true);
      expect(served.requested).toBe(true);
      expect(owner.requestRender).toHaveBeenCalledOnce();
      expect(owner.tick().rendered).toBe(true);
      owner.quiet();
    }
    finally {
      owner.tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it('retains old covering debt when its camera render fails at the last Native viewport of 2', async () => {
    const viewports = 2;
    const owner = await uploadedWaterLifecycle();
    try {
      owner.position(6000);
      expect(owner.tick().rendered).toBe(true);
      expect(owner.state.afterRender).toHaveLength(1);
      owner.position(6000, 0.000001);
      const failure = new Error('Native water update failed');
      owner.upload.mockImplementationOnce(owner.upload.getMockImplementation()!);
      owner.upload.mockImplementationOnce(() => {
        throw failure;
      });
      const failed = owner.tick(viewports);
      expect(failed.cameraChanged).toBe(true);
      expect(failed.renderError).toBe(failure);
      expect(failed.requested).toBe(true);
      const retry = owner.tick();
      expect(retry.rendered).toBe(true);
      expect(retry.renderError).toBeUndefined();
      owner.quiet();
    }
    finally {
      owner.tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it('continues admitted CPU work on idle demand ticks without a full tileset update or publication', async () => {
    const owner = await uploadedWaterLifecycle();
    const { tileset, state } = owner;
    const internals = (tileset as unknown as { _renderer: { collections: SceneCollections; publishQueue: TilePublishQueue; evaluation: StyleEvaluation } })._renderer;
    try {
      const update = vi.spyOn(tileset, 'update');
      const evaluate = vi.spyOn(internals.evaluation, 'evaluate');
      const publish = vi.spyOn(internals.publishQueue, 'drain');
      const commands = [...state.commandList!];
      const draws = owner.upload.mock.calls.length;
      vi.spyOn(internals.collections, 'hasRunnablePreparations', 'get').mockReturnValue(true);
      const advance = vi.spyOn(internals.collections, 'advancePreparations').mockReturnValue({ units: 1, renderNeeded: false });
      expect(owner.tick().rendered).toBe(false);
      expect(advance).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(state.commandList).toEqual(commands);
      expect(owner.upload).toHaveBeenCalledTimes(draws);
      expect(state.afterRender).toEqual([]);
    }
    finally {
      tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it('releases scene listeners on retained direct and ancestor removal, then binds again', async () => {
    const tileset = new CesiumVectorTileset({
      style: { version: 8, sources: {}, layers: [] },
      gpuMemoryBudgetBytes: 1024,
    });
    const primitives = new PrimitiveCollection({ destroyPrimitives: false });
    const parent = new PrimitiveCollection({ destroyPrimitives: false });
    const state = frame();
    const scene = { primitives, mode: SceneMode.SCENE3D, preUpdate: new Event(), preRender: new Event(), postRender: new Event(), _frameState: state };
    state.camera._scene = scene;
    const consume = () => state.afterRender!.splice(0).map(callback => callback());
    try {
      await tileset.whenReady();
      expect(tileset.stats().gpuMemory.maxBytes).toBe(1024);
      primitives.add(parent);
      parent.add(tileset);
      tileset.prePassesUpdate(state);
      expect(consume()).toEqual([true]);
      expect(scene.preRender.numberOfListeners).toBe(1);
      expect(scene.postRender.numberOfListeners).toBe(2);
      expect(scene.preUpdate.numberOfListeners).toBe(1);
      expect(primitives.primitiveRemoved.numberOfListeners).toBe(1);
      expect(parent.primitiveRemoved.numberOfListeners).toBe(1);
      parent.remove(tileset);
      expect(tileset.isDestroyed()).toBe(false);
      expect(consume()).toEqual([true]);
      expect(scene.preRender.numberOfListeners).toBe(0);
      expect(scene.postRender.numberOfListeners).toBe(0);
      expect(scene.preUpdate.numberOfListeners).toBe(0);
      expect(primitives.primitiveRemoved.numberOfListeners).toBe(0);
      expect(parent.primitiveRemoved.numberOfListeners).toBe(0);
      tileset.setGpuMemoryBudgetBytes(2048);
      expect(consume()).toEqual([]);
      parent.add(tileset);
      tileset.prePassesUpdate(state);
      expect(consume()).toEqual([true]);
      primitives.remove(parent);
      expect(consume()).toEqual([true]);
      expect(scene.preRender.numberOfListeners).toBe(0);
      expect(scene.postRender.numberOfListeners).toBe(0);
      expect(scene.preUpdate.numberOfListeners).toBe(0);
      primitives.add(parent);
      tileset.prePassesUpdate(state);
      expect(consume()).toEqual([true]);
      tileset.destroy();
      expect(consume()).toEqual([true]);
      expect(scene.preRender.numberOfListeners).toBe(0);
      expect(parent.primitiveRemoved.numberOfListeners).toBe(0);
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
      parent.removeAll();
      primitives.removeAll();
      parent.destroy();
      primitives.destroy();
    }
  });

  it('wakes an idle scene when first observed and after visibility changes, then stays quiet', async () => {
    const tileset = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] }, show: false });
    const state = frame();
    const consume = () => state.afterRender!.splice(0).map(callback => callback());
    try {
      await tileset.whenReady();
      tileset.prePassesUpdate(state);
      expect(consume()).toEqual([true]);
      tileset.prePassesUpdate(state);
      expect(consume()).toEqual([]);
      tileset.show = true;
      tileset.prePassesUpdate(state);
      expect(consume()).toEqual([true]);
      tileset.show = false;
      tileset.prePassesUpdate(state);
      expect(consume()).toEqual([true]);
      tileset.prePassesUpdate(state);
      expect(consume()).toEqual([]);
      expect(tileset.destroy()).toBeUndefined();
      expect(consume()).toEqual([true]);
      expect(tileset.isDestroyed()).toBe(true);
      expect(() => tileset.whenReady()).toThrow();
      expect(() => tileset.setGpuMemoryBudgetBytes(1024)).toThrow();
      expect(() => tileset.destroy()).toThrow();
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });

  it('continues asynchronous style loading through the first frame queue', async () => {
    const tileset = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    const state = frame();
    try {
      // Bind the callback while style loading is still pending.
      expect(tileset.ready).toBe(false);
      tileset.update(state);
      tileset.setGpuMemoryBudgetBytes(1024);
      state.passes = { render: true, pick: false };
      state.newFrame = true;
      tileset.update(state);
      expect(tileset.ready).toBe(false);
      expect(state.afterRender!.shift()!()).toBe(true);
      await tileset.whenReady();
      expect(state.afterRender).toHaveLength(1);
      expect(state.afterRender!.shift()!()).toBe(true);

      tileset.setGpuMemoryBudgetBytes(1024);
      tileset.setGpuMemoryBudgetBytes(2048);
      expect(state.afterRender).toHaveLength(1);
      expect(state.afterRender!.shift()!()).toBe(true);

      // Cesium clears and reuses the queue after every frame.
      tileset.setGpuMemoryBudgetBytes(4096);
      expect(state.afterRender).toHaveLength(1);
      const pending = state.afterRender![0];
      tileset.destroy();
      expect(pending()).toBe(false);
      expect(state.afterRender!.shift()!()).toBe(true);
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });

  it('drapes fills with the provider supplied by the frame and detaches a replaced provider', async () => {
    const tileset = new CesiumVectorTileset({
      style: { version: 8, sources: {}, layers: [] },
      heightReference: HeightReference.CLAMP_TO_GROUND,
    });
    const provider = { markForFrame: vi.fn(), remove: vi.fn() };
    const replacement = { markForFrame: vi.fn(), remove: vi.fn() };
    const state = frame(provider);
    try {
      tileset.update(state);
      await tileset.whenReady();
      const renderer = ((tileset as unknown as { _renderer: { vector: VectorTileRenderer } })._renderer).vector;
      const sceneCollections = ((tileset as unknown as { _renderer: { collections: SceneCollections } })._renderer).collections;
      const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
      const layer = new FillStyleLayer({ id: 'land', type: 'fill', source: 'land', paint: { 'fill-antialias': false } });
      layer.recalculate(new EvaluationParameters(0), []);
      const bucket = new FillBucket({ layers: [layer], zoom: 0 } as never);
      bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
      buildVectorTile(renderer, { tileId: `land/${tileID.key}`, buckets: { land: bucket }, tileID });
      const [collection] = renderer.getTileCollections(`land/${tileID.key}`);
      expect(collection).toBeInstanceOf(BufferPolygonCollection);
      expect((collection as BufferPolygonCollection).heightReference).toBe(HeightReference.CLAMP_TO_GROUND);
      sceneCollections.add(collection!);
      renderer.markDrapedCollections(1, new Map([['land', 0]]));
      expect(provider.markForFrame).toHaveBeenCalledWith(collection, 1, HeightReference.CLAMP_TO_GROUND);

      provider.markForFrame.mockClear();
      sceneCollections.syncDrapedVisibility(new Map([['land', false]]));
      renderer.markDrapedCollections(2, new Map([['land', 0]]));
      expect(provider.markForFrame).not.toHaveBeenCalled();
      expect(provider.remove).toHaveBeenCalledWith(collection);
      // Cesium's next Native collection pass sees show, not our provider removal.
      expect(collection!.show).toBe(false);
      sceneCollections.syncDrapedVisibility(new Map([['land', true]]));
      renderer.markDrapedCollections(3, new Map([['land', 0]]));
      expect(collection!.show).toBe(true);
      expect(provider.markForFrame).toHaveBeenCalledWith(collection, 3, HeightReference.CLAMP_TO_GROUND);

      state.camera._scene!.vectorProvider = replacement;
      // Keep the tile fixture out of source scheduling while exercising rebinding.
      tileset.show = false;
      tileset.update(state);
      expect(provider.remove).toHaveBeenCalledWith(collection);
      renderer.markDrapedCollections(2, new Map([['land', 0]]));
      expect(replacement.markForFrame).toHaveBeenCalledWith(collection, 2, HeightReference.CLAMP_TO_GROUND);
      tileset.destroy();
      expect(replacement.remove).toHaveBeenCalledWith(collection);
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });

  it('restores draped style visibility through coverage and successor readiness gates', () => {
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, vi.fn(), () => true);
    const old = new BufferPolygonCollection({ heightReference: HeightReference.CLAMP_TO_GROUND });
    const next = new BufferPolygonCollection({ heightReference: HeightReference.CLAMP_TO_GROUND });
    registerDrawLayers(old, ['land']);
    registerDrawLayers(next, ['land']);
    const nativeVisible = () => Array.from({ length: root.length }, (_, index) => root.get(index)).filter(collection => collection.show);
    try {
      scene.add(old);
      scene.syncDrapedVisibility(new Map([['land', false]]));
      expect(nativeVisible()).toEqual([]);

      // Repaint while hidden still owns an upload handoff.
      scene.replaceWhenReady('land/tile', old, next);
      expect(scene.hasPendingReplacement('land/tile')).toBe(true);
      scene.syncDrapedVisibility(new Map([['land', true]]));
      expect(nativeVisible()).toEqual([old]);
      expect(next.show).toBe(false);

      // Coverage may be changed again after style synchronization.
      scene.setVectorVisibility(old, false);
      scene.setVectorVisibility(next, true);
      scene.syncDrapedVisibility(new Map([['land', true]]));
      expect(nativeVisible()).toEqual([]);
      scene.setVectorVisibility(old, true);
      expect(nativeVisible()).toEqual([old]);

      // A hidden first upload may finish, but cannot reveal a hidden style.
      scene.syncDrapedVisibility(new Map([['land', false]]));
      vi.spyOn(next, 'update').mockImplementation(() => {});
      scene.pumpFirstUpdates(frame(), UNBOUNDED_BUDGET);
      expect(scene.hasPendingReplacement('land/tile')).toBe(false);
      expect(nativeVisible()).toEqual([]);
      scene.syncDrapedVisibility(new Map([['land', true]]));
      expect(nativeVisible()).toEqual([next]);
      expect(old.show).toBe(false);
    }
    finally {
      scene.flushRemovals();
      root.removeAll();
      if (!old.isDestroyed())
        old.destroy();
      if (!next.isDestroyed())
        next.destroy();
      root.destroy();
    }
  });
});
