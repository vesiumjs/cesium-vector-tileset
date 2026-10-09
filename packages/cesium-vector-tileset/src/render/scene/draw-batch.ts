import type { Color } from 'cesium';
import type { LineTileClip } from '../line/line-tile-clip';
import { rememberPrimitiveBytes } from './resource-memory';

/** Cesium commands keep their owner across primitive updates and module replacement. */
const batchKey = Symbol.for('cesium-vector-tileset.draw-batch');
const linePaintKey = Symbol.for('cesium-vector-tileset.line-paint');
const lineExtentKey = Symbol.for('cesium-vector-tileset.uniform-line-extent');
const layerOwners = new WeakMap<object, ReadonlySet<string>>();
const NO_LAYERS: ReadonlySet<string> = new Set();

export type DrawBatch
  = | { layerId: string; tileId: string; kind: 'fill' | 'fill-outline' | 'line' | 'circle' | 'extrusion' | 'pattern' | 'dash' | 'symbol' }
  /** Dynamic raster sources can combine several source tiles in one primitive. */
    | { layerId: string; tileId?: string; kind: 'raster' | 'background' };

export interface LinePaintUniforms {
  clip: LineTileClip;
  width: number;
  color: Color;
  offset: number;
  /** Mercator meters per CSS pixel, independent of source tile LOD. */
  metersPerPixel: number;
  widthUniform: () => number;
  colorUniform: () => Color;
  offsetUniform: () => number;
  metersPerPixelUniform: () => number;
}

/** Proven construction/upload factors; absence includes all instance paint. */
export interface UniformLineExtent {
  widthFactor: number;
  miterLimit: number;
}

export function registerDrawBatch(owner: object, batch: DrawBatch): void {
  (owner as Record<symbol, DrawBatch>)[batchKey] = batch;
  layerOwners.set(owner, new Set([batch.layerId]));
  rememberPrimitiveBytes(owner);
}

/** Collections cache their actual draw ownership when builds append or replace them. */
export function registerDrawLayers(owner: object, layers: Iterable<string>): void {
  layerOwners.set(owner, new Set(layers));
}

export function drawLayersForOwner(owner: object): ReadonlySet<string> {
  return layerOwners.get(owner) ?? NO_LAYERS;
}

export function allDrawLayersHidden(owner: object, hidden: ReadonlySet<string> | undefined): boolean {
  const layers = drawLayersForOwner(owner);
  if (!hidden || layers.size === 0) {
    return false;
  }
  for (const layer of layers) {
    if (!hidden.has(layer)) {
      return false;
    }
  }
  return true;
}

export function drawBatchForOwner(owner: object | undefined): DrawBatch | undefined {
  return owner && (owner as Record<symbol, DrawBatch | undefined>)[batchKey];
}

export function registerLinePaint(owner: object, uniforms: LinePaintUniforms, extent?: UniformLineExtent): void {
  (owner as Record<symbol, LinePaintUniforms>)[linePaintKey] = uniforms;
  registerUniformLineExtent(owner, extent);
}

export function registerUniformLineExtent(owner: object, extent: UniformLineExtent | undefined): void {
  if (extent)
    (owner as Record<symbol, UniformLineExtent>)[lineExtentKey] = extent;
  else delete (owner as Record<symbol, UniformLineExtent>)[lineExtentKey];
}

export function uniformLineExtentForOwner(owner: object | undefined): UniformLineExtent | undefined {
  return owner && (owner as Record<symbol, UniformLineExtent | undefined>)[lineExtentKey];
}

export function linePaintForOwner(owner: object | undefined): LinePaintUniforms | undefined {
  return owner && (owner as Record<symbol, LinePaintUniforms | undefined>)[linePaintKey];
}
