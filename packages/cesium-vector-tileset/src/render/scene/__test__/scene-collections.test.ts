import type { Geometry } from 'cesium';
import { Appearance, buildModuleUrl, Cartesian3, Event, GeographicProjection, GeometryInstance, Primitive, PrimitiveCollection, SceneMode, TaskProcessor } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeometryPrimitive, updateGeometryWithBudget } from '../../geometry/geometry-primitive';
import { createLineGeometry } from '../../line/line-geometry';
import { FrameBudget, UNBOUNDED_BUDGET } from '../frame-budget';
import { sharePrimitiveBytes } from '../resource-memory';
import { SceneCollections } from '../scene-collections';
import { acquireSceneFrameBudget } from '../scene-frame-budget';

afterEach(() => vi.restoreAllMocks());

function lineOwner(count: number): GeometryPrimitive {
  const positions = new Float64Array(count * 3);
  for (let index = 0; index < count; index++)
    Cartesian3.pack(Cartesian3.fromDegrees(index / 10000, 30), positions as unknown as number[], index * 3);
  const geometry = createLineGeometry(positions, { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05, widthPx: 12 }) as Geometry;
  const vertexShaderSource = `${['3D', '2D'].flatMap(track => ['position', 'positionLow', 'prevOffset', 'nextOffset'].map(name => `in vec3 ${name === 'position' ? `position${track}High` : name === 'positionLow' ? `position${track}Low` : `${name}${track}`};`)).join('\n')}\nvoid main() {}`;
  return new GeometryPrimitive({ geometryInstances: new GeometryInstance({ geometry, id: 'line' }), appearance: new Appearance({ vertexShaderSource }) }, 'line');
}

