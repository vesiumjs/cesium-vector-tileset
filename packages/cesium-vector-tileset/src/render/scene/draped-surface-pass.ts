import type { BufferPolygonCollection, HeightReference as HeightReferenceType, Rectangle, SceneMode as SceneModeType } from 'cesium';
import type { VectorDrapingProvider } from '../vector/vector-tile-renderer';
import type { DrawBatch } from './draw-batch';
import type { DrawCommands } from './draw-commands';
import type { MemoryBudgetVisitor } from './gpu-memory-budget';
import type { RenderFrameState } from './render-frame';
import type { RetainedSourceStyle } from './tile-residency';
import * as Cesium from 'cesium';
import { BlendingState, DepthFunction, HeightReference, SceneMode } from 'cesium';
import { drawBatchForOwner, registerDrawBatch, retainedStyleForBatch } from './draw-batch';
import { DrawCommandReplay } from './draw-command-replay';

interface Texture { readonly sizeInBytes: number }
interface VectorData {
  show: boolean;
  hasPolygons: boolean;
  collectionVersions: Map<BufferPolygonCollection, number>;
  widthTexture?: Texture;
  colorTexture?: Texture;
  pickColorTexture?: Texture;
  polygonEdgeTexture?: Texture;
  polygonEdgePrimitiveIndicesTexture?: Texture;
  polygonGridCellIndicesTexture?: Texture;
}
interface Provider extends VectorDrapingProvider {
  tilingScheme: object;
  antialias: boolean;
  update: (frameNumber?: number) => void;
  isTileDirty: (x: number, y: number, level: number) => boolean;
  makeClean: () => void;
  requestDataForRectangle: (rectangle: Rectangle, context: object, reference: HeightReferenceType) => VectorData;
  updateDataForRectangle: (rectangle: Rectangle, context: object, data: VectorData, reference: HeightReferenceType) => VectorData;
  releaseTileData: (data: VectorData) => void;
}
interface ShaderSource { clone: () => ShaderSource }
interface Shader { fragmentShaderSource: { defines: string[] }; vertexShaderSource: { defines: string[] } }
interface SurfaceTile {
  readonly renderedMesh: { encoding: { hasGeodeticSurfaceNormals: boolean } };
  vectorData?: VectorData;
  surfaceShader?: object;
}
interface TerrainTile { x: number; y: number; level: number; rectangle: Rectangle; data: SurfaceTile }
interface SurfaceState {
  depthMask: boolean;
  depthTest: { enabled: boolean; func: number };
}
interface SurfaceCommand {
  owner?: object;
  pass: number;
  shaderProgram?: Shader;
  renderState?: SurfaceState;
  uniformMap?: Record<string, () => unknown>;
  castShadows?: boolean;
  receiveShadows?: boolean;
  pickId?: string;
}
interface TerrainCommand extends SurfaceCommand {
  owner: TerrainTile;
  shaderProgram: Shader;
  renderState: SurfaceState;
  uniformMap: Record<string, () => unknown>;
}
interface ShaderSet {
  baseVertexShaderSource?: ShaderSource;
  baseFragmentShaderSource?: ShaderSource;
  getShaderProgram: (options: object) => Shader;
  destroy: () => void;
}
interface TileProvider {
  _surfaceShaderSet: ShaderSet;
  _clippingPlanes?: object;
  _clippingPolygons?: object;
}
interface SurfaceGlobe {
  render: (frame: RenderFrameState) => void;
  _surface: { _tilesToRender: readonly TerrainTile[]; _tileProvider: TileProvider };
}
export interface DrapedSurfaceScene {
  globe?: SurfaceGlobe;
  vectorProvider?: Provider;
  updateDerivedCommands?: (command: object) => void;
}
const native = Cesium as unknown as {
  Pass: { GLOBE: number; OPAQUE: number };
  ClearCommand: new (options: object) => SurfaceCommand;
  VectorProvider: new (options: object) => Provider;
  GlobeSurfaceShaderSet: new () => ShaderSet;
  ShaderSource: new (options: object) => ShaderSource;
  RenderState: { fromCache: (options: object) => SurfaceState };
};

