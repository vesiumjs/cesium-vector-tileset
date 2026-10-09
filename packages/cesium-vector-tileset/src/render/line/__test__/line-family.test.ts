import type { LineLayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Primitive } from 'cesium';
import Point from '@mapbox/point-geometry';
import * as Cesium from 'cesium';
import { BoundingSphere, Cartesian3, Cartesian4, Color, ComponentDatatype, Matrix4, SceneMode } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineBucket } from '../../../data/bucket/line-bucket';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { LineStyleLayer } from '../../../style/style-layer/line-style-layer';
import { OverscaledTileID } from '../../../tile/tile-id';
import { GeometryPrimitive } from '../../geometry/geometry-primitive';
import { linePaintForOwner, uniformLineExtentForOwner } from '../../scene/draw-batch';
import { LineFamilyChunk } from '../line-family';
import { beginLineBuild, commitLineBuild, stepLineBuild } from '../line-renderer';

interface NativeTable {
  setBatchedAttribute: (instance: number, attribute: number, value: number | Cartesian4) => void;
  getBatchedAttribute: (instance: number, attribute: number, result?: Cartesian4) => number | Cartesian4;
  update: (frame: unknown) => void;
}

interface NativeCommand {
  owner: object;
  vertexArray?: unknown;
  uniformMap: Record<string, () => unknown>;
  dirty: boolean;
  lastDirtyTime: number;
  count?: number;
  instanceCount?: number;
  boundingVolume?: object;
  modelMatrix?: object;
  pass?: number;
  pickId?: string;
  derivedCommands: {
    logDepth?: { command: NativeCommand };
    picking?: { pickCommand: NativeCommand };
  };
}

const native = Cesium as unknown as {
  BatchTable: new (context: object, attributes: object[], instances: number) => NativeTable;
  DrawCommand: new (options: object) => NativeCommand;
  Scene: { prototype: { updateDerivedCommands: (command: NativeCommand) => void } };
  DerivedCommand: {
    createLogDepthCommand: (...args: unknown[]) => unknown;
    createPickDerivedCommand: (...args: unknown[]) => unknown;
  };
  RenderState: { fromCache: (options: object) => object };
  ContextLimits: { _maximumTextureSize: number; _minimumAliasedLineWidth: number; _maximumAliasedLineWidth: number };
};

afterEach(() => vi.restoreAllMocks());

function uniformFamily(instanceCasing = false) {
  const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
  const layers = ['roads', 'casing'].map((id, index) => {
    const layer = new LineStyleLayer({
      id,
      type: 'line',
      source: 'city',
      paint: {
        'line-width': index && instanceCasing ? ['get', 'width'] : 5 + index,
        'line-color': '#ff0000',
      },
    } satisfies LineLayerSpecification, {});
    layer.recalculate(new EvaluationParameters(8), []);
    return layer;
  });
  const bucket = new LineBucket({ layers, zoom: 0 } as never);
  for (let featureIndex = 0; featureIndex < 2; featureIndex++)
    bucket.addFeature({ properties: { width: 7 }, type: 2 } as never, [[new Point(0, 0), new Point(4096, 4096)]], featureIndex, tileID.canonical, {}, {});
  const positions = new Float64Array([...Cartesian3.pack(Cartesian3.fromDegrees(0, 0), []), ...Cartesian3.pack(Cartesian3.fromDegrees(1, 0), [])]);
  const sources = layers.flatMap(layer => [0, 1].map(featureIndex => ({ layerId: layer.id, featureIndex, positions, tilePositions: new Float64Array([0, 0, 4096, 4096]) })));
  const build = beginLineBuild(sources, { roads: bucket, casing: bucket }, 'city/roads', tileID, 4, 8);
  expect(stepLineBuild(build, { exhausted: false })).toBe(true);
  const collection = commitLineBuild(build)!;
  const chunk = collection.get(0) as LineFamilyChunk;
  expect(chunk).toBeInstanceOf(LineFamilyChunk);
  const limit = native.ContextLimits._maximumTextureSize;
  native.ContextLimits._maximumTextureSize = 4096;
  const context = { floatingPointTexture: true, createPickId: vi.fn(() => ({ color: Color.YELLOW, destroy: vi.fn() })) };
  const base = new native.BatchTable(context, [
    { functionName: 'czm_batchTable_pickColor', componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4 },
    { functionName: 'czm_batchTable_color', componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4 },
    { functionName: 'czm_batchTable_lineWidth', componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1 },
  ], 2);
  const tables: NativeTable[] = [];
  vi.spyOn(native.BatchTable.prototype, 'update').mockImplementation(function () {
    tables.push(this);
  });
  const vertexArray = { destroy: vi.fn() };
  const command = new native.DrawCommand({ owner: chunk.primitive, uniformMap: {}, vertexArray });
  // Native upload is the boundary; builds, family initialization, actual
  // BatchTable storage, live paint, pick IDs and command replay stay real.
  const update = vi.spyOn(GeometryPrimitive.prototype, 'update').mockImplementation(function (frame) {
    Object.assign(this, { _batchTable: base, _va: [vertexArray] });
    frame!.commandList!.push(command as never);
  });
  let now = 0;
  const paint = (values: LineLayerSpecification['paint'], indices = [0, 1]) => {
    now += 10;
    for (const index of indices) {
      const layer = layers[index];
      for (const [property, value] of Object.entries(values!))
        layer.setPaintProperty(property, value);
      layer.updateTransitions({ now, transition: { duration: 0 } });
      layer.recalculate(new EvaluationParameters(8, { now }), []);
    }
    chunk.updatePaint(8, true);
  };
  const render = (state = {}) => {
    const frame = { context, commandList: [] as NativeCommand[], ...state };
    chunk.update(frame);
    return frame.commandList;
  };
  const ready = () => Object.assign(chunk.primitive, { _ready: true });
  const close = () => {
    collection.destroy();
    native.ContextLimits._maximumTextureSize = limit;
  };
  return { chunk, context, command, update, tables, vertexArray, paint, render, ready, close };
}

