import type { StyleGlyph } from '../style/style-glyph';

import type { RequestTransformFunction } from '../util/request';
import type { GetGlyphsResponse } from '../worker/messages';
import TinySDF from '@mapbox/tiny-sdf';
import { v8 } from '@maplibre/maplibre-gl-style-spec';

import { loadGlyphRange } from '../style/load-glyph-range';
import { ensureError, warnOnce } from '../util/errors';
import { AlphaImage } from '../util/image';

import { codePointUsesLocalIdeographFontFamily } from '../util/unicode-properties.g';

interface Entry {
  glyphs: Record<string, StyleGlyph>;
  requests: Record<number, Promise<Record<number, StyleGlyph>>>;
  ranges: Record<number, boolean>;
  localRequests?: Record<string, Promise<StyleGlyph>>;
  tinySDF?: Promise<TinySDF>;
  ideographTinySDF?: Promise<TinySDF>;
  clusterTinySDF?: Promise<TinySDF>;
  ideographClusterTinySDF?: Promise<TinySDF>;
}

interface GlyphResult {
  stack: string;
  id: string;
  glyph?: StyleGlyph;
}

/**
 * The style specification hard-codes some last resort fonts as a default fontstack.
 */
const defaultStack = v8.layout_symbol['text-font'].default.join(',');
/**
 * The CSS generic font family closest to `defaultStack`.
 */
const defaultGenericFontFamily = 'sans-serif';

/**
 * Scale factor for client-generated glyphs.
 *
 * Client-generated glyphs are rendered at 2× because CJK glyphs are more detailed than others.
 */
const textureScale = 2;

export class GlyphSource {
  transformRequest?: RequestTransformFunction;
  localIdeographFontFamily: string | false;
  entries: Record<string, Entry>;
  url?: string;
  lang?: string;

  // exposed as statistics to enable stubbing in unit tests
  static loadGlyphRange: typeof loadGlyphRange = loadGlyphRange;
  static TinySDF: typeof TinySDF = TinySDF;

  constructor(transformRequest?: RequestTransformFunction, localIdeographFontFamily?: string | false, lang?: string) {
    this.transformRequest = transformRequest;
    this.localIdeographFontFamily = localIdeographFontFamily ?? false;
    this.entries = {};
    this.lang = lang;
  }

  setURL(url?: string | null): void {
    this.url = url ?? undefined;
  }

  async getGlyphs(glyphs: { [stack: string]: string[] }): Promise<GetGlyphsResponse> {
    const glyphsPromises: Array<Promise<GlyphResult>> = [];

    for (const stack in glyphs) {
      for (const id of glyphs[stack]) {
        glyphsPromises.push(this.loadGlyph(stack, id));
      }
    }

    const updatedGlyphs = await Promise.all(glyphsPromises);

    const result: GetGlyphsResponse = {};

    for (const { stack, id, glyph } of updatedGlyphs) {
      result[stack] ||= {};
      if (glyph) {
        // Clone the glyph so that our own copy of its ArrayBuffer doesn't get transferred.
        result[stack][id] = {
          id: glyph.id,
          bitmap: glyph.bitmap.clone(),
          metrics: glyph.metrics,
        };
      }
    }

    return result;
  }

  async loadGlyph(stack: string, id: string): Promise<GlyphResult> {
    // Create an entry for this fontstack if it doesn’t already exist.
    this.entries[stack] ??= { glyphs: {}, requests: {}, ranges: {} };
    const entry = this.entries[stack];

    // Try to get the glyph from the cache of glyphs by grapheme.
    let glyph = entry.glyphs[id];
    if (glyph !== undefined) {
      return { stack, id, glyph };
    }

    // A PBF serves individual codepoints; clusters use browser font shaping.
    const url = this.url;
    if (!url || [...id].length > 1 || this._charUsesLocalIdeographFontFamily(id.codePointAt(0)!)) {
      glyph = await this._loadLocalGlyph(entry, stack, id);
      return { stack, id, glyph };
    }

    return await this._downloadAndCacheRangePromise(stack, id, url);
  }

