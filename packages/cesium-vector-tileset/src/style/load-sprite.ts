import type { SpriteSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { RequestTransformFunction } from '../util/request';

import type { SpriteJSON, StyleImage } from './style-image';
import { getJSON } from '../util/ajax';
import { browser } from '../util/browser';

import { getImage } from '../util/image-request';
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
    throw new Error(`Invalid sprite URL "${url}", must be absolute.`);
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

  const sprites = await Promise.all(spriteArray.map(async ({ id: spriteName, url }) => {
    const [jsonResponse, imageResponse] = await Promise.all([
      Promise.resolve(transformRequest(normalizeSpriteURL(url, format, '.json'), ResourceType.SpriteJSON, requestTransform))
        .then(parameters => getJSON<SpriteJSON>(parameters, abortController)),
      Promise.resolve(transformRequest(normalizeSpriteURL(url, format, '.png'), ResourceType.SpriteImage, requestTransform))
        .then(parameters => getImage(parameters, abortController)),
    ]);
    const image = imageResponse.data;
    if (!image) {
      throw new Error(`Could not load sprite image "${spriteName}".`);
    }
    const context = browser.getImageCanvasContext(image);
    const json = jsonResponse.data;
    const images: { [id: string]: StyleImage } = {};
    for (const id in json) {
      const { width, height, x, y, sdf, pixelRatio, stretchX, stretchY, content, textFitWidth, textFitHeight } = json[id];
      const spriteData = { width, height, x, y, context };
      images[id] = { data: undefined, pixelRatio, sdf, stretchX, stretchY, content, textFitWidth, textFitHeight, spriteData };
    }
    return [spriteName, images];
  }));
  return Object.fromEntries(sprites);
}
