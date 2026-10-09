import type { TilePublishQueue } from '../../scene/tile-publish-queue';
import type { GeometryPrepareBatchRequest } from '../geometry-preparation';
import * as Cesium from 'cesium';
import { Appearance, BoundingSphere, buildModuleUrl, Cartesian3, Cartesian4, Event as CesiumEvent, Color, ComponentDatatype, GeographicProjection, Geometry, GeometryInstance, GeometryInstanceAttribute, Matrix4, Primitive, PrimitiveCollection, SceneMode, TaskProcessor } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../../../cesium-vector-tileset';
import { CanonicalTileID } from '../../../tile/tile-id';
import { lineAppearanceForMode } from '../../line/line-appearance-mode';
import { createLineGeometry } from '../../line/line-geometry';
import { lineGroundScale } from '../../line/line-ground-scale';
import { DashLineAppearance, LineAAAppearance } from '../../line/line-renderer';
import { LineTileClip } from '../../line/line-tile-clip';
import { registerDrawBatch, registerLinePaint } from '../../scene/draw-batch';
import { DrawCommands } from '../../scene/draw-commands';
import { FrameBudget, UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { SceneCollections } from '../../scene/scene-collections';
import { acquireSceneFrameBudget } from '../../scene/scene-frame-budget';
import { prepareGeometryBatch } from '../geometry-preparation';
import { GeometryPrimitive, updateGeometryWithBudget } from '../geometry-primitive';
import { lineInputs } from '../line-input';

const textures = vi.hoisted(() => ({ created: [] as Array<{ source: { arrayBufferView: Uint32Array } }> }));
const gpu = vi.hoisted(() => ({
  buffers: [] as Array<{ sizeInBytes: number; isDestroyed: () => boolean }>,
  textures: [] as Array<{ isDestroyed: () => boolean }>,
  writes: [] as number[],
  failBufferCopy: false,
  failTextureCopy: false,
}));
vi.mock('cesium', async (original) => {
  const native = await original<typeof import('cesium')>();
  class GpuBuffer {
    readonly sizeInBytes: number;
    private destroyed = false;
    constructor(options: { sizeInBytes: number }) {
      this.sizeInBytes = options.sizeInBytes;
      gpu.buffers.push(this);
    }

    copyFromArrayView(values: ArrayBufferView) {
      if (gpu.failBufferCopy)
        throw new Error('GPU range copy failed');
      gpu.writes.push(values.byteLength);
    }

    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  class VertexArray {
    readonly numberOfAttributes: number;
    readonly indexBuffer: GpuBuffer;
    private readonly attributes: Array<{ vertexBuffer: GpuBuffer }>;
    private destroyed = false;
    constructor(options: { attributes: Array<{ vertexBuffer: GpuBuffer }>; indexBuffer: GpuBuffer }) {
      this.attributes = options.attributes;
      this.numberOfAttributes = options.attributes.length;
      this.indexBuffer = options.indexBuffer;
    }

    getAttribute(index: number) { return this.attributes[index]; }
    isDestroyed() { return this.destroyed; }
    destroy() {
      this.destroyed = true;
      for (const attribute of this.attributes) attribute.vertexBuffer.destroy();
      this.indexBuffer.destroy();
    }
  }
  return {
    ...native,
    Buffer: { createVertexBuffer: (options: { sizeInBytes: number }) => new GpuBuffer(options), createIndexBuffer: (options: { sizeInBytes: number }) => new GpuBuffer(options) },
    VertexArray,
    ContextLimits: { maximumTextureSize: 4096 },
    Texture: class {
      readonly width: number;
      readonly height: number;
      readonly sizeInBytes: number;
      private readonly values: Uint32Array;
      private destroyed = false;
      constructor(options: { width: number; height: number }) {
        this.width = options.width;
        this.height = options.height;
        this.sizeInBytes = options.width * options.height * 16;
        this.values = new Uint32Array(options.width * options.height * 4);
        gpu.textures.push(this);
        textures.created.push({ source: { arrayBufferView: this.values } });
      }

      copyFrom(options: { source: { arrayBufferView: Uint32Array }; yOffset: number }) {
        if (gpu.failTextureCopy)
          throw new Error('GPU texture copy failed');
        gpu.writes.push(options.source.arrayBufferView.byteLength);
        this.values.set(options.source.arrayBufferView, options.yOffset * this.width * 4);
      }

      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; }
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  gpu.failBufferCopy = false;
  gpu.failTextureCopy = false;
  gpu.buffers.length = 0;
  gpu.textures.length = 0;
  gpu.writes.length = 0;
});

function lineOwner(count: number): GeometryPrimitive {
  const positions = new Float64Array(count * 3);
  for (let index = 0; index < count; index++)
    Cartesian3.pack(Cartesian3.fromDegrees(index / 10000, 30), positions as unknown as number[], index * 3);
  const geometry = createLineGeometry(positions, { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05, widthPx: 12 }) as Geometry;
  const vertexShaderSource = `${['3D', '2D'].flatMap(track => ['position', 'positionLow', 'prevOffset', 'nextOffset'].map(name => `in vec3 ${name === 'position' ? `position${track}High` : name === 'positionLow' ? `position${track}Low` : `${name}${track}`};`)).join('\n')}\nvoid main() {}`;
  return new GeometryPrimitive({ geometryInstances: new GeometryInstance({ geometry, id: 'line' }), appearance: new Appearance({ vertexShaderSource }) }, 'line');
}

function frame() {
  return { mode: SceneMode.SCENE3D, mapProjection: new GeographicProjection(), scene3DOnly: false, context: { elementIndexUint: true, webgl2: true }, passes: { render: true, pick: false }, commandList: [], afterRender: [] as Array<() => boolean> };
}

interface NativeCommand {
  owner: Primitive;
  boundingVolume: BoundingSphere;
  uniformMap: Record<string, () => unknown>;
  renderState: { depthMask: boolean };
  pass: number;
  dirty: boolean;
  lastDirtyTime: number;
  derivedCommands: { logDepth?: { command: NativeCommand } };
  count?: number;
  instanceCount?: number;
  vertexArray?: object;
  modelMatrix?: Matrix4;
  pickMetadataAllowed?: boolean;
}

async function pendingLinePage(specializeAppearance?: 'solid' | 'dash', linePoints = 9000) {
  const native = Cesium as unknown as { DrawCommand: new (options: object) => NativeCommand };
  const commands = new WeakMap<object, NativeCommand>();
  vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (...args: unknown[]) {
    Object.assign(this, { _batchTable: { attributes: [], destroy: () => undefined } });
    const arrays = (this as unknown as { _va?: object[] })._va;
    if (arrays?.length) {
      let command = commands.get(this);
      if (!command) {
        command = new native.DrawCommand({ owner: this, vertexArray: arrays[0] });
        commands.set(this, command);
      }
      (args[0] as { commandList: NativeCommand[] }).commandList.push(command);
    }
  });
  const worker = { addEventListener: vi.fn(), removeEventListener: vi.fn(), terminate: vi.fn() };
  vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters) {
    Object.assign(this, { _worker: worker });
    const transfers: ArrayBuffer[] = [];
    return Promise.resolve(prepareGeometryBatch(structuredClone(parameters) as GeometryPrepareBatchRequest, transfers));
  });
  const source = lineOwner(linePoints);
  if (specializeAppearance)
    source.appearance = specializeAppearance === 'solid' ? new LineAAAppearance() : new DashLineAppearance({ translucent: true, material: new Cesium.Material({ fabric: { source: 'czm_material czm_getMaterial(czm_materialInput materialInput) { return czm_getDefaultMaterial(materialInput); }' } }) });
  const template = source.geometryInstances as GeometryInstance;
  const owner = new GeometryPrimitive({
    geometryInstances: [0, 1, 2].map(featureIndex => new GeometryInstance({ geometry: template.geometry, id: { featureIndex } })),
    appearance: source.appearance,
  }, 'line', 0, specializeAppearance ? lineAppearanceForMode : undefined);
  source.destroy();
  const root = new PrimitiveCollection();
  const scene = new SceneCollections(root, vi.fn(), () => true);
  const collection = new PrimitiveCollection();
  collection.add(owner);
  scene.add(collection);
  scene.queueFirstUpdate([collection]);
  const state = { ...frame(), frameNumber: 1, commandList: [] as NativeCommand[] };
  scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  // CPU restore is allowed in idle, but texture/VA writes still await render.
  owner.advancePreparation(state, UNBOUNDED_BUDGET);
  state.frameNumber++;
  return { owner, collection, root, scene, state };
}

