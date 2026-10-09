import type { ExtrusionDepthScene } from '../vector/extrusion-depth-pass';
import type { LineVisibilityScene } from './line-visibility';
import type { RenderFrameState } from './render-frame';
import * as Cesium from 'cesium';
import { BufferPointCollection, BufferPolygonCollection, DepthFunction, PointPrimitiveCollection, SceneMode } from 'cesium';
import { ExtrusionDepthPass } from '../vector/extrusion-depth-pass';
import { drawBatchForOwner, linePaintForOwner, uniformLineExtentForOwner } from './draw-batch';
import { LineVisibility } from './line-visibility';

const pass = (Cesium as typeof Cesium & { Pass: { OPAQUE: number; TRANSLUCENT: number; OVERLAY: number } }).Pass;
const renderState = (Cesium as unknown as { RenderState: { fromCache: (options: object) => object } }).RenderState;
const surfaceStates = new WeakMap<object, object>();

interface NativeShaderSource {
  sources: string[];
  clone: () => NativeShaderSource;
}

interface NativeShaderProgram {
  vertexShaderSource: NativeShaderSource;
  fragmentShaderSource: NativeShaderSource;
  _attributeLocations: Record<string, number>;
}

interface NativeShaderCache {
  getDerivedShaderProgram: (source: NativeShaderProgram, key: string) => NativeShaderProgram | undefined;
  createDerivedShaderProgram: (source: NativeShaderProgram, key: string, options: {
    vertexShaderSource: NativeShaderSource;
    fragmentShaderSource: NativeShaderSource;
    attributeLocations: Record<string, number>;
  }) => NativeShaderProgram;
}

type NativeCommand = NonNullable<RenderFrameState['commandList']>[number] & { dirty: boolean; shaderProgram?: NativeShaderProgram; renderState?: { depthMask?: boolean } };
// Native collection renderers own their blend pass. Prepare a cached Native derivative
// so style ordering never changes the renderer's blend-transition detection.
const drawCommand = (Cesium as unknown as {
  DrawCommand: { shallowClone: (source: NativeCommand, result?: NativeCommand) => NativeCommand };
}).DrawCommand;
const paintCommands = new WeakMap<NativeCommand, NativeCommand>();
const extrusionCommands = new WeakMap<NativeCommand, { color: NativeCommand; depth: NativeCommand }>();
const extrusionStates = new WeakMap<object, { offscreen: object; opaque: object }>();
const extrusionIdCommands = new WeakMap<NativeCommand, NativeCommand>();
const extrusionIdStates = new WeakMap<object, object>();
const extrusionPickStates = new WeakMap<object, object>();

function extrusionCommand(source: NativeCommand): { color: NativeCommand; depth: NativeCommand } {
  let commands = extrusionCommands.get(source);
  if (!commands || source.dirty) {
    commands = {
      color: drawCommand.shallowClone(source, commands?.color),
      depth: drawCommand.shallowClone(source, commands?.depth),
    };
    commands.depth.pass = pass.OPAQUE;
    Object.assign(commands.depth, { pickId: undefined, castShadows: false });
    extrusionCommands.set(source, commands);
    source.dirty = false;
  }
  return commands;
}

function extrusionState(state: object): { offscreen: object; opaque: object } {
  let states = extrusionStates.get(state);
  if (!states) {
    const options = state as { depthTest?: object };
    states = {
      offscreen: renderState.fromCache({ ...state, depthTest: { ...options.depthTest, enabled: true, func: DepthFunction.LESS_OR_EQUAL }, depthMask: true, blending: { enabled: false } }),
      opaque: renderState.fromCache({ ...state, depthTest: { ...options.depthTest, enabled: true, func: DepthFunction.LESS_OR_EQUAL }, depthMask: true }),
    };
    extrusionStates.set(state, states);
  }
  return states;
}

const CIRCLE_PAINT = 'vector-circle-paint';
const CIRCLE_COLOR = `
vec4 cvt_circleColor(vec4 outline, vec4 fill, float coverage)
{
    float alpha = mix(outline.a, fill.a, coverage);
    vec3 rgb = mix(outline.rgb * outline.a, fill.rgb * fill.a, coverage);
    return vec4(alpha > 0.0 ? rgb / alpha : vec3(0.0), alpha);
}
`;