  /**
   * @internal
   */
  private async _downloadAndCacheRangePromise(stack: string, id: string, url: string): Promise<GlyphResult> {
    // Try to get the glyph from the cache of server-side glyphs by PBF range.
    const entry = this.entries[stack];
    const codePoint = id.codePointAt(0)!;
    const range = Math.floor(codePoint / 256);
    if (entry.ranges[range]) {
      return { stack, id };
    }

    // Start downloading this range unless we’re currently downloading it.
    entry.requests[range] ||= GlyphSource.loadGlyphRange(stack, range, url, this.transformRequest).then((response) => {
      const glyphs: Record<number, StyleGlyph> = {};
      for (const id in response) {
        const glyph = response[+id];
        if (glyph) {
          glyphs[+id] = glyph;
        }
      }
      return glyphs;
    });

    try {
      // Get the response and cache the glyphs from it.
      const response = await entry.requests[range];
      for (const id in response) {
        entry.glyphs[String.fromCodePoint(+id)] = response[+id];
      }
      entry.ranges[range] = true;
      const glyph = response[codePoint];
      return glyph ? { stack, id, glyph } : { stack, id };
    }
    catch (e) {
      // Drop the failed request so the range can be retried. Leaving the
      // rejected promise cached means `entry.requests[range] ||=` never
      // re-issues it, so one transient failure forces local TinySDF rendering
      // for all 256 glyphs in the range for the rest of the session.
      delete entry.requests[range];
      this._warnOnMissingGlyphRange(range, codePoint, ensureError(e));
      // Fall back to drawing the glyph locally and caching it.
      const glyph = await this._loadLocalGlyph(entry, stack, id);
      return { stack, id, glyph };
    }
  }

  /**
   * Tiles share a font's pending draw while retaining independent response bitmaps.
   * @internal
   */
  private _loadLocalGlyph(entry: Entry, stack: string, id: string): Promise<StyleGlyph> {
    const glyph = entry.glyphs[id];
    if (glyph)
      return Promise.resolve(glyph);
    const requests = entry.localRequests ??= {};
    return requests[id] ??= this._drawGlyph(entry, stack, id).then((glyph) => {
      entry.glyphs[id] = glyph;
      return glyph;
    }).finally(() => {
      delete requests[id];
    });
  }

  /**
   * @internal
   */
  private _warnOnMissingGlyphRange(range: number, id: number, err: Error): void {
    const begin = range * 256;
    const end = begin + 255;
    const codePoint = id.toString(16).padStart(4, '0').toUpperCase();
    warnOnce(`Unable to load glyph range ${range}, ${begin}-${end}. Rendering codepoint U+${codePoint} locally instead. ${err}`);
  }

  /**
   * Returns whether the given codepoint should be rendered locally.
   * @internal
   */
  private _charUsesLocalIdeographFontFamily(id: number): boolean {
    return !!this.localIdeographFontFamily && codePointUsesLocalIdeographFontFamily(id);
  }

  /**
   * Draws a glyph offscreen using TinySDF, creating a TinySDF instance lazily.
   * @internal
   */
  private async _drawGlyph(entry: Entry, stack: string, id: string): Promise<StyleGlyph> {
    // The CJK fallback font specified by the developer takes precedence over the last resort fontstack in the style specification.
    const usesLocalIdeographFontFamily = stack === defaultStack && this.localIdeographFontFamily !== '' && this._charUsesLocalIdeographFontFamily(id.codePointAt(0)!);

    // Keep a separate TinySDF instance for when we need to apply the localIdeographFontFamily fallback to keep the font selection from bleeding into non-CJK text.
    const cluster = [...id].length > 1;
    const tinySDFKey = cluster
      ? (usesLocalIdeographFontFamily ? 'ideographClusterTinySDF' : 'clusterTinySDF')
      : (usesLocalIdeographFontFamily ? 'ideographTinySDF' : 'tinySDF');
    entry[tinySDFKey] ||= this._createTinySDF(usesLocalIdeographFontFamily ? this.localIdeographFontFamily : stack, cluster ? 3 : 1);
    const tinySDF = await entry[tinySDFKey];
    const char = tinySDF.draw(id);

    /**
     * TinySDF's "top" is the distance from the alphabetic baseline to the top of the glyph.
     * Server-generated fonts specify "top" relative to an origin above the em box (the origin
     * comes from FreeType).
     *
     * Server fonts don't yet include baseline information, so we can't line up exactly with them
     * (and they don't line up with each other)
     *
     * Follow MapLibre's baseline adjustment to approximately align TinySDF glyphs with server-provided glyphs,
     * using a factor calibrated to be between DIN Pro and Arial Unicode (but closer to Arial Unicode).
     */
    const topAdjustment = 27.5;

    const leftAdjustment = 0.5;

    // By definition, control characters are invisible and nonspacing.
    const isControl = /^\p{gc=Cf}+$/u.test(id);

    return {
      id: id.codePointAt(0)!,
      bitmap: new AlphaImage({ width: char.width || 30 * textureScale, height: char.height || 30 * textureScale }, char.data),
      metrics: {
        width: isControl ? 0 : (char.glyphWidth / textureScale || 24),
        height: char.glyphHeight / textureScale || 24,
        left: (char.glyphLeft / textureScale + leftAdjustment) || 0,
        top: char.glyphTop / textureScale - topAdjustment || -8,
        advance: isControl ? 0 : (char.glyphAdvance / textureScale || 24),
        isDoubleResolution: true,
      },
    };
  }