const FRAGMENT = `
in vec3 v_textureCoordinates;
#ifdef TILE_LIMIT_RECTANGLE
uniform vec4 u_cartographicLimitRectangle;
#endif
#ifdef ENABLE_CLIPPING_PLANES
uniform highp sampler2D u_clippingPlanes;
uniform mat4 u_clippingPlanesMatrix;
#endif
void main() {
    #ifdef TILE_LIMIT_RECTANGLE
    if (v_textureCoordinates.x < u_cartographicLimitRectangle.x || v_textureCoordinates.x > u_cartographicLimitRectangle.z ||
        v_textureCoordinates.y < u_cartographicLimitRectangle.y || v_textureCoordinates.y > u_cartographicLimitRectangle.w) discard;
    #endif
    #ifdef ENABLE_CLIPPING_PLANES
    clip(gl_FragCoord, u_clippingPlanes, u_clippingPlanesMatrix);
    #endif
    #ifdef ENABLE_CLIPPING_POLYGONS
    bool inside = vectorClip(v_textureCoordinates.xy);
    #ifdef CLIPPING_INVERSE
    if (!inside) discard;
    #else
    if (inside) discard;
    #endif
    #endif
    out_FragColor = vectorPolygonRender(v_textureCoordinates.xy, vec4(0.0));
}`;

const textureFields = ['colorTexture', 'pickColorTexture', 'polygonEdgeTexture', 'polygonEdgePrimitiveIndicesTexture', 'polygonGridCellIndicesTexture', 'widthTexture'] as const;
const textureUniforms = ['u_vectorColorTexture', 'u_vectorPickColorTexture', 'u_vectorPolygonEdgeTexture', 'u_vectorPolygonEdgePrimitiveIndicesTexture', 'u_vectorPolygonGridCellIndicesTexture', 'u_vectorWidthTexture'] as const;
const sceneHubs = new WeakMap<object, SceneHub>();

interface CollectionEntry { frameNumber: number; heightReference: HeightReferenceType }
interface SurfaceEntry {
  data: VectorData;
  surface?: SurfaceTile;
  replay?: DrawCommandReplay;
  uniformSource?: object;
  uniformMap?: Record<string, () => unknown>;
}
interface Run {
  id: number;
  layerId: string;
  style?: RetainedSourceStyle;
  provider: Provider;
  shaderSet?: ShaderSet;
  slot: SurfaceCommand;
  entries: Map<TerrainTile, SurfaceEntry>;
  frame?: RenderFrameState;
  sourceOrder: BufferPolygonCollection[];
}
export interface DrapedSurfacePaint {
  layerOrder: ReadonlyMap<string, number>;
  retainedStyle?: RetainedSourceStyle;
  tileRanks: ReadonlyMap<string, number>;
  hiddenTiles: ReadonlySet<string>;
  hiddenLayers: ReadonlyMap<string, ReadonlySet<string>>;
  visibility: ReadonlyMap<string, boolean>;
}

/** One hook per scene routes owned terrain colors out of Native's fused surface. */
class SceneHub {
  readonly scene: DrapedSurfaceScene;
  provider: Provider;
  readonly owners = new Set<DrapedSurfacePass>();
  readonly collections = new Map<BufferPolygonCollection, DrapedSurfacePass>();
  private _mark: Provider['markForFrame'];
  private _globe?: SurfaceGlobe;
  private _render?: SurfaceGlobe['render'];
  private readonly _output: SurfaceCommand[] = [];
  private _routingDirty = false;

