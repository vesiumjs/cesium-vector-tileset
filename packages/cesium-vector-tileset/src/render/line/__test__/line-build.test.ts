import type { GeometryPrepareBatchRequest } from '../../geometry/geometry-preparation';
import * as Cesium from 'cesium';
import { BoundingSphere, buildModuleUrl, Cartesian3, Ellipsoid, GeographicProjection, Matrix4, Primitive, PrimitiveType, SceneMode, TaskProcessor, WebMercatorProjection } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { FillBucket, LineBucket } from '../../../data/bucket-runtime';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { LineStyleLayer } from '../../../style/style-layer/line-style-layer';
import { CanonicalTileID } from '../../../tile/tile-id';
import { createGeometryPacket } from '../../geometry/geometry-packet';
import { prepareGeometry, prepareGeometryBatch } from '../../geometry/geometry-preparation';
import { updateGeometryWithBudget } from '../../geometry/geometry-primitive';
import { lineInputs } from '../../geometry/line-input';
import { drawBatchForOwner, linePaintForOwner, uniformLineExtentForOwner } from '../../scene/draw-batch';
import { createLineGeometry } from '../line-geometry';
import { beginLineBuild, canResumeLineBuild, commitLineBuild, discardLineBuild, stepLineBuild } from '../line-renderer';

