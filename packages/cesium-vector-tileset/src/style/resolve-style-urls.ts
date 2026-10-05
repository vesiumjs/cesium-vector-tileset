import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

export function resolveResourceUrl(url: string, baseUrl: string): string {
  return new URL(url, baseUrl).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

/** Resolve resource URLs relative to the stylesheet that declared them. */
export function resolveStyleUrls(style: StyleSpecification, styleUrl: string): StyleSpecification {
  const resolve = (url: string): string => resolveResourceUrl(url, styleUrl);
  const sources = Object.fromEntries(Object.entries(style.sources).map(([id, source]) => {
    const resolved = { ...source };
    if ('url' in resolved && typeof resolved.url === 'string') {
      resolved.url = resolve(resolved.url);
    }
    if ('tiles' in resolved && Array.isArray(resolved.tiles)) {
      resolved.tiles = resolved.tiles.map(resolve);
    }
    return [id, resolved];
  })) as StyleSpecification['sources'];

  return {
    ...style,
    sources,
    ...(style.sprite && {
      sprite: typeof style.sprite === 'string'
        ? resolve(style.sprite)
        : style.sprite.map(sprite => ({ ...sprite, url: resolve(sprite.url) })),
    }),
    ...(style.glyphs && { glyphs: resolve(style.glyphs) }),
  };
}
