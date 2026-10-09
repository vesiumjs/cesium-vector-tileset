import type TinySDF from '@mapbox/tiny-sdf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphSource } from '../glyph-source';

function localFont(source: GlyphSource) {
  const draw = vi.fn(() => ({
    width: 2,
    height: 2,
    data: new Uint8Array([0, 32, 128, 255]),
    glyphWidth: 2,
    glyphHeight: 2,
    glyphLeft: 0,
    glyphTop: 2,
    glyphAdvance: 2,
  }));
  vi.spyOn(source, '_createTinySDF').mockResolvedValue({ draw } as unknown as TinySDF);
  return draw;
}

afterEach(() => vi.restoreAllMocks());

describe('concurrent tile glyph requests', () => {
  it('draws each local font/codepoint once and returns independent transferable bitmaps', async () => {
    const source = new GlyphSource(undefined, 'sans-serif');
    const draw = localFont(source);
    const requests = Array.from({ length: 8 }, () => source.getGlyphs({ 'Noto Sans Regular': [0x4E0A, 0x6D77] }));
    const results = await Promise.all(requests);
    expect(draw).toHaveBeenCalledTimes(2);
    for (const result of results) {
      expect(Object.keys(result['Noto Sans Regular'])).toEqual(['19978', '28023']);
      expect(result['Noto Sans Regular'][0x4E0A].metrics.isDoubleResolution).toBe(true);
      expect(result['Noto Sans Regular'][0x4E0A].bitmap.data).toEqual(new Uint8Array([0, 32, 128, 255]));
    }
    const transferred = structuredClone(results[0]['Noto Sans Regular'][0x4E0A].bitmap.data, {
      transfer: [results[0]['Noto Sans Regular'][0x4E0A].bitmap.data.buffer],
    });
    transferred.fill(0);
    const cached = await source.getGlyphs({ 'Noto Sans Regular': [0x4E0A] });
    expect(cached['Noto Sans Regular'][0x4E0A].bitmap.data).toEqual(new Uint8Array([0, 32, 128, 255]));
    expect(results[1]['Noto Sans Regular'][0x4E0A].bitmap.data).toEqual(new Uint8Array([0, 32, 128, 255]));
    expect(draw).toHaveBeenCalledTimes(2);
    source.destroy();
  });

  it('keeps different font stacks separate', async () => {
    const source = new GlyphSource(undefined, 'sans-serif');
    const draw = localFont(source);
    await Promise.all(Array.from({ length: 4 }, () => source.getGlyphs({ regular: [0x4E0A], bold: [0x4E0A] })));
    expect(draw).toHaveBeenCalledTimes(2);
    source.destroy();
  });

  it('shares missing-range fallback work and retries the server range later', async () => {
    const source = new GlyphSource();
    source.setURL('https://example.test/{fontstack}/{range}.pbf');
    const draw = localFont(source);
    const range = vi.spyOn(GlyphSource, 'loadGlyphRange').mockRejectedValue(new Error('missing range'));
    vi.spyOn(source, '_warnOnMissingGlyphRange').mockImplementation(() => {});
    await Promise.all(Array.from({ length: 8 }, () => source.getGlyphs({ regular: [65] })));
    expect(range).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(1);
    await source.getGlyphs({ regular: [66] });
    expect(range).toHaveBeenCalledTimes(2);
    expect(draw).toHaveBeenCalledTimes(2);
    source.destroy();
  });

  it('releases a failed local request so a later tile can retry', async () => {
    const source = new GlyphSource();
    const draw = localFont(source);
    const preparation = vi.mocked(source._createTinySDF);
    // Font creation belongs to the font stack; a draw failure belongs to one
    // glyph request and must not leave a rejected glyph promise cached.
    draw.mockImplementationOnce(() => {
      throw new Error('temporary draw failure');
    });
    const results = await Promise.allSettled([source.getGlyphs({ regular: [65] }), source.getGlyphs({ regular: [65] })]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(draw).toHaveBeenCalledTimes(1);
    const retried = await source.getGlyphs({ regular: [65] });
    expect(retried.regular[65].bitmap.data).toEqual(new Uint8Array([0, 32, 128, 255]));
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(2);
    source.destroy();
  });
});
