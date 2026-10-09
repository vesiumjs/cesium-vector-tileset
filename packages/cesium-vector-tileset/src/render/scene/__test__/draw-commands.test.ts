import type { LinePaintUniforms } from '../draw-batch';
import type { RenderFrameState } from '../render-frame';
import * as Cesium from 'cesium';
import { BoundingSphere, BufferPointCollection, BufferPolygonCollection, Color, DepthFunction, GeographicProjection, Matrix4, PerspectiveFrustum, PointPrimitiveCollection, PrimitiveType, SceneMode, WebMercatorProjection } from 'cesium';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CanonicalTileID } from '../../../tile/tile-id';
import { lineGroundScale } from '../../line/line-ground-scale';
import { LineTileClip } from '../../line/line-tile-clip';
import { registerDrawBatch, registerLinePaint } from '../draw-batch';
import { DrawCommands } from '../draw-commands';

type Command = NonNullable<RenderFrameState['commandList']>[number];
const runtime = Cesium as typeof Cesium & {
  DrawCommand: new (options: { owner: object; pass: number; uniformMap: object; boundingVolume?: BoundingSphere; primitiveType?: PrimitiveType; pickId?: string; renderState?: object }) => Command & {
    dirty: boolean;
    cull: boolean;
    occlude: boolean;
    boundingVolume?: BoundingSphere;
    primitiveType: PrimitiveType;
    pickId?: string;
    renderState?: { depthTest?: { enabled?: boolean } };
  };
  Pass: { OPAQUE: number; TRANSLUCENT: number; OVERLAY: number };
  RenderState: { fromCache: (options: object) => object };
  ContextLimits: { _minimumAliasedLineWidth: number; _maximumAliasedLineWidth: number };
  ClearCommand: new () => object;
};

function lineCommand(kind: 'line' | 'dash' | 'fill-outline', layerId: string, width: number, alpha: number): { command: Command; paint: LinePaintUniforms } {
  const owner = { appearance: undefined };
  const paint: LinePaintUniforms = {
    clip: new LineTileClip(new CanonicalTileID(0, 0, 0)),
    width,
    color: new Color(1, 1, 1, alpha),
    offset: 0,
    metersPerPixel: lineGroundScale(14),
    widthUniform: () => paint.width,
    colorUniform: () => paint.color,
    offsetUniform: () => paint.offset,
    metersPerPixelUniform: () => paint.metersPerPixel,
  };
  registerDrawBatch(owner, { kind, layerId, tileId: 'tile' });
  registerLinePaint(owner, paint);
  return { command: new runtime.DrawCommand({ owner, pass: runtime.Pass.TRANSLUCENT, uniformMap: {} }), paint };
}

function frame(commands: Command[], pick: boolean): RenderFrameState {
  const context = { drawingBufferWidth: 1, uniformState: { view: Matrix4.IDENTITY } };
  return {
    camera: { frustum: new PerspectiveFrustum() } as RenderFrameState['camera'],
    context,
    commandList: commands,
    passes: { render: !pick, pick },
  };
}