describe('budgeted Native line pages', () => {
  it.each(['solid', 'dash'] as const)('selects immutable %s owner shaders at the Native boundary through mode changes without replacing geometry', async (kind) => {
    const { owner, root, scene, state } = await pendingLinePage(kind, 16);
    const other = await pendingLinePage(kind, 16);
    const observed: Appearance[] = [];
    const update = vi.mocked(Primitive.prototype.update);
    const original = update.getMockImplementation()!;
    update.mockImplementation(function (...args: unknown[]) {
      observed.push(this.appearance as Appearance);
      return Reflect.apply(original, this, args);
    });
    try {
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      const spatial = observed.at(-1)!;
      expect(spatial.vertexShaderSource).not.toContain('czm_morphTime');
      expect(spatial.fragmentShaderSource).not.toContain('czm_morphTime');
      expect(spatial.vertexShaderSource).toContain('if (1.0 != 0.0)');
      other.state.mode = SceneMode.COLUMBUS_VIEW;
      other.scene.pumpFirstUpdates(other.state as never, UNBOUNDED_BUDGET);
      expect(other.owner.appearance.vertexShaderSource).toContain('if (0.0 != 0.0)');
      expect(owner.appearance).toBe(spatial);
      const texture = owner.positionTexture;
      const uniforms = (spatial as Appearance & { uniforms: Record<string, unknown> }).uniforms;
      const material = spatial.material;
      const geometry = (owner as unknown as { _va: object[] })._va;
      owner.update(state);
      expect(observed.at(-1)).toBe(spatial);
      state.mode = SceneMode.COLUMBUS_VIEW;
      owner.update(state);
      const planar = observed.at(-1)!;
      expect(planar).not.toBe(spatial);
      expect(planar.vertexShaderSource).toContain('if (0.0 != 0.0)');
      expect(planar.fragmentShaderSource).not.toContain('czm_morphTime');
      expect((planar as Appearance & { uniforms: object }).uniforms).toBe(uniforms);
      expect(uniforms.lineRecord_texture).toBe(texture);
      expect(planar.material).toBe(material);
      state.mode = SceneMode.SCENE2D;
      owner.update(state);
      expect(observed.at(-1)).toBe(planar);
      state.mode = SceneMode.MORPHING;
      owner.update(state);
      expect(observed.at(-1)!.vertexShaderSource).toContain('if (czm_morphTime != 0.0)');
      expect(observed.at(-1)!.fragmentShaderSource).toContain('czm_morphTime');
      state.mode = SceneMode.SCENE3D;
      owner.update(state);
      expect(observed.at(-1)).toBe(spatial);
      expect(owner.positionTexture).toBe(texture);
      expect((owner as unknown as { _va: object[] })._va).toBe(geometry);
      expect(other.owner.appearance).not.toBe(spatial);
      expect(other.owner.positionTexture).not.toBe(texture);
    }
    finally {
      root.destroy();
      other.root.destroy();
    }
  });

  it.each(['steady', 'persistent transition', 'changed style', 'changed pixel ratio'])('advances resource bytes through the real Root idle seam during %s without a complete Scene render', async (condition) => {
    const { owner, root, scene, state } = await pendingLinePage();
    const tileset = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    await tileset.whenReady();
    const nativeScene = { mode: state.mode, mapProjection: state.mapProjection, requestRenderMode: true, requestRender: vi.fn() };
    const idle = { ...state, newFrame: false, pixelRatio: 1, camera: { _scene: nativeScene } };
    const internals = tileset as unknown as { _style: { _changed: boolean; getRenderTransitionFlags: () => { any: boolean } }; _vectorRenderer: { pixelRatio: number }; _tilePublishQueue: Pick<TilePublishQueue, 'advanceBuilds'> };
    internals._style._changed = condition === 'changed style';
    internals._vectorRenderer.pixelRatio = condition === 'changed pixel ratio' ? 2 : 1;
    if (condition === 'persistent transition') {
      vi.spyOn(internals._style, 'getRenderTransitionFlags').mockReturnValue({ ...internals._style.getRenderTransitionFlags(), any: true });
    }
    const cpuPreparation = vi.spyOn(scene, 'advancePreparations');
    const cpuBuild = vi.spyOn(internals._tilePublishQueue, 'advanceBuilds');
    Object.assign(tileset, { _sceneCollections: scene, _renderScene: nativeScene, _renderRequested: false, _lastShow: true });
    const nativeUpdate = vi.mocked(Primitive.prototype.update);
    nativeUpdate.mockClear();
    state.commandList.length = 0;
    const writes = gpu.writes.length;
    try {
      tileset.prePassesUpdate(idle as never);
      expect(gpu.writes.length).toBeGreaterThan(writes);
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(state.commandList).toHaveLength(0);
      expect(owner.ready).toBe(false);
      if (condition !== 'steady') {
        expect(cpuPreparation).not.toHaveBeenCalled();
        expect(cpuBuild).not.toHaveBeenCalled();
      }
    }
    finally {
      tileset.destroy();
      if (!root.isDestroyed())
        root.destroy();
    }
  });

  it('advances bounded resource bytes at the safe seam without Native update, commands or readiness', async () => {
    const { owner, root, scene, state } = await pendingLinePage();
    scene.idlePreparationsEnabled = true;
    const nativeUpdate = vi.mocked(Primitive.prototype.update);
    try {
      scene.pumpFirstUpdates(state as never, { exhausted: true }, undefined, true);
      nativeUpdate.mockClear();
      state.commandList.length = 0;
      const writes = gpu.writes.length;
      scene.advancePreparations(state as never, UNBOUNDED_BUDGET, operation => operation(), false);
      expect(gpu.writes).toHaveLength(writes);
      const tick = {};
      const progress = scene.advanceResourceUploads(state as never, { exhausted: true }, tick, operation => operation(), true);
      expect(gpu.writes.length).toBeGreaterThan(writes);
      expect(progress.renderNeeded).toBe(false);
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(state.commandList).toHaveLength(0);
      for (const callback of state.afterRender.splice(0)) callback();
      expect(owner.ready).toBe(false);
      const copied = gpu.writes.length;
      scene.advanceResourceUploads(state as never, UNBOUNDED_BUDGET, tick, operation => operation(), true);
      expect(gpu.writes).toHaveLength(copied);
      root.destroy();
      scene.advanceResourceUploads(state as never, UNBOUNDED_BUDGET, {}, operation => operation(), true);
      expect(gpu.writes).toHaveLength(copied);
    }
    finally {
      if (!root.isDestroyed())
        root.destroy();
    }
  });

  it.each(['steady', 'persistent transition', 'changed style', 'changed pixel ratio'])('retains one shared overload admission for resource writes after an expensive real-render tick during %s', async (condition) => {
    const { owner, root, scene, state } = await pendingLinePage();
    const tileset = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    await tileset.whenReady();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(gpu.writes, 'push').mockImplementation((...writes) => {
      now += 3;
      return Array.prototype.push.apply(gpu.writes, writes);
    });
    let rendered: typeof state & { newFrame: boolean; pixelRatio: number; camera: { _scene: object } };
    let lease: ReturnType<typeof acquireSceneFrameBudget>;
    const nativeScene = {
      mode: state.mode,
      mapProjection: state.mapProjection,
      requestRenderMode: true,
      requestRender: vi.fn(),
      preUpdate: new CesiumEvent(),
      postRender: new CesiumEvent(),
      _frameState: undefined as object | undefined,
      render: () => {
        nativeScene.preUpdate.raiseEvent(nativeScene);
        const work = lease.frame(state.frameNumber);
        scene.pumpFirstUpdates(rendered as never, UNBOUNDED_BUDGET, operation => work.measure(operation), false, work.tileBudget);
        Object.assign(tileset, { _tileWorkFrame: { frameNumber: state.frameNumber, budget: work.tileBudget, successfulUpdate: true } });
        now = 100;
        const nativeUpdate = vi.mocked(Primitive.prototype.update);
        nativeUpdate.mockClear();
        const writes = gpu.writes.length;
        tileset.postPassesUpdate(rendered as never);
        expect(gpu.writes.length).toBeGreaterThan(writes);
        expect(nativeUpdate).not.toHaveBeenCalled();
        expect(owner.ready).toBe(false);
        const copied = gpu.writes.length;
        tileset.postPassesUpdate(rendered as never);
        expect(gpu.writes).toHaveLength(copied);
      },
    };
    rendered = { ...state, newFrame: true, pixelRatio: 1, camera: { _scene: nativeScene } };
    nativeScene._frameState = rendered;
    lease = acquireSceneFrameBudget(nativeScene, tileset);
    const internals = tileset as unknown as { _style: { _changed: boolean; getRenderTransitionFlags: () => { any: boolean } }; _vectorRenderer: { pixelRatio: number }; _tilePublishQueue: Pick<TilePublishQueue, 'advanceBuilds'> };
    internals._style._changed = condition === 'changed style';
    internals._vectorRenderer.pixelRatio = condition === 'changed pixel ratio' ? 2 : 1;
    if (condition === 'persistent transition') {
      vi.spyOn(internals._style, 'getRenderTransitionFlags').mockReturnValue({ ...internals._style.getRenderTransitionFlags(), any: true });
    }
    const cpuPreparation = vi.spyOn(scene, 'advancePreparations');
    const cpuBuild = vi.spyOn(internals._tilePublishQueue, 'advanceBuilds');
    scene.idlePreparationsEnabled = true;
    Object.assign(tileset, { _sceneCollections: scene, _renderScene: nativeScene, _sceneBudget: lease, _budgetScene: nativeScene });
    try {
      nativeScene.render();
      if (condition !== 'steady') {
        expect(cpuPreparation).not.toHaveBeenCalled();
        expect(cpuBuild).not.toHaveBeenCalled();
      }
    }
    finally {
      tileset.destroy();
      lease.release();
      if (!root.isDestroyed())
        root.destroy();
    }
  });

  it('shares resource admission across same-tick frame classification changes and advances on the next idle tick', async () => {
    const { root, scene, state } = await pendingLinePage();
    const observed = { preUpdate: new CesiumEvent(), postRender: new CesiumEvent() };
    const lease = acquireSceneFrameBudget(observed, root);
    scene.idlePreparationsEnabled = true;
    try {
      observed.preUpdate.raiseEvent(observed);
      const first = lease.frame(state.frameNumber);
      scene.advanceResourceUploads(state as never, { exhausted: true }, first.tileBudget, operation => first.measure(operation), true);
      const writes = gpu.writes.length;
      const reclassified = lease.frame(++state.frameNumber);
      expect(reclassified.tileBudget).toBe(first.tileBudget);
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET, operation => reclassified.measure(operation), false, reclassified.tileBudget);
      scene.advanceResourceUploads(state as never, UNBOUNDED_BUDGET, reclassified.tileBudget, operation => reclassified.measure(operation), true);
      expect(gpu.writes).toHaveLength(writes);
      observed.preUpdate.raiseEvent(observed);
      const idle = lease.frame(state.frameNumber);
      expect(idle.tileBudget).not.toBe(first.tileBudget);
      scene.advanceResourceUploads(state as never, { exhausted: true }, idle.tileBudget, operation => idle.measure(operation), true);
      expect(gpu.writes.length).toBeGreaterThan(writes);
    }
    finally {
      lease.release();
      root.destroy();
    }
  });

  it('publishes resource completion and hidden replacement readiness only through a real Native render', async () => {
    const { owner, collection, root, scene, state } = await pendingLinePage();
    scene.idlePreparationsEnabled = true;
    const previous = new PrimitiveCollection();
    scene.add(previous);
    scene.replaceWhenReady('roads', previous, collection);
    const nativeUpdate = vi.mocked(Primitive.prototype.update);
    nativeUpdate.mockClear();
    try {
      const progress = scene.advanceResourceUploads(state as never, UNBOUNDED_BUDGET, {}, operation => operation(), false);
      expect(progress.renderNeeded).toBe(true);
      expect(gpu.writes.length).toBeGreaterThan(0);
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(state.commandList).toHaveLength(0);
      expect(state.afterRender).toHaveLength(0);
      expect(owner.ready).toBe(false);
      expect(owner.hasPendingUpload).toBe(true);
      expect(owner.hasRunnableResourceUpload).toBe(false);
      expect(owner.needsRenderUpdate).toBe(true);
      expect(previous.isDestroyed()).toBe(false);
      state.passes = { render: false, pick: true };
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(owner.ready).toBe(false);
      expect(state.afterRender).toHaveLength(0);
      state.passes = { render: true, pick: false };
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(owner.ready).toBe(false);
      expect(previous.isDestroyed()).toBe(false);
      for (const callback of state.afterRender.splice(0)) callback();
      expect(owner.ready).toBe(true);
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(previous.show).toBe(false);
      scene.flushRemovals();
      expect(previous.isDestroyed()).toBe(true);
      expect(scene.pendingFirstUpdateCount).toBe(0);
    }
    finally { root.destroy(); }
  });

  it('requests presentation only when a complete feature prefix grows', async () => {
    const { owner, root, scene, state } = await pendingLinePage();
    scene.idlePreparationsEnabled = true;
    scene.pumpFirstUpdates(state as never, { exhausted: true }, undefined, true);
    const nativeUpdate = vi.mocked(Primitive.prototype.update);
    nativeUpdate.mockClear();
    let prefix = false;
    try {
      for (let turn = 0; turn < 100 && !prefix; turn++) {
        const progress = scene.advanceResourceUploads(state as never, { exhausted: true }, {}, operation => operation(), true);
        prefix = owner.hasDrawableGeometry;
        expect(progress.renderNeeded).toBe(prefix);
        expect(nativeUpdate).not.toHaveBeenCalled();
        expect(state.commandList).toHaveLength(0);
        expect(state.afterRender).toHaveLength(0);
        expect(owner.ready).toBe(false);
      }
      expect(prefix).toBe(true);
      const writes = gpu.writes.length;
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(gpu.writes).toHaveLength(writes);
      expect(state.commandList).toHaveLength(1);
      expect(owner.hasPendingUpload).toBe(true);
      expect(owner.needsRenderUpdate).toBe(false);
      const presented = state.commandList[0].count;
      scene.advanceResourceUploads(state as never, UNBOUNDED_BUDGET, {}, operation => operation(), false);
      state.commandList.length = 0;
      state.passes = { render: false, pick: true };
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(state.commandList[0].count).toBe(presented);
      expect(owner.ready).toBe(false);
      expect(state.afterRender).toHaveLength(0);
      state.commandList.length = 0;
      state.passes = { render: true, pick: false };
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(state.commandList[0].count).toBeGreaterThan(presented!);
      expect(owner.ready).toBe(false);
      for (const callback of state.afterRender.splice(0)) callback();
      expect(owner.ready).toBe(true);
    }
    finally { root.destroy(); }
  });

  it.each(['mode', 'context', 'projection', '3D-only'] as const)('revokes detached writes after a %s change', async (change) => {
    const { root, scene, state } = await pendingLinePage();
    try {
      scene.advanceResourceUploads(state as never, { exhausted: true }, {}, operation => operation(), true);
      const writes = gpu.writes.length;
      const changed = { ...state };
      if (change === 'mode')
        changed.mode = SceneMode.COLUMBUS_VIEW;
      if (change === 'context')
        changed.context = { ...state.context };
      if (change === 'projection')
        changed.mapProjection = new GeographicProjection();
      if (change === '3D-only')
        changed.scene3DOnly = true;
      const progress = scene.advanceResourceUploads(changed as never, UNBOUNDED_BUDGET, {}, operation => operation(), true);
      expect(gpu.writes).toHaveLength(writes);
      expect(progress.renderNeeded).toBe(true);
    }
    finally { root.destroy(); }
  });

  it.each(['texture', 'buffer'] as const)('releases failed detached %s uploads without publishing ready or late writes', async (kind) => {
    const { owner, root, scene, state } = await pendingLinePage();
    try {
      if (kind === 'buffer') {
        while (gpu.buffers.length === 0)
          scene.advanceResourceUploads(state as never, { exhausted: true }, {}, operation => operation(), true);
        gpu.failBufferCopy = true;
      }
      else {
        gpu.failTextureCopy = true;
      }
      const progress = scene.advanceResourceUploads(state as never, UNBOUNDED_BUDGET, {}, operation => operation(), true);
      expect(progress.renderNeeded).toBe(true);
      expect(owner.ready).toBe(false);
      expect(state.afterRender).toHaveLength(0);
      expect(owner.hasRunnableResourceUpload).toBe(false);
      expect(gpu.buffers.every(buffer => buffer.isDestroyed())).toBe(true);
      expect(gpu.textures.every(texture => texture.isDestroyed())).toBe(true);
      const writes = gpu.writes.length;
      scene.advanceResourceUploads(state as never, UNBOUNDED_BUDGET, {}, operation => operation(), true);
      expect(gpu.writes).toHaveLength(writes);
    }
    finally { root.destroy(); }
  });

  it('creates the real Native batch table when an idle Worker reply precedes the first Native update', async () => {
    const actual = await vi.importActual<typeof import('cesium')>('cesium');
    const runtime = actual as unknown as {
      ContextLimits: { _maximumTextureSize: number; _maximumVertexTextureImageUnits: number };
      BatchTable: { prototype: { update: () => void } };
      PrimitiveState: { COMBINED: number; COMPLETE: number };
    };
    const maximumTextureSize = runtime.ContextLimits._maximumTextureSize;
    const maximumVertexTextureImageUnits = runtime.ContextLimits._maximumVertexTextureImageUnits;
    runtime.ContextLimits._maximumTextureSize = 4096;
    runtime.ContextLimits._maximumVertexTextureImageUnits = 16;
    vi.spyOn(runtime.BatchTable.prototype, 'update').mockImplementation(() => {});
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update');
    const worker = { addEventListener: vi.fn(), removeEventListener: vi.fn(), terminate: vi.fn() };
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters) {
      Object.assign(this, { _worker: worker });
      return Promise.resolve(prepareGeometryBatch(structuredClone(parameters) as GeometryPrepareBatchRequest, []));
    });
    const owner = lineOwner(2);
    owner.show = false;
    const state = {
      ...frame(),
      context: { ...frame().context, floatingPointTexture: true, createPickId: (object: object) => ({ object, color: Color.WHITE, destroy: vi.fn() }) },
    };
    try {
      while (!(owner as unknown as { _started: boolean })._started)
        updateGeometryWithBudget(state, { exhausted: true }, () => owner.update(state));
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      owner.advancePreparation(state, UNBOUNDED_BUDGET);
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect((owner as unknown as { _state: number })._state).toBe(runtime.PrimitiveState.COMBINED);
      expect(() => updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => owner.update(state))).not.toThrow();
      expect((owner as unknown as { _batchTable?: object })._batchTable).toBeDefined();
      expect((owner as unknown as { _state: number })._state).toBe(runtime.PrimitiveState.COMPLETE);
      expect(owner.getGeometryInstanceAttributes('line')).toBeDefined();
      expect(owner.geometryInstances).toBeUndefined();
    }
    finally {
      owner.destroy();
      runtime.ContextLimits._maximumTextureSize = maximumTextureSize;
      runtime.ContextLimits._maximumVertexTextureImageUnits = maximumVertexTextureImageUnits;
    }
  });

  it('holds a visible predecessor until the hidden page completes all uploads', async () => {
    const { owner, collection, root, scene, state } = await pendingLinePage();
    const previous = new PrimitiveCollection();
    scene.add(previous);
    scene.replaceWhenReady('roads', previous, collection);
    let partial = false;
    try {
      for (let turn = 0; turn < 100 && !owner.ready; turn++) {
        state.commandList.length = 0;
        scene.pumpFirstUpdates(state as never, { exhausted: true }, undefined, true);
        if (owner.hasDrawableGeometry && owner.hasPendingUpload)
          partial = true;
        expect(previous.show).toBe(true);
        expect(collection.show).toBe(false);
        expect(scene.hasPendingReplacement('roads')).toBe(true);
        expect(state.commandList).toHaveLength(0);
        for (const callback of state.afterRender.splice(0)) callback();
        state.frameNumber++;
      }
      expect(partial).toBe(true);
      expect(owner.ready).toBe(true);
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(scene.hasPendingReplacement('roads')).toBe(false);
      expect(previous.show).toBe(false);
      expect(collection.show).toBe(true);
      scene.flushRemovals();
      expect(previous.isDestroyed()).toBe(true);
      expect(owner.isDestroyed()).toBe(false);
    }
    finally { root.destroy(); }
  });

  it('draws complete feature prefixes while one page continues uploading, once per physical render', async () => {
    const { owner, root, scene, state } = await pendingLinePage();
    const counts: number[] = [];
    let partial = false;
    try {
      for (let turn = 0; turn < 100 && !owner.ready; turn++) {
        state.commandList.length = 0;
        scene.pumpFirstUpdates(state as never, { exhausted: true }, undefined, true);
        const count = state.commandList[0]?.count ?? 0;
        counts.push(count);
        if (count > 0 && owner.hasPendingUpload) {
          partial = true;
          expect(owner.ready).toBe(false);
          expect(scene.pendingFirstUpdateCount).toBe(1);
          const writes = gpu.writes.length;
          state.commandList.length = 0;
          // Another 2D viewport in the same frame can draw, never re-upload.
          scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
          expect(gpu.writes).toHaveLength(writes);
          expect(state.commandList).toHaveLength(1);
          expect(state.commandList[0].count).toBe(count);
          state.commandList.length = 0;
          state.frameNumber++;
          state.passes = { render: false, pick: true };
          scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
          expect(gpu.writes).toHaveLength(writes);
          expect(state.commandList[0].count).toBe(count);
          state.passes = { render: true, pick: false };
        }
        for (const callback of state.afterRender.splice(0)) callback();
        state.frameNumber++;
      }
      expect(partial).toBe(true);
      expect(owner.ready).toBe(true);
      expect(owner.hasPendingUpload).toBe(false);
      const full = counts.at(-1)!;
      expect(full).toBeGreaterThan(0);
      expect(counts.some(count => count > 0 && count < full)).toBe(true);
      expect(Math.max(...gpu.writes)).toBeLessThanOrEqual(256 * 1024);
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(scene.pendingFirstUpdateCount).toBe(0);
    }
    finally {
      root.destroy();
      expect(gpu.buffers.every(buffer => buffer.isDestroyed())).toBe(true);
      expect(gpu.textures.every(texture => texture.isDestroyed())).toBe(true);
    }
  });

  it.each(['range', 'index', 'texture'] as const)('releases an allocated page after a %s upload failure', async (failure) => {
    const { owner, root, scene, state } = await pendingLinePage();
    try {
      if (failure !== 'texture') {
        while (failure === 'index' ? !owner.hasDrawableGeometry : gpu.buffers.length === 0) {
          scene.pumpFirstUpdates(state as never, { exhausted: true }, undefined, true);
          state.frameNumber++;
        }
        gpu.failBufferCopy = true;
      }
      else {
        gpu.failTextureCopy = true;
      }
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(owner.hasPendingUpload).toBe(false);
      expect(owner.positionTexture).toBeUndefined();
      expect(gpu.buffers.every(buffer => buffer.isDestroyed())).toBe(true);
      expect(gpu.textures).not.toHaveLength(0);
      expect(gpu.textures.every(texture => texture.isDestroyed())).toBe(true);
      expect((owner as unknown as { _va: unknown[] })._va).toHaveLength(0);
      expect((owner as unknown as { _error: Error })._error.message).toMatch(/GPU .* copy failed/);
    }
    finally { root.destroy(); }
  });
});