describe('shared Scene minimum Native admission', () => {
  it('continues each admitted shared owner once in idle without paint, visibility or repeated minimum units', () => {
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const owner = lineOwner(10000);
    const next = lineOwner(10000);
    const state = { mode: SceneMode.SCENE3D, mapProjection: new GeographicProjection(), scene3DOnly: false, context: { elementIndexUint: true, webgl2: true }, passes: { render: true }, commandList: [], afterRender: [] };
    const collection = new PrimitiveCollection();
    collection.show = false;
    const replay = new Primitive();
    sharePrimitiveBytes(replay, owner);
    Object.assign(replay, { update: () => owner.update(state) });
    collection.add(owner);
    collection.add(replay);
    collection.add(next);
    const ready = new Primitive();
    Object.assign(ready, { _ready: true });
    collection.add(ready);
    const root = new PrimitiveCollection();
    const paint = vi.fn(() => true);
    const requestRender = vi.fn();
    const collections = new SceneCollections(root, requestRender, () => true, () => {}, paint);
    collections.add(collection);
    collections.queueFirstUpdate([collection]);
    try {
      // Each owner gets its first bounded CPU unit on the true render path.
      collections.pumpFirstUpdates(state as never, { exhausted: true }, undefined, true);
      updateGeometryWithBudget(state, { exhausted: true }, () => next.update(state));
      expect(paint).toHaveBeenCalledOnce();
      paint.mockClear();
      requestRender.mockClear();
      collections.idlePreparationsEnabled = true;
      state.passes.render = false;
      const first = vi.spyOn(owner, 'advancePreparation');
      const second = vi.spyOn(next, 'advancePreparation');
      const measure = vi.fn(<T>(operation: () => T): T => operation());
      expect(collections.hasRunnablePreparations).toBe(true);
      const result = collections.advancePreparations(state as never, { exhausted: true }, measure, true);
      expect(result).toEqual({ units: 1, renderNeeded: false });
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
      expect(measure).toHaveBeenCalledOnce();
      expect(paint).not.toHaveBeenCalled();
      expect(requestRender).not.toHaveBeenCalled();
      expect(state.commandList).toEqual([]);
      expect(state.afterRender).toEqual([]);
      expect(collection.show).toBe(false);
      expect(collections.pendingFirstUpdateCount).toBe(1);
      first.mockClear();
      expect(collections.advancePreparations(state as never, { exhausted: true }, measure, false).units).toBe(0);
      expect(first).not.toHaveBeenCalled();
      // Ready siblings cannot demand another render just for CPU preparation.
      expect(collections.advancePreparations(state as never, { exhausted: true }, measure, false).renderNeeded).toBe(false);
    }
    finally {
      root.destroy();
    }
  });

  it.each(['fresh', 'unknown', 'ready'] as const)('keeps %s first-update owners on the real render path', (kind) => {
    const root = new PrimitiveCollection();
    const collection = new PrimitiveCollection();
    const owner = kind === 'fresh' ? lineOwner(2) : new Primitive();
    if (kind === 'ready')
      Object.assign(owner, { _ready: true });
    collection.add(owner);
    const paint = vi.fn(() => true);
    const collections = new SceneCollections(root, vi.fn(), () => true, () => {}, paint);
    collections.idlePreparationsEnabled = true;
    collections.add(collection);
    collections.queueFirstUpdate([collection]);
    try {
      expect(collections.hasRunnablePreparations).toBe(false);
      expect(collections.advancePreparations({ commandList: [] } as never, UNBOUNDED_BUDGET, operation => operation(), true))
        .toEqual({ units: 0, renderNeeded: true });
      expect(paint).not.toHaveBeenCalled();
      expect(collections.pendingFirstUpdateCount).toBe(1);
    }
    finally {
      root.destroy();
    }
  });

  it('keeps completed upload bookkeeping from consuming the next cold owner admission', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const root = new PrimitiveCollection();
    const uploaded = new PrimitiveCollection();
    const owner = new Primitive();
    const state = { mode: SceneMode.SCENE3D, mapProjection: new GeographicProjection(), scene3DOnly: false, context: { elementIndexUint: true, webgl2: true }, passes: { render: true }, commandList: [] as Array<{ owner: Primitive }>, afterRender: [] as Array<() => void> };
    const draw = vi.spyOn(owner, 'update').mockImplementation(() => {
      state.commandList.push({ owner });
      if (!owner.ready)
        state.afterRender.push(() => Object.assign(owner, { _ready: true }));
    });
    uploaded.add(owner);
    const collections = new SceneCollections(root, vi.fn(), () => true);
    collections.add(uploaded);
    collections.queueFirstUpdate([uploaded]);
    try {
      collections.pumpFirstUpdates(state as never, UNBOUNDED_BUDGET);
      expect(state.commandList).toEqual([{ owner }]);
      expect(owner.ready).toBe(false);
      state.afterRender.splice(0).forEach(callback => callback());
      expect(owner.ready).toBe(true);
      expect(collections.pendingFirstUpdateCount).toBe(1);
      const cold = lineOwner(10000);
      const next = new PrimitiveCollection();
      next.add(cold);
      collections.add(next);
      collections.queueFirstUpdate([next]);
      const advance = vi.spyOn(cold, 'advancePreparation');
      state.commandList.length = 0;
      draw.mockClear();
      collections.pumpFirstUpdates(state as never, { exhausted: true }, undefined, true);
      expect(advance).toHaveBeenCalledOnce();
      expect(draw).toHaveBeenCalledOnce();
      expect(state.commandList).toEqual([{ owner }]);
      expect(collections.pendingFirstUpdateCount).toBe(1);
      collections.updateChildren(state as never, [uploaded]);
      expect(draw).toHaveBeenCalledOnce();
    }
    finally {
      root.destroy();
    }
  });

  it('keeps a queued ready Native draw in the mandatory reserve', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const root = new PrimitiveCollection();
    const collection = new PrimitiveCollection();
    const ready = new Primitive();
    Object.assign(ready, { _ready: true });
    vi.spyOn(ready, 'update').mockImplementation(() => {
      now += 12;
    });
    collection.add(ready);
    const collections = new SceneCollections(root, vi.fn(), () => true);
    collections.add(collection);
    collections.queueFirstUpdate([collection]);
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const lease = acquireSceneFrameBudget(scene, collections);
    try {
      scene.preUpdate.raiseEvent();
      const work = lease.frame(1);
      collections.pumpFirstUpdates({ commandList: [] } as never, work.tileBudget, operation => work.measure(operation));
      scene.postRender.raiseEvent();
      now = 100;
      scene.preUpdate.raiseEvent();
      const next = lease.frame(2);
      next.measure(() => {
        now = 102;
        expect(next.tileBudget.exhausted).toBe(true);
      });
    }
    finally {
      lease.release();
      root.destroy();
    }
  });

  it('charges replacement paint before allowing another cold owner to advance', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const root = new PrimitiveCollection();
    const previous = new PrimitiveCollection();
    const replacement = new PrimitiveCollection();
    const ready = new Primitive();
    vi.spyOn(ready, 'update').mockImplementation(() => Object.assign(ready, { _ready: true }));
    replacement.add(ready);
    const paint = vi.fn(() => {
      now += 4;
      return true;
    });
    const collections = new SceneCollections(root, vi.fn(), () => true, () => {}, paint);
    collections.add(previous);
    collections.replaceWhenReady('tile', previous, replacement);
    const cold = lineOwner(10000);
    const pending = new PrimitiveCollection();
    pending.add(cold);
    collections.add(pending);
    collections.queueFirstUpdate([pending]);
    const advance = vi.spyOn(cold, 'advancePreparation');
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const lease = acquireSceneFrameBudget(scene, collections);
    try {
      scene.preUpdate.raiseEvent();
      const work = lease.frame(1);
      collections.pumpFirstUpdates({ commandList: [] } as never, work.tileBudget, operation => work.measure(operation));
      expect(paint).toHaveBeenCalledTimes(2);
      expect(previous.show).toBe(false);
      expect(replacement.show).toBe(true);
      expect(collections.hasPendingReplacement('tile')).toBe(false);
      expect(work.tileBudget.exhausted).toBe(true);
      expect(advance).not.toHaveBeenCalled();
      expect(collections.pendingFirstUpdateCount).toBe(1);
    }
    finally {
      lease.release();
      root.destroy();
    }
  });

  it('advances real cold geometry once after required paint spends the admitted allowance', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now++);
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(() => {});
    const projection = vi.spyOn(GeographicProjection.prototype, 'project');
    const positions = new Float64Array(10000 * 3);
    for (let index = 0; index < 10000; index++)
      Cartesian3.pack(Cartesian3.fromDegrees(index / 10000, 30), positions as unknown as number[], index * 3);
    const geometry = createLineGeometry(positions, { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05, widthPx: 12 }) as Geometry;
    const copying = vi.spyOn(Object.getPrototypeOf(Uint8Array.prototype) as Uint8Array, 'set');
    const vertexShaderSource = `${['3D', '2D'].flatMap(track => ['position', 'positionLow', 'prevOffset', 'nextOffset'].map(name => `in vec3 ${name === 'position' ? `position${track}High` : name === 'positionLow' ? `position${track}Low` : `${name}${track}`};`)).join('\n')}\nvoid main() {}`;
    const owner = new GeometryPrimitive({ geometryInstances: new GeometryInstance({ geometry, id: 'line' }), appearance: new Appearance({ vertexShaderSource }) }, 'line');
    const root = new PrimitiveCollection();
    const collection = new PrimitiveCollection();
    collection.add(owner);
    const paint = vi.fn(() => {
      now += 100;
      return true;
    });
    const collections = new SceneCollections(root, vi.fn(), () => true, () => {}, paint);
    collections.add(collection);
    collections.queueFirstUpdate([collection]);
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const lease = acquireSceneFrameBudget(scene, collections);
    const state = { mode: SceneMode.SCENE3D, mapProjection: new GeographicProjection(), scene3DOnly: false, context: { elementIndexUint: true, webgl2: true }, passes: { render: true }, commandList: [], afterRender: [] };
    try {
      scene.preUpdate.raiseEvent();
      const work = lease.frame(1);
      now = 50;
      collections.pumpFirstUpdates(state as never, work.tileBudget);
      expect(paint).not.toHaveBeenCalled();
      expect(projection).not.toHaveBeenCalled();
      expect(copying).not.toHaveBeenCalled();
      const stages = { upload: collections.hasRunnableFirstUpdates, build: false, paint: false, placement: false };
      const minimum = work.continuation('upload', stages)!;
      collections.pumpFirstUpdates(state as never, minimum, operation => work.measure(operation), true);
      expect(paint).toHaveBeenCalledOnce();
      expect(projection).not.toHaveBeenCalled();
      const copiedBytes = copying.mock.calls.reduce((bytes, [values], index) => bytes + values.length * copying.mock.contexts[index].BYTES_PER_ELEMENT, 0);
      expect(copiedBytes).toBeGreaterThan(0);
      expect(copiedBytes).toBeLessThanOrEqual(16 * 1024);
      expect(copiedBytes).toBeLessThan(positions.byteLength);
      const prepared = copying.mock.calls.length;
      collections.updateChildren(state as never);
      expect(copying.mock.calls.length).toBe(prepared);
      expect(projection).not.toHaveBeenCalled();
      expect(work.continuation('upload', stages)).toBeUndefined();
      expect(work.continuation('placement', stages)).toBeUndefined();
    }
    finally {
      lease.release();
      root.destroy();
    }
  });
  it('spends minimum admission on runnable geometry behind a child waiting for its Worker', async () => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(function () {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
    });
    const worker = { addEventListener: vi.fn(), removeEventListener: vi.fn(), terminate: vi.fn() };
    const tasks = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function () {
      Object.assign(this, { _worker: worker });
      return new Promise(() => {});
    });
    const root = new PrimitiveCollection();
    const collection = new PrimitiveCollection();
    const waiting = lineOwner(2);
    const copying = lineOwner(10000);
    collection.add(waiting);
    collection.add(copying);
    const state = { mode: SceneMode.SCENE3D, mapProjection: new GeographicProjection(), scene3DOnly: false, context: { elementIndexUint: true, webgl2: true }, passes: { render: true }, commandList: [], afterRender: [] };
    updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => waiting.update(state));
    await Promise.resolve();
    expect(tasks).toHaveBeenCalledOnce();
    expect(waiting.hasRunnableUpdate).toBe(false);
    expect(copying.hasRunnableUpdate).toBe(true);
    const waitingUpdate = vi.spyOn(waiting, 'update');
    const ownedCopy = vi.spyOn(Object.getPrototypeOf(Uint8Array.prototype) as Uint8Array, 'set');
    const paint = vi.fn(() => {
      now += 100;
      return true;
    });
    const collections = new SceneCollections(root, vi.fn(), () => true, () => {}, paint);
    collections.add(collection);
    collections.queueFirstUpdate([collection]);
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const lease = acquireSceneFrameBudget(scene, collections);
    try {
      scene.preUpdate.raiseEvent();
      const work = lease.frame(1);
      now = 50;
      const stages = { upload: collections.hasRunnableFirstUpdates, build: false, paint: false, placement: false };
      expect(stages.upload).toBe(true);
      const minimum = work.continuation('upload', stages)!;
      collections.pumpFirstUpdates(state as never, minimum, operation => work.measure(operation), true);
      const bytes = ownedCopy.mock.calls.reduce((total, [values], index) => total + values.length * ownedCopy.mock.contexts[index].BYTES_PER_ELEMENT, 0);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(16 * 1024);
      expect(waitingUpdate).not.toHaveBeenCalled();
      expect(paint).toHaveBeenCalledOnce();
      expect(tasks).toHaveBeenCalledOnce();
      expect(collections.pendingFirstUpdateCount).toBe(1);
      collections.updateChildren(state as never);
      expect(ownedCopy.mock.calls.length).toBe(1);
      expect(work.continuation('upload', stages)).toBeUndefined();
    }
    finally {
      lease.release();
      root.destroy();
    }
  });

  it.each([false, true])('keeps drawable children once per viewport while skipping waiting work (hidden=%s)', (hidden) => {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(Primitive.prototype, 'update').mockImplementation(function () {
      Object.assign(this, { _batchTable: { destroy: () => undefined } });
    });
    const worker = { addEventListener: vi.fn(), removeEventListener: vi.fn(), terminate: vi.fn() };
    vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function () {
      Object.assign(this, { _worker: worker });
      return new Promise(() => {});
    });
    const state = { mode: SceneMode.SCENE3D, mapProjection: new GeographicProjection(), scene3DOnly: false, context: { elementIndexUint: true, webgl2: true }, passes: { render: true }, commandList: [] as Array<{ owner: Primitive }>, afterRender: [] };
    const waiting = lineOwner(2);
    updateGeometryWithBudget(state, UNBOUNDED_BUDGET, () => waiting.update(state));
    expect(waiting.hasRunnableUpdate).toBe(false);
    const copying = lineOwner(10000);
    const ready = new Primitive();
    Object.assign(ready, { _ready: true, update: () => state.commandList.push({ owner: ready }) });
    const draw = vi.spyOn(ready, 'update');
    const collection = new PrimitiveCollection();
    collection.add(ready);
    collection.add(waiting);
    collection.add(copying);
    collection.show = !hidden;
    const root = new PrimitiveCollection();
    let consumePaint = false;
    const collections = new SceneCollections(root, vi.fn(), () => true, () => {}, () => {
      if (consumePaint)
        now += 100;
      return true;
    });
    collections.add(collection);
    collections.queueFirstUpdate([collection]);
    const scene = { preUpdate: new Event(), postRender: new Event() };
    const lease = acquireSceneFrameBudget(scene, collections);
    try {
      // Native's completed first child is remembered before later children
      // can run. A hidden upload's temporary command must be discarded.
      collections.pumpFirstUpdates(state as never, new FrameBudget(0), undefined, true);
      expect(draw).toHaveBeenCalledOnce();
      expect(state.commandList).toHaveLength(hidden ? 0 : 1);
      expect(copying.hasRunnableUpdate).toBe(true);
      draw.mockClear();
      state.commandList.length = 0;
      const ownedCopy = vi.spyOn(Object.getPrototypeOf(Uint8Array.prototype) as Uint8Array, 'set');
      consumePaint = true;
      scene.preUpdate.raiseEvent();
      const work = lease.frame(1);
      now = 50;
      const stages = { upload: collections.hasRunnableFirstUpdates, build: false, paint: false, placement: false };
      const minimum = work.continuation('upload', stages)!;
      collections.pumpFirstUpdates(state as never, minimum, operation => work.measure(operation), true);
      expect(ownedCopy).toHaveBeenCalledOnce();
      expect(draw).toHaveBeenCalledTimes(hidden ? 0 : 1);
      expect(state.commandList).toHaveLength(hidden ? 0 : 1);
      collections.updateChildren(state as never);
      expect(draw).toHaveBeenCalledTimes(hidden ? 0 : 1);
      expect(collection.show).toBe(!hidden);

      // The second viewport reuses the physical frame's spent service grant.
      // It draws the uploaded child without another cold preparation unit.
      state.commandList.length = 0;
      const second = lease.frame(1);
      expect(second.continuation('upload', stages)).toBeUndefined();
      collections.pumpFirstUpdates(state as never, second.tileBudget);
      collections.updateChildren(state as never);
      expect(ownedCopy).toHaveBeenCalledOnce();
      expect(draw).toHaveBeenCalledTimes(hidden ? 0 : 2);
      expect(state.commandList).toHaveLength(hidden ? 0 : 1);
      expect(collection.show).toBe(!hidden);
    }
    finally {
      lease.release();
      root.destroy();
    }
  });
});
