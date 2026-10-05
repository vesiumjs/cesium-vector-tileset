import type { RasterDEMSourceSpecification, RasterSourceSpecification, VectorSourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { RequestTransformFunction } from '../util/request';
import { resolveResourceUrl } from '../style/resolve-style-urls';

import { getJSON } from '../util/ajax';
import { browser } from '../util/browser';
import { pick } from '../util/objects';
import { ResourceType, transformRequest } from '../util/request';

interface TileMetadata extends Partial<TileJSON> {
  tileInfo?: {
    lods?: Array<{ level: number }>;
  };
}

export interface LoadTileJsonResponse {
  tiles: string[];
  minzoom: number;
  maxzoom: number;
  attribution: string;
  bounds: RasterSourceSpecification['bounds'];
  scheme: RasterSourceSpecification['scheme'];
  tileSize: number;
  encoding: RasterDEMSourceSpecification['encoding'];
  vectorLayerIds?: string[];
}

export async function loadTileJson(
  options: RasterSourceSpecification | RasterDEMSourceSpecification | VectorSourceSpecification,
  requestTransform: RequestTransformFunction | undefined,
  abortController: AbortController,
  targetWindow?: Window,
): Promise<LoadTileJsonResponse | null> {
  let tileJSON: TileMetadata | typeof options = options;
  if (options.url) {
    const request = await transformRequest(options.url, ResourceType.Source, requestTransform);
    const requestUrl = new URL(request.url, globalThis.location?.href);
    const arcgisService = options.type === 'vector' && /\/VectorTileServer\/?$/i.test(requestUrl.pathname);
    if (arcgisService) {
      requestUrl.searchParams.set('f', 'json');
    }
    const response = await getJSON<TileMetadata>(
      arcgisService ? { ...request, url: requestUrl.href } : request,
      abortController,
    );
    const metadata = response.data;
    const tileBaseUrl = new URL(response.url || requestUrl.href);
    if (arcgisService && !tileBaseUrl.pathname.endsWith('/')) {
      tileBaseUrl.pathname += '/';
    }
    const levels = arcgisService
      ? metadata.tileInfo?.lods?.map(lod => lod.level).filter(Number.isInteger)
      : undefined;
    tileJSON = {
      ...metadata,
      ...(metadata.tiles && { tiles: metadata.tiles.map(tile => resolveResourceUrl(tile, tileBaseUrl.href)) }),
      ...(levels?.length && { minzoom: Math.min(...levels), maxzoom: Math.max(...levels) }),
    };
  }
  else {
    await browser.frameAsync(abortController, targetWindow);
  }
  if (!tileJSON) {
    return null;
  }
  const result = pick(
    // explicit source options take precedence over TileJSON
    Object.assign(tileJSON, options),
    ['tiles', 'minzoom', 'maxzoom', 'attribution', 'bounds', 'scheme', 'tileSize', 'encoding'],
  ) as LoadTileJsonResponse;

  if ('vector_layers' in tileJSON && tileJSON.vector_layers) {
    result.vectorLayerIds = tileJSON.vector_layers.map(layer => layer.id);
  }

  return result;
}

export interface TileJSON {
  tilejson: '2.2.0' | '2.1.0' | '2.0.1' | '2.0.0' | '1.0.0';
  name?: string;
  description?: string;
  version?: string;
  attribution?: string;
  template?: string;
  tiles: string[];
  grids?: string[];
  data?: string[];
  minzoom?: number;
  maxzoom?: number;
  bounds?: [number, number, number, number];
  center?: [number, number, number];
  vector_layers: [{ id: string }]; // this is partial but enough for what we need
}
