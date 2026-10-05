import type { StyleLayer } from './style-layer';

export interface TransitionSource {
  hasTransition: () => boolean;
}

export interface RenderTransitionFlags {
  /** Any style, source, or light transition is active. */
  any: boolean;
  /** A fill/line/circle/extrusion transition can change vector paint. */
  vector: boolean;
  /** A raster transition can change raster material uniforms. */
  raster: boolean;
  /** The specific vector layers that can invalidate vector paint. */
  vectorLayerIds: ReadonlySet<string>;
  /** The specific raster layers that can invalidate raster paint. */
  rasterLayerIds: ReadonlySet<string>;
}

const VECTOR_LAYER_TYPES = new Set(['fill', 'fill-extrusion', 'line', 'circle']);
const EMPTY_LAYER_IDS: ReadonlySet<string> = new Set();

/**
 * Deadband for treating the derived camera zoom as changed. The CesiumVectorTileset
 * derives styleZoom from the ground footprint every frame, so even a pure
 * pan wiggles it by ~1e-11 (float noise on metre-scale math). Exact
 * comparison would mark every pan frame as a zoom change: full paint
 * recalculation, a renderRevision bump (which re-syncs every pattern tile),
 * and a VectorPaintUpdater.update walk with vertex re-uploads. MapLibre's
 * zoom is exact camera state and never wiggles; the deadband restores that.
 * 1e-6 is ~10000x the observed noise and ~1000x below anything perceptible
 * (a paint byte flips per ~0.008 zoom on typical ramps; slow pinches move
 * ~1e-3/frame), so real gestures still evaluate every frame.
 */
export const PAINT_ZOOM_EPSILON = 1e-6;

/** Whether two style zooms differ enough to re-evaluate paint. */
export function samePaintZoom(a: number, b: number): boolean {
  return Math.abs(a - b) <= PAINT_ZOOM_EPSILON;
}

/**
 * Classify all transition owners in one pass for the CesiumVectorTileset.
 * Keeping this outside Style makes the classification cheap to unit-test and
 * prevents the tileset from independently scanning the same layer list three
 * times for broad, vector, and raster transitions.
 */
export function renderTransitionFlags(
  light: TransitionSource | undefined,
  tilePyramids: Readonly<Record<string, TransitionSource>>,
  layers: Readonly<Record<string, StyleLayer>>,
  layerOrder: readonly string[],
): RenderTransitionFlags {
  let any = light?.hasTransition() ?? false;
  let vectorLayerIds: Set<string> | undefined;
  let rasterLayerIds: Set<string> | undefined;

  for (const id in tilePyramids) {
    if (tilePyramids[id].hasTransition()) {
      any = true;
    }
  }

  for (const id of layerOrder) {
    const layer = layers[id];
    if (!layer || !layer.hasTransition()) {
      continue;
    }
    any = true;
    if (VECTOR_LAYER_TYPES.has(layer.type)) {
      vectorLayerIds ??= new Set();
      vectorLayerIds.add(id);
    }
    else if (layer.type === 'raster') {
      rasterLayerIds ??= new Set();
      rasterLayerIds.add(id);
    }
  }

  return {
    any,
    vector: !!vectorLayerIds,
    raster: !!rasterLayerIds,
    vectorLayerIds: vectorLayerIds ?? EMPTY_LAYER_IDS,
    rasterLayerIds: rasterLayerIds ?? EMPTY_LAYER_IDS,
  };
}
