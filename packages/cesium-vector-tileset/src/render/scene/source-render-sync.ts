import type { SceneMode } from 'cesium';
import type { RasterStyleLayer } from '../../style/style-layer/raster-style-layer';
import type { Tile } from '../../tile/tile';
import type { TilePyramid } from '../../tile/tile-pyramid';
import type { PatternStyleLayer } from '../pattern/pattern-layer';
import type { RasterSourceGeometry, RasterTileRenderer } from '../raster/raster-renderer';
import type { Budget } from './frame-budget';
import type { RenderCovering } from './render-frame';
import type { SceneCollections } from './scene-collections';
import type { TilePublishQueue } from './tile-publish-queue';
import type { TileResidency } from './tile-residency';
import { rasterSourceInfo } from '../raster/raster-renderer';

interface SourceRenderState {
  renderableIds: readonly string[];
  mode: SceneMode;
  rasterLayers: readonly RasterStyleLayer[];
  rasterSource: RasterSourceGeometry;
  rasterDynamic: boolean;
  rasterReady: boolean;
  patternLayers: readonly PatternStyleLayer[];
  patternStyleRevision: number;
  imageUpdateRevision: number;
}

export interface SourceRenderInput {
  mode: SceneMode;
  rasterLayers: readonly RasterStyleLayer[];
  patternLayers: readonly PatternStyleLayer[];
  transitioningVectorLayers: ReadonlySet<string>;
  styleRevision: number;
  imageUpdateRevision: number;
  budget: Budget;
}

export interface SourceRenderResult {
  renderableCount: number;
  changed: boolean;
  memoryChanged: boolean;
  featureStateChanged: boolean;
}

export interface SourceRenderSyncOptions {
  raster: RasterTileRenderer;
  publishQueue: TilePublishQueue;
  residency: TileResidency;
  scene: SceneCollections;
}

/** Applies source selection and preparation to its raster, pattern and resident scene tracks. */
export class SourceRenderSync {
  private readonly _states = new Map<string, SourceRenderState>();
  private readonly _rasterRenderer: RasterTileRenderer;
  private readonly _tilePublishQueue: TilePublishQueue;
  private readonly _residency: TileResidency;
  private readonly _sceneCollections: SceneCollections;

  constructor(options: SourceRenderSyncOptions) {
    this._rasterRenderer = options.raster;
    this._tilePublishQueue = options.publishQueue;
    this._residency = options.residency;
    this._sceneCollections = options.scene;
  }

  reset(): void {
    this._states.clear();
    this._residency.resetSourceState();
  }

  updateSource(
    sourceId: string,
    tilePyramid: TilePyramid,
    covering: RenderCovering | undefined,
    input: SourceRenderInput,
  ): SourceRenderResult {
    if (covering) {
      tilePyramid.update(covering);
    }
    const featureStateChanged = tilePyramid.prepare();
    const renderableIds = tilePyramid.getRenderableIds();
    const rasterSource = tilePyramid.getSource() as RasterSourceGeometry;
    const rasterDynamic = rasterSourceInfo(rasterSource).dynamic;
    const previous = this._states.get(sourceId);
    const sameRenderableSet = previous?.renderableIds === renderableIds && previous.mode === input.mode;
    const rasterInputsChanged = !sameRenderableSet
      || previous?.rasterLayers !== input.rasterLayers
      || previous.rasterSource !== rasterSource
      || previous.rasterDynamic !== rasterDynamic;
    let rasterReady = previous?.rasterReady ?? false;
    let memoryChanged = false;
    if (rasterInputsChanged || !rasterReady) {
      const raster = this._syncRaster(sourceId, tilePyramid, renderableIds, input.rasterLayers, rasterSource, rasterDynamic, input.mode);
      rasterReady = raster.ready;
      memoryChanged = raster.memoryChanged;
    }

    const patternTransitions = input.patternLayers.some(layer => input.transitioningVectorLayers.has(layer.id));
    if (!sameRenderableSet || previous?.patternLayers !== input.patternLayers
      || previous.patternStyleRevision !== input.styleRevision
      || previous.imageUpdateRevision !== input.imageUpdateRevision || patternTransitions) {
      this._syncPattern(sourceId, tilePyramid, renderableIds, input.patternLayers, patternTransitions, input.budget);
    }
    const residentChanged = this._residency.syncSource(sourceId, tilePyramid, renderableIds, input.mode);
    this._states.set(sourceId, {
      renderableIds,
      mode: input.mode,
      rasterLayers: input.rasterLayers,
      rasterSource,
      rasterDynamic,
      rasterReady,
      patternLayers: input.patternLayers,
      patternStyleRevision: input.styleRevision,
      imageUpdateRevision: input.imageUpdateRevision,
    });
    return { renderableCount: renderableIds.length, changed: !sameRenderableSet || residentChanged, memoryChanged, featureStateChanged };
  }

  private _syncRaster(
    sourceId: string,
    tilePyramid: TilePyramid,
    renderableIds: readonly string[],
    layers: readonly RasterStyleLayer[],
    source: RasterSourceGeometry,
    dynamic: boolean,
    mode: SceneMode,
  ): { ready: boolean; memoryChanged: boolean } {
    if (layers.length === 0) {
      return { ready: true, memoryChanged: false };
    }
    let ready = true;
    let memoryChanged = false;
    for (const tileKey of renderableIds) {
      const tile: Tile | undefined = tilePyramid.getTileByID(tileKey);
      if (!tile?.textureData) {
        ready = false;
        continue;
      }
      const tileId = `${sourceId}/${tileKey}`;
      if (this._tilePublishQueue.has(tileId)) {
        continue;
      }
      const update = this._rasterRenderer.addTile(
        tileId,
        tile.tileID,
        tile.textureData,
        layers,
        dynamic,
        source.tileCoords,
        source.flippedWindingOrder ?? false,
        mode,
      );
      this._residency.published(sourceId, tile.tileID);
      this._sceneCollections.applyRasterUpdate(update);
      if (update.added.length > 0 || update.removed.length > 0) {
        memoryChanged = true;
      }
    }
    return { ready, memoryChanged };
  }

  private _syncPattern(
    sourceId: string,
    tilePyramid: TilePyramid,
    renderableIds: readonly string[],
    layers: readonly PatternStyleLayer[],
    transitions: boolean,
    budget: Budget,
  ): void {
    if (layers.length === 0) {
      return;
    }
    for (const tileKey of renderableIds) {
      const tile = tilePyramid.getTileByID(tileKey);
      if (tile) {
        this._tilePublishQueue.refreshPattern(sourceId, tile, layers, transitions, budget);
      }
    }
  }
}
