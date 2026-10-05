import type { Camera, Cartesian2, Color, ComponentDatatype, Geometry, Globe, Material, Primitive, Rectangle, Scene, Viewer } from 'cesium';
import type { CesiumVectorTileset } from '../../packages/cesium-vector-tileset/src/cesium-vector-tileset';
import type { GeometryPrimitive } from '../../packages/cesium-vector-tileset/src/render/geometry/geometry-primitive';
import type { DashMaterial } from '../../packages/cesium-vector-tileset/src/render/line/dash-material';
import type { PatternTileRenderer } from '../../packages/cesium-vector-tileset/src/render/pattern/pattern-renderer';
import type { RasterTileRenderer } from '../../packages/cesium-vector-tileset/src/render/raster/raster-renderer';
import type { RenderFrameState } from '../../packages/cesium-vector-tileset/src/render/scene/render-frame';
import type { SceneCollections } from '../../packages/cesium-vector-tileset/src/render/scene/scene-collections';
import type { SceneTileCovering } from '../../packages/cesium-vector-tileset/src/render/scene/scene-tile-covering';
import type { SourceRenderSync } from '../../packages/cesium-vector-tileset/src/render/scene/source-render-sync';
import type { TilePublishQueue } from '../../packages/cesium-vector-tileset/src/render/scene/tile-publish-queue';
import type { TileResidency } from '../../packages/cesium-vector-tileset/src/render/scene/tile-residency';
import type { SymbolPlacementPass } from '../../packages/cesium-vector-tileset/src/render/symbol/symbol-placement-pass';
import type { SymbolTileRenderer } from '../../packages/cesium-vector-tileset/src/render/symbol/symbol-renderer';
import type { BufferCollection, VectorTileRecord, VectorTileRenderer } from '../../packages/cesium-vector-tileset/src/render/vector/vector-tile-renderer';

// Native runtime fields omitted by Cesium.d.ts, inspected only by browser tests.
export interface NativeBuffer {
  sizeInBytes: number;
  _buffer: WebGLBuffer;
  _getBuffer: () => WebGLBuffer;
  isDestroyed: () => boolean;
}
export interface NativeVertexArray {
  numberOfAttributes: number;
  numberOfVertices: number;
  indexBuffer?: NativeBuffer;
  getAttribute: (index: number) => {
    index: number;
    vertexBuffer?: NativeBuffer;
    componentsPerAttribute: number;
    componentDatatype: ComponentDatatype;
    strideInBytes: number;
    normalize: boolean;
  };
  isDestroyed: () => boolean;
}
export interface NativeTexture {
  width: number;
  height: number;
  sizeInBytes: number;
  _texture: WebGLTexture;
  isDestroyed: () => boolean;
}
export interface NativeShaderProgram {
  fragmentShaderSource: { sources: string[]; defines: string[] };
  vertexShaderSource: { sources: string[]; defines: string[] };
  _cachedShader: { count: number };
  isDestroyed: () => boolean;
}
export interface NativeCommand {
  owner: object;
  pass: number;
  vertexArray: NativeVertexArray;
  shaderProgram: NativeShaderProgram;
  renderState: { depthTest: { enabled: boolean }; depthMask: boolean; blending: { enabled: boolean } };
  uniformMap: Record<string, () => unknown>;
}
export interface NativeContext {
  _gl: WebGL2RenderingContext;
  depthTexture: boolean;
  defaultTexture: NativeTexture;
  elementIndexUint: boolean;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  readPixels: (options: { x?: number; y?: number; width: number; height: number; framebuffer?: object }) => Uint8Array;
  draw: (command: NativeCommand, ...args: unknown[]) => void;
  getObjectByPickColor: (color: Color) => unknown;
}
export type NativePrimitive = Primitive & {
  _va: NativeVertexArray[];
  _state: number;
  _numberOfInstances: number;
  _batchTable: { _texture?: NativeTexture; getBatchedAttribute: (instance: number, attribute: number) => ArrayLike<number>; setBatchedAttribute: (instance: number, attribute: number, value: unknown) => void; destroy: () => void; isDestroyed: () => boolean };
  _geometries?: Geometry[];
  _attributeLocations: Record<string, number>;
  _layout: GeometryPrimitive['_layout'];
  positionTexture?: NativeTexture;
};
export interface NativeBufferMaterial { color: Color; outlineColor?: Color; outlineWidth?: number }
export interface NativeBufferPrimitive { getMaterial: (result: NativeBufferMaterial) => NativeBufferMaterial }
export type NativeBufferCollection = BufferCollection & {
  _getPrimitiveClass: () => new () => NativeBufferPrimitive;
  _getMaterialClass: () => new () => NativeBufferMaterial;
  get: (index: number, result: NativeBufferPrimitive) => NativeBufferPrimitive;
  _pickIds: Map<NativeContext, Array<{ color: Color; object: unknown }>>;
  _renderContext?: { vertexArray: NativeVertexArray; command: NativeCommand; renderState: NativeCommand['renderState']; shaderProgram: NativeShaderProgram };
};
export type TestScene = Omit<Scene, 'pick' | 'camera' | 'globe'> & {
  camera: Omit<Camera, 'frustum'> & { frustum: Camera['frustum'] & { fovy?: number; aspectRatio?: number } };
  globe: Globe & { _surface: { _tilesToRender: Array<{ level: number; x: number; y: number; rectangle: Rectangle }> } };
  pixelRatio: number;
  context: NativeContext;
  _frameState: Omit<RenderFrameState, 'commandList'> & { commandList: NativeCommand[]; useLogDepth: boolean };
  pick: (position: Pick<Cartesian2, 'x' | 'y'>, width?: number, height?: number) => ReturnType<Scene['pick']>;
};
export type TestViewer = Omit<Viewer, 'scene' | 'camera'> & { scene: TestScene; camera: TestScene['camera'] };

