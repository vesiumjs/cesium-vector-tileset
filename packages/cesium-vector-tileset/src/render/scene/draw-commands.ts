import type { RenderFrameState } from './render-frame';
import * as Cesium from 'cesium';
import { BufferPointCollection, BufferPolygonCollection, PointPrimitiveCollection, SceneMode } from 'cesium';
import { drawBatchForOwner, linePaintForOwner } from './draw-batch';

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

type NativeCommand = NonNullable<RenderFrameState['commandList']>[number] & { dirty: boolean; shaderProgram?: NativeShaderProgram };
// Native collection renderers own their blend pass. Prepare a cached Native derivative
// so style ordering never changes the renderer's blend-transition detection.
const drawCommand = (Cesium as unknown as {
  DrawCommand: { shallowClone: (source: NativeCommand, result?: NativeCommand) => NativeCommand };
}).DrawCommand;
const paintCommands = new WeakMap<NativeCommand, NativeCommand>();

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
  // Pinned Cesium 1.146 adapter: retain Native coverage, discard, gamma and
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
    throw new Error('Cesium circle fragment shader changed; update the 1.146 paint adapter.');
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

interface VisibleScene {
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
}

const EMPTY_RANKS: ReadonlyMap<string, number> = new Map();
const EMPTY_HIDDEN: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const EMPTY_TILES: ReadonlySet<string> = new Set();

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

/** Own reusable command preparation and ordering for one tileset. */
export class DrawCommands {
  private readonly _records = new WeakMap<object, DrawCommandEntry>();
  private readonly _entries: Array<DrawCommandEntry | undefined> = [];
  private readonly _paint: DrawCommandEntry[] = [];
  private readonly _symbols: DrawCommandEntry[] = [];
  private readonly _paintSlots: number[] = [];
  private readonly _symbolSlots: number[] = [];

  prepare(
    frameState: RenderFrameState,
    firstCommand: number,
    mode: SceneMode,
    layerOrder: ReadonlyMap<string, number>,
    scene?: VisibleScene,
    tileRanks: ReadonlyMap<string, number> = EMPTY_RANKS,
    hiddenLayers: ReadonlyMap<string, ReadonlySet<string>> = EMPTY_HIDDEN,
    hiddenTiles: ReadonlySet<string> = EMPTY_TILES,
  ): void {
    const commands = frameState.commandList;
    if (!commands) {
      return;
    }
    try {
      let lastGeometryLayer = -1;
      let write = firstCommand;
      for (let index = firstCommand; index < commands.length; index++) {
        const source = commands[index];
        const batch = commandBatch(source);
        if (batch?.tileId && (hiddenTiles.has(batch.tileId)
          || (batch.kind !== 'symbol' && hiddenLayers.get(batch.tileId)?.has(batch.layerId)))) {
          continue;
        }
        let command = source as FrameCommand;
        if (command.owner instanceof BufferPointCollection || command.owner instanceof BufferPolygonCollection || command.owner instanceof PointPrimitiveCollection
          || (batch?.kind === 'extrusion' && mode !== SceneMode.SCENE3D)) {
          command = paintCommand(command as NativeCommand, frameState.context);
        }
        // Surface layers retain scene-depth testing without occluding later
        // style layers. Physical 3D volumes keep Native depth and blend passes.
        if (batch && (mode !== SceneMode.SCENE3D || batch.kind !== 'extrusion') && command.renderState?.depthMask) {
          command.renderState = surfaceState(command.renderState);
        }
        // Promotion is recomputed from this frame's complete geometry set.
        if (batch?.kind === 'symbol') {
          command.pass = pass.OPAQUE;
        }
        const uniforms = linePaintForOwner(command.owner);
        const clip = uniforms?.clip.bind(frameState);
        if (uniforms && command.uniformMap?.u_line_width !== uniforms.widthUniform) {
          command.uniformMap = {
            ...command.uniformMap,
            ...clip,
            u_line_width: uniforms.widthUniform,
            u_line_color: uniforms.colorUniform,
            u_line_layer_offset: uniforms.offsetUniform,
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
        if (promoteSymbols && record?.batch.kind === 'symbol') {
          if (!scene.isVisible(frameState.cullingVolume, command, occluder)) {
            continue;
          }
          if (record.promotionLayer > lastGeometryLayer) {
            command.pass = pass.OVERLAY;
          }
        }
        commands[write] = command;
        this._entries[write - firstCommand] = record;
        if (record && (mode !== SceneMode.SCENE3D || record.batch.kind !== 'extrusion')) {
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
      if (frameState.passes.pick && scene?.updateDerivedCommands) {
        for (const record of this._entries) {
          if (!record || (mode === SceneMode.SCENE3D && record.batch.kind === 'extrusion')) {
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
    }
  }
}
