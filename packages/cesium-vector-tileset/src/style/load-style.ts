import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { RequestTransformFunction } from '../util/request';
import { ResourceType, transformRequest } from '../util/request';
import { resolveStyleUrls } from './resolve-style-urls';

/** Loads a style and resolves its resources against the final response URL. */
export async function loadStyle(url: string, requestTransform?: RequestTransformFunction, signal?: AbortSignal): Promise<StyleSpecification> {
  signal?.throwIfAborted();
  const request = await transformRequest(url, ResourceType.Style, requestTransform);
  signal?.throwIfAborted();
  const response = await fetch(request.url, {
    signal,
    method: request.method,
    headers: request.headers,
    body: request.body,
    credentials: request.credentials,
    cache: request.cache,
    referrerPolicy: request.referrerPolicy,
  });
  if (!response.ok) {
    throw new Error(`Failed to load style from ${request.url}: ${response.status} ${response.statusText}`);
  }
  const style: unknown = await response.json();
  signal?.throwIfAborted();
  if (!isStyleSpecification(style)) {
    throw new Error(`The style response from ${request.url} is not a valid style object`);
  }
  return resolveStyleUrls(style, response.url || request.url);
}

function isStyleSpecification(value: unknown): value is StyleSpecification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  return fields.version === 8
    && typeof fields.sources === 'object'
    && fields.sources !== null
    && !Array.isArray(fields.sources)
    && Array.isArray(fields.layers);
}