type Public<T> = { [Key in keyof T]: T[Key] };
type PolygonEntry = NonNullable<VectorTileRecord['standard']>['polygons'][number];
type TestTileRenderRecord = Omit<VectorTileRecord, 'standard'> & {
  standard?: Omit<NonNullable<VectorTileRecord['standard']>, 'polygons'> & { polygons: Array<Omit<PolygonEntry, 'primitive'> & { primitive: NativePrimitive }> };
};
type FirstUpdateQueue = SceneCollections['_firstUpdates'][number];
type TestFirstUpdateQueue = FirstUpdateQueue extends Map<infer Collection, infer Update>
  ? Map<Collection & { length?: number; ready?: boolean }, Update> : never;
type RasterEntry = RasterTileRenderer['_tiles'] extends Map<string, Array<infer Entry>> ? Entry : never;
export type TestTileset = Public<CesiumVectorTileset> & {
  _style: CesiumVectorTileset['_style'];
  _styleEvaluation: CesiumVectorTileset['_styleEvaluation'];
  _sceneCovering: Public<SceneTileCovering> & { _cameraPose: SceneTileCovering['_cameraPose']; _observedCamera: SceneTileCovering['_observedCamera']; _globeCoverings: SceneTileCovering['_globeCoverings'] };
  _vectorRenderer: Omit<Public<VectorTileRenderer>, 'dashMaterial'> & {
    _records: Map<string, TestTileRenderRecord>;
    _retired: VectorTileRenderer['_retired'];
    dashMaterial?: Public<DashMaterial> & { _material?: Material & { _textures: Record<string, NativeTexture> } };
  };
  _rasterRenderer: Public<RasterTileRenderer> & { _tiles: Map<string, Array<Omit<RasterEntry, 'material'> & { material: Material & { _textures: Record<string, NativeTexture> } }>> };
  _patternRenderer: Public<PatternTileRenderer> & { _tiles: PatternTileRenderer['_tiles'] };
  _symbolRenderer: Public<SymbolTileRenderer> & {
    _tiles: SymbolTileRenderer['_tiles'];
    _excludedPlacementTiles: SymbolTileRenderer['_excludedPlacementTiles'];
    _retired: SymbolTileRenderer['_retired'];
    _placementDirty: SymbolTileRenderer['_placementDirty'];
    _placementUrgent: SymbolTileRenderer['_placementUrgent'];
    _orderedBatches: SymbolTileRenderer['_orderedBatches'];
    _pendingOpacityHalves: SymbolTileRenderer['_pendingOpacityHalves'];
    _pendingDynamicHalves: SymbolTileRenderer['_pendingDynamicHalves'];
    _placement: Public<SymbolPlacementPass> & { _batchIndex: SymbolPlacementPass['_batchIndex'] };
  };
  _tilePublishQueue: Public<TilePublishQueue> & { _jobs: TilePublishQueue['_jobs']; _patternRefreshes: TilePublishQueue['_patternRefreshes'] };
  _sceneCollections: Public<SceneCollections> & { _firstUpdates: TestFirstUpdateQueue[] };
  _sourceRenderSync: Public<SourceRenderSync>;
  _tileResidency: Public<TileResidency> & {
    _sources: TileResidency['_sources'];
    _tiles: TileResidency['_tiles'];
  };
  _tileWorkFrame: CesiumVectorTileset['_tileWorkFrame'];
};