function circleProgram(source: NativeShaderProgram, cache: NativeShaderCache, buffer: boolean): NativeShaderProgram {
  const cached = cache.getDerivedShaderProgram(source, CIRCLE_PAINT);
  if (cached) {
    return cached;
  }
  // Cesium adapter: retain Native coverage, discard, gamma and
  // pick/log-depth code; interpolate premultiplied fill/stroke contributions.
  const original = buffer
    ? 'vec4 color = vec4(mix(v_outlineColor.rgb, v_color.rgb, innerAlpha), outerAlpha);\n    color.a *= mix(v_outlineColor.a, v_color.a, innerAlpha);'
    : 'vec4 color = mix(v_outlineColor, v_color, innerAlpha);';
  const replacement = `vec4 color = cvt_circleColor(v_outlineColor, v_color, innerAlpha);${buffer ? '\n    color.a *= outerAlpha;' : ''}`;
  const fragment = source.fragmentShaderSource.clone();
  let replaced = 0;
  fragment.sources = fragment.sources.map((text) => {
    if (!text.includes(original)) {
      return text;
    }
    replaced++;
    return text.replace(original, replacement);
  });
  if (replaced !== 1) {
    throw new Error('Cesium circle fragment shader changed; update the circle paint adapter.');
  }
  fragment.sources.unshift(CIRCLE_COLOR);
  // Native recursively destroys derived programs with their base shader.
  // The collection keeps that base ownership; this command adds no refcount.
  return cache.createDerivedShaderProgram(source, CIRCLE_PAINT, {
    vertexShaderSource: source.vertexShaderSource,
    fragmentShaderSource: fragment,
    attributeLocations: source._attributeLocations,
  });
}

function paintCommand(source: NativeCommand, context: RenderFrameState['context']): NativeCommand {
  let command = paintCommands.get(source);
  if (!command || source.dirty) {
    command = drawCommand.shallowClone(source, command);
    source.dirty = false;
    if (source.shaderProgram && (source.owner instanceof BufferPointCollection || source.owner instanceof PointPrimitiveCollection)) {
      const cache = (context as { shaderCache: NativeShaderCache }).shaderCache;
      command.shaderProgram = circleProgram(source.shaderProgram, cache, source.owner instanceof BufferPointCollection);
    }
    paintCommands.set(source, command);
  }
  return command;
}

interface VisibleScene extends LineVisibilityScene {
  isVisible?: (volume: unknown, command: unknown, occluder?: unknown) => boolean;
  updateDerivedCommands?: (command: NonNullable<RenderFrameState['commandList']>[number]) => void;
}

interface DerivedCommand {
  renderState?: { depthMask?: boolean };
  derivedCommands?: {
    picking?: { pickCommand: DerivedCommand };
    logDepth?: { command: DerivedCommand };
  };
}

function surfaceState(state: { depthMask?: boolean }): object {
  let surface = surfaceStates.get(state);
  if (!surface) {
    surface = renderState.fromCache({ ...state, depthMask: false });
    surfaceStates.set(state, surface);
  }
  return surface;
}

type FrameCommand = NonNullable<RenderFrameState['commandList']>[number] & {
  cull?: boolean;
  uniformMap?: Record<string, () => unknown>;
  renderState?: { depthMask?: boolean };
};

interface DrawCommandEntry {
  command: FrameCommand;
  batch: NonNullable<ReturnType<typeof drawBatchForOwner>>;
  layer: number;
  promotionLayer: number;
  tile?: number;
  order: number;
  extrusion?: { depth: NativeCommand; states: ReturnType<typeof extrusionState>; translucent: boolean };
}

const EMPTY_RANKS: ReadonlyMap<string, number> = new Map();
const EMPTY_HIDDEN: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const EMPTY_TILES: ReadonlySet<string> = new Set();
const EMPTY_VISIBILITY: ReadonlyMap<string, boolean> = new Map();

function commandBatch(command: { owner?: object }): ReturnType<typeof drawBatchForOwner> {
  return drawBatchForOwner(command) ?? drawBatchForOwner(command.owner);
}

function paintOrder(a: DrawCommandEntry, b: DrawCommandEntry): number {
  const layerDifference = a.layer - b.layer;
  if (layerDifference !== 0) {
    return layerDifference;
  }
  if (a.tile !== undefined && b.tile !== undefined) {
    const tileDifference = b.tile - a.tile;
    if (tileDifference !== 0) {
      return tileDifference;
    }
  }
  return a.order - b.order;
}