describe('expanded Native line commands', () => {
  it('admits sixteen small owners in one CPU turn through at most two real Native Worker tasks', async () => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const runtime = Cesium as unknown as { PrimitiveState: { COMBINING: number; COMBINED: number; COMPLETE: number } };
    const transfer = TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer?: boolean };
    const previousTransfer = transfer._canTransferArrayBuffer;
    transfer._canTransferArrayBuffer = true;
    const received: Array<{ id: number; parameters: GeometryPrepareBatchRequest }> = [];
    const worker = Object.assign(new EventTarget(), {
      postMessage: vi.fn((message: { id: number; parameters: GeometryPrepareBatchRequest }, transfers: ArrayBuffer[]) => {
        received.push(structuredClone(message, { transfer: transfers }));
      }),
      terminate: vi.fn(),
    });
    const schedule = TaskProcessor.prototype.scheduleTask;
    const tasks = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters, transfers) {
      Object.assign(this, { _worker: worker });
      return schedule.call(this, parameters, transfers);
    });
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (...args: unknown[]) {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
      if ((this as unknown as { _state: number })._state === runtime.PrimitiveState.COMBINED) {
        Object.assign(this, { _state: runtime.PrimitiveState.COMPLETE });
        const state = args[0] as ReturnType<typeof frame>;
        state.afterRender.push(() => {
          Object.assign(this, { _ready: true });
          return true;
        });
      }
    });
    const owners = Array.from({ length: 16 }, (_, index) => {
      const owner = lineOwner(index + 2);
      (owner.geometryInstances as GeometryInstance).id = `line-${index}`;
      return owner;
    });
    const cached = owners.map((owner) => {
      const geometry = (owner.geometryInstances as GeometryInstance).geometry;
      const positions = lineInputs.get(geometry)!.positions;
      const attributes = Object.values(geometry.attributes).map(attribute => ({
        values: attribute.values as ArrayLike<number>,
        expected: Array.from(attribute.values as ArrayLike<number>),
      }));
      const indices = geometry.indices!;
      return { geometry, positions, expected: new Float64Array(positions), attributes, indices, expectedIndices: Array.from(indices) };
    });
    const state = frame();
    textures.created.length = 0;
    try {
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => {
        for (const owner of owners) owner.update(state);
      });
      // This is the behavior control: the old per-owner slot gate admits only
      // two actual geometries, before any Worker protocol is inspected.
      expect(owners.filter(owner => (owner as unknown as { _state: number })._state === runtime.PrimitiveState.COMBINING)).toHaveLength(16);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(tasks.mock.calls.length).toBeGreaterThan(0);
      expect(tasks.mock.calls.length).toBeLessThanOrEqual(2);
      expect(new Set(tasks.mock.contexts).size).toBe(1);
      expect(worker.postMessage).toHaveBeenCalledTimes(tasks.mock.calls.length);
      expect((tasks.mock.contexts[0] as unknown as { _activeTasks: number })._activeTasks).toBe(tasks.mock.calls.length);
      for (const input of cached) {
        expect(input.positions.byteLength).toBe(input.expected.byteLength);
        expect(input.positions).toEqual(input.expected);
        for (const attribute of input.attributes) {
          expect(attribute.values.length).toBe(attribute.expected.length);
          expect(Array.from(attribute.values)).toEqual(attribute.expected);
        }
        expect(Array.from(input.indices)).toEqual(input.expectedIndices);
      }
      expect(textures.created).toHaveLength(0);
      expect(owners.every(owner => !owner.ready)).toBe(true);
      expect(state.afterRender).toEqual([]);
      expect(received.flatMap(task => task.parameters.requests)).toHaveLength(16);
      const expectedTextures: Uint32Array[] = [];
      for (const task of received) {
        const outputs: ArrayBuffer[] = [];
        const result = prepareGeometryBatch(task.parameters, outputs);
        for (const entry of result.results) {
          if ('error' in entry)
            throw new Error(entry.error.message);
          expectedTextures.push(new Uint32Array(entry.result.linePositions!.values));
        }
        worker.dispatchEvent(new MessageEvent('message', { data: { id: task.id, result: structuredClone(result, { transfer: outputs }) } }));
      }
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      expect((tasks.mock.contexts[0] as unknown as { _activeTasks: number })._activeTasks).toBe(0);
      nativeUpdate.mockClear();
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => {
        for (const owner of owners) owner.update(state);
      });
      expect(owners.map(owner => (owner as unknown as { _error?: Error })._error)).toEqual(owners.map(() => undefined));
      expect(nativeUpdate).toHaveBeenCalledTimes(16);
      expect(textures.created).toHaveLength(16);
      expect(owners.every(owner => !owner.ready)).toBe(true);
      expect(state.afterRender).toHaveLength(16);
      const vertexArrays = owners.map(owner => (owner as unknown as { _va: unknown[] })._va[0]);
      expect(new Set(vertexArrays).size).toBe(16);
      for (let index = 0; index < owners.length; index++) {
        expect((owners[index] as unknown as { _instanceIds: unknown[] })._instanceIds).toEqual([`line-${index}`]);
        expect(Array.from(textures.created[index].source.arrayBufferView)).toEqual(Array.from(expectedTextures[index]));
        expect(owners[index].positionTexture).toBeDefined();
        expect(cached[index].positions).toEqual(cached[index].expected);
      }
      for (const callback of state.afterRender.splice(0)) callback();
      expect(owners.every(owner => owner.ready)).toBe(true);
      expect(tasks.mock.calls.length).toBeLessThanOrEqual(2);
    }
    finally {
      transfer._canTransferArrayBuffer = previousTransfer;
      for (const owner of owners) owner.destroy();
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  });

  it('continues admitted CPU preparation and restores a real Worker reply in idle without Native or GPU work', async () => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const runtime = Cesium as unknown as { PrimitiveState: { COMBINED: number; COMPLETE: number } };
    const transfer = TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer?: boolean };
    const previousTransfer = transfer._canTransferArrayBuffer;
    transfer._canTransferArrayBuffer = false;
    const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() });
    const schedule = TaskProcessor.prototype.scheduleTask;
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters, transfers) {
      Object.assign(this, { _worker: worker });
      return schedule.call(this, parameters, transfers);
    });
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (...args: unknown[]) {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
      if ((this as unknown as { _state: number })._state === runtime.PrimitiveState.COMBINED) {
        Object.assign(this, { _state: runtime.PrimitiveState.COMPLETE });
        const state = args[0] as ReturnType<typeof frame>;
        state.afterRender.push(() => {
          Object.assign(this, { _ready: true });
          return true;
        });
      }
    });
    const owner = lineOwner(10000);
    const state = frame();
    textures.created.length = 0;
    try {
      // An idle call cannot bypass the first real render's paint admission.
      owner.advancePreparation(state, UNBOUNDED_BUDGET);
      expect(owner.hasRunnableIdlePreparation).toBe(false);
      expect(owner.needsRenderUpdate).toBe(true);
      expect(worker.postMessage).not.toHaveBeenCalled();
      updateGeometryWithBudget(state, { exhausted: true }, () => owner.update(state));
      expect(owner.hasRunnableIdlePreparation).toBe(true);
      expect(owner.needsRenderUpdate).toBe(false);
      expect(nativeUpdate).not.toHaveBeenCalled();
      const copy = vi.spyOn(Object.getPrototypeOf(Uint8Array.prototype) as Uint8Array, 'set');
      state.passes.render = false;
      owner.advancePreparation(state, { exhausted: true });
      const bytes = copy.mock.calls.reduce((total, [values], index) => total + values.length * copy.mock.contexts[index].BYTES_PER_ELEMENT, 0);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(16 * 1024);
      owner.advancePreparation(state, UNBOUNDED_BUDGET);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(worker.postMessage).toHaveBeenCalledOnce();
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(textures.created).toHaveLength(0);
      expect(state.commandList).toEqual([]);
      expect(state.afterRender).toEqual([]);
      expect(owner.needsRenderUpdate).toBe(true);
      expect(owner.hasRunnableUpdate).toBe(true);
      state.passes.render = true;
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => owner.update(state));
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(owner.needsRenderUpdate).toBe(false);
      expect(owner.hasRunnableIdlePreparation).toBe(false);
      nativeUpdate.mockClear();
      state.passes.render = false;
      owner.advancePreparation(state, UNBOUNDED_BUDGET);
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(worker.postMessage).toHaveBeenCalledOnce();
      const task = worker.postMessage.mock.calls[0][0] as { id: number; parameters: GeometryPrepareBatchRequest };
      const outputs: ArrayBuffer[] = [];
      const result = prepareGeometryBatch(structuredClone(task.parameters), outputs);
      worker.dispatchEvent(new MessageEvent('message', { data: { id: task.id, result: structuredClone(result, { transfer: outputs }) } }));
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      expect(owner.hasRunnableIdlePreparation).toBe(true);
      owner.advancePreparation(state, UNBOUNDED_BUDGET);
      expect(owner.hasRunnableIdlePreparation).toBe(false);
      expect(owner.needsRenderUpdate).toBe(true);
      expect(owner.ready).toBe(false);
      expect(owner.positionTexture).toBeUndefined();
      expect(textures.created).toHaveLength(0);
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(state.commandList).toEqual([]);
      expect(state.afterRender).toEqual([]);
      state.passes.render = true;
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => owner.update(state));
      expect(owner.positionTexture).toBeDefined();
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(owner.ready).toBe(false);
      state.afterRender.splice(0).forEach(callback => callback());
      expect(owner.ready).toBe(true);
    }
    finally {
      owner.destroy();
      transfer._canTransferArrayBuffer = previousTransfer;
    }
  });

  it.each(['line', 'native'] as const)('initializes the Native %s table while waiting and preserves the latest paint through a real reply', async (layout) => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const native = await vi.importActual<typeof import('cesium')>('cesium');
    const runtime = native as unknown as {
      ContextLimits: { _maximumTextureSize: number; _maximumVertexTextureImageUnits: number };
      BatchTable: { prototype: { update: () => void } };
      VertexArray: { fromGeometry: () => unknown };
      PrimitiveState: { COMBINING: number; COMPLETE: number };
    };
    const maximumTextureSize = runtime.ContextLimits._maximumTextureSize;
    const maximumVertexTextureImageUnits = runtime.ContextLimits._maximumVertexTextureImageUnits;
    runtime.ContextLimits._maximumTextureSize = 4096;
    runtime.ContextLimits._maximumVertexTextureImageUnits = 16;
    // Only GPU allocation/upload is substituted. Native creates and populates
    // its real BatchTable, instance accessor, pick IDs and ready callback.
    vi.spyOn(runtime.BatchTable.prototype, 'update').mockImplementation(() => {});
    const vertexArray = { destroy: vi.fn() };
    const createVertexArray = vi.spyOn(runtime.VertexArray, 'fromGeometry').mockReturnValue(vertexArray);
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update');
    const transfer = TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer?: boolean };
    const previousTransfer = transfer._canTransferArrayBuffer;
    transfer._canTransferArrayBuffer = false;
    const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() });
    const schedule = TaskProcessor.prototype.scheduleTask;
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters, transfers) {
      Object.assign(this, { _worker: worker });
      return schedule.call(this, parameters, transfers);
    });
    const source = lineOwner(2);
    const owner = new GeometryPrimitive({ geometryInstances: source.geometryInstances, appearance: source.appearance }, layout);
    source.destroy();
    const instance = owner.geometryInstances as GeometryInstance;
    instance.attributes = {
      color: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, value: [1, 0, 0, 1] }),
      lineWidth: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, value: [2] }),
    };
    const root = new PrimitiveCollection();
    const requestRender = vi.fn();
    const scene = new SceneCollections(root, requestRender, () => true);
    scene.idlePreparationsEnabled = true;
    const collection = new PrimitiveCollection();
    collection.add(owner);
    // Hidden first uploads still run Native initialization, but omit shaders
    // and draws; the GPU fixture verifies the eventual visible draw separately.
    collection.show = false;
    owner.show = false;
    scene.add(collection);
    scene.queueFirstUpdate([collection]);
    const pickIds: Array<{ object: object; color: Color; destroy: ReturnType<typeof vi.fn> }> = [];
    const state = {
      ...frame(),
      scene3DOnly: true,
      context: {
        ...frame().context,
        floatingPointTexture: true,
        createPickId: (object: object) => {
          const pickId = { object, color: Color.WHITE, destroy: vi.fn() };
          pickIds.push(pickId);
          return pickId;
        },
      },
    };
    try {
      const construction = owner.getGeometryInstanceAttributes('line');
      const scratch = new Float32Array([0, 1, 0, 0.5]);
      construction.color = scratch;
      construction.lineWidth = [4];
      scratch.set([0, 0, 1, 0.25]);
      expect(Array.from(construction.color)).toEqual([0, 1, 0, 0.5]);
      requestRender.mockClear();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(worker.postMessage).toHaveBeenCalledOnce();
      expect((owner as unknown as { _state: number })._state).toBe(runtime.PrimitiveState.COMBINING);
      if (layout === 'native') {
        expect(nativeUpdate).not.toHaveBeenCalled();
        expect(owner.hasRunnableUpdate).toBe(true);
        expect(owner.needsRenderUpdate).toBe(true);
        expect(requestRender).toHaveBeenCalledOnce();
        requestRender.mockClear();
        scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      }
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(createVertexArray).not.toHaveBeenCalled();
      expect(owner.needsRenderUpdate).toBe(false);
      expect(owner.hasRunnableUpdate).toBe(false);
      expect(requestRender).not.toHaveBeenCalled();
      const attributes = owner.getGeometryInstanceAttributes('line');
      expect(attributes).not.toBe(construction);
      expect(Array.from(attributes.color)).toEqual([0, 1, 0, 0.5]);
      expect(Array.from(attributes.lineWidth)).toEqual([4]);
      owner.getGeometryInstanceAttributes('line').color = scratch;
      owner.getGeometryInstanceAttributes('line').lineWidth = [8];
      scratch.fill(0);
      expect(Array.from(attributes.color)).toEqual([0, 0, 1, 0.25]);
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(worker.postMessage).toHaveBeenCalledOnce();
      expect(requestRender).not.toHaveBeenCalled();
      const task = worker.postMessage.mock.calls[0][0] as { id: number; parameters: GeometryPrepareBatchRequest };
      const outputs: ArrayBuffer[] = [];
      const result = prepareGeometryBatch(structuredClone(task.parameters), outputs);
      worker.dispatchEvent(new MessageEvent('message', { data: { id: task.id, result: structuredClone(result, { transfer: outputs }) } }));
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      expect(owner.hasRunnableUpdate).toBe(true);
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      if (layout === 'line') {
        expect(nativeUpdate).toHaveBeenCalledOnce();
        const progress = scene.advanceResourceUploads(state as never, UNBOUNDED_BUDGET, {}, operation => operation(), false);
        expect(progress.renderNeeded).toBe(true);
        expect(owner.ready).toBe(false);
        scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      }
      expect(nativeUpdate).toHaveBeenCalledTimes(2);
      expect(createVertexArray).toHaveBeenCalledTimes(Number(layout === 'native'));
      expect((owner as unknown as { _state: number })._state).toBe(runtime.PrimitiveState.COMPLETE);
      const uploaded = owner.getGeometryInstanceAttributes('line');
      expect(uploaded).toBe(attributes);
      expect(Array.from(uploaded.color)).toEqual([0, 0, 1, 0.25]);
      expect(Array.from(uploaded.lineWidth)).toEqual([8]);
      expect(pickIds).toHaveLength(1);
      expect(pickIds[0].object).toEqual({ primitive: owner, id: 'line' });
      expect(owner.geometryInstances).toBeUndefined();
      expect(owner.ready).toBe(false);
      expect(state.afterRender).toHaveLength(1);
      expect(state.afterRender.splice(0)[0]()).toBe(true);
      expect(owner.ready).toBe(true);
    }
    finally {
      root.destroy();
      runtime.ContextLimits._maximumTextureSize = maximumTextureSize;
      runtime.ContextLimits._maximumVertexTextureImageUnits = maximumVertexTextureImageUnits;
      transfer._canTransferArrayBuffer = previousTransfer;
    }
  });

  it.each(['line', 'dash', 'fill-outline'] as const)('keeps %s primary bounds and prepared derivatives stable through real Native updates', async (kind) => {
    const cesium = await vi.importActual<typeof import('cesium')>('cesium');
    const runtime = cesium as unknown as {
      PrimitiveState: { COMPLETE: number };
      DrawCommand: new (options: object) => NativeCommand;
      RenderState: { fromCache: (options: object) => object };
      ContextLimits: { _minimumAliasedLineWidth: number; _maximumAliasedLineWidth: number };
      Pass: { TRANSLUCENT: number; OPAQUE: number };
      Scene: { prototype: { updateDerivedCommands: (command: NativeCommand) => void } };
      DerivedCommand: { createLogDepthCommand: (...args: unknown[]) => unknown };
    };
    const minimum = runtime.ContextLimits._minimumAliasedLineWidth;
    const maximum = runtime.ContextLimits._maximumAliasedLineWidth;
    runtime.ContextLimits._minimumAliasedLineWidth = 1;
    runtime.ContextLimits._maximumAliasedLineWidth = 1;
    const appearance = new Appearance({ translucent: true });
    const owner = new GeometryPrimitive({ geometryInstances: new GeometryInstance({ geometry: new Geometry({ attributes: {} }), id: 'roads' }), appearance }, kind === 'fill-outline' ? 'native' : 'line', 1.03);
    registerDrawBatch(owner, { kind, layerId: 'roads', tileId: 'city' });
    const paint = {
      clip: new LineTileClip(new CanonicalTileID(0, 0, 0)),
      width: 1,
      color: Color.WHITE.clone(),
      offset: 1.03,
      metersPerPixel: lineGroundScale(14),
      widthUniform: () => paint.width,
      colorUniform: () => paint.color,
      offsetUniform: () => paint.offset,
      metersPerPixelUniform: () => paint.metersPerPixel,
    };
    registerLinePaint(owner, paint);
    const local = new BoundingSphere(new Cartesian3(10, 20, 30), 4);
    const spatial = BoundingSphere.clone(local)!;
    const planar = new BoundingSphere(new Cartesian3(0, 20, 30), 4);
    const flat = BoundingSphere.clone(planar)!;
    const shader = { id: 1, fragmentShaderSource: { defines: [] } };
    const vertexArray = { destroy: vi.fn() };
    const raw = new runtime.DrawCommand({ owner, boundingVolume: spatial, uniformMap: {}, renderState: runtime.RenderState.fromCache({ depthMask: true }), shaderProgram: shader, vertexArray, pass: runtime.Pass.TRANSLUCENT });
    Object.assign(owner, {
      _started: true,
      _ready: true,
      _state: runtime.PrimitiveState.COMPLETE,
      _batchTable: { attributes: [], destroy: vi.fn() },
      _batchTableOffsetsUpdated: true,
      _appearance: appearance,
      _translucent: true,
      _va: [vertexArray],
      _colorCommands: [raw],
      _boundingSpheres: [local],
      _boundingSphereWC: [spatial],
      _boundingSphereCV: [planar],
      _boundingSphere2D: [flat],
      _boundingSphereMorph: [BoundingSphere.union(spatial, planar)],
      _modelMatrix: Matrix4.clone(owner.modelMatrix),
    });
    const state = { ...frame(), frameNumber: 6, camera: {}, context: { elementIndexUint: true, uniformState: { view: Matrix4.clone(Matrix4.IDENTITY) } }, passes: { render: true, pick: false, snap: false }, commandList: [] as NativeCommand[], shadowState: { lastDirtyTime: 7 }, useLogDepth: true, pickingMetadata: false };
    const scene = { _frameState: state, _context: { shaderCache: { getDerivedShaderProgram: (source: object) => source } }, _view: {}, _hdr: false, _depthOnlyRenderStateCache: {}, picking: { pickRenderStateCache: {} } };
    const draw = new DrawCommands();
    const update = vi.spyOn(Primitive.prototype, 'update');
    const logDepth = vi.spyOn(runtime.DerivedCommand, 'createLogDepthCommand');
    const render = () => {
      state.commandList.length = 0;
      owner.update(state);
      draw.prepare(state as never, 0, state.mode, new Map([['roads', 0]]));
      const command = state.commandList[0];
      Reflect.apply(runtime.Scene.prototype.updateDerivedCommands, scene, [command]);
      return command;
    };
    try {
      const prepared = render();
      expect(prepared.boundingVolume.radius).toBe(5.03);
      expect(spatial).toEqual(local);
      expect(prepared.dirty).toBe(false);
      expect(prepared.pass).toBe(runtime.Pass.OPAQUE);
      expect(prepared.renderState.depthMask).toBe(false);
      const uniforms = prepared.uniformMap;
      const renderState = prepared.renderState;
      const derivative = prepared.derivedCommands.logDepth!.command;
      logDepth.mockClear();
      const next = render();
      expect(next).toBe(prepared);
      expect(next.uniformMap).toBe(uniforms);
      expect(next.renderState).toBe(renderState);
      expect(next.derivedCommands.logDepth!.command).toBe(derivative);
      expect(logDepth).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(2);
      expect(raw.boundingVolume).toBe(spatial);
      expect(spatial.radius).toBe(4);
      expect(raw.pass).toBe(runtime.Pass.TRANSLUCENT);
      expect(raw.renderState.depthMask).toBe(true);
      expect(raw.uniformMap).not.toBe(uniforms);

      state.mode = SceneMode.COLUMBUS_VIEW;
      const projected = render();
      expect(projected).toBe(prepared);
      expect(projected.boundingVolume).not.toBe(planar);
      expect(projected.boundingVolume.center).toEqual(planar.center);
      expect(projected.boundingVolume.radius).toBe(5.03);
      expect(logDepth).toHaveBeenCalledTimes(1);
      expect(raw.boundingVolume).toBe(planar);
      expect(planar.radius).toBe(4);
      logDepth.mockClear();
      render();
      expect(logDepth).not.toHaveBeenCalled();

      // Two actual viewports can update the same source in one physical frame.
      state.mode = SceneMode.SCENE2D;
      const firstView = render();
      const west = Matrix4.getColumn(firstView.uniformMap.u_line_clip_planes() as Matrix4, 0, new Cartesian4());
      expect(logDepth).toHaveBeenCalledTimes(1);
      const flatBounds = firstView.boundingVolume;
      logDepth.mockClear();
      flat.center.y = 44;
      state.context.uniformState.view = Matrix4.fromTranslation(new Cartesian3(0, 20, 0));
      const secondView = render();
      expect(state.frameNumber).toBe(6);
      expect(secondView).toBe(firstView);
      expect(secondView.boundingVolume).toBe(flatBounds);
      expect(secondView.boundingVolume.center.y).toBe(44);
      expect(Matrix4.getColumn(secondView.uniformMap.u_line_clip_planes() as Matrix4, 0, new Cartesian4())).not.toEqual(west);
      expect(raw.boundingVolume).toBe(flat);
      expect(flat.radius).toBe(4);
      expect(logDepth).not.toHaveBeenCalled();

      // Native command reconfiguration must replace the retained paint inputs
      // once, then preserve the final preparation on the following update.
      const nextVertexArray = { destroy: vi.fn() };
      Object.assign(raw, {
        count: 24,
        instanceCount: 2,
        vertexArray: nextVertexArray,
        shaderProgram: { ...shader, id: 2 },
        uniformMap: { u_nativePaint: () => 19 },
        renderState: runtime.RenderState.fromCache({ depthMask: true, blending: { enabled: true } }),
        _pickMetadataAllowed: true,
      });
      const changed = render();
      expect(logDepth).toHaveBeenCalledTimes(1);
      const changedDerived = changed.derivedCommands.logDepth!.command;
      expect(changedDerived.count).toBe(24);
      expect(changedDerived.instanceCount).toBe(2);
      expect(changedDerived.vertexArray).toBe(nextVertexArray);
      expect(changedDerived.uniformMap.u_nativePaint()).toBe(19);
      expect(changedDerived.pickMetadataAllowed).toBe(true);
      expect(changed.pass).toBe(runtime.Pass.OPAQUE);
      expect(changed.renderState.depthMask).toBe(false);
      expect(changed.uniformMap.u_line_width()).toBe(1);
      logDepth.mockClear();
      render();
      expect(logDepth).not.toHaveBeenCalled();

      state.mode = SceneMode.SCENE3D;
      state.passes.render = false;
      state.passes.pick = true;
      owner.modelMatrix[12] = 10;
      const picking = render();
      expect(picking.derivedCommands.logDepth!.command.modelMatrix).toBe(owner.modelMatrix);
      expect(picking.boundingVolume.center.x).toBe(20);
      expect(spatial.radius).toBe(4);
      const pickBounds = picking.boundingVolume;
      owner.modelMatrix[12] = 20;
      const moved = render();
      expect(moved.boundingVolume).toBe(pickBounds);
      expect(moved.derivedCommands.logDepth!.command.boundingVolume.center.x).toBe(30);
      expect(moved.derivedCommands.logDepth!.command.modelMatrix![12]).toBe(20);
      expect(vertexArray.destroy).not.toHaveBeenCalled();
      expect(nextVertexArray.destroy).not.toHaveBeenCalled();
    }
    finally {
      owner.destroy();
      expect((owner as unknown as { _expandedCommands?: unknown })._expandedCommands).toBeUndefined();
      expect((owner as unknown as { _lineBoundingSpheres?: unknown })._lineBoundingSpheres).toBeUndefined();
      runtime.ContextLimits._minimumAliasedLineWidth = minimum;
      runtime.ContextLimits._maximumAliasedLineWidth = maximum;
    }
  });
});