describe('native family replay commands', () => {
  it('updates ground scale for constant and held instance paint without rewriting feature widths', () => {
    const family = uniformFamily(true);
    try {
      const original = family.render();
      const replay = original[1];
      const uniforms = replay.uniformMap;
      const scale = uniforms.u_line_meters_per_pixel() as number;
      const instanceWidth = family.tables[1].getBatchedAttribute(0, 2);
      family.chunk.updateUniformPaint(12);
      expect(family.render()[1]).toBe(replay);
      expect(replay.uniformMap).toBe(uniforms);
      expect(uniforms.u_line_meters_per_pixel()).toBeCloseTo(scale / 16, 10);
      expect(family.tables[1].getBatchedAttribute(0, 2)).toBe(instanceWidth);
      const snapshot = family.chunk.captureCameraPaint();
      snapshot(13);
      expect(uniforms.u_line_meters_per_pixel()).toBeCloseTo(scale / 32, 10);
      expect(family.tables[1].getBatchedAttribute(0, 2)).toBe(instanceWidth);
    }
    finally { family.close(); }
  });

  it('publishes uniform width evidence only after normalizing the actual family table', () => {
    const family = uniformFamily(true);
    try {
      expect(uniformLineExtentForOwner(family.chunk.primitive)).toBeUndefined();
      const commands = family.render();
      expect(uniformLineExtentForOwner(commands[0].owner)).toEqual({ widthFactor: 1, miterLimit: 2 });
      // The replay's sentinel uniform width of one is instance paint, so its
      // visible seven-pixel features must never inherit root culling evidence.
      expect(linePaintForOwner(commands[1].owner)!.width).toBe(1);
      expect(uniformLineExtentForOwner(commands[1].owner)).toBeUndefined();
      const base = family.tables[0] as NativeTable;
      expect(base.getBatchedAttribute(0, 2)).toBe(1);
    }
    finally {
      family.close();
    }
  });

  it('retains clean replay commands and Native pick/log-depth derivatives on steady frames', () => {
    const family = uniformFamily();
    const minimumLineWidth = native.ContextLimits._minimumAliasedLineWidth;
    const maximumLineWidth = native.ContextLimits._maximumAliasedLineWidth;
    native.ContextLimits._minimumAliasedLineWidth = 1;
    native.ContextLimits._maximumAliasedLineWidth = 1;
    const shader = { id: 1, fragmentShaderSource: { defines: [] } };
    Object.assign(family.command, {
      shaderProgram: shader,
      renderState: native.RenderState.fromCache({}),
      pickId: 'v_pickColor',
      modelMatrix: Matrix4.IDENTITY,
    });
    const scene = {
      _frameState: { useLogDepth: true, pickingMetadata: false, passes: { snap: false }, shadowState: { lastDirtyTime: 7 } },
      _hdr: false,
      _context: { shaderCache: { getDerivedShaderProgram: () => shader } },
      _view: {},
      picking: { pickRenderStateCache: {} },
      _depthOnlyRenderStateCache: {},
    };
    const derive = (command: NativeCommand) => Reflect.apply(native.Scene.prototype.updateDerivedCommands, scene, [command]);
    const logDepth = vi.spyOn(native.DerivedCommand, 'createLogDepthCommand');
    const pick = vi.spyOn(native.DerivedCommand, 'createPickDerivedCommand');
    try {
      const replay = family.render({ mode: SceneMode.SCENE3D })[1];
      derive(replay);
      expect(replay.dirty).toBe(false);
      expect(logDepth).toHaveBeenCalledTimes(1);
      expect(pick).toHaveBeenCalledTimes(2);
      const uniforms = replay.uniformMap;
      const derived = replay.derivedCommands.logDepth!.command;
      logDepth.mockClear();
      pick.mockClear();
      const next = family.render({ mode: SceneMode.SCENE3D })[1];
      expect(next).toBe(replay);
      expect(next.uniformMap).toBe(uniforms);
      expect(next.dirty).toBe(false);
      expect(next.lastDirtyTime).toBe(7);
      derive(next);
      expect(logDepth).not.toHaveBeenCalled();
      expect(pick).not.toHaveBeenCalled();
      expect(next.derivedCommands.logDepth!.command).toBe(derived);
      expect(family.update).toHaveBeenCalledTimes(2);
      family.paint({ 'line-width': 9, 'line-color': '#00ff00' });
      const live = family.render()[1];
      expect(live).toBe(replay);
      expect(live.dirty).toBe(false);
      expect(live.uniformMap.u_line_width()).toBe(9);
      expect(live.uniformMap.u_line_color()).toEqual(Color.LIME);
      derive(live);
      expect(logDepth).not.toHaveBeenCalled();
      expect(pick).not.toHaveBeenCalled();

      // Native selects a different volume in planar mode, and can recreate
      // geometry/shaders or uniforms while retaining its command object.
      const bounds = new BoundingSphere(new Cartesian3(0, 20, 30), 4);
      const modelMatrix = Matrix4.fromTranslation(new Cartesian3(0, 2, 3));
      const vertexArray = {};
      Object.assign(family.command, {
        count: 24,
        instanceCount: 2,
        boundingVolume: bounds,
        modelMatrix,
        vertexArray,
        pass: 7,
        pickId: 'v_newPickColor',
        shaderProgram: { ...shader, id: 2 },
        uniformMap: { u_nativeView: () => modelMatrix },
      });
      const changed = family.render({ mode: SceneMode.COLUMBUS_VIEW })[1];
      expect(changed).toBe(replay);
      expect(changed.owner).not.toBe(family.command.owner);
      expect(changed.dirty).toBe(true);
      expect(changed.uniformMap).not.toBe(uniforms);
      expect(changed.uniformMap.u_nativeView()).toBe(modelMatrix);
      expect(changed.uniformMap.u_line_width).toBe(uniforms.u_line_width);
      expect(changed.uniformMap.u_line_color).toBe(uniforms.u_line_color);
      expect(changed.uniformMap.u_line_clip_planes).toBe(uniforms.u_line_clip_planes);
      derive(changed);
      const changedLogDepth = changed.derivedCommands.logDepth!.command;
      expect(changedLogDepth.count).toBe(24);
      expect(changedLogDepth.instanceCount).toBe(2);
      expect(changedLogDepth.boundingVolume).toBe(bounds);
      expect(changedLogDepth.modelMatrix).toBe(modelMatrix);
      expect(changedLogDepth.vertexArray).toBe(vertexArray);
      expect(changedLogDepth.pass).toBe(7);
      expect(changedLogDepth.derivedCommands.picking!.pickCommand.pickId).toBe('v_newPickColor');
      logDepth.mockClear();
      pick.mockClear();
      bounds.radius = 8;
      modelMatrix[12] = 10;
      const planar = family.render({ mode: SceneMode.COLUMBUS_VIEW })[1];
      expect(planar.dirty).toBe(false);
      derive(planar);
      expect(logDepth).not.toHaveBeenCalled();
      expect(pick).not.toHaveBeenCalled();
      expect(changedLogDepth.boundingVolume).toEqual(bounds);
      expect(changedLogDepth.modelMatrix).toEqual(modelMatrix);
      planar.dirty = true;
      family.render({ mode: SceneMode.SCENE2D });
      expect(planar.dirty).toBe(true);
      derive(planar);
      expect(logDepth).toHaveBeenCalledTimes(1);
      expect(pick).toHaveBeenCalledTimes(2);
      expect(family.update).toHaveBeenCalledTimes(6);
    }
    finally {
      family.close();
      native.ContextLimits._minimumAliasedLineWidth = minimumLineWidth;
      native.ContextLimits._maximumAliasedLineWidth = maximumLineWidth;
    }
  });
});