  constructor(scene: DrapedSurfaceScene, provider: Provider) {
    this.scene = scene;
    this.provider = provider;
    this._mark = provider.markForFrame;
    provider.markForFrame = this._markOwned;
    this.syncGlobe();
  }

  private _markOwned: Provider['markForFrame'] = (collection, frameNumber, reference) => {
    const owner = this.collections.get(collection);
    // CLAMP_TO_GROUND keeps the existing model backend. Only its terrain
    // contribution moves to an ordered run; models remain explicitly pending.
    if (owner) {
      if (reference === HeightReference.CLAMP_TO_TERRAIN)
        return;
      if (reference === HeightReference.CLAMP_TO_GROUND)
        reference = HeightReference.CLAMP_TO_3D_TILE;
    }
    this._mark.call(this.provider, collection, frameNumber, reference);
  };

  markModel(collection: BufferPolygonCollection, frameNumber: number, reference: HeightReferenceType): void {
    this._markOwned(collection, frameNumber, reference);
  }

  claim(collection: BufferPolygonCollection, owner: DrapedSurfacePass): void {
    this.provider.remove(collection);
    this.collections.set(collection, owner);
    this._routingDirty = true;
  }

  syncGlobe(): void {
    const provider = this.scene.vectorProvider!;
    const providerChanged = this.provider !== provider;
    if (this._globe === this.scene.globe && !providerChanged)
      return;
    if (this._globe && this._globe.render === this._renderOwned)
      this._globe.render = this._render!;
    for (const owner of this.owners)
      owner.releaseSurfaces();
    if (providerChanged) {
      if (this.provider.markForFrame === this._markOwned)
        this.provider.markForFrame = this._mark;
      for (const collection of this.collections.keys()) {
        this.provider.remove(collection);
        provider.remove(collection);
      }
      this.provider = provider;
      this._mark = provider.markForFrame;
      provider.markForFrame = this._markOwned;
      this._routingDirty = true;
    }
    this._globe = this.scene.globe;
    this._render = this._globe?.render;
    if (this._globe)
      this._globe.render = this._renderOwned;
  }

  private _renderOwned = (frame: RenderFrameState): void => {
    if (this._routingDirty && frame.context) {
      // Native beginFrame precedes primitive updates. On scene/globe handoff
      // it may already have baked an owned collection into terrain. Re-bake
      // only packets that actually contain it, before Native emits commands.
      for (const tile of this._globe!._surface._tilesToRender) {
        const data = tile.data.vectorData;
        if (data && [...data.collectionVersions.keys()].some(collection => this.collections.has(collection))) {
          this.provider.releaseTileData(data);
          tile.data.vectorData = this.provider.requestDataForRectangle(tile.rectangle, frame.context, HeightReference.CLAMP_TO_TERRAIN);
        }
      }
      // Leave Native's dirty regions intact for loaded, unrendered packets.
      this._routingDirty = false;
    }
    const first = frame.commandList?.length ?? 0;
    this._render!.call(this._globe, frame);
    const commands = frame.commandList as SurfaceCommand[] | undefined;
    if (!commands)
      return;
    const terrain: TerrainCommand[] = [];
    const tiles = new Set<object>();
    for (let index = first; index < commands.length; index++) {
      const command = commands[index];
      if (command.pass !== native.Pass.GLOBE)
        continue;
      const source = command as TerrainCommand;
      // A terrain tile can emit several imagery commands with the same VA.
      if (!tiles.has(source.owner)) {
        tiles.add(source.owner);
        terrain.push(source);
      }
    }
    const slots = new Map<SurfaceCommand, SurfaceCommand[]>();
    const submitted = new Set<SurfaceCommand>();
    for (const owner of this.owners)
      owner.collectSlots(submitted);
    const present = new Set<SurfaceCommand>();
    for (let index = 0; index < first; index++) {
      if (submitted.has(commands[index]))
        present.add(commands[index]);
    }
    for (const owner of this.owners)
      owner.resolve(frame, terrain, this._globe!, slots, present);
    if (!slots.size)
      return;
    // Expand only owned reserved slots. Existing compositor commands and
    // other primitives keep their exact relative positions and identities.
    let write = 0;
    const output = this._output;
    for (const command of commands) {
      const expanded = slots.get(command);
      if (expanded)
        output.push(...expanded);
      else
        output.push(command);
    }
    for (const command of output)
      commands[write++] = command;
    commands.length = write;
    output.length = 0;
  };

