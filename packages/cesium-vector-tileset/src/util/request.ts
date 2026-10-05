import type { RequestParameters } from './ajax';

/**
 * A type of MapLibre resource.
 */
export const ResourceType = {
  Glyphs: 'Glyphs',
  Image: 'Image',
  Source: 'Source',
  SpriteImage: 'SpriteImage',
  SpriteJSON: 'SpriteJSON',
  Style: 'Style',
  Tile: 'Tile',
  Unknown: 'Unknown',
} as const;

export type ResourceType = typeof ResourceType[keyof typeof ResourceType];

/**
 * This function is used to transform a request.
 * It is used just before executing the relevant request.
 */
export type RequestTransformFunction = (url: string, resourceType?: ResourceType) => RequestParameters | Promise<RequestParameters> | undefined;

export function transformRequest(url: string, resourceType: ResourceType, callback?: RequestTransformFunction): RequestParameters | Promise<RequestParameters> {
  return callback?.(url, resourceType) ?? { url };
}