describe('invisible ready family owners', () => {
  it.each(['width', 'alpha'] as const)('prepares cold zero %s owners, then skips Native work until a casing becomes visible', (zero) => {
    const family = uniformFamily();
    try {
      family.paint(zero === 'width' ? { 'line-width': 0 } : { 'line-opacity': 0 });
      expect(family.chunk.ready).toBe(false);
      expect(family.render()).toHaveLength(2);
      expect(family.update).toHaveBeenCalledTimes(1);
      expect(family.tables).toHaveLength(2);
      expect(family.context.createPickId).toHaveBeenCalledTimes(2);
      family.ready();
      const picks = family.context.createPickId.mock.results.map(result => result.value);
      for (let frame = 0; frame < 4; frame++) {
        const commands = family.render();
        expect(family.update).toHaveBeenCalledTimes(1);
        expect(commands).toHaveLength(0);
      }
      expect(family.update).toHaveBeenCalledTimes(1);
      expect(family.tables).toHaveLength(2);

      family.paint({ 'line-width': 9, 'line-opacity': 1, 'line-color': '#00ff00' }, [1]);
      const partial = family.render();
      expect(family.update).toHaveBeenCalledTimes(2);
      expect(partial).toHaveLength(2);
      const road = linePaintForOwner(partial[0].owner)!;
      const casing = linePaintForOwner(partial[1].owner)!;
      expect(zero === 'width' ? road.width : road.color.alpha).toBe(0);
      expect(casing.width).toBe(9);
      expect(casing.color).toEqual(Color.LIME);
      expect(partial.every(command => command.vertexArray === family.vertexArray)).toBe(true);
      expect(family.context.createPickId.mock.results.map(result => result.value)).toEqual(picks);
      expect(picks.every(pick => pick.destroy.mock.calls.length === 0)).toBe(true);

      family.paint({ 'line-width': 10, 'line-opacity': 1 }, [0]);
      expect(family.render().every(command => command.vertexArray === family.vertexArray)).toBe(true);
      expect(family.context.createPickId).toHaveBeenCalledTimes(2);
    }
    finally { family.close(); }
  });

  it('initializes an invisible family even if Native became ready before its first replay', () => {
    const family = uniformFamily();
    try {
      family.paint({ 'line-width': 0 });
      family.ready();
      expect(family.render()).toHaveLength(2);
      expect(family.update).toHaveBeenCalledTimes(1);
      expect(family.context.createPickId).toHaveBeenCalledTimes(2);
      expect(family.tables).toHaveLength(2);
    }
    finally { family.close(); }
  });

  it('continues Native preparation after replay initialization until Native is ready', () => {
    const family = uniformFamily();
    try {
      family.paint({ 'line-width': 0 });
      family.render();
      expect(family.chunk.ready).toBe(false);
      expect(family.render()).toHaveLength(2);
      expect(family.update).toHaveBeenCalledTimes(2);
      expect(family.tables).toHaveLength(4);
      expect(family.context.createPickId).toHaveBeenCalledTimes(2);
    }
    finally { family.close(); }
  });

  it('keeps Native updates for instance paint even when all actual instance colors are transparent', () => {
    const family = uniformFamily(true);
    try {
      family.render();
      family.ready();
      family.paint({ 'line-opacity': 0 });
      const commands = family.render();
      expect(family.update).toHaveBeenCalledTimes(2);
      expect(commands).toHaveLength(2);
      expect(linePaintForOwner(commands[0].owner)!.color.alpha).toBe(0);
      expect(linePaintForOwner(commands[1].owner)!.color.alpha).toBe(1);
      expect(family.tables[1].getBatchedAttribute(0, 1, new Cartesian4())).toEqual(new Cartesian4(255, 0, 0, 0));
      expect(commands.every(command => command.vertexArray === family.vertexArray)).toBe(true);
      expect(family.context.createPickId).toHaveBeenCalledTimes(2);
    }
    finally { family.close(); }
  });
});