  detach(owner: DrapedSurfacePass): void {
    this.owners.delete(owner);
    if (this.owners.size)
      return;
    if (this.provider.markForFrame === this._markOwned)
      this.provider.markForFrame = this._mark;
    if (this._globe && this._globe.render === this._renderOwned)
      this._globe.render = this._render!;
    sceneHubs.delete(this.scene);
  }
}

/** Owner-scoped terrain lookup resources and their ordered submission slots. */
export class DrapedSurfacePass {
  private readonly _commands: DrawCommands;
  private readonly _memoryChanged: () => void;
  private _hub?: SceneHub;
  private readonly _collections = new Map<BufferPolygonCollection, CollectionEntry>();
  private readonly _runs: Run[] = [];
  private _nextRun = 0;
  private _memoryBytes = 0;

  readonly provider: VectorDrapingProvider = {
    markForFrame: (collection, frameNumber, heightReference) => {
      const hub = this._hub!;
      if (!this._collections.has(collection)) {
        // Replace a possibly pre-existing automatic Native registration,
        // including its target, before the next terrain lookup is baked.
        hub.claim(collection, this);
      }
      this._collections.set(collection, { frameNumber, heightReference });
      hub.markModel(collection, frameNumber, heightReference);
    },
    remove: (collection) => {
      this._collections.delete(collection);
      this._hub?.collections.delete(collection);
      this._hub?.provider.remove(collection);
      for (const run of this._runs)
        run.provider.remove(collection);
    },
  };

  constructor(commands: DrawCommands, memoryChanged: () => void) {
    this._commands = commands;
    this._memoryChanged = memoryChanged;
  }

  bind(scene: DrapedSurfaceScene | undefined, mode: SceneModeType, reference: HeightReferenceType): VectorDrapingProvider | undefined {
    const terrain = mode === SceneMode.SCENE3D && scene?.globe && scene.vectorProvider
      && (reference === HeightReference.CLAMP_TO_TERRAIN || reference === HeightReference.CLAMP_TO_GROUND);
    if (!terrain) {
      this.release();
      return scene?.vectorProvider;
    }
    if (this._hub?.scene !== scene) {
      this.release();
      let hub = sceneHubs.get(scene);
      if (!hub) {
        hub = new SceneHub(scene, scene.vectorProvider!);
        sceneHubs.set(scene, hub);
      }
      this._hub = hub;
      hub.owners.add(this);
    }
    this._hub!.syncGlobe();
    return this.provider;
  }