describe('invisible standalone dash owners', () => {
  it.each(['width', 'alpha'] as const)('finishes Native readiness for zero %s paint, then skips draw work and restores the same VA and pick owner', (zero) => {
    const owner = lineOwner(2);
    const runtime = Cesium as unknown as { PrimitiveState: { COMPLETE: number } };
    const table = { _batchValuesDirty: true, destroy: vi.fn() };
    const vertexArray = { destroy: vi.fn() };
    const pickId = { object: { primitive: owner, id: 'line' }, destroy: vi.fn() };
    const uniforms = {
      clip: new LineTileClip(new CanonicalTileID(0, 0, 0)),
      width: zero === 'width' ? 0 : 12,
      color: zero === 'alpha' ? Color.TRANSPARENT.clone() : Color.WHITE.clone(),
      offset: 0,
      metersPerPixel: lineGroundScale(14),
      widthUniform: () => uniforms.width,
      colorUniform: () => uniforms.color,
      offsetUniform: () => uniforms.offset,
      metersPerPixelUniform: () => uniforms.metersPerPixel,
    };
    registerDrawBatch(owner, { kind: 'dash', tileId: 'city/roads', layerId: 'roads' });
    registerLinePaint(owner, uniforms);
    Object.assign(owner, { _started: true, _state: runtime.PrimitiveState.COMPLETE, _batchTable: table, _va: [vertexArray], _pickIds: [pickId] });
    const state = { ...frame(), commandList: [] as Array<{ owner: Primitive; vertexArray: object; pickId: object }>, afterRender: [] as Array<() => boolean> };
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (this: Primitive) {
      table._batchValuesDirty = false;
      state.commandList.push({ owner: this, vertexArray, pickId });
      if (!this.ready) {
        state.afterRender.push(() => {
          Object.assign(this, { _ready: true });
          return false;
        });
      }
    });
    try {
      owner.update(state);
      owner.update(state);
      expect(nativeUpdate).toHaveBeenCalledTimes(2);
      expect(owner.ready).toBe(false);
      for (const finish of state.afterRender)
        finish();
      expect(owner.ready).toBe(true);
      nativeUpdate.mockClear();
      state.commandList.length = 0;
      for (let index = 0; index < 4; index++)
        owner.update(state);
      expect(nativeUpdate).not.toHaveBeenCalled();
      expect(state.commandList).toHaveLength(0);
      expect(owner.show).toBe(true);

      // Cold instance setters can still leave Native's texture upload pending.
      table._batchValuesDirty = true;
      owner.update(state);
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(table._batchValuesDirty).toBe(false);
      owner.update(state);
      expect(nativeUpdate).toHaveBeenCalledOnce();

      uniforms.width = 12;
      uniforms.color.alpha = 1;
      state.commandList.length = 0;
      owner.update(state);
      expect(nativeUpdate).toHaveBeenCalledTimes(2);
      expect(state.commandList).toEqual([{ owner, vertexArray, pickId }]);
      expect(pickId.object).toEqual({ primitive: owner, id: 'line' });
      expect(vertexArray.destroy).not.toHaveBeenCalled();
      expect(pickId.destroy).not.toHaveBeenCalled();

      // Family primary metadata can be zero while a replay casing is visible.
      registerDrawBatch(owner, { kind: 'line', tileId: 'city/roads', layerId: 'roads' });
      uniforms.width = 0;
      owner.update(state);
      expect(nativeUpdate).toHaveBeenCalledTimes(3);

      // Instance paint uses unit uniform factors even for hidden features.
      registerDrawBatch(owner, { kind: 'dash', tileId: 'city/roads', layerId: 'roads' });
      uniforms.width = 1;
      Color.clone(Color.WHITE, uniforms.color);
      owner.update(state);
      expect(nativeUpdate).toHaveBeenCalledTimes(4);
    }
    finally {
      owner.destroy();
    }
  });
});