describe('committed family instance paint', () => {
  it.each(['cold-held', 'hot-held', 'cold-current'])('keeps complete committed instance paint through first upload and freeze (%s)', (mode) => {
    const uploaded = mode === 'hot-held';
    const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
    const layers = ['roads', 'casing'].map((id, index) => {
      const layer = new LineStyleLayer({
        id,
        type: 'line',
        source: 'city',
        paint: {
          'line-width': index ? ['*', ['get', 'width'], 2] : ['get', 'width'],
          'line-color': index ? '#00ff00' : '#ff0000',
        },
      } satisfies LineLayerSpecification, {});
      layer.recalculate(new EvaluationParameters(8), []);
      return layer;
    });
    const bucket = new LineBucket({ layers, zoom: 0 } as never);
    for (const [index, width] of [7, 3].entries())
      bucket.addFeature({ properties: { width }, type: 2 } as never, [[new Point(0, 0), new Point(4096, 4096)]], index, tileID.canonical, {}, {});
    const positions = new Float64Array([...Cartesian3.pack(Cartesian3.fromDegrees(0, 0), []), ...Cartesian3.pack(Cartesian3.fromDegrees(1, 0), [])]);
    const sources = layers.flatMap(layer => [0, 1].map(featureIndex => ({ layerId: layer.id, featureIndex, positions, tilePositions: new Float64Array([0, 0, 4096, 4096]) })));
    const build = beginLineBuild(sources, { roads: bucket, casing: bucket }, 'city/old', tileID, 4, 8);
    expect(stepLineBuild(build, { exhausted: false })).toBe(true);
    const collection = commitLineBuild(build)!;
    const chunk = collection.get(0) as LineFamilyChunk;
    expect(chunk).toBeInstanceOf(LineFamilyChunk);
    expect(chunk.ready).toBe(false);
    const limit = native.ContextLimits._maximumTextureSize;
    native.ContextLimits._maximumTextureSize = 4096;
    const context = { floatingPointTexture: true, createPickId: vi.fn(() => ({ color: Color.YELLOW, destroy: vi.fn() })) };
    const attributes = [
      { functionName: 'czm_batchTable_pickColor', componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4 },
      { functionName: 'czm_batchTable_color', componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4 },
      { functionName: 'czm_batchTable_lineWidth', componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1 },
    ];
    const base = new native.BatchTable(context, attributes, 2);
    const tables: NativeTable[] = [];
    vi.spyOn(native.BatchTable.prototype, 'update').mockImplementation(function () {
      tables.push(this);
    });
    // Substitute only Native's GPU upload: family initialization, table
    // storage, instance paint and replay commands remain production code.
    vi.spyOn(GeometryPrimitive.prototype, 'update').mockImplementation(function (frame) {
      Object.assign(this, { _batchTable: base });
      frame!.commandList!.push({ owner: this, uniformMap: {} } as never);
    });
    try {
      if (uploaded) {
        chunk.update({ context, commandList: [] });
        for (const [index, layer] of layers.entries()) {
          layer.setPaintProperty('line-color', index ? '#ffff00' : '#ff00ff');
          layer.updateTransitions({ now: 50, transition: { duration: 0 } });
          layer.recalculate(new EvaluationParameters(8, { now: 50 }), []);
        }
        chunk.updatePaint(8, true);
        tables.length = 0;
      }
      const snapshot = chunk.captureCameraPaint();
      for (const layer of layers) {
        layer.setPaintProperty('line-color', '#0000ff');
        if (mode !== 'cold-current') {
          layer.setPaintProperty('line-width', 99);
          layer.setLayoutProperty('line-join', 'bevel');
        }
        layer.updateTransitions({ now: 100, transition: { duration: 0 } });
        layer.recalculate(new EvaluationParameters(12, { now: 100 }), []);
      }
      if (uploaded)
        snapshot(12);
      if (mode === 'cold-current')
        chunk.updatePaint(12, true);
      const frame = { context, commandList: [] as Array<{ owner: Primitive }> };
      chunk.update(frame);
      expect(frame.commandList).toHaveLength(2);
      expect(tables).toHaveLength(2);
      expect([0, 1].map(index => tables[0].getBatchedAttribute(index, 2))).toEqual([7, 3]);
      expect([0, 1].map(index => tables[1].getBatchedAttribute(index, 2))).toEqual([14, 6]);
      expect(tables[0].getBatchedAttribute(0, 1, new Cartesian4())).toEqual(mode === 'cold-current' ? new Cartesian4(0, 0, 255, 255) : new Cartesian4(255, 0, uploaded ? 255 : 0, 255));
      expect(tables[1].getBatchedAttribute(1, 1, new Cartesian4())).toEqual(mode === 'cold-current' ? new Cartesian4(0, 0, 255, 255) : new Cartesian4(uploaded ? 255 : 0, 255, 0, 255));
      expect(context.createPickId).toHaveBeenCalledTimes(2);
      snapshot(12);
    }
    finally {
      collection.destroy();
      native.ContextLimits._maximumTextureSize = limit;
    }
  });
});
