import type { SpriteSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { GetResourceResponse } from '../util/ajax';
import type { RequestTransformFunction } from '../util/request';

import type { SpriteJSON, StyleImage } from './style-image';
import { getJSON } from '../util/ajax';
import { browser } from '../util/browser';

import { ImageRequest } from '../util/image-request';
import { ResourceType, transformRequest } from '../util/request';
import { normalizeSprite } from './sprite';

export interface LoadSpriteResult {
  [spriteName: string]: {
    [id: string]: StyleImage;
  };
}

export function normalizeSpriteURL(url: string, format: string, extension: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname += `${format}${extension}`;
    return parsed.toString();
  }
  catch {
    throw new Error(`Invalid sprite URL "${url}", must be absolute. Modify style specification directly or use TransformStyleFunction to correct the issue dynamically`);
  }
}

export async function loadSprite(
  originalSprite: SpriteSpecification,
  requestTransform: RequestTransformFunction | undefined,
  pixelRatio: number,
  abortController: AbortController,
): Promise<LoadSpriteResult> {
  const spriteArray = normalizeSprite(originalSprite);
  const format = pixelRatio > 1 ? '@2x' : '';

  const jsonsMap: { [id: string]: Promise<GetResourceResponse<SpriteJSON>> } = {};
  const imagesMap: { [id: string]: Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>> } = {};

  for (const { id, url } of spriteArray) {
    const jsonRequestParameters = await transformRequest(normalizeSpriteURL(url, format, '.json'), ResourceType.SpriteJSON, requestTransform);
    jsonsMap[id] = getJSON<SpriteJSON>(jsonRequestParameters, abortController);

    const imageRequestParameters = await transformRequest(normalizeSpriteURL(url, format, '.png'), ResourceType.SpriteImage, requestTransform);
    imagesMap[id] = ImageRequest.getImage(imageRequestParameters, abortController);
  }

  await Promise.all([...Object.values(jsonsMap), ...Object.values(imagesMap)]);
  return doOnceCompleted(jsonsMap, imagesMap);
}

/**
 * @param jsonsMap - JSON data map
 * @param imagesMap - image data map
 */
async function doOnceCompleted(
  jsonsMap: { [id: string]: Promise<GetResourceResponse<SpriteJSON>> },
  imagesMap: { [id: string]: Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>> },
): Promise<LoadSpriteResult> {
  const result = {} as { [spriteName: string]: { [id: string]: StyleImage } };
  for (const spriteName in jsonsMap) {
    result[spriteName] = {};

    const image = (await imagesMap[spriteName]).data;
    if (!image) {
      throw new Error(`Could not load sprite image "${spriteName}".`);
    }
    const context = browser.getImageCanvasContext(image);
    const json = (await jsonsMap[spriteName]).data;

    for (const id in json) {
      const { width, height, x, y, sdf, pixelRatio, stretchX, stretchY, content, textFitWidth, textFitHeight } = json[id];
      const spriteData = { width, height, x, y, context };
      result[spriteName][id] = { data: undefined, pixelRatio, sdf, stretchX, stretchY, content, textFitWidth, textFitHeight, spriteData };
    }
  }

  return result;
}