describe('cold geometry instance attributes', () => {
  it('reuses each instance facade while copying paint scratch arrays into construction attributes', () => {
    const geometry = new Geometry({ attributes: {} });
    const first = new GeometryInstance({ geometry, id: 'first', attributes: { color: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, value: [1, 0, 0, 1] }) } });
    const second = new GeometryInstance({ geometry, id: 'second', attributes: { color: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, value: [0, 0, 1, 1] }) } });
    const owner = new GeometryPrimitive({ geometryInstances: [first, second] }, 'native');
    const attributes = owner.getGeometryInstanceAttributes('first');
    const scratch = new Float32Array([0, 1, 0, 1]);

    attributes.color = scratch;
    scratch.fill(0);
    expect(Array.from(first.attributes.color.value)).toEqual([0, 1, 0, 1]);
    const again = owner.getGeometryInstanceAttributes('first');
    expect(again).toBe(attributes);
    expect(Array.from(again.color)).toEqual([0, 1, 0, 1]);
    scratch.set([1, 1, 0, 1]);
    again.color = scratch;
    scratch.fill(0);
    expect(Array.from(attributes.color)).toEqual([1, 1, 0, 1]);
    expect(Array.from(first.attributes.color.value)).toEqual([1, 1, 0, 1]);
    const other = owner.getGeometryInstanceAttributes('second');
    expect(other).not.toBe(attributes);
    expect(owner.getGeometryInstanceAttributes('second')).toBe(other);
    expect(Array.from(other.color)).toEqual([0, 0, 1, 1]);
    expect(owner.getGeometryInstanceAttributes('unknown')).toBeUndefined();
    owner.destroy();
    expect((owner as unknown as { _inputInstances?: unknown })._inputInstances).toBeUndefined();
    expect((owner as unknown as { _inputAttributeCache?: unknown })._inputAttributeCache).toBeUndefined();
  });

  it('delegates to Native and releases cold attributes as soon as the batch table exists', () => {
    const owner = lineOwner(2);
    const cold = owner.getGeometryInstanceAttributes('line');
    Object.assign(owner, {
      _batchTable: {
        attributes: [{ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 1 }],
        getBatchedAttribute: () => 1,
        destroy: () => undefined,
      },
      _batchTableAttributeIndices: { show: 0 },
      _instanceIds: ['line'],
    });

    const native = owner.getGeometryInstanceAttributes('line');
    expect(native).not.toBe(cold);
    expect(Array.from(native.show)).toEqual([1]);
    expect(owner.getGeometryInstanceAttributes('line')).toBe(native);
    expect(owner.getGeometryInstanceAttributes('unknown')).toBeUndefined();
    expect((owner as unknown as { _inputInstances?: unknown })._inputInstances).toBeUndefined();
    expect((owner as unknown as { _inputAttributeCache?: unknown })._inputAttributeCache).toBeUndefined();
    owner.destroy();
  });

  it('releases cold construction attributes when Native creates its batch table during update', () => {
    const owner = lineOwner(2);
    owner.getGeometryInstanceAttributes('line');
    const runtime = Cesium as unknown as { PrimitiveState: { COMPLETE: number } };
    Object.assign(owner, { _started: true, _state: runtime.PrimitiveState.COMPLETE });
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(function () {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
    });

    owner.update(frame());
    expect((owner as unknown as { _inputInstances?: unknown })._inputInstances).toBeUndefined();
    expect((owner as unknown as { _inputAttributeCache?: unknown })._inputAttributeCache).toBeUndefined();
    owner.destroy();
  });

  it('preserves Native errors for missing ids and missing construction geometry', () => {
    const owner = lineOwner(2);
    expect(() => owner.getGeometryInstanceAttributes(undefined)).toThrow('id is required');
    expect(() => owner.getGeometryInstanceAttributes(null)).toThrow('id is required');
    owner.destroy();

    const empty = new GeometryPrimitive({}, 'native');
    expect(() => empty.getGeometryInstanceAttributes('unknown')).toThrow('must call update before calling getGeometryInstanceAttributes');
    empty.destroy();
  });
});