  /**
   * @internal
   */
  private async _createTinySDF(stack: string | false, emsWide: number = 1): Promise<TinySDF> {
    // Escape and quote the font family list for use in CSS.
    const fontFamilies = stack ? stack.split(',') : [];
    fontFamilies.push(defaultGenericFontFamily);
    const fontFamily = fontFamilies.map(fontName =>
      /[-\w]+/.test(fontName) ? fontName : `'${CSS.escape(fontName)}'`,
    ).join(',');

    const fontSize = 24 * textureScale;
    const fontWeight = this._fontWeight(fontFamilies[0]);
    const fontStyle = this._fontStyle(fontFamilies[0]);

    // Await web font load so TinySDF doesn't cache a fallback bitmap. See #7307.
    if (typeof document !== 'undefined' && document.fonts?.load) {
      try {
        await document.fonts.load(`${fontStyle} ${fontWeight || 'normal'} ${fontSize}px ${fontFamily}`);
      }
      catch (e) {
        warnOnce(`Failed to load font "${fontFamily}": ${ensureError(e).message}`);
      }
    }

    const padding = 3 * textureScale;
    const tinySDF = new GlyphSource.TinySDF({
      fontSize,
      buffer: Math.max(padding, Math.ceil(fontSize * (emsWide - 1) / 4)),
      radius: 8 * textureScale,
      cutoff: 0.25,
      fontFamily,
      fontWeight,
      fontStyle,
      lang: this.lang,
    }) as TinySDF & { buffer: number };
    // TinySDF uses constructor buffer to size its canvas, and draw-time buffer
    // for bitmap padding. Wider clusters still use the atlas's 3px SDF border.
    tinySDF.buffer = padding;
    return tinySDF;
  }

  /**
   * Sniffs the font style out of a font family name.
   * @internal
   */
  private _fontStyle(fontFamily: string): string {
    if (/italic/i.test(fontFamily)) {
      return 'italic';
    }
    else if (/oblique/i.test(fontFamily)) {
      return 'oblique';
    }
    return 'normal';
  }

  /**
   * Sniffs the font weight out of a font family name.
   * @internal
   */
  private _fontWeight(fontFamily: string): string | undefined {
    // Based on the OpenType specification
    // https://learn.microsoft.com/en-us/typography/opentype/spec/os2#usweightclass
    const weightsByName = {
      'thin': 100,
      'hairline': 100,
      'extra light': 200,
      'ultra light': 200,
      'light': 300,
      'normal': 400,
      'regular': 400,
      'medium': 500,
      'semibold': 600,
      'demibold': 600,
      'bold': 700,
      'extra bold': 800,
      'ultra bold': 800,
      'black': 900,
      'heavy': 900,
      'extra black': 950,
      'ultra black': 950,
    };
    let match: string | undefined;
    for (const [name, weight] of Object.entries(weightsByName)) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(fontFamily)) {
        match = `${weight}`;
      }
    }
    return match;
  }

  destroy(): void {
    this.entries = {};
  }
}