describe('final Native draw commands', () => {
  const minimumLineWidth = runtime.ContextLimits._minimumAliasedLineWidth;
  const maximumLineWidth = runtime.ContextLimits._maximumAliasedLineWidth;
  beforeAll(() => {
    // Native normally reads these GL limits when constructing a Context.
    runtime.ContextLimits._minimumAliasedLineWidth = 1;
    runtime.ContextLimits._maximumAliasedLineWidth = 1;
  });
  afterAll(() => {
    runtime.ContextLimits._minimumAliasedLineWidth = minimumLineWidth;
    runtime.ContextLimits._maximumAliasedLineWidth = maximumLineWidth;
  });
  it.each([SceneMode.COLUMBUS_VIEW, SceneMode.SCENE3D])('groups every translucent extrusion owner into a stable compositor in style order in scene mode %s', (mode) => {
    const stateOptions = { depthTest: { enabled: true }, depthMask: false, blending: { enabled: true } };
    const nativeState = runtime.RenderState.fromCache(stateOptions);
    const owners = [{}, {}, {}];
    const sources = owners.map(owner => new runtime.DrawCommand({ owner, pass: runtime.Pass.TRANSLUCENT, uniformMap: {}, renderState: nativeState }));
    sources.forEach((source, index) => registerDrawBatch(source.owner!, { kind: 'extrusion', layerId: index === 2 ? 'later' : 'buildings', tileId: String(index) }));
    const before = new runtime.DrawCommand({ owner: {}, pass: runtime.Pass.OPAQUE, uniformMap: {} });
    const after = new runtime.DrawCommand({ owner: {}, pass: runtime.Pass.OPAQUE, uniformMap: {} });
    registerDrawBatch(before, { kind: 'fill', layerId: 'ground', tileId: 'tile' });
    registerDrawBatch(after, { kind: 'fill', layerId: 'top', tileId: 'tile' });
    const order = new Map([['ground', 0], ['buildings', 1], ['later', 2], ['top', 3]]);
    const draw = new DrawCommands();
    let previous: Command[] | undefined;
    for (let iteration = 0; iteration < 3; iteration++) {
      const state = frame([after, sources[1], sources[2], before, sources[0]], false);
      draw.prepare(state, 0, mode, order, { updateDerivedCommands: () => {} });
      const commands = state.commandList!;
      expect(commands).toHaveLength(4);
      expect(commands[0]).toBe(before);
      expect(commands[3]).toBe(after);
      expect(commands.slice(1, 3).map(command => command.owner)).toEqual([owners[1], owners[2]]);
      for (const index of [1, 2]) {
        const command = commands[index];
        expect(command.pass).toBe(runtime.Pass.OPAQUE);
        expect(command).toBeInstanceOf(runtime.ClearCommand);
      }
      for (const source of sources) {
        expect(source.pass).toBe(runtime.Pass.TRANSLUCENT);
        expect(source.renderState).toBe(nativeState);
      }
      if (previous) {
        commands.forEach((command, index) => expect(command).toBe(previous![index]));
        commands.forEach(command => expect(Reflect.get(command, 'dirty')).toBe(false));
      }
      commands.forEach(command => Reflect.set(command, 'dirty', false));
      previous = commands.slice();
    }
  });

  it('restores one writable-depth Native command for picking and opaque paint after translucent rendering', () => {
    const nativeState = runtime.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: false, blending: { enabled: true } });
    const source = new runtime.DrawCommand({ owner: {}, pass: runtime.Pass.TRANSLUCENT, uniformMap: {}, pickId: 'v_pickColor', renderState: nativeState });
    registerDrawBatch(source.owner!, { kind: 'extrusion', layerId: 'buildings', tileId: 'tile' });
    const draw = new DrawCommands();
    const order = new Map([['buildings', 0]]);
    const rendered = frame([source], false);
    draw.prepare(rendered, 0, SceneMode.COLUMBUS_VIEW, order, { updateDerivedCommands: () => {} });
    expect(rendered.commandList).toHaveLength(1);
    expect(Reflect.get(rendered.commandList![0], 'pickId')).toBeUndefined();
    const picked = frame([source], true);
    draw.prepare(picked, 0, SceneMode.COLUMBUS_VIEW, order);
    expect(picked.commandList).toHaveLength(1);
    expect(Reflect.get(picked.commandList![0], 'pickId')).toBe('v_pickColor');
    expect(Reflect.get(picked.commandList![0], 'renderState')).toMatchObject({ depthMask: true, depthTest: { func: DepthFunction.LESS_OR_EQUAL } });
    source.pass = runtime.Pass.OPAQUE;
    const opaque = frame([source], false);
    draw.prepare(opaque, 0, SceneMode.SCENE3D, order);
    expect(opaque.commandList).toHaveLength(1);
    expect(Reflect.get(opaque.commandList![0], 'renderState')).toMatchObject({ depthMask: true, depthTest: { func: DepthFunction.LESS_OR_EQUAL } });
    const hidden = frame([source], false);
    draw.prepare(hidden, 0, SceneMode.SCENE3D, order, undefined, undefined, undefined, undefined, new Map([['buildings', false]]));
    expect(hidden.commandList).toEqual([]);
  });

  it('submits actual translucent extrusion geometry for selected IDs with only pick derivatives writable', () => {
    const nativeState = runtime.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: false, blending: { enabled: true } });
    const sources = [{}, {}].map(owner => new runtime.DrawCommand({ owner, pass: runtime.Pass.TRANSLUCENT, uniformMap: {}, pickId: 'v_pickColor', renderState: nativeState }));
    sources.forEach(source => registerDrawBatch(source.owner!, { kind: 'extrusion', layerId: 'buildings', tileId: 'tile' }));
    const derive = vi.fn((command: Command) => {
      // Native's pick state enables depth writes but inherits the original
      // colorMask, including a normal draw that deliberately writes no color.
      const state = Reflect.get(command, 'renderState');
      const picking = () => ({ pickCommand: new runtime.DrawCommand({ owner: command.owner!, pass: runtime.Pass.OPAQUE, uniformMap: {}, renderState: runtime.RenderState.fromCache({ ...state, depthMask: true, blending: { enabled: false } }) }) });
      Reflect.get(command, 'derivedCommands').picking = picking();
      const log = new runtime.DrawCommand({ owner: command.owner!, pass: runtime.Pass.OPAQUE, uniformMap: {}, renderState: state });
      Reflect.get(log, 'derivedCommands').picking = picking();
      Reflect.get(command, 'derivedCommands').logDepth = { command: log };
      Reflect.set(command, 'dirty', false);
    });
    const draw = new DrawCommands();
    const order = new Map([['buildings', 0]]);
    let previous: Command[] | undefined;
    for (const selected of [true, false, true]) {
      const state = frame(sources.slice(), false);
      Reflect.set(state.passes!, 'postProcess', selected);
      draw.prepare(state, 0, SceneMode.COLUMBUS_VIEW, order, { updateDerivedCommands: derive });
      expect(state.commandList).toHaveLength(selected ? 3 : 1);
      expect(state.commandList![0]).toBeInstanceOf(runtime.ClearCommand);
      if (selected) {
        const identities = state.commandList!.slice(1);
        expect(identities.map(command => command.owner)).toEqual(sources.map(source => source.owner));
        identities.forEach((command, index) => {
          expect(command).not.toBe(sources[index]);
          expect(Reflect.get(command, 'pickId')).toBe('v_pickColor');
          expect(Reflect.get(command, 'renderState')).toMatchObject({ depthMask: false, colorMask: { red: false, green: false, blue: false, alpha: false }, blending: { enabled: false } });
          const derived = Reflect.get(command, 'derivedCommands');
          for (const branch of [derived, Reflect.get(derived.logDepth.command, 'derivedCommands')]) {
            expect(branch.picking.pickCommand.renderState).toMatchObject({ depthMask: true, colorMask: { red: true, green: true, blue: true, alpha: true }, blending: { enabled: false } });
          }
          if (previous)
            expect(command).toBe(previous[index]);
        });
        previous = identities;
      }
      sources.forEach(source => expect(source.renderState).toBe(nativeState));
    }
    expect(derive).toHaveBeenCalledTimes(4);
    const picked = frame(sources.slice(), true);
    Reflect.set(picked.passes!, 'postProcess', true);
    draw.prepare(picked, 0, SceneMode.COLUMBUS_VIEW, order, { updateDerivedCommands: derive });
    expect(picked.commandList).toHaveLength(2);
    expect(derive).toHaveBeenCalledTimes(4);
  });
  it('keeps a stable line projection getter current across new frame overrides', () => {
    const draw = new DrawCommands();
    const { command } = lineCommand('line', 'roads', 10, 1);
    const geographic = new GeographicProjection();
    const mercator = new WebMercatorProjection();
    const camera = { _scene: { mapProjection: geographic } } as RenderFrameState['camera'];
    const prepare = (projection?: RenderFrameState['mapProjection']) => {
      const state = frame([command], false);
      state.camera = camera;
      state.mapProjection = projection;
      draw.prepare(state, 0, SceneMode.COLUMBUS_VIEW, new Map());
      return Reflect.get(command, 'uniformMap') as Record<string, () => unknown>;
    };
    const uniforms = prepare(mercator);
    const projection = uniforms.u_line_mercator_projection;
    expect(projection()).toBe(1);
    // Each call receives a new frame object. The owning scene deliberately
    // stays Geographic, so the frame's current override must take precedence.
    expect(prepare(geographic)).toBe(uniforms);
    expect(uniforms.u_line_mercator_projection).toBe(projection);
    expect(projection()).toBe(0);
    expect(prepare(mercator)).toBe(uniforms);
    expect(projection()).toBe(1);
    expect(prepare()).toBe(uniforms);
    expect(projection()).toBe(0);
  });

  it('lets real BufferPoint circle pixels escape center bounds without invalidating stable Native commands', () => {
    const owner = new BufferPointCollection({ primitiveCountMax: 1, allowPicking: true });
    const bounds = new BoundingSphere();
    const renderState = { depthTest: { enabled: true }, depthMask: false };
    const source = new runtime.DrawCommand({ owner, pass: runtime.Pass.TRANSLUCENT, uniformMap: {}, boundingVolume: bounds, primitiveType: PrimitiveType.POINTS, pickId: 'v_pickColor', renderState });
    registerDrawBatch(owner, { kind: 'circle', layerId: 'circles', tileId: 'tile' });
    const setCull = vi.spyOn(source, 'cull', 'set');
    const draw = new DrawCommands();
    let prepared: typeof source | undefined;
    try {
      for (const pick of [false, true, false, true, false]) {
        const state = frame([source], pick);
        draw.prepare(state, 0, SceneMode.SCENE3D, new Map([['circles', 0]]));
        const command = state.commandList![0] as typeof source;
        expect(source.cull).toBe(false);
        expect(command.cull).toBe(false);
        expect(command.occlude).toBe(true);
        expect(command.boundingVolume).toBe(bounds);
        expect(command.primitiveType).toBe(PrimitiveType.POINTS);
        expect(command.pickId).toBe('v_pickColor');
        expect(command.renderState).toBe(renderState);
        expect(command.renderState!.depthTest!.enabled).toBe(true);
        if (prepared) {
          expect(command).toBe(prepared);
          expect(command.dirty).toBe(false);
        }
        command.dirty = false;
        prepared = command;
      }
      expect(setCull).toHaveBeenCalledTimes(1);
    }
    finally {
      setCull.mockRestore();
      owner.destroy();
    }
  });

  it('preserves CPU culling for unrelated owners and Native point owners with pixel-aware bounds', () => {
    const owners = [new BufferPointCollection({ primitiveCountMax: 1 }), new BufferPointCollection({ primitiveCountMax: 1 }), new BufferPolygonCollection({ primitiveCountMax: 1, vertexCountMax: 3 }), new PointPrimitiveCollection(), {}];
    const kinds = [undefined, 'fill', 'fill', 'circle', 'circle'] as const;
    try {
      for (const [index, owner] of owners.entries()) {
        const source = new runtime.DrawCommand({ owner, pass: runtime.Pass.OPAQUE, uniformMap: {} });
        if (kinds[index])
          registerDrawBatch(owner, { kind: kinds[index]!, layerId: 'control', tileId: 'tile' });
        const state = frame([source], false);
        new DrawCommands().prepare(state, 0, SceneMode.SCENE3D, new Map());
        expect(source.cull).toBe(true);
        expect((state.commandList![0] as typeof source).cull).toBe(true);
      }
    }
    finally {
      for (const owner of owners) {
        if (owner instanceof BufferPointCollection || owner instanceof BufferPolygonCollection || owner instanceof PointPrimitiveCollection)
          owner.destroy();
      }
    }
  });

  it('preserves Native derived-command validity for a stable promoted symbol', () => {
    const draw = new DrawCommands();
    const symbol = new runtime.DrawCommand({ owner: {}, pass: runtime.Pass.OPAQUE, uniformMap: {} });
    registerDrawBatch(symbol, { kind: 'symbol', layerId: 'labels', tileId: 'tile' });
    const scene = { isVisible: () => true };
    const order = new Map([['labels', 1]]);
    const prepare = () => {
      const state = frame([symbol], false);
      state.cullingVolume = {} as NonNullable<RenderFrameState['cullingVolume']>;
      draw.prepare(state, 0, SceneMode.SCENE3D, order, scene);
      expect(state.commandList).toEqual([symbol]);
      expect(symbol.pass).toBe(runtime.Pass.OVERLAY);
    };
    prepare();
    // Native clears this flag after deriving the actual command. Stable
    // preparation must preserve its cached log-depth and pick derivatives.
    symbol.dirty = false;
    for (let index = 0; index < 5; index++) {
      prepare();
      expect(symbol.dirty).toBe(false);
    }
  });

  it('invalidates symbol derivatives when final paint ordering, mode or pass changes', () => {
    const draw = new DrawCommands();
    const symbol = new runtime.DrawCommand({ owner: {}, pass: runtime.Pass.OPAQUE, uniformMap: {} });
    const surface = new runtime.DrawCommand({ owner: {}, pass: runtime.Pass.OPAQUE, uniformMap: {} });
    registerDrawBatch(symbol, { kind: 'symbol', layerId: 'labels', tileId: 'tile' });
    registerDrawBatch(surface, { kind: 'fill', layerId: 'surface', tileId: 'tile' });
    const order = new Map([['labels', 1], ['surface', 2]]);
    let visible = true;
    const scene = { isVisible: () => visible };
    const prepare = (geometry: boolean, mode = SceneMode.SCENE3D, pick = false) => {
      const state = frame(geometry ? [symbol, surface] : [symbol], pick);
      state.cullingVolume = {} as NonNullable<RenderFrameState['cullingVolume']>;
      draw.prepare(state, 0, mode, order, scene);
      return state;
    };
    prepare(false);
    expect(symbol.pass).toBe(runtime.Pass.OVERLAY);
    symbol.dirty = false;
    prepare(true);
    expect(symbol.pass).toBe(runtime.Pass.OPAQUE);
    expect(symbol.dirty).toBe(true);
    symbol.dirty = false;
    prepare(true);
    expect(symbol.dirty).toBe(false);
    prepare(false);
    expect(symbol.pass).toBe(runtime.Pass.OVERLAY);
    expect(symbol.dirty).toBe(true);
    for (const [mode, pick] of [[SceneMode.SCENE2D, false], [SceneMode.SCENE3D, true]] as const) {
      symbol.dirty = false;
      prepare(false, mode, pick);
      expect(symbol.pass).toBe(runtime.Pass.OPAQUE);
      expect(symbol.dirty).toBe(true);
      prepare(false, SceneMode.COLUMBUS_VIEW);
      expect(symbol.pass).toBe(runtime.Pass.OVERLAY);
    }
    visible = false;
    expect(prepare(false).commandList).toEqual([]);
    visible = true;
    expect(prepare(false).commandList).toEqual([symbol]);
  });

  it.each(['line', 'dash'] as const)('omits zero uniform %s paint from render and pick commands, then restores the same commands', (kind) => {
    const draw = new DrawCommands();
    const foreign = new runtime.DrawCommand({ owner: {}, pass: runtime.Pass.TRANSLUCENT, uniformMap: {} });
    const roads = lineCommand(kind, 'roads', 6, 1);
    const casing = lineCommand(kind, 'casing', 24, 1);
    const outline = lineCommand('fill-outline', 'outline', 1, 1);
    const order = new Map([['casing', 0], ['outline', 1], ['roads', 2]]);
    for (const pick of [false, true]) {
      for (const property of ['width', 'alpha'] as const) {
        if (property === 'width')
          roads.paint.width = 0;
        else roads.paint.color.alpha = 0;
        const hidden = frame([foreign, roads.command, outline.command, casing.command], pick);
        draw.prepare(hidden, 1, SceneMode.SCENE3D, order);
        expect(hidden.commandList).toHaveLength(3);
        expect(hidden.commandList).toEqual([foreign, casing.command, outline.command]);

        roads.paint.width = 6;
        roads.paint.color.alpha = 1;
        const restored = frame([foreign, roads.command, outline.command, casing.command], pick);
        draw.prepare(restored, 1, SceneMode.SCENE3D, order);
        expect(restored.commandList).toEqual([foreign, casing.command, outline.command, roads.command]);
      }
    }
  });

  it('retains instance-paint sentinel commands and visible fill outlines', () => {
    const line = lineCommand('line', 'instance-lines', 1, 1);
    const dash = lineCommand('dash', 'instance-dashes', 1, 1);
    const outline = lineCommand('fill-outline', 'outline', 1, 1);
    const state = frame([line.command, dash.command, outline.command], false);
    new DrawCommands().prepare(state, 0, SceneMode.SCENE3D, new Map());
    expect(state.commandList).toEqual([line.command, dash.command, outline.command]);
  });
});
