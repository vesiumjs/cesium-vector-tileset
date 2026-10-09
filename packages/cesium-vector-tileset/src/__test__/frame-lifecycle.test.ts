import type { MapProjection } from 'cesium';
import type { RenderFrameState } from '../render/scene/render-frame';
import type { StyleEvaluation } from '../render/scene/style-evaluation';
import type { TilePublishQueue } from '../render/scene/tile-publish-queue';
import type { TileResidency } from '../render/scene/tile-residency';
import type { SymbolPlacementScope } from '../render/symbol/symbol-placement-pass';
import type { SymbolTileRenderer } from '../render/symbol/symbol-renderer';
import type { VectorDrapingProvider } from '../render/vector/vector-tile-renderer';
import type { Style } from '../style/style';
import Point from '@mapbox/point-geometry';
import * as Cesium from 'cesium';
import { BufferPolygonCollection, Cartesian3, Event, GeographicProjection, HeightReference, Matrix4, PrimitiveCollection, Rectangle, SceneMode, WebMercatorProjection, WebMercatorTilingScheme } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../cesium-vector-tileset';
import { FillBucket } from '../data/bucket/fill-bucket';
import { GeometryPrimitive, updateGeometryWithBudget } from '../render/geometry/geometry-primitive';
import { createLineGeometry } from '../render/line/line-geometry';
import { cameraFrame } from '../render/scene/__test__/camera-helper';
import { cityOrbitFrame } from '../render/scene/__test__/view-priority-helper';
import { drawBatchForOwner, registerDrawLayers } from '../render/scene/draw-batch';
import { UNBOUNDED_BUDGET } from '../render/scene/frame-budget';
import { zoomForFrame } from '../render/scene/render-frame';
import { SceneCollections } from '../render/scene/scene-collections';
import { SceneFrameWork } from '../render/scene/scene-frame-budget';
import { SymbolProjectionContext } from '../render/symbol/symbol-placement';
import { buildVectorTile } from '../render/vector/__test__/vector-tile-helper';
import { VectorTileRenderer } from '../render/vector/vector-tile-renderer';
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
async function uploadedWaterLifecycle(mode = SceneMode.SCENE3D, projection?: MapProjection) {
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
  const state: RenderFrameState = { ...cameraFrame({ mode, projection, height: 3000 }), frameNumber: 0, commandList: [], afterRender: [], passes: { render: true, pick: false } };
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
  const uploads = new WeakMap<BufferPolygonCollection | GeometryPrimitive, { vertexArray: object; command: NonNullable<RenderFrameState['commandList']>[number] }>();
  // No WebGL in jsdom: this represents a completed Native upload and reuses
  // its same VA/command. Root source, residency, paint and wake logic are real.
  let onDraw: (() => void) | undefined;
  const draw = function (this: BufferPolygonCollection | GeometryPrimitive, value: unknown) {
    expect(drawBatchForOwner(this)?.layerId, 'The only GPU boundary in this owner fixture is the real water bucket').toBe('water');
    let gpu = uploads.get(this);
    if (!gpu) {
      const vertexArray = { numberOfAttributes: 0, getAttribute: vi.fn(), isDestroyed: () => false, destroy: vi.fn() };
      const command = new native.DrawCommand({ owner: this, pass: native.Pass.OPAQUE, vertexArray });
      gpu = { vertexArray, command };
      uploads.set(this, gpu);
      if (this instanceof GeometryPrimitive)
        Object.assign(this, { _ready: true, _va: [vertexArray] });
      else
        Object.assign(this, { _renderContext: { vertexArray, command, destroy: vi.fn() } });
    }
    if (this.show) {
      (value as RenderFrameState).commandList!.push(gpu.command);
      const callback = onDraw;
      onDraw = undefined;
      callback?.();
    }
  };
  const upload = mode === SceneMode.SCENE3D
    ? vi.spyOn(BufferPolygonCollection.prototype, 'update').mockImplementation(draw)
    : vi.spyOn(GeometryPrimitive.prototype, 'update').mockImplementation(draw);
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
    const water = collections.flatMap(collection => collection instanceof PrimitiveCollection
      ? Array.from({ length: collection.length }, (_, index) => collection.get(index) as GeometryPrimitive)
      : [collection]).filter(collection => drawBatchForOwner(collection)?.layerId === 'water');
    expect(water).toHaveLength(1);
    expect(water[0].show).toBe(true);
    expect(collections.every(collection => tileset.contains(collection))).toBe(true);
    expect(uploads.has(water[0] as BufferPolygonCollection | GeometryPrimitive)).toBe(true);
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

describe('stationary loading service', () => {
  it.each(['steady', 'camera', 'fov', 'early'] as const)('requests extra loading service only after the physical camera settles: %s', async (condition) => {
    const owner = await uploadedWaterLifecycle();
    const native = vi.spyOn(Cesium.Primitive.prototype, 'update').mockImplementation(() => {});
    const worker = { addEventListener: vi.fn(), removeEventListener: vi.fn(), terminate: vi.fn() };
    vi.spyOn(Cesium.TaskProcessor.prototype, 'scheduleTask').mockImplementation(function () {
      Object.assign(this, { _worker: worker });
      return new Promise(() => {});
    });
    const positions = new Float64Array(9000 * 3);
    for (let index = 0; index < 9000; index++)
      Cartesian3.pack(Cartesian3.fromDegrees(index / 10000, 30), positions as unknown as number[], index * 3);
    const geometry = createLineGeometry(positions, { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05, widthPx: 12 });
    const line = new GeometryPrimitive({ geometryInstances: new Cesium.GeometryInstance({ geometry: geometry as never }), appearance: new Cesium.Appearance() }, 'line');
    const collection = new PrimitiveCollection();
    collection.add(line);
    const internals = (owner.tileset as unknown as { _renderer: { collections: SceneCollections } })._renderer;
    try {
      internals.collections.add(collection);
      internals.collections.queueFirstUpdate([collection]);
      updateGeometryWithBudget(owner.state, { exhausted: true }, () => line.update(owner.state as never));
      const continuation = vi.spyOn(SceneFrameWork.prototype, 'continuation');
      vi.mocked(performance.now).mockReturnValue(condition === 'early' ? 100 : 300);
      if (condition === 'camera')
        owner.position(3000, 0.000002);
      if (condition === 'fov') {
        const frustum = owner.state.camera.frustum as Cesium.PerspectiveFrustum;
        frustum.fov *= 0.8;
      }
      expect(owner.tick().renderError).toBeUndefined();
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(owner.tick().renderError).toBeUndefined();
      expect(continuation).toHaveBeenCalled();
      const floors = continuation.mock.calls.map(call => call[2] ?? 0);
      if (condition === 'steady')
        expect(floors).toContain(12);
      else
        expect(floors.every(floor => floor === 0)).toBe(true);
      expect(native.mock.calls.length).toBeLessThanOrEqual(2);
    }
    finally {
      owner.tileset.destroy();
      if (!collection.isDestroyed())
        collection.destroy();
      vi.restoreAllMocks();
    }
  });
});

const preparationModes = [
  { name: '3D', mode: SceneMode.SCENE3D, projection: new GeographicProjection() },
  { name: 'CV geographic', mode: SceneMode.COLUMBUS_VIEW, projection: new GeographicProjection() },
  { name: 'CV Mercator', mode: SceneMode.COLUMBUS_VIEW, projection: new WebMercatorProjection() },
];

describe('primitive frame lifecycle', () => {
  it.each(preparationModes)('continues $name CPU preparation after the completed draw without redrawing or publishing in that tick', async ({ mode, projection }) => {
    const owner = await uploadedWaterLifecycle(mode, projection);
    let now = 0;
    vi.mocked(performance.now).mockImplementation(() => now);
    const internals = (owner.tileset as unknown as { _renderer: { collections: SceneCollections; publishQueue: TilePublishQueue } })._renderer;
    const publish = vi.spyOn(internals.publishQueue, 'drain');
    let drawnCommands: object[] = [];
    let drawCalls = 0;
    const advance = vi.spyOn(internals.collections, 'advancePreparations').mockImplementation((state, budget, measure, minimum) => {
      expect(state.commandList).toEqual(drawnCommands);
      expect(owner.upload).toHaveBeenCalledTimes(drawCalls);
      expect(minimum).toBe(false);
      expect(budget.takeMinimumProgress).toBeUndefined();
      expect(budget.exhausted).toBe(false);
      measure(() => now += 2);
      return { units: 1, renderNeeded: true };
    });
    try {
      const child = new PrimitiveCollection();
      Object.assign(child, { postPassesUpdate: () => {
        now = 12;
        drawnCommands = [...owner.state.commandList!];
        drawCalls = owner.upload.mock.calls.length;
        publish.mockClear();
        vi.spyOn(internals.collections, 'hasRunnablePreparations', 'get').mockReturnValue(true);
      } });
      owner.tileset.add(child);
      owner.position(3000, 0.000001);
      const result = owner.tick();
      expect(result.rendered).toBe(true);
      expect(result.renderError).toBeUndefined();
      expect(advance).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(owner.state.commandList).toEqual(drawnCommands);
      expect(owner.upload).toHaveBeenCalledTimes(drawCalls);
      expect(result.requested).toBe(true);
    }
    finally {
      owner.tileset.destroy();
      vi.restoreAllMocks();
    }
  });

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

  it('shortens stopped zoom-out recency on idle Native ticks and owns the earlier render wake', async () => {
    const owner = await uploadedWaterLifecycle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    vi.mocked(performance.now).mockImplementation(() => now);
    const batch = { geometry: { pairs: [] }, options: { pairs: [] } };
    const internals = (owner.tileset as unknown as { _renderer: { symbol: { _targetPlacement: SymbolPlacementScope<typeof batch> }; wake: { continuePlacement: () => boolean } } })._renderer;
    const scope = internals.symbol._targetPlacement;
    const view = { viewProjection: new Float64Array(16), width: 1000, height: 1000, pixelRatio: 1, cameraZoom: 10 };
    scope.prepare([batch]);
    scope.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext());
    now = 20;
    vi.advanceTimersByTime(20);
    scope.advance({ ...view, cameraZoom: 9 }, UNBOUNDED_BUDGET, new SymbolProjectionContext());
    const advance = vi.spyOn(scope, 'advance');
    try {
      expect(scope.nextPlacementTime).toBe(300);
      internals.wake.continuePlacement();
      expect(vi.getTimerCount()).toBe(1);
      now = 40;
      vi.advanceTimersByTime(20);
      expect(owner.tick().rendered).toBe(false);
      expect(advance).not.toHaveBeenCalled();
      expect(scope.nextPlacementTime).toBeCloseTo(100);
      expect(owner.requestRender).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      now = 99;
      vi.advanceTimersByTime(59);
      expect(owner.requestRender).not.toHaveBeenCalled();
      now = 101;
      vi.advanceTimersByTime(2);
      expect(owner.requestRender).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(owner.tick().rendered).toBe(true);
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

  it.each(['hide', 'release', 'destroy'] as const)('cancels the owned placement wake on %s', async (action) => {
    const owner = await uploadedWaterLifecycle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    const internals = (owner.tileset as unknown as { _renderer: { symbol: SymbolTileRenderer; wake: { continuePlacement: () => boolean }; _releaseScene: () => void } })._renderer;
    vi.mocked(performance.now).mockImplementation(() => now);
    vi.spyOn(internals.symbol, 'nextPlacementTime', 'get').mockImplementation(() => now < 300 ? 300 : undefined);
    vi.spyOn(internals.symbol, 'hasRunnableWork', 'get').mockImplementation(() => now >= 300);
    try {
      internals.wake.continuePlacement();
      expect(vi.getTimerCount()).toBe(1);
      if (action === 'hide') {
        owner.tileset.show = false;
        owner.tick();
      }
      else if (action === 'release') {
        internals._releaseScene();
      }
      else {
        owner.tileset.destroy();
      }
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

  it.each([1, 2])('consumes a postRender covering wake already served by a camera render with %i viewports', async (viewports) => {
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

  it.each([1, 2])('preserves a fresh paint wake during the camera render that serves old covering debt with %i viewports', async (viewports) => {
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

  it.each([1, 2])('retains old covering debt when its camera render fails at the last Native viewport of %i', async (viewports) => {
    const owner = await uploadedWaterLifecycle();
    try {
      owner.position(6000);
      expect(owner.tick().rendered).toBe(true);
      expect(owner.state.afterRender).toHaveLength(1);
      owner.position(6000, 0.000001);
      const failure = new Error('Native water update failed');
      if (viewports === 2)
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

  it('retains a covering wake when the next camera frame cannot serve a hidden owner', async () => {
    const owner = await uploadedWaterLifecycle();
    try {
      owner.position(6000);
      expect(owner.tick().rendered).toBe(true);
      expect(owner.state.afterRender).toHaveLength(1);
      owner.tileset.show = false;
      owner.position(6000, 0.000001);
      const calls = owner.upload.mock.calls.length;
      const hidden = owner.tick();
      expect(hidden.cameraChanged).toBe(true);
      expect(hidden.renderError).toBeUndefined();
      expect(owner.upload.mock.calls.length).toBe(calls);
      expect(hidden.requested).toBe(true);
      owner.tileset.show = true;
      expect(owner.tick().rendered).toBe(true);
      owner.quiet();
    }
    finally {
      owner.tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it.each(preparationModes)('continues admitted $name CPU work on idle demand ticks without a full tileset update or publication', async ({ mode, projection }) => {
    const owner = await uploadedWaterLifecycle(mode, projection);
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

  it.each(preparationModes)('continues an admitted $name build before requesting evaluation of its unprepared sibling', async ({ mode, projection }) => {
    const owner = await uploadedWaterLifecycle(mode, projection);
    const { tileset, state, scene } = owner;
    const internals = (tileset as unknown as { _renderer: { collections: SceneCollections; publishQueue: TilePublishQueue; evaluation: StyleEvaluation } })._renderer;
    try {
      const update = vi.spyOn(tileset, 'update');
      const evaluate = vi.spyOn(internals.evaluation, 'evaluate');
      const publish = vi.spyOn(internals.publishQueue, 'drain');
      const commands = [...state.commandList!];
      const draws = owner.upload.mock.calls.length;
      vi.spyOn(internals.collections, 'hasRunnablePreparations', 'get').mockReturnValue(false);
      vi.spyOn(internals.publishQueue, 'inspectBuilds').mockReturnValue({ runnable: true, renderNeeded: true });
      const advance = vi.spyOn(internals.publishQueue, 'advanceBuilds').mockReturnValue({ steps: 1, ready: 0, renderNeeded: true });
      state.newFrame = false;
      scene.preUpdate.raiseEvent(scene);
      tileset.prePassesUpdate(state);
      expect(advance).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(state.commandList).toEqual(commands);
      expect(owner.upload).toHaveBeenCalledTimes(draws);
      expect(state.afterRender).toHaveLength(1);
      // A pending render must prevent a second idle preparation allowance.
      tileset.prePassesUpdate(state);
      expect(advance).toHaveBeenCalledOnce();
      expect(state.afterRender).toHaveLength(1);
    }
    finally {
      tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it.each(['unknown projection', 'mode mismatch', '3D only', '2D', 'morph'] as const)('keeps %s on the normal-render preparation path', async (capability) => {
    const owner = await uploadedWaterLifecycle(SceneMode.COLUMBUS_VIEW);
    const internals = (owner.tileset as unknown as { _renderer: { collections: SceneCollections; publishQueue: TilePublishQueue } })._renderer;
    try {
      if (capability === 'unknown projection') {
        const projection = new GeographicProjection();
        owner.state.mapProjection = {
          ellipsoid: projection.ellipsoid,
          project: projection.project.bind(projection),
          unproject: projection.unproject.bind(projection),
        };
      }
      else if (capability === 'mode mismatch') {
        owner.scene.mode = SceneMode.SCENE3D;
      }
      else if (capability === '3D only') {
        owner.state.scene3DOnly = true;
      }
      else {
        owner.state.mode = owner.scene.mode = capability === '2D' ? SceneMode.SCENE2D : SceneMode.MORPHING;
      }
      vi.spyOn(internals.collections, 'hasRunnablePreparations', 'get').mockReturnValue(true);
      vi.spyOn(internals.publishQueue, 'inspectBuilds').mockReturnValue({ runnable: true, renderNeeded: true });
      const prepare = vi.spyOn(internals.collections, 'advancePreparations');
      const build = vi.spyOn(internals.publishQueue, 'advanceBuilds');
      const commands = [...owner.state.commandList!];
      const draws = owner.upload.mock.calls.length;
      owner.state.newFrame = false;
      owner.scene.preUpdate.raiseEvent(owner.scene);
      owner.tileset.prePassesUpdate(owner.state);
      expect(internals.collections.idlePreparationsEnabled).toBe(false);
      expect(internals.publishQueue.idlePreparationsEnabled).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect(owner.state.commandList).toEqual(commands);
      expect(owner.upload).toHaveBeenCalledTimes(draws);
    }
    finally {
      owner.tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it('grants heavy paint progress after live camera paint without a second viewport quota', async () => {
    const tileset = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    const state = frame();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const evaluation = ((tileset as unknown as { _renderer: { evaluation: StyleEvaluation } })._renderer).evaluation;
    const evaluate = evaluation.evaluate.bind(evaluation);
    vi.spyOn(evaluation, 'evaluate').mockImplementation((zoom) => {
      now += 13;
      return evaluate(zoom);
    });
    const renderer = ((tileset as unknown as { _renderer: { vector: VectorTileRenderer } })._renderer).vector;
    vi.spyOn(renderer, 'needsPaintUpdate', 'get').mockReturnValue(true);
    vi.spyOn(renderer, 'updateLivePaint').mockImplementation(() => {
      now += 3;
    });
    const progress: number[] = [];
    vi.spyOn(renderer, 'updatePaint').mockImplementation(({ budget }) => {
      let count = 0;
      while (!budget!.exhausted) {
        count++;
        now += 0.1;
      }
      progress.push(count);
      return [];
    });
    try {
      await tileset.whenReady();
      tileset.update(state);
      expect(progress[0]).toBeGreaterThanOrEqual(19);
      expect(progress[0]).toBeLessThanOrEqual(21);
      tileset.update(state);
      expect(progress[1]).toBe(0);
    }
    finally {
      tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it('passes the current oblique ground center to tile publication', async () => {
    const tileset = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    const state: RenderFrameState = { ...cityOrbitFrame(), frameNumber: 1, commandList: [], afterRender: [] };
    const queue = ((tileset as unknown as { _renderer: { publishQueue: TilePublishQueue } })._renderer).publishQueue;
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(queue, 'size', 'get').mockReturnValue(1);
    const drain = vi.spyOn(queue, 'drain').mockReturnValue(0);
    try {
      await tileset.whenReady();
      tileset.update(state);
      expect(drain).toHaveBeenCalledTimes(1);
      const point = drain.mock.calls[0][2]!;
      expect(point.longitude * 180 / Math.PI).toBeCloseTo(-0.12760000000036453, 8);
      expect(point.latitude * 180 / Math.PI).toBeCloseTo(51.465168023536584, 8);
    }
    finally {
      tileset.destroy();
      vi.restoreAllMocks();
    }
  });

  it('shares preparation allowance between tilesets and both physical-frame viewports', async () => {
    const first = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    const second = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    const state = frame();
    const budgets: unknown[] = [];
    for (const tileset of [first, second]) {
      const collections = ((tileset as unknown as { _renderer: { collections: SceneCollections } })._renderer).collections;
      vi.spyOn(collections, 'pumpFirstUpdates').mockImplementation((_state, budget) => {
        budgets.push(budget);
        return [];
      });
    }
    try {
      await Promise.all([first.whenReady(), second.whenReady()]);
      first.update(state);
      second.update(state);
      first.update(state);
      expect(budgets[1]).toBe(budgets[0]);
      expect(budgets[2]).toBe(budgets[0]);
    }
    finally {
      first.destroy();
      second.destroy();
      vi.restoreAllMocks();
    }
  });

  it('bounds style preparation by the shared physical frame without resetting it for another viewport', async () => {
    const tileset = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    const state = frame();
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const evaluation = ((tileset as unknown as { _renderer: { evaluation: StyleEvaluation } })._renderer).evaluation;
    const evaluate = evaluation.evaluate.bind(evaluation);
    const style = vi.spyOn(evaluation, 'evaluate').mockImplementation((zoom) => {
      // Mandatory preparation exceeds the physical tile cutoff, 16.67 - 2ms.
      now += 15;
      return evaluate(zoom);
    });
    const collections = ((tileset as unknown as { _renderer: { collections: SceneCollections } })._renderer).collections;
    const allowances: boolean[] = [];
    const upload = vi.spyOn(collections, 'pumpFirstUpdates').mockImplementation((_frame, budget) => {
      allowances.push(budget.exhausted);
      return [];
    });
    try {
      await tileset.whenReady();
      tileset.update(state);
      style.mockImplementation(zoom => evaluate(zoom));
      tileset.update(state);
      state.frameNumber = 2;
      tileset.update(state);
      expect(allowances).toEqual([true, true, false]);
    }
    finally {
      upload.mockRestore();
      style.mockRestore();
      clock.mockRestore();
      tileset.destroy();
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

  it('keeps each successor coverage policy when one tile contains visible and hidden fills', () => {
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, vi.fn(), () => true);
    const land = new BufferPolygonCollection({ heightReference: HeightReference.CLAMP_TO_GROUND });
    const water = new BufferPolygonCollection({ heightReference: HeightReference.CLAMP_TO_GROUND });
    registerDrawLayers(land, ['land']);
    registerDrawLayers(water, ['water']);
    try {
      scene.restoreWhenReady('source/tile', [land, water]);
      scene.syncTileVisibility({ hiddenLayers: new Map([['source/tile', new Set(['land'])]]), hiddenSymbols: new Set() }, { hiddenLayers: new Map(), hiddenSymbols: new Set() });
      scene.syncDrapedVisibility(new Map([['land', true], ['water', true]]));
      vi.spyOn(land, 'update').mockImplementation(() => {});
      vi.spyOn(water, 'update').mockImplementation(() => {});
      scene.pumpFirstUpdates(frame(), UNBOUNDED_BUDGET);
      scene.syncDrapedVisibility(new Map([['land', true], ['water', true]]));
      expect(land.show).toBe(false);
      expect(water.show).toBe(true);
    }
    finally {
      scene.clearPendingReplacements();
      scene.flushRemovals();
      root.removeAll();
      if (!land.isDestroyed())
        land.destroy();
      if (!water.isDestroyed())
        water.destroy();
      root.destroy();
    }
  });

  it('leaves ordinary polygon paint visibility to its owner', () => {
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, vi.fn(), () => true);
    const polygon = new BufferPolygonCollection();
    registerDrawLayers(polygon, ['land']);
    try {
      polygon.show = false;
      scene.add(polygon);
      scene.syncDrapedVisibility(new Map([['land', true]]));
      expect(polygon.show).toBe(false);
      scene.syncDrapedVisibility(new Map([['land', false]]));
      scene.setVectorVisibility(polygon, true);
      expect(polygon.show).toBe(true);
    }
    finally {
      root.removeAll();
      polygon.destroy();
      root.destroy();
    }
  });

  it('normalizes persistent provider insertion order only when visible polygon order changes', () => {
    const renderer = new VectorTileRenderer();
    const marked = new Map<BufferPolygonCollection, HeightReference>();
    const provider = {
      markForFrame: vi.fn((collection: BufferPolygonCollection, _frame: number, reference: HeightReference) => marked.set(collection, reference)),
      remove: vi.fn((collection: BufferPolygonCollection) => marked.delete(collection)),
    };
    const foreign = new BufferPolygonCollection();
    const order = new Map([['land', 0], ['detail', 1]]);
    const tileID = new OverscaledTileID(14, 0, 14, 8186, 5446);
    const layers = ['land', 'detail'].map(id => new FillStyleLayer({ id, type: 'fill', source: 'world', paint: { 'fill-color': id === 'land' ? '#3366aa' : '#ff00ff', 'fill-antialias': false } }));
    for (const layer of layers)
      layer.recalculate(new EvaluationParameters(0), []);
    const bucket = new FillBucket({ layers, zoom: 0 } as never);
    bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
    renderer.setDraping(provider, HeightReference.CLAMP_TO_GROUND);
    buildVectorTile(renderer, { tileId: `world/${tileID.key}`, buckets: { land: bucket, detail: bucket }, tileID, layerOrder: order });
    const [land, detail] = renderer.getTileCollections(`world/${tileID.key}`) as BufferPolygonCollection[];
    const names = new Map([[foreign, 'foreign'], [land!, 'land'], [detail!, 'detail']]);
    const markedNames = () => [...marked.keys()].map(collection => names.get(collection));
    try {
      // Native marks before the tileset, and set(existing) preserves this wrong order.
      marked.set(foreign, HeightReference.CLAMP_TO_GROUND);
      marked.set(detail!, HeightReference.CLAMP_TO_GROUND);
      marked.set(land!, HeightReference.CLAMP_TO_GROUND);
      expect(renderer.markDrapedCollections(1, order)).toBe(true);
      expect(markedNames()).toEqual(['foreign', 'land', 'detail']);
      expect(provider.remove).not.toHaveBeenCalledWith(foreign);

      provider.remove.mockClear();
      expect(renderer.markDrapedCollections(2, order)).toBe(false);
      expect(provider.remove).not.toHaveBeenCalled();

      detail!.show = false;
      renderer.markDrapedCollections(3, order);
      expect(markedNames()).toEqual(['foreign', 'land']);
      detail!.show = true;
      renderer.markDrapedCollections(4, order);
      expect(markedNames()).toEqual(['foreign', 'land', 'detail']);
      renderer.markDrapedCollections(5, new Map([['detail', 0], ['land', 1]]));
      expect(markedNames()).toEqual(['foreign', 'detail', 'land']);

      provider.remove.mockClear();
      renderer.markDrapedCollections(6, new Map([['detail', 0], ['land', 1]]));
      expect(provider.remove).not.toHaveBeenCalled();
      renderer.removeTile(`world/${tileID.key}`);
      expect(renderer.markDrapedCollections(7, order)).toBe(true);
      provider.remove.mockClear();
      expect(renderer.markDrapedCollections(8, order)).toBe(false);
      expect(provider.remove).not.toHaveBeenCalled();
      renderer.undrapeAll();
      expect(markedNames()).toEqual(['foreign']);
    }
    finally {
      renderer.removeAll();
      if (!land!.isDestroyed())
        land!.destroy();
      if (!detail!.isDestroyed())
        detail!.destroy();
      foreign.destroy();
    }
  });
});