  prepare(frame: RenderFrameState, paint: DrapedSurfacePaint): void {
    if (!this._hub || !frame.commandList || frame.frameNumber === undefined)
      return;
    const groups = new Map<Run, BufferPolygonCollection[]>();
    for (const [collection, entry] of this._collections) {
      const batch = drawBatchForOwner(collection);
      if (entry.frameNumber !== frame.frameNumber || !collection.show || !batch
        || paint.visibility.get(batch.layerId) === false
        || (batch.tileId && (paint.hiddenTiles.has(batch.tileId) || paint.hiddenLayers.get(batch.tileId)?.has(batch.layerId)))) {
        continue;
      }
      const style = retainedStyleForBatch(batch, paint.retainedStyle);
      let run = this._runs.find(candidate => candidate.layerId === batch.layerId && candidate.style === style);
      if (!run) {
        run = {
          id: ++this._nextRun,
          layerId: batch.layerId,
          style,
          provider: new native.VectorProvider({ tilingScheme: this._hub.provider.tilingScheme, antialias: this._hub.provider.antialias }),
          slot: new native.ClearCommand({ pass: native.Pass.OPAQUE }),
          entries: new Map(),
          sourceOrder: [],
        };
        this._runs.push(run);
      }
      const group = groups.get(run) ?? [];
      group.push(collection);
      groups.set(run, group);
    }
    for (const run of [...this._runs]) {
      const group = groups.get(run);
      if (!group) {
        this._releaseRun(run);
        this._runs.splice(this._runs.indexOf(run), 1);
        continue;
      }
      group.sort((a, b) => {
        const aRank = paint.tileRanks.get(drawBatchForOwner(a)!.tileId!);
        const bRank = paint.tileRanks.get(drawBatchForOwner(b)!.tileId!);
        return aRank === undefined || bRank === undefined ? 0 : bRank - aRank;
      });
      if (group.length !== run.sourceOrder.length || group.some((collection, index) => collection !== run.sourceOrder[index])) {
        for (const collection of run.sourceOrder)
          run.provider.remove(collection);
        run.sourceOrder = group;
      }
      for (const collection of group)
        run.provider.markForFrame(collection, frame.frameNumber, HeightReference.CLAMP_TO_TERRAIN);
      const owner = run.slot.owner ??= {};
      // Filtering uses each real tile above, before grouping. The surviving
      // representative also carries the exact held source/style identity.
      registerDrawBatch(owner, { ...drawBatchForOwner(group[0])!, kind: 'fill' } as DrawBatch);
      run.slot.renderState = native.RenderState.fromCache({ depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL }, depthMask: false, blending: BlendingState.PRE_MULTIPLIED_ALPHA_BLEND });
      run.frame = frame;
      frame.commandList.push(run.slot);
    }
    this._updateMemory();
  }

  collectSlots(slots: Set<SurfaceCommand>): void {
    for (const run of this._runs)
      slots.add(run.slot);
  }

  resolve(frame: RenderFrameState, terrain: readonly TerrainCommand[], globe: SurfaceGlobe, slots: Map<SurfaceCommand, SurfaceCommand[]>, present: ReadonlySet<SurfaceCommand>): void {
    const visible = new Set(terrain.map(command => command.owner));
    for (const run of this._runs) {
      const output: SurfaceCommand[] = [];
      const submitted = run.frame === frame && present.has(run.slot);
      if (submitted)
        slots.set(run.slot, output);
      for (const [tile, entry] of run.entries) {
        if (!submitted || !visible.has(tile)) {
          run.provider.releaseTileData(entry.data);
          run.entries.delete(tile);
        }
      }
      if (!submitted || !frame.context)
        continue;
      run.provider.update(frame.frameNumber);
      for (const source of terrain) {
        const tile = source.owner;
        let entry = run.entries.get(tile);
        if (!entry) {
          entry = { data: run.provider.requestDataForRectangle(tile.rectangle, frame.context, HeightReference.CLAMP_TO_TERRAIN) };
          run.entries.set(tile, entry);
        }
        else if (run.provider.isTileDirty(tile.x, tile.y, tile.level)) {
          entry.data = run.provider.updateDataForRectangle(tile.rectangle, frame.context, entry.data, HeightReference.CLAMP_TO_TERRAIN);
        }
        // Empty intersections allocate no shader, replay command or textures.
        if (!entry.data.show || !entry.data.hasPolygons)
          continue;
        if (!run.shaderSet) {
          run.shaderSet = new native.GlobeSurfaceShaderSet();
          run.shaderSet.baseVertexShaderSource = globe._surface._tileProvider._surfaceShaderSet.baseVertexShaderSource!.clone();
          run.shaderSet.baseFragmentShaderSource = new native.ShaderSource({ sources: [FRAGMENT] });
        }
        // renderedMesh is a Native prototype getter over mesh/vertexArray/fill.
        entry.surface ??= Object.assign(Object.create(tile.data) as SurfaceTile, { surfaceShader: undefined });
        entry.surface.vectorData = entry.data;
        const defines = source.shaderProgram.fragmentShaderSource.defines;
        const tileProvider = globe._surface._tileProvider;
        const shader = run.shaderSet.getShaderProgram({
          frameState: frame,
          surfaceTile: entry.surface,
          numberOfDayTextures: 0,
          vectorAntialias: run.provider.antialias,
          hasGeodeticSurfaceNormals: tile.data.renderedMesh.encoding.hasGeodeticSurfaceNormals,
          hasExaggeration: source.shaderProgram.vertexShaderSource.defines.includes('EXAGGERATION'),
          clippedByBoundaries: defines.includes('TILE_LIMIT_RECTANGLE'),
          enableClippingPlanes: defines.includes('ENABLE_CLIPPING_PLANES'),
          clippingPlanes: tileProvider._clippingPlanes,
          enableClippingPolygons: defines.includes('ENABLE_CLIPPING_POLYGONS'),
          clippingPolygons: tileProvider._clippingPolygons,
        });
        entry.replay ??= new DrawCommandReplay(source);
        const command = entry.replay.update(source) as SurfaceCommand;
        command.owner = run.slot.owner;
        command.pass = native.Pass.OPAQUE;
        command.shaderProgram = shader;
        command.castShadows = false;
        command.receiveShadows = false;
        command.pickId = 'vectorPickColorOver(vec4(0.0))';
        command.renderState = native.RenderState.fromCache({ ...source.renderState, depthTest: run.slot.renderState!.depthTest, depthMask: false, blending: BlendingState.PRE_MULTIPLIED_ALPHA_BLEND });
        if (entry.uniformSource !== source.uniformMap) {
          entry.uniformSource = source.uniformMap;
          entry.uniformMap = { ...source.uniformMap };
          for (let index = 0; index < textureFields.length; index++) {
            const field = textureFields[index];
            entry.uniformMap[textureUniforms[index]] = () => entry.data[field];
          }
        }
        command.uniformMap = entry.uniformMap;
        this._commands.finishSurfaceCommand(command, frame, this._hub!.scene);
        output.push(command);
      }
      run.provider.makeClean();
    }
    this._updateMemory();
  }

  readonly visitMemoryEntries = (visit: MemoryBudgetVisitor): void => {
    for (const run of this._runs) {
      const textures = new Set<Texture>();
      for (const entry of run.entries.values()) {
        for (const field of textureFields) {
          const texture = entry.data[field];
          if (texture)
            textures.add(texture);
        }
      }
      let bytes = 0;
      for (const texture of textures)
        bytes += texture.sizeInBytes;
      if (bytes)
        visit(`drape/${run.id}`, bytes, true);
    }
  };

  private _updateMemory(): void {
    let bytes = 0;
    this.visitMemoryEntries((_key, size) => {
      bytes += size;
    });
    if (bytes !== this._memoryBytes) {
      this._memoryBytes = bytes;
      this._memoryChanged();
    }
  }

  private _releaseRun(run: Run): void {
    for (const entry of run.entries.values())
      run.provider.releaseTileData(entry.data);
    run.entries.clear();
    run.shaderSet?.destroy();
    run.shaderSet = undefined;
  }

  releaseSurfaces(): void {
    for (const run of this._runs)
      this._releaseRun(run);
    this._runs.length = 0;
    this._updateMemory();
  }

  release(): void {
    for (const collection of this._collections.keys()) {
      this._hub?.provider.remove(collection);
      this._hub?.collections.delete(collection);
    }
    this._collections.clear();
    this.releaseSurfaces();
    this._runs.length = 0;
    this._hub?.detach(this);
    this._hub = undefined;
  }
}