function symbolOrder(a: DrawCommandEntry, b: DrawCommandEntry): number {
  return a.layer - b.layer || a.order - b.order;
}

function preservePickDepth(command: DerivedCommand | undefined): void {
  const pick = command?.derivedCommands?.picking?.pickCommand;
  if (pick?.renderState?.depthMask) {
    pick.renderState = surfaceState(pick.renderState);
  }
}

function enableExtrusionPickColor(command: DerivedCommand | undefined): void {
  const pick = command?.derivedCommands?.picking?.pickCommand;
  if (!pick?.renderState)
    return;
  let state = extrusionPickStates.get(pick.renderState);
  if (!state) {
    state = renderState.fromCache({ ...pick.renderState, depthMask: true, colorMask: { red: true, green: true, blue: true, alpha: true } });
    extrusionPickStates.set(pick.renderState, state);
    extrusionPickStates.set(state, state);
  }
  pick.renderState = state;
}

function extrusionIdCommand(source: NativeCommand, scene: VisibleScene): NativeCommand {
  // Native owns geometry, shaders and its real picking derivatives. This
  // separate cached command participates only in selected-ID rendering;
  // its ordinary color draw contributes neither color nor scene depth.
  const command = drawCommand.shallowClone(source, extrusionIdCommands.get(source));
  extrusionIdCommands.set(source, command);
  let state = extrusionIdStates.get(source.renderState!);
  if (!state) {
    state = renderState.fromCache({ ...source.renderState, depthMask: false, blending: { enabled: false }, colorMask: { red: false, green: false, blue: false, alpha: false } });
    extrusionIdStates.set(source.renderState!, state);
  }
  command.renderState = state;
  Object.assign(command, { castShadows: false });
  scene.updateDerivedCommands!(command);
  enableExtrusionPickColor(command as DerivedCommand);
  enableExtrusionPickColor((command as DerivedCommand).derivedCommands?.logDepth?.command);
  return command;
}

/** Own reusable command preparation and ordering for one tileset. */
export class DrawCommands {
  private readonly _lineVisibility = new LineVisibility();

  private _lineMercatorProjection = 0;
  /**
   * @internal
   */
  private readonly _lineProjectionUniform = () => this._lineMercatorProjection;

  private readonly _records = new WeakMap<object, DrawCommandEntry>();

  private readonly _entries: Array<DrawCommandEntry | undefined> = [];

  private readonly _paint: DrawCommandEntry[] = [];

  private readonly _symbols: DrawCommandEntry[] = [];

  private readonly _paintSlots: number[] = [];

  private readonly _symbolSlots: number[] = [];

  private readonly _extrusionLayers = new Map<string, DrawCommandEntry[]>();

  private readonly _prepared: FrameCommand[] = [];

  private readonly _extrusionDepth = new ExtrusionDepthPass();

  private readonly _compositedLayers = new Set<string>();

  destroy(): void {
    this._extrusionDepth.destroy();
  }

  get extrusionGpuBytes(): number {
    return this._extrusionDepth.memoryBytes;
  }