describe('line publication budget', () => {
  it('keeps dense solid roads in one permanent owner and one Native VA input despite many work quanta', () => {
    const runtime = Cesium as unknown as {
      VERSION: string;
      ContextLimits: { _maximumTextureSize: number };
      PrimitivePipeline: {
        packCombineGeometryParameters: (parameters: object, transfers: ArrayBuffer[]) => object;
        unpackCombineGeometryResults: (result: object) => { geometries: object[] };
      };
    };
    const previous = runtime.ContextLimits._maximumTextureSize;
    runtime.ContextLimits._maximumTextureSize = 4096;
    const layer = new LineStyleLayer({ id: 'road', type: 'line', source: 'source' }, {});
    layer.recalculate(new EvaluationParameters(0), []);
    const bucket = Object.assign(Object.create(LineBucket.prototype), {
      layers: [layer],
      featureLineJoinCaps: [],
      lineJoinCap: { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05 },
      programConfigurations: { get: () => ({ getAttributeArray: () => undefined }), getFeatureRange: () => ({ index: 0, start: 0, end: 1 }) },
    });
    const positions = new Float64Array([...Cartesian3.pack(Cartesian3.fromDegrees(0, 30), []), ...Cartesian3.pack(Cartesian3.fromDegrees(0.001, 30.001), [])]);
    const sources = Array.from({ length: 3000 }, (_, featureIndex) => ({ layerId: 'road', featureIndex, positions, tilePositions: new Float64Array([0, 0, 1, 1]) }));
    const state = beginLineBuild(sources, { road: bucket }, '0/0/0', new CanonicalTileID(0, 0, 0), 0, 0);
    try {
      expect(stepLineBuild(state, { exhausted: false })).toBe(true);
      const collection = commitLineBuild(state)!;
      try {
        let nativeVertexArrays = 0;
        let instances = 0;
        for (let index = 0; index < collection.length; index++) {
          const owner = collection.get(index);
          const geometries = owner.geometryInstances.map(instance => instance.geometry);
          const copying = createGeometryPacket(geometries, lineInputs);
          let copied = copying.next();
          while (!copied.done) copied = copying.next();
          const packet = copied.value;
          const parameters = runtime.PrimitivePipeline.packCombineGeometryParameters({ createGeometryResults: [], instances: owner.geometryInstances, ellipsoid: Ellipsoid.WGS84, projection: new WebMercatorProjection(), elementIndexUintSupported: true, scene3DOnly: true, vertexCacheOptimize: false, compressVertices: false, modelMatrix: Matrix4.IDENTITY, createPickOffsets: true }, []);
          const prepared = prepareGeometry(structuredClone({ version: runtime.VERSION, parameters, geometries: packet.subTasks.map(task => task.geometry), lineInputs: packet.lineInputs, layout: 'line', scene3DOnly: true, maximumTextureSize: 4096 }), []);
          // LineGeometryUpload allocates one permanent VA for each actual
          // Native combined geometry, independently of its upload writes.
          nativeVertexArrays += runtime.PrimitivePipeline.unpackCombineGeometryResults(prepared.combined).geometries.length;
          instances += owner.geometryInstances.length;
        }
        expect(instances).toBe(3000);
        expect({ owners: collection.length, nativeVertexArrays }).toEqual({ owners: 1, nativeVertexArrays: 1 });
      }
      finally { collection.destroy(); }
    }
    finally {
      discardLineBuild(state);
      runtime.ContextLimits._maximumTextureSize = previous;
    }
  });

  it('amortizes deadline checks for short roads while preserving every geometry', () => {
    const tileID = new CanonicalTileID(0, 0, 0);
    const layer = new LineStyleLayer({ id: 'road', type: 'line', source: 'source' }, {});
    layer.recalculate(new EvaluationParameters(0), []);
    const bucket = Object.assign(Object.create(LineBucket.prototype), {
      layers: [layer],
      featureLineJoinCaps: [],
      lineJoinCap: { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05 },
      programConfigurations: {
        get: () => ({ getAttributeArray: () => undefined }),
        getFeatureRange: () => ({ index: 0, start: 0, end: 1 }),
      },
    });
    const sources = Array.from({ length: 512 }, (_, featureIndex) => {
      const positions = new Float64Array(6);
      Cartesian3.pack(Cartesian3.fromDegrees(featureIndex / 1000, 30), positions as unknown as number[], 0);
      Cartesian3.pack(Cartesian3.fromDegrees((featureIndex + 1) / 1000, 30.001), positions as unknown as number[], 3);
      return { layerId: 'road', featureIndex, positions, tilePositions: new Float64Array([featureIndex, 0, featureIndex + 1, 1]) };
    });
    const state = beginLineBuild(sources, { road: bucket }, '0/0/0', tileID, 0, 0);
    let checkpoints = 0;
    expect(stepLineBuild(state, {
      get exhausted() {
        checkpoints++;
        return false;
      },
    })).toBe(true);
    // Real geometry work still checks once per road; cheap preparation adds
    // less than one extra check per eight roads across both source scans.
    expect(checkpoints).toBeLessThan(600);
    expect(checkpoints).toBeGreaterThanOrEqual(sources.length);
    expect(state.byLayer[0].sources).toEqual(sources);
    expect(state.byLayer[0].geometryInputs).toHaveLength(sources.length);
    expect(state.byLayer[0].instances).toHaveLength(sources.length);
    expect(state.byLayer[0].maximumMiterLimit).toBe(2);
    expect(uniformLineExtentForOwner(state.collection!.get(0))).toEqual({ widthFactor: 1, miterLimit: 2 });
    for (const [index, source] of sources.entries()) {
      const expected = createLineGeometry(source.positions, { ...bucket.lineJoinCap, widthPx: 255 }, false, {
        tileID,
        tilePositions: source.tilePositions,
      })!;
      const actual = state.byLayer[0].instances![index];
      expect(actual.id.featureIndex).toBe(source.featureIndex);
      expect(actual.geometry.attributes).toEqual(expected.attributes);
      expect(actual.geometry.indices).toEqual(expected.indices);
      expect(actual.geometry.boundingSphere).toEqual(expected.boundingSphere);
    }
    discardLineBuild(state);

    let groupingReads = 0;
    const interruptedSources = sources.map(source => ({
      ...source,
      get layerId() {
        groupingReads++;
        return source.layerId;
      },
    }));
    const interrupted = beginLineBuild(interruptedSources, { road: bucket }, '0/0/0', tileID, 0, 0);
    expect(groupingReads).toBe(0);
    expect(stepLineBuild(interrupted, { exhausted: true })).toBe(false);
    expect(groupingReads).toBeGreaterThan(0);
    // Map insertion may read a layer id twice, but one call cannot inspect
    // more than 64 source ids plus its initial insertion.
    expect(groupingReads).toBeLessThanOrEqual(65);
    expect(interrupted.byLayer).toHaveLength(0);
    let preparationSteps = 1;
    while (!interrupted.byLayer[0]?.geometryInputs.length && preparationSteps < 64) {
      const previousReads = groupingReads;
      expect(stepLineBuild(interrupted, { exhausted: true })).toBe(false);
      expect(groupingReads - previousReads).toBeLessThanOrEqual(65);
      preparationSteps++;
    }
    // An already-spent budget still advances preparation, but never scans the
    // whole tile or snapshots more than a small bounded batch in one call.
    expect(preparationSteps).toBeLessThan(64);
    let prepared = interrupted.byLayer[0].geometryInputs.length;
    expect(prepared).toBeGreaterThan(0);
    expect(prepared).toBeLessThanOrEqual(64);
    while (prepared < sources.length) {
      expect(stepLineBuild(interrupted, { exhausted: true })).toBe(false);
      const next = interrupted.byLayer[0].geometryInputs.length;
      expect(next - prepared).toBeGreaterThan(0);
      expect(next - prepared).toBeLessThanOrEqual(64);
      expect(interrupted.byLayer[0].instances ?? []).toHaveLength(0);
      prepared = next;
    }
    expect(stepLineBuild(interrupted, { exhausted: true })).toBe(false);
    expect(interrupted.byLayer[0].instances).toHaveLength(1);
    expect(interrupted.collection).toBeUndefined();
    expect(() => commitLineBuild(interrupted)).toThrow('unfinished');
    discardLineBuild(interrupted);
  });

  it('keeps Native outline coordinates immutable and expands command bounds for shader height', async () => {
    const layer = new FillStyleLayer({ id: 'land', type: 'fill', source: 'source' }, {});
    layer.recalculate(new EvaluationParameters(0), []);
    const bucket = Object.assign(Object.create(FillBucket.prototype), {
      layers: [layer],
      programConfigurations: {
        get: () => ({ getAttributeArray: () => undefined }),
        getFeatureRange: () => ({ index: 0, start: 0, end: 1 }),
      },
    });
    const positions = new Float64Array([...Cartesian3.pack(Cartesian3.fromDegrees(0, 0), []), ...Cartesian3.pack(Cartesian3.fromDegrees(1, 0), [])]);
    const source = { layerId: 'land', featureIndex: 0, positions, tilePositions: new Float64Array([0, 0, 1, 0]), offsetMeters: 1.031 };
    const state = beginLineBuild([source], { land: bucket }, '0/0/0', new CanonicalTileID(0, 0, 0), 0, 0);
    expect(stepLineBuild(state, { exhausted: false })).toBe(true);
    const collection = commitLineBuild(state)!;
    const primitive = collection.get(0);
    const geometry = primitive.geometryInstances[0].geometry;
    expect(geometry.primitiveType).toBe(PrimitiveType.LINES);
    expect(geometry.attributes.position.values).toBe(positions);
    expect(drawBatchForOwner(primitive)).toEqual({ layerId: 'land', tileId: '0/0/0', kind: 'fill-outline' });
    expect(linePaintForOwner(primitive)!.offsetUniform()).toBe(source.offsetMeters);
    const bounds = BoundingSphere.clone(geometry.boundingSphere)!;
    const initialRadius = bounds.radius;
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl('http://localhost/cesium/');
    const runtime = Cesium as unknown as { PrimitiveState: { COMBINING: number; COMBINED: number } };
    const transfer = TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer?: boolean };
    const previousTransfer = transfer._canTransferArrayBuffer;
    transfer._canTransferArrayBuffer = false;
    const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() });
    const schedule = TaskProcessor.prototype.scheduleTask;
    const scheduling = vi.spyOn(TaskProcessor.prototype, 'scheduleTask').mockImplementation(function (this: TaskProcessor, parameters, transfers) {
      Object.assign(this, { _worker: worker });
      return schedule.call(this, parameters, transfers);
    });
    // Native initializes its batch table while the kernel is pending, then
    // submits a command only after the real reply advances it to COMBINED.
    const update = vi.spyOn(Primitive.prototype, 'update').mockImplementation((...args: unknown[]) => {
      if ((primitive as unknown as { _state: number })._state === runtime.PrimitiveState.COMBINING) {
        Object.assign(primitive, { _batchTable: { destroy: () => undefined } });
        return;
      }
      expect((primitive as unknown as { _state: number })._state).toBe(runtime.PrimitiveState.COMBINED);
      const frame = args[0] as { commandList: Array<{ boundingVolume: BoundingSphere }> };
      frame.commandList.push({ boundingVolume: bounds });
    });
    const frame = { mode: SceneMode.SCENE3D, mapProjection: new GeographicProjection(), scene3DOnly: true, context: { elementIndexUint: true }, commandList: [] as Array<{ boundingVolume: BoundingSphere }>, afterRender: [] };
    try {
      updateGeometryWithBudget(frame, { exhausted: false }, () => primitive.update(frame));
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(worker.postMessage).toHaveBeenCalledOnce();
      expect(frame.commandList).toEqual([]);
      expect(update).not.toHaveBeenCalled();
      updateGeometryWithBudget(frame, { exhausted: false }, () => primitive.update(frame));
      expect(frame.commandList).toEqual([]);
      expect(update).toHaveBeenCalledOnce();
      updateGeometryWithBudget(frame, { exhausted: false }, () => primitive.update(frame));
      expect(frame.commandList).toEqual([]);
      expect(update).toHaveBeenCalledOnce();
      const task = worker.postMessage.mock.calls[0][0] as { id: number; parameters: GeometryPrepareBatchRequest };
      const outputs: ArrayBuffer[] = [];
      const result = prepareGeometryBatch(structuredClone(task.parameters), outputs);
      worker.dispatchEvent(new MessageEvent('message', { data: { id: task.id, result: structuredClone(result, { transfer: outputs }) } }));
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      updateGeometryWithBudget(frame, { exhausted: false }, () => primitive.update(frame));
      expect(update).toHaveBeenCalledTimes(2);
      expect(frame.commandList[0].boundingVolume.radius).toBe(initialRadius + source.offsetMeters);
      expect(bounds.radius).toBe(initialRadius);
      expect(geometry.attributes.position.values).toBe(positions);
      expect(geometry.boundingSphere.radius).toBe(initialRadius);
    }
    finally {
      collection.destroy();
      scheduling.mockRestore();
      update.mockRestore();
      transfer._canTransferArrayBuffer = previousTransfer;
    }
  });

  it('yields inside a single long path before publishing an instance', () => {
    const layer = new LineStyleLayer({ id: 'road', type: 'line', source: 'source' }, {});
    layer.recalculate(new EvaluationParameters(0), []);
    const bucket = Object.assign(Object.create(LineBucket.prototype), {
      layers: [layer],
      featureLineJoinCaps: [],
      lineJoinCap: { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05 },
      programConfigurations: {
        get: () => ({ getAttributeArray: () => undefined }),
        getFeatureRange: () => ({ index: 0, start: 0, end: 1 }),
      },
    });
    const count = 10000;
    const positions = new Float64Array(count * 3);
    const tilePositions = new Float64Array(count * 2);
    for (let index = 0; index < count; index++) {
      const point = Cartesian3.fromDegrees(index / count, 30 + index % 2 / count);
      Cartesian3.pack(point, positions as unknown as number[], index * 3);
      tilePositions[index * 2] = index;
      tilePositions[index * 2 + 1] = index % 2;
    }
    const state = beginLineBuild([{ layerId: 'road', featureIndex: 0, positions, tilePositions }], { road: bucket }, '0/0/0', new CanonicalTileID(0, 0, 0), 0, 0);

    let checkpoints = 0;
    expect(stepLineBuild(state, {
      get exhausted() {
        return ++checkpoints === 16;
      },
    })).toBe(false);
    expect(checkpoints).toBe(16);
    expect(state.byLayer[0].instances ?? []).toHaveLength(0);
    expect(state.sourceIndex).toBe(0);
    expect(canResumeLineBuild(state)).toBe(true);
    bucket.lineJoinCap.join = 'bevel';
    expect(canResumeLineBuild(state)).toBe(false);
    bucket.lineJoinCap.join = 'round';

    let frames = 1;
    while (!stepLineBuild(state, {
      get exhausted() {
        return ++checkpoints % 250 === 0;
      },
    })) {
      frames++;
    }
    expect(frames).toBeGreaterThan(1);
    // Deadline reads stay proportional to small point quanta, not vertices.
    expect(checkpoints).toBeGreaterThan(1800);
    expect(checkpoints).toBeLessThan(2100);
    const expected = createLineGeometry(positions, { ...bucket.lineJoinCap, widthPx: 255 }, false, {
      tileID: new CanonicalTileID(0, 0, 0),
      tilePositions,
    });
    const actual = state.byLayer[0].instances![0].geometry;
    expect(actual.attributes).toEqual(expected!.attributes);
    expect(actual.indices).toEqual(expected!.indices);
    expect(actual.boundingSphere).toEqual(expected!.boundingSphere);
    const staged = state.collection!;
    const primitive = staged.get(0);
    discardLineBuild(state);
    expect(staged.isDestroyed()).toBe(true);
    expect(primitive.isDestroyed()).toBe(true);
    expect(state.iterator).toBeUndefined();
    expect(state.geometryCache).toBeUndefined();
  });

  it('hands ownership of completed chunks to the caller', () => {
    const state = beginLineBuild([], {}, '0/0/0', new CanonicalTileID(0, 0, 0), 0, 0);
    expect(stepLineBuild(state, { exhausted: false })).toBe(true);
    const staged = state.collection!;
    expect(commitLineBuild(state)).toBeUndefined();
    expect(staged.isDestroyed()).toBe(true);
    expect(state.collection).toBeUndefined();
  });

  it('checks many small outline paths once per source rather than once per compiler phase', () => {
    const layer = new FillStyleLayer({ id: 'land', type: 'fill', source: 'source' }, {});
    layer.recalculate(new EvaluationParameters(0), []);
    const bucket = Object.assign(Object.create(FillBucket.prototype), {
      layers: [layer],
      programConfigurations: {
        get: () => ({ getAttributeArray: () => undefined }),
        getFeatureRange: () => ({ index: 0, start: 0, end: 1 }),
      },
    });
    const sources = Array.from({ length: 1000 }, () => {
      const positions = new Float64Array(15);
      const tilePositions = new Float64Array(10);
      for (let index = 0; index < 5; index++) {
        Cartesian3.pack(Cartesian3.fromDegrees(index / 1000, 30 + index % 2 / 1000), positions as unknown as number[], index * 3);
        tilePositions[index * 2] = index;
        tilePositions[index * 2 + 1] = index % 2;
      }
      return { layerId: 'land', featureIndex: 0, positions, tilePositions };
    });
    const state = beginLineBuild(sources, { land: bucket }, '0/0/0', new CanonicalTileID(0, 0, 0), 0, 0, true);
    let checkpoints = 0;
    expect(stepLineBuild(state, {
      get exhausted() {
        checkpoints++;
        return false;
      },
    })).toBe(true);
    // Source grouping, input preparation and instance assembly each scan once;
    // tiny line/bounds compilers add no phase checkpoints between those scans.
    expect(checkpoints).toBeLessThan(3100);
    expect(state.byLayer[0].instances).toHaveLength(1000);
    expect(state.collection!.length).toBe(2);
    discardLineBuild(state);
  });

  it('destroys chunks staged before an interrupted assembly', () => {
    const layer = new LineStyleLayer({ id: 'road', type: 'line', source: 'source' }, {});
    layer.recalculate(new EvaluationParameters(0), []);
    const bucket = Object.assign(Object.create(LineBucket.prototype), {
      layers: [layer],
      featureLineJoinCaps: [],
      lineJoinCap: { join: 'miter', cap: 'butt', miterLimit: 2, roundLimit: 1.05 },
      programConfigurations: {
        get: () => ({ getAttributeArray: () => undefined }),
        getFeatureRange: () => ({ index: 0, start: 0, end: 1 }),
      },
    });
    const positions = new Float64Array([...Cartesian3.pack(Cartesian3.fromDegrees(0, 0), []), ...Cartesian3.pack(Cartesian3.fromDegrees(1, 0), [])]);
    const source = { layerId: 'road', featureIndex: 0, positions, tilePositions: new Float64Array([0, 0, 1, 0]) };
    const state = beginLineBuild(Array.from<typeof source>({ length: 600 }).fill(source), { road: bucket }, '0/0/0', new CanonicalTileID(0, 0, 0), 0, 0);
    expect(state.byLayer).toHaveLength(0);
    expect(stepLineBuild(state, { exhausted: true })).toBe(false);
    expect(canResumeLineBuild(state)).toBe(true);
    while (!state.collection?.length) expect(stepLineBuild(state, { exhausted: true })).toBe(false);
    expect(state.complete).toBe(false);
    expect(() => commitLineBuild(state)).toThrow('unfinished');
    const collection = state.collection;
    const primitive = collection.get(0);
    discardLineBuild(state);
    discardLineBuild(state);
    expect(collection.isDestroyed()).toBe(true);
    expect(primitive.isDestroyed()).toBe(true);
    expect(stepLineBuild(state, { exhausted: false })).toBe(false);

    const completed = beginLineBuild([source], { road: bucket }, '0/0/0', new CanonicalTileID(0, 0, 0), 0, 0);
    expect(stepLineBuild(completed, { exhausted: false })).toBe(true);
    const committed = commitLineBuild(completed)!;
    discardLineBuild(completed);
    expect(committed.isDestroyed()).toBe(false);
    expect(committed.get(0).isDestroyed()).toBe(false);
    committed.destroy();
  });
});