describe('native geometry preparation', () => {
  it('consumes an empty Native completion once and finishes without repeated wakeups', () => {
    const runtime = Cesium as unknown as {
      PrimitivePipeline: { unpackCombineGeometryResults: (value: object) => object };
      PrimitiveState: { COMBINING: number };
    };
    const unpack = vi.spyOn(runtime.PrimitivePipeline, 'unpackCombineGeometryResults').mockReturnValue({ geometries: [] });
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const owner = lineOwner(2);
    const originalGeometry = (owner.geometryInstances as GeometryInstance).geometry;
    Object.assign(owner, { _started: true, _combinedResult: {}, _state: runtime.PrimitiveState.COMBINING, _batchTable: { destroy() {} } });
    const state = frame();
    try {
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => owner.update(state));
      expect(unpack).toHaveBeenCalledTimes(1);
      expect(state.afterRender).toHaveLength(1);
      expect(owner.ready).toBe(false);
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => owner.update(state));
      expect(unpack).toHaveBeenCalledTimes(1);
      expect(state.afterRender).toHaveLength(1);
      const ready = state.afterRender[0] as () => boolean;
      expect(ready()).toBe(true);
      expect(owner.ready).toBe(true);
      expect(owner.hasRunnableUpdate).toBe(false);
      expect((owner as unknown as { _error?: unknown })._error).toBeUndefined();
      const instance = owner.geometryInstances as GeometryInstance;
      expect(instance.id).toBe('line');
      expect(instance.geometry.attributes).toEqual({});
      expect(instance.geometry.indices).toBeUndefined();
      expect(originalGeometry.indices?.length).toBeGreaterThan(0);
    }
    finally {
      owner.destroy();
    }
  });

  it('admits the separate solid batch-table update before waiting for combine', () => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const source = lineOwner(2);
    const owner = new GeometryPrimitive({ geometryInstances: source.geometryInstances, appearance: source.appearance }, 'native');
    source.destroy();
    const worker = { addEventListener: vi.fn(), removeEventListener: vi.fn(), terminate: vi.fn() };
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function () {
      Object.assign(this, { _worker: worker });
      return new Promise(() => {});
    });
    const update = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function () {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
    });
    const root = new PrimitiveCollection();
    const requestRender = vi.fn();
    const scene = new SceneCollections(root, requestRender, () => true);
    scene.add(owner);
    scene.queueFirstUpdate([owner]);
    const state = frame();
    try {
      requestRender.mockClear();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(update).not.toHaveBeenCalled();
      expect(owner.hasRunnableUpdate).toBe(true);
      expect(owner.needsRenderUpdate).toBe(true);
      expect(requestRender).toHaveBeenCalledTimes(1);
      requestRender.mockClear();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(update).toHaveBeenCalledTimes(1);
      expect(owner.hasRunnableUpdate).toBe(false);
      expect(requestRender).not.toHaveBeenCalled();
    }
    finally {
      root.destroy();
    }
  });

  it('continues Native CREATED and COMBINED states while leaving CREATING and COMBINING asleep', () => {
    const runtime = Cesium as unknown as { PrimitiveState: { CREATING: number; CREATED: number; COMBINING: number; COMBINED: number } };
    const root = new PrimitiveCollection();
    const requestRender = vi.fn();
    const scene = new SceneCollections(root, requestRender, () => true);
    const owner = new Primitive();
    const update = vi.spyOn(owner, 'update').mockImplementation(() => {});
    scene.add(owner);
    scene.queueFirstUpdate([owner]);
    try {
      for (const state of [runtime.PrimitiveState.CREATING, runtime.PrimitiveState.COMBINING]) {
        Object.assign(owner, { _state: state });
        requestRender.mockClear();
        scene.pumpFirstUpdates(frame() as never, UNBOUNDED_BUDGET);
        expect(update).not.toHaveBeenCalled();
        expect(requestRender).not.toHaveBeenCalled();
        expect(scene.pendingFirstUpdateCount).toBe(1);
      }
      for (const state of [runtime.PrimitiveState.CREATED, runtime.PrimitiveState.COMBINED]) {
        Object.assign(owner, { _state: state });
        update.mockClear();
        requestRender.mockClear();
        scene.pumpFirstUpdates(frame() as never, UNBOUNDED_BUDGET);
        expect(update).toHaveBeenCalledTimes(1);
        expect(requestRender).toHaveBeenCalledTimes(1);
      }
    }
    finally {
      root.destroy();
    }
  });

  it.each(['cancelled reply', 'owner error'] as const)('posts two tasks through one real TaskProcessor and leaves a third quiet until %s', async (completion) => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(function () {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
    });
    const transfer = TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer?: boolean };
    const previousTransfer = transfer._canTransferArrayBuffer;
    transfer._canTransferArrayBuffer = false;
    const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() });
    const schedule = TaskProcessor.prototype.scheduleTask;
    const tasks = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters, transfers) {
      Object.assign(this, { _worker: worker });
      return schedule.call(this, parameters, transfers);
    });
    const root = new PrimitiveCollection();
    const requestRender = vi.fn();
    const scene = new SceneCollections(root, requestRender, () => true);
    const collection = new PrimitiveCollection();
    const first = lineOwner(2);
    const waiting = lineOwner(2);
    collection.add(first);
    const second = collection.add(lineOwner(2));
    collection.add(waiting);
    scene.add(collection);
    scene.queueFirstUpdate([collection]);
    const state = frame();
    try {
      requestRender.mockClear();
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => first.update(state));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => second.update(state));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(tasks).toHaveBeenCalledTimes(2);
      expect(new Set(tasks.mock.contexts).size).toBe(1);
      expect(worker.postMessage).toHaveBeenCalledTimes(2);
      expect(waiting.hasRunnableUpdate).toBe(false);
      expect(scene.pendingFirstUpdateCount).toBe(1);
      expect(requestRender).not.toHaveBeenCalled();
      const copying = vi.spyOn(Object.getPrototypeOf(Uint8Array.prototype) as Uint8Array, 'set');
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(copying).not.toHaveBeenCalled();
      expect(tasks).toHaveBeenCalledTimes(2);
      expect(requestRender).not.toHaveBeenCalled();

      const abandoned = collection.add(lineOwner(2));
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => abandoned.update(state));
      expect(abandoned.hasRunnableUpdate).toBe(false);
      collection.remove(abandoned);
      expect(copying).not.toHaveBeenCalled();
      expect(tasks).toHaveBeenCalledTimes(2);
      expect(worker.terminate).not.toHaveBeenCalled();

      if (completion === 'cancelled reply')
        collection.remove(first);
      expect(waiting.hasRunnableUpdate).toBe(false);
      expect(worker.terminate).not.toHaveBeenCalled();
      const task = worker.postMessage.mock.calls[0][0] as { id: number; parameters: GeometryPrepareBatchRequest };
      const outputs: ArrayBuffer[] = [];
      const result = completion === 'cancelled reply' ? prepareGeometryBatch(structuredClone(task.parameters), outputs) : undefined;
      worker.dispatchEvent(new MessageEvent('message', { data: completion === 'cancelled reply'
        ? { id: task.id, result: structuredClone(result, { transfer: outputs }) }
        : { id: task.id, result: { results: [{ error: { name: 'Error', message: 'invalid geometry' } }] } } }));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(waiting.hasRunnableUpdate).toBe(true);
      expect(worker.terminate).not.toHaveBeenCalled();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(tasks).toHaveBeenCalledTimes(3);
      const copied = copying.mock.calls.length;
      expect(copied).toBeGreaterThan(0);
      for (const callback of state.afterRender.splice(0)) callback();
      requestRender.mockClear();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(copying.mock.calls).toHaveLength(copied);
      expect(waiting.hasRunnableUpdate).toBe(false);
      expect(requestRender).not.toHaveBeenCalled();
    }
    finally {
      transfer._canTransferArrayBuffer = previousTransfer;
      root.destroy();
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  });

  it.each(['error', 'messageerror', 'task error', 'batch count', 'undefined result', 'null result', 'missing combined'] as const)('wakes through afterRender and fails every owner when a geometry Worker reports %s', async (event) => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const nativeUpdate = Primitive.prototype.update;
    const failedState = (Cesium as unknown as { PrimitiveState: { FAILED: number } }).PrimitiveState.FAILED;
    const message = {
      'error': 'worker failed',
      'messageerror': 'could not deserialize',
      'task error': 'batch failed',
      'batch count': 'Geometry preparation batch result count does not match its requests',
      'undefined result': 'Invalid geometry preparation success result',
      'null result': 'Invalid geometry preparation success result',
      'missing combined': 'Invalid geometry preparation success result',
    }[event];
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(function () {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
    });
    const transfer = TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer?: boolean };
    const previousTransfer = transfer._canTransferArrayBuffer;
    transfer._canTransferArrayBuffer = false;
    const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() });
    const schedule = TaskProcessor.prototype.scheduleTask;
    const tasks = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters, transfers) {
      Object.assign(this, { _worker: worker });
      return schedule.call(this, parameters, transfers);
    });
    const root = new PrimitiveCollection();
    const requestRender = vi.fn();
    const scene = new SceneCollections(root, requestRender, () => true);
    const collection = new PrimitiveCollection();
    const owners = Array.from({ length: 3 }, () => lineOwner(2));
    for (const owner of owners) collection.add(owner);
    scene.add(collection);
    scene.queueFirstUpdate([collection]);
    const state = frame();
    const taskCompleted = vi.fn();
    const stop = TaskProcessor.taskCompletedEvent.addEventListener(taskCompleted);
    try {
      requestRender.mockClear();
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => owners[0].update(state));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => owners[1].update(state));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(tasks).toHaveBeenCalledTimes(2);
      expect(worker.postMessage).toHaveBeenCalledTimes(2);
      expect((tasks.mock.contexts[0] as unknown as { _activeTasks: number })._activeTasks).toBe(2);
      expect(owners[2].hasRunnableUpdate).toBe(false);
      expect(requestRender).not.toHaveBeenCalled();
      if (event === 'task error') {
        const task = worker.postMessage.mock.calls[0][0] as { id: number };
        worker.dispatchEvent(new MessageEvent('message', { data: { id: task.id, error: { name: 'Error', message: 'batch failed' } } }));
      }
      else if (event === 'error' || event === 'messageerror') {
        worker.dispatchEvent(event === 'error' ? new ErrorEvent('error', { message: 'worker failed' }) : new Event('messageerror'));
      }
      else {
        const task = worker.postMessage.mock.calls[0][0] as { id: number };
        const results = event === 'batch count' ? [] : [{ result: event === 'undefined result' ? undefined : event === 'null result' ? null : {} }];
        worker.dispatchEvent(new MessageEvent('message', { data: { id: task.id, result: { results } } }));
      }
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      for (const owner of owners.slice(0, 2))
        expect((owner as unknown as { _state: number })._state).toBe(failedState);
      // Fatal protocol validation must terminate the still-running sibling
      // task now, while all owners remain attached to the live collection.
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(taskCompleted).toHaveBeenCalledTimes(event === 'error' || event === 'messageerror' ? 0 : 1);
      expect(state.afterRender).not.toHaveLength(0);
      for (const callback of state.afterRender.splice(0)) {
        if (callback())
          requestRender();
      }
      expect(requestRender).toHaveBeenCalled();
      scene.idlePreparationsEnabled = true;
      const nativeCalls = vi.mocked(Primitive.prototype.update).mock.calls.length;
      // The third owner resumes its slot wait and gets the same task failure.
      // Its rejection reaches FAILED in a microtask; verify the failure's own
      // render requirement independently of an uninitialized batch table.
      scene.advancePreparations(state as never, UNBOUNDED_BUDGET, operation => operation(), true);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect((owners[2] as unknown as { _state: number })._state).toBe(failedState);
      expect(tasks).toHaveBeenCalledTimes(2);
      expect(scene.advancePreparations(state as never, UNBOUNDED_BUDGET, operation => operation(), true).renderNeeded).toBe(true);
      expect(vi.mocked(Primitive.prototype.update).mock.calls.length).toBe(nativeCalls);
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      for (const callback of state.afterRender.splice(0)) callback();
      for (const owner of owners) {
        expect(owner.ready).toBe(true);
        const instance = owner.geometryInstances as GeometryInstance;
        expect(instance.id).toBe('line');
        expect(instance.geometry.attributes).toEqual({});
        expect(instance.geometry.indices).toBeUndefined();
        expect(() => Reflect.apply(nativeUpdate, owner, [state])).toThrow(message);
      }
      expect(worker.terminate).toHaveBeenCalledOnce();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(scene.pendingFirstUpdateCount).toBe(0);
    }
    finally {
      stop();
      transfer._canTransferArrayBuffer = previousTransfer;
      root.destroy();
    }
  });

  it('waits quietly for real TaskProcessor replies, uploads zero dash paint and restores its prepared positions', async () => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const runtime = Cesium as unknown as {
      PrimitivePipeline: { unpackCombineGeometryResults: (value: object) => object };
      PrimitiveState: { COMBINED: number; COMPLETE: number };
    };
    const transfer = TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer?: boolean };
    const previousTransfer = transfer._canTransferArrayBuffer;
    transfer._canTransferArrayBuffer = false;
    const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() });
    const schedule = TaskProcessor.prototype.scheduleTask;
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters, transfers) {
      Object.assign(this, { _worker: worker });
      return schedule.call(this, parameters, transfers);
    });
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (...args: unknown[]) {
      const state = args[0] as ReturnType<typeof frame>;
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
      if ((this as unknown as { _state: number })._state === runtime.PrimitiveState.COMBINED) {
        Object.assign(this, { _state: runtime.PrimitiveState.COMPLETE });
        state.afterRender.push(() => {
          Object.assign(this, { _ready: true });
          return true;
        });
      }
    });
    const root = new PrimitiveCollection();
    const requestRender = vi.fn();
    const scene = new SceneCollections(root, requestRender, () => true);
    const collection = new PrimitiveCollection();
    const owner = lineOwner(2);
    const uniforms = {
      clip: new LineTileClip(new CanonicalTileID(0, 0, 0)),
      width: 0,
      color: Color.WHITE.clone(),
      offset: 0,
      metersPerPixel: lineGroundScale(14),
      widthUniform: () => uniforms.width,
      colorUniform: () => uniforms.color,
      offsetUniform: () => uniforms.offset,
      metersPerPixelUniform: () => uniforms.metersPerPixel,
    };
    registerDrawBatch(owner, { kind: 'dash', tileId: 'city/roads', layerId: 'roads' });
    registerLinePaint(owner, uniforms);
    collection.add(owner);
    scene.add(collection);
    scene.queueFirstUpdate([collection]);
    const state = frame();
    const consume = () => state.afterRender.splice(0).forEach((callback) => {
      if (callback())
        requestRender();
    });
    const stopWake = TaskProcessor.taskCompletedEvent.addEventListener(() => {
      state.afterRender.push(() => {
        requestRender();
        return false;
      });
    });
    try {
      requestRender.mockClear();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      expect(scene.pendingFirstUpdateCount).toBe(1);
      expect(requestRender).not.toHaveBeenCalled();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(requestRender).not.toHaveBeenCalled();

      const task = worker.postMessage.mock.calls[0][0] as { id: number; parameters: GeometryPrepareBatchRequest };
      const outputs: ArrayBuffer[] = [];
      const result = prepareGeometryBatch(structuredClone(task.parameters), outputs);
      worker.dispatchEvent(new MessageEvent('message', { data: { id: task.id, result: structuredClone(result, { transfer: outputs }) } }));
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      consume();
      expect(requestRender).toHaveBeenCalled();
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(owner.positionTexture).toBeDefined();
      expect(owner.ready).toBe(false);
      consume();
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(owner.ready).toBe(true);
      expect(scene.pendingFirstUpdateCount).toBe(0);
      expect(nativeUpdate).toHaveBeenCalled();
      const positions = owner.positionTexture;
      nativeUpdate.mockClear();
      owner.update(state);
      owner.update(state);
      expect(nativeUpdate).not.toHaveBeenCalled();
      uniforms.width = 12;
      owner.update(state);
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(owner.positionTexture).toBe(positions);
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    }
    finally {
      stopWake();
      transfer._canTransferArrayBuffer = previousTransfer;
      root.destroy();
    }
  });

  it('advances bounded owned copying when paint exhausts the budget without projecting lines on main', async () => {
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const projection = vi.spyOn(GeographicProjection.prototype, 'project');
    const worker = { addEventListener: vi.fn(), removeEventListener: vi.fn(), terminate: vi.fn() };
    const tasks = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function () {
      Object.assign(this, { _worker: worker });
      return new Promise(() => {});
    });
    const root = new PrimitiveCollection();
    let clock = 0;
    let consumePaint = true;
    const scene = new SceneCollections(root, vi.fn(), () => true, () => {}, () => {
      if (consumePaint)
        clock += 100;
      return true;
    });
    const collection = new PrimitiveCollection();
    const owner = lineOwner(10000);
    collection.add(owner);
    scene.add(collection);
    const state = frame();
    scene.updateChildren(state as never);
    expect(tasks).not.toHaveBeenCalled();
    scene.queueFirstUpdate([collection]);
    const copying = vi.spyOn(Object.getPrototypeOf(Uint8Array.prototype) as Uint8Array, 'set');
    vi.spyOn(performance, 'now').mockImplementation(() => clock++);
    scene.pumpFirstUpdates(state as never, new FrameBudget(12));
    const copiedBytes = copying.mock.calls.reduce((bytes, [values], index) => bytes + values.length * copying.mock.contexts[index].BYTES_PER_ELEMENT, 0);
    expect(copiedBytes).toBeGreaterThan(0);
    expect(copiedBytes).toBeLessThanOrEqual(16 * 1024);
    expect(projection).not.toHaveBeenCalled();
    expect(tasks).not.toHaveBeenCalled();
    scene.updateChildren(state as never);
    expect(tasks).not.toHaveBeenCalled();
    consumePaint = false;
    scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(tasks).toHaveBeenCalledTimes(1);
    expect(projection).not.toHaveBeenCalled();
    root.destroy();
  });

  it.each(['unbounded', 'timed'] as const)('restores a replied owner with a %s budget while two other Worker tasks remain pending', async (budgetMode) => {
    textures.created.length = 0;
    const runtime = Cesium as unknown as { PrimitiveState: { COMBINED: number; COMPLETE: number } };
    const worker = { addEventListener: vi.fn(), removeEventListener: vi.fn(), terminate: vi.fn() };
    const requests: Array<{ parameters: GeometryPrepareBatchRequest; resolve: (result: object) => void }> = [];
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters) {
      Object.assign(this, { _worker: worker });
      return new Promise(resolve => requests.push({ parameters: structuredClone(parameters) as GeometryPrepareBatchRequest, resolve }));
    });
    const upload = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function () {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
      if ((this as unknown as { _state: number })._state === runtime.PrimitiveState.COMBINED)
        Object.assign(this, { _state: runtime.PrimitiveState.COMPLETE });
    });
    const source = lineOwner(2);
    const template = source.geometryInstances as GeometryInstance;
    const replied = new GeometryPrimitive({
      geometryInstances: Array.from({ length: 96 }, (_, id) => new GeometryInstance({ geometry: template.geometry, id })),
      appearance: source.appearance,
    }, 'line');
    source.destroy();
    const pending = Array.from({ length: 2 }, () => lineOwner(2));
    const state = frame();
    try {
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => replied.update(state));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => pending[0].update(state));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(requests).toHaveLength(2);
      const transfers: ArrayBuffer[] = [];
      const result = prepareGeometryBatch(requests[0].parameters, transfers);
      const entry = result.results[0];
      if ('error' in entry)
        throw new Error(entry.error.message);
      expect(entry.result.lineBoundsCV).toHaveLength(96 * 4);
      const reply = structuredClone(result, { transfer: transfers });
      const repliedEntry = reply.results[0];
      if ('error' in repliedEntry)
        throw new Error(repliedEntry.error.message);
      const lineBoundsCV = repliedEntry.result.lineBoundsCV;
      requests[0].resolve(reply);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => pending[1].update(state));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(requests).toHaveLength(3);
      expect(pending.every(owner => !owner.hasRunnableUpdate)).toBe(true);
      expect(replied.hasRunnableUpdate).toBe(true);
      upload.mockClear();
      if (budgetMode === 'timed') {
        let now = 0;
        let restored = 0;
        const unpack = BoundingSphere.unpack;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        vi.spyOn(BoundingSphere, 'unpack').mockImplementation((...args) => {
          if (args[0] === lineBoundsCV as unknown as number[]) {
            now += 0.1;
            restored++;
          }
          return unpack(...args);
        });
        updateGeometryWithBudget(state, new FrameBudget(2), () => replied.update(state));
        expect(restored).toBe(32);
        expect(replied.positionTexture).toBeUndefined();
        expect(upload).not.toHaveBeenCalled();
        expect(replied.hasRunnableUpdate).toBe(true);
      }
      updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => replied.update(state));
      expect(replied.positionTexture).toBeDefined();
      expect(upload).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(3);
    }
    finally {
      replied.destroy();
      for (const owner of pending) owner.destroy();
    }
  });

  it.each([32, 33])('finishes the final bounded sphere restoration for %s instances before the next spent Native admission', async (count) => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const runtime = Cesium as unknown as { PrimitiveState: { COMBINING: number; COMBINED: number; COMPLETE: number } };
    const transfer = TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer?: boolean };
    const previousTransfer = transfer._canTransferArrayBuffer;
    transfer._canTransferArrayBuffer = false;
    const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() });
    const schedule = TaskProcessor.prototype.scheduleTask;
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters, transfers) {
      Object.assign(this, { _worker: worker });
      return schedule.call(this, parameters, transfers);
    });
    // Observe the actual Native call boundary; this unit does not claim GPU
    // correctness, which the real Worker/VA browser regression covers.
    const nativeUpdate = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (...args: unknown[]) {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
      if ((this as unknown as { _state: number })._state === runtime.PrimitiveState.COMBINED) {
        Object.assign(this, { _state: runtime.PrimitiveState.COMPLETE });
        const state = args[0] as ReturnType<typeof frame>;
        state.afterRender.push(() => {
          Object.assign(this, { _ready: true });
          return true;
        });
      }
    });
    const source = lineOwner(2);
    const template = source.geometryInstances as GeometryInstance;
    const owner = new GeometryPrimitive({
      geometryInstances: Array.from({ length: count }, (_, id) => new GeometryInstance({ geometry: template.geometry, id })),
      appearance: source.appearance,
    }, 'line');
    source.destroy();
    const root = new PrimitiveCollection();
    const scene = new SceneCollections(root, vi.fn(), () => true);
    scene.add(owner);
    scene.queueFirstUpdate([owner]);
    const state = frame();
    try {
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(worker.postMessage).toHaveBeenCalledOnce();
      const task = worker.postMessage.mock.calls[0][0] as { id: number; parameters: GeometryPrepareBatchRequest };
      const outputs: ArrayBuffer[] = [];
      const result = prepareGeometryBatch(structuredClone(task.parameters), outputs);
      const entry = result.results[0];
      if ('error' in entry)
        throw new Error(entry.error.message);
      expect(entry.result.lineBoundsCV).toHaveLength(count * 4);
      const reply = structuredClone(result, { transfer: outputs });
      const repliedEntry = reply.results[0];
      if ('error' in repliedEntry)
        throw new Error(repliedEntry.error.message);
      const lineBoundsCV = repliedEntry.result.lineBoundsCV;
      worker.dispatchEvent(new MessageEvent('message', { data: { id: task.id, result: reply } }));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      const unpack = BoundingSphere.unpack;
      let restored = 0;
      vi.spyOn(BoundingSphere, 'unpack').mockImplementation((...args) => {
        if (args[0] === lineBoundsCV as unknown as number[])
          restored++;
        return unpack(...args);
      });
      nativeUpdate.mockClear();
      const phases = count === 32
        ? [{ restored: 32, state: runtime.PrimitiveState.COMBINED }]
        : [{ restored: 32, state: runtime.PrimitiveState.COMBINING }, { restored: 1, state: runtime.PrimitiveState.COMBINED }];
      for (const phase of phases) {
        const before = restored;
        scene.pumpFirstUpdates(state as never, { exhausted: true }, undefined, true);
        expect(restored - before).toBe(phase.restored);
        expect((owner as unknown as { _state: number })._state).toBe(phase.state);
        expect(nativeUpdate).not.toHaveBeenCalled();
        expect(owner.positionTexture).toBeUndefined();
        expect(worker.postMessage).toHaveBeenCalledOnce();
      }
      scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(owner.hasPendingUpload).toBe(false);
      expect(owner.positionTexture).toBeDefined();
      expect(nativeUpdate).toHaveBeenCalledOnce();
      expect(owner.ready).toBe(false);
      for (const callback of state.afterRender.splice(0)) callback();
      expect(owner.ready).toBe(true);
    }
    finally {
      transfer._canTransferArrayBuffer = previousTransfer;
      root.destroy();
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  });

  it('uploads a complete Worker line payload atomically under admission and discards cancelled CPU results', async () => {
    textures.created.length = 0;
    const runtime = Cesium as unknown as { PrimitiveState: { COMBINED: number; COMPLETE: number } };
    const worker = { addEventListener: vi.fn(), removeEventListener: vi.fn(), terminate: vi.fn() };
    const tasks = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (parameters) {
      Object.assign(this, { _worker: worker });
      const outputs: ArrayBuffer[] = [];
      const result = prepareGeometryBatch(structuredClone(parameters) as GeometryPrepareBatchRequest, outputs);
      return Promise.resolve(structuredClone(result, { transfer: outputs }));
    });
    const draw = vi.spyOn(Primitive.prototype, 'update').mockImplementation(function (...args: unknown[]) {
      const state = args[0] as { commandList: Array<{ owner: Primitive }>; afterRender: Array<() => boolean> };
      const native = this as unknown as { _state: number };
      if (native._state === runtime.PrimitiveState.COMBINED) {
        native._state = runtime.PrimitiveState.COMPLETE;
        state.afterRender.push(() => {
          Object.assign(this, { _ready: true });
          return true;
        });
      }
      if (native._state === runtime.PrimitiveState.COMPLETE)
        state.commandList.push({ owner: this });
    });
    const root = new PrimitiveCollection();
    const scene = new SceneCollections(root, vi.fn(), () => true);
    const collection = new PrimitiveCollection();
    const owner = lineOwner(10000);
    const original = (owner.geometryInstances as GeometryInstance).geometry;
    const input = lineInputs.get(original)!;
    const positions = new Float64Array(input.positions);
    collection.add(owner);
    scene.add(collection);
    scene.queueFirstUpdate([collection]);
    const state = frame();
    scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(tasks).toHaveBeenCalledTimes(1);
    expect(input.positions).toEqual(positions);
    draw.mockClear();
    scene.updateChildren(state as never);
    expect(draw).not.toHaveBeenCalled();
    expect(textures.created).toHaveLength(0);

    updateGeometryWithBudget(state, { exhausted: true }, () => owner.update(state));
    expect(textures.created).toHaveLength(0);
    expect(owner.ready).toBe(false);
    scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
    expect(textures.created).toHaveLength(1);
    expect(scene.hasPendingFirstUpdate(collection)).toBe(true);
    for (const ready of state.afterRender.splice(0) as Array<() => boolean>) ready();
    scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
    expect(scene.hasPendingFirstUpdate(collection)).toBe(false);
    const uploaded = owner.positionTexture;
    draw.mockClear();
    scene.updateChildren(state as never);
    expect(draw).toHaveBeenCalledTimes(1);

    const cancelled = new PrimitiveCollection();
    const nextOwner = lineOwner(10000);
    cancelled.add(nextOwner);
    scene.add(cancelled);
    scene.queueFirstUpdate([cancelled]);
    scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    updateGeometryWithBudget(state, { exhausted: true }, () => nextOwner.update(state));
    expect(textures.created).toHaveLength(1);
    scene.deferDestroy(cancelled);
    scene.flushRemovals();
    expect(nextOwner.isDestroyed()).toBe(true);
    expect(uploaded.isDestroyed()).toBe(false);
    scene.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
    expect(textures.created).toHaveLength(1);
    root.destroy();
    expect(uploaded.isDestroyed()).toBe(true);
  });

  it('releases a partially encoded owner without scheduling work after destruction', () => {
    const root = new PrimitiveCollection();
    const scene = new SceneCollections(root, vi.fn(), () => true);
    const collection = new PrimitiveCollection();
    const owner = lineOwner(10000);
    collection.add(owner);
    scene.add(collection);
    scene.queueFirstUpdate([collection]);
    const tasks = vi.spyOn(TaskProcessor.prototype, 'scheduleTask');
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock++);
    scene.pumpFirstUpdates(frame() as never, new FrameBudget(12));
    scene.deferDestroy(collection);
    scene.flushRemovals();
    expect(owner.isDestroyed()).toBe(true);
    scene.pumpFirstUpdates(frame() as never, UNBOUNDED_BUDGET);
    expect(tasks.mock.calls.length).toBe(0);
    root.destroy();
  });
});