  prepare(
    frameState: RenderFrameState,
    firstCommand: number,
    mode: SceneMode,
    layerOrder: ReadonlyMap<string, number>,
    scene?: VisibleScene,
    tileRanks: ReadonlyMap<string, number> = EMPTY_RANKS,
    hiddenLayers: ReadonlyMap<string, ReadonlySet<string>> = EMPTY_HIDDEN,
    hiddenTiles: ReadonlySet<string> = EMPTY_TILES,
    layerVisibility: ReadonlyMap<string, boolean> = EMPTY_VISIBILITY,
  ): void {
    this._lineMercatorProjection = (frameState.mapProjection ?? frameState.camera._scene?.mapProjection) instanceof Cesium.WebMercatorProjection ? 1 : 0;
    const commands = frameState.commandList;
    if (!commands) {
      return;
    }
    try {
      this._lineVisibility.prepare(frameState, mode, scene);
      let lastGeometryLayer = -1;
      let write = firstCommand;
      for (let index = firstCommand; index < commands.length; index++) {
        const source = commands[index];
        const batch = commandBatch(source);
        // Visibility belongs to the live view, including commands from held
        // and fading generations that no longer appear in renderer records.
        if (batch && layerVisibility.get(batch.layerId) === false) {
          continue;
        }
        if (batch?.tileId && (hiddenTiles.has(batch.tileId)
          || (batch.kind !== 'symbol' && hiddenLayers.get(batch.tileId)?.has(batch.layerId)))) {
          continue;
        }
        // Native preparation and paint have already run. Zero uniform paint
        // needs neither a color command nor a pick command this frame.
        const uniforms = linePaintForOwner(source.owner);
        if (uniforms && (uniforms.width <= 0 || uniforms.color.alpha <= 0)) {
          continue;
        }
        if ((batch?.kind === 'line' || batch?.kind === 'dash')
          && this._lineVisibility.outside((source as FrameCommand & { boundingVolume?: Cesium.BoundingSphere }).boundingVolume, uniforms, uniformLineExtentForOwner(source.owner))) {
          continue;
        }
        let command = source as FrameCommand;
        // Buffer points expand in pixels after projecting their centers. Their
        // ground bounds cannot safely frustum/horizon-cull those pixels or picks.
        // Change the Native source once so its cached paint derivative inherits
        // the policy; GPU clipping/depth and source tile selection still apply.
        if (batch?.kind === 'circle' && command.owner instanceof BufferPointCollection && command.cull !== false)
          command.cull = false;
        const extrusion = batch?.kind === 'extrusion' && command.renderState
          ? { ...extrusionCommand(source as NativeCommand), states: extrusionState(command.renderState), translucent: source.pass === pass.TRANSLUCENT }
          : undefined;
        if (extrusion) {
          command = extrusion.color;
        }
        else if (command.owner instanceof BufferPointCollection || command.owner instanceof BufferPolygonCollection || command.owner instanceof PointPrimitiveCollection) {
          command = paintCommand(command as NativeCommand, frameState.context);
        }
        // Surface layers retain scene-depth testing without occluding later
        // style layers. Extrusion depth is prepared for the entire layer below.
        if (batch && batch.kind !== 'extrusion' && command.renderState?.depthMask) {
          command.renderState = surfaceState(command.renderState);
        }
        const clip = uniforms?.clip.bind(frameState);
        if (uniforms && (command.uniformMap?.u_line_width !== uniforms.widthUniform || command.uniformMap?.u_line_mercator_projection !== this._lineProjectionUniform)) {
          command.uniformMap = {
            ...command.uniformMap,
            ...clip,
            u_line_width: uniforms.widthUniform,
            u_line_color: uniforms.colorUniform,
            u_line_layer_offset: uniforms.offsetUniform,
            u_line_meters_per_pixel: uniforms.metersPerPixelUniform,
            u_line_mercator_projection: this._lineProjectionUniform,
          };
        }
        let record: DrawCommandEntry | undefined;
        if (batch) {
          const layer = layerOrder.get(batch.layerId);
          record = this._records.get(source);
          if (!record) {
            record = { command, batch, layer: 0, promotionLayer: 0, order: 0 };
            this._records.set(source, record);
          }
          record.command = command;
          record.batch = batch;
          record.layer = layer ?? Number.MAX_SAFE_INTEGER;
          record.promotionLayer = layer ?? -1;
          record.tile = batch.tileId ? tileRanks.get(batch.tileId) : undefined;
          record.order = index;
          record.extrusion = extrusion;
          if (batch.kind !== 'symbol') {
            lastGeometryLayer = Math.max(lastGeometryLayer, record.promotionLayer);
          }
        }
        this._entries.push(record);
        commands[write++] = command;
      }
      commands.length = write;
      if (!frameState.passes?.render && !frameState.passes?.pick) {
        return;
      }

      // OVERLAY is collected once after both 2D date-line viewports. Only
      // visible symbols above all geometry can leave the in-frustum paint pass.
      const promoteSymbols = frameState.passes.render && mode !== SceneMode.SCENE2D && frameState.cullingVolume && scene?.isVisible;
      const occluder = mode === SceneMode.SCENE3D ? frameState.occluder : undefined;
      write = firstCommand;
      for (let index = firstCommand; index < commands.length; index++) {
        const command = commands[index];
        const record = this._entries[index - firstCommand];
        if (record?.batch.kind === 'symbol') {
          // Decide the final pass once. Resetting a stable OVERLAY command to
          // OPAQUE first invalidates Native's cached derivatives every frame.
          let symbolPass = pass.OPAQUE;
          if (promoteSymbols) {
            if (!scene.isVisible(frameState.cullingVolume, command, occluder))
              continue;
            if (record.promotionLayer > lastGeometryLayer)
              symbolPass = pass.OVERLAY;
          }
          command.pass = symbolPass;
        }
        commands[write] = command;
        this._entries[write - firstCommand] = record;
        if (record) {
          if (command.pass === pass.OVERLAY) {
            this._symbols.push(record);
            this._symbolSlots.push(write);
          }
          else if (command.pass === pass.OPAQUE || command.pass === pass.TRANSLUCENT) {
            // Native pass selection does not define MapLibre paint order.
            command.pass = pass.OPAQUE;
            this._paint.push(record);
            this._paintSlots.push(write);
          }
        }
        write++;
      }
      commands.length = write;
      this._entries.length = write - firstCommand;
      this._paint.sort(paintOrder);
      this._symbols.sort(symbolOrder);
      for (let index = 0; index < this._paint.length; index++) {
        const slot = this._paintSlots[index];
        const record = this._paint[index];
        commands[slot] = record.command;
        this._entries[slot - firstCommand] = record;
      }
      for (let index = 0; index < this._symbols.length; index++) {
        const slot = this._symbolSlots[index];
        const record = this._symbols[index];
        commands[slot] = record.command;
        this._entries[slot - firstCommand] = record;
      }
      for (const record of this._paint) {
        if (!record.extrusion)
          continue;
        const id = record.batch.layerId;
        let layer = this._extrusionLayers.get(id);
        if (!layer) {
          layer = [];
          this._extrusionLayers.set(id, layer);
        }
        layer.push(record);
      }
      for (const records of this._extrusionLayers.values()) {
        for (const record of records) {
          const extrusion = record.extrusion!;
          record.command.renderState = extrusion.states.opaque;
          extrusion.depth.renderState = extrusion.states.offscreen;
        }
      }
      if (frameState.passes.render && !frameState.passes.pick) {
        // A layer's owned compositor retains all owners together across
        // Native's independent depth frustums and resolves coincident faces
        // without borrowing scene stencil bits or accumulating surface alpha.
        for (let index = firstCommand; index < commands.length; index++) {
          const record = this._entries[index - firstCommand];
          if (record?.extrusion) {
            if (this._compositedLayers.has(record.batch.layerId))
              continue;
            const layer = this._extrusionLayers.get(record.batch.layerId);
            if (layer) {
              if (layer.some(entry => entry.extrusion!.translucent)) {
                if (!scene?.updateDerivedCommands)
                  throw new Error('Extrusion compositor requires the owning Native scene');
                this._compositedLayers.add(record.batch.layerId);
                this._prepared.push(this._extrusionDepth.prepare(record.batch.layerId, layer.map(entry => entry.extrusion!.depth), frameState, scene as unknown as ExtrusionDepthScene) as FrameCommand);
                // Native sets this flag from PostProcessStageCollection's
                // actual selected feature list. ClearCommand compositors
                // have no Native ID derivatives, so retain each source's
                // real geometry solely for that selected-ID pass.
                if ((frameState.passes as { postProcess?: boolean }).postProcess) {
                  for (const entry of layer)
                    this._prepared.push(extrusionIdCommand(entry.command as NativeCommand, scene));
                }
                continue;
              }
            }
          }
          this._prepared.push(commands[index]);
        }
        for (let index = 0; index < this._prepared.length; index++)
          commands[firstCommand + index] = this._prepared[index];
        commands.length = firstCommand + this._prepared.length;
        this._extrusionDepth.retain(this._compositedLayers);
      }
      if (frameState.passes.pick && scene?.updateDerivedCommands) {
        for (const record of this._entries) {
          if (!record || record.batch.kind === 'extrusion') {
            continue;
          }
          // Derive through Native before command collection, then preserve
          // surface depth state for ordinary and logarithmic-depth picking.
          scene.updateDerivedCommands(record.command);
          const derived = record.command as DerivedCommand;
          preservePickDepth(derived);
          preservePickDepth(derived.derivedCommands?.logDepth?.command);
        }
      }
    }
    finally {
      // Scratch must not keep commands or their retired owners alive between
      // frames. Cached records survive only as long as their actual command.
      this._entries.length = 0;
      this._paint.length = 0;
      this._symbols.length = 0;
      this._paintSlots.length = 0;
      this._symbolSlots.length = 0;
      this._extrusionLayers.clear();
      this._prepared.length = 0;
      this._compositedLayers.clear();
    }
  }
}
