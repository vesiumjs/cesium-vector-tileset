import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { HeightReference } from 'cesium';
import type { RequestTransformFunction } from './util/request';

export interface CesiumVectorTilesetOptions {
  style: StyleSpecification;
  /** Whether the tileset is shown. Defaults to true. */
  show?: boolean;
  /** Estimated GPU cache budget in bytes. Defaults to 256 MiB; active tiles are retained. */
  gpuMemoryBudgetBytes?: number;
  /** Transforms style, tile, sprite, glyph and source requests before loading. */
  transformRequest?: RequestTransformFunction;
  /**
   * Number of zoom levels above a vector source's max zoom for which tiles
   * are re-parsed from the deepest available tile, keeping deep zoom crisp
   * instead of upscaled (MapLibre default: 4).
   */
  zoomLevelsToOverscale?: number;
  /**
   * Font family used to render CJK ideographs locally (client-side SDF)
   * instead of fetching their glyph ranges from the style's glyph server.
   * MapLibre defaults to 'sans-serif'; pass `false` to force server fonts.
   */
  localIdeographFontFamily?: string | false;
  /**
   * Drape fill polygons onto terrain / 3D Tiles through the scene's vector
   * provider (Cesium 1.144+). Defaults to `HeightReference.NONE` (geometry
   * drawn at ellipsoid heights, as before).
   *
   * Only fill polygons drape: circle points, lines, symbols, extrusions and
   * patterns keep their ellipsoid heights, because Cesium's vector pipeline
   * only packs polygons and polylines.
   */
  heightReference?: HeightReference;
}

export type CesiumVectorTilesetFromUrlOptions = Omit<CesiumVectorTilesetOptions, 'style'> & {
  /** Cancels style loading and initialization before the factory resolves. */
  signal?: AbortSignal;
};
