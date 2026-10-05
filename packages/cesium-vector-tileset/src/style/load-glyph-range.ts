import type { RequestTransformFunction } from '../util/request';
import type { StyleGlyph } from './style-glyph';

import { getArrayBuffer } from '../util/ajax';

import { ResourceType, transformRequest } from '../util/request';
import { parseGlyphPbf } from './parse-glyph-pbf';

export async function loadGlyphRange(fontstack: string, range: number, urlTemplate: string, requestTransform?: RequestTransformFunction): Promise<{ [_: number]: StyleGlyph | null }> {
  const begin = range * 256;
  const end = begin + 255;

  const request = await transformRequest(
    urlTemplate.replace('{fontstack}', fontstack).replace('{range}', `${begin}-${end}`),
    ResourceType.Glyphs,
    requestTransform,
  );

  const response = await getArrayBuffer(request, new AbortController());
  if (!response?.data) {
    throw new Error(`Could not load glyph range. range: ${range}, ${begin}-${end}`);
  }
  const glyphs: Record<number, StyleGlyph> = {};

  for (const glyph of parseGlyphPbf(response.data)) {
    glyphs[glyph.id] = glyph;
  }

  return glyphs;
}
