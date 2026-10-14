import type { StyleGlyph } from '../../style/style-glyph';
import type { Shaping } from '../shaping';
import Point from '@mapbox/point-geometry';
import { Formatted, FormattedSection, ResolvedImage } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { GlyphAtlas } from '../../assets/glyph-atlas';
import { CollisionBoxArray } from '../../data/array-types.g';
import { SymbolBucket } from '../../data/bucket/symbol-bucket';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { SymbolStyleLayer } from '../../style/style-layer/symbol-style-layer';
import { CanonicalTileID } from '../../tile/tile-id';
import { AlphaImage } from '../../util/image';
import { getBidiGlyphDependencies, segmentGraphemes } from '../bidi';
import { getGlyphQuads } from '../quads';
import { shapeText, WritingMode } from '../shaping';
import { performSymbolLayout } from '../symbol-layout';
import { transformText } from '../transform-text';

function shape(text: Formatted, availableText = text.toString(), maxWidth = Infinity, writingMode: Shaping['writingMode'] = WritingMode.horizontal): Shaping {
  const glyphs: Record<string, StyleGlyph> = {};
  const availableGlyphs = new Set(availableText);
  for (const { segment } of segmentGraphemes(availableText)) {
    for (const glyph of getBidiGlyphDependencies(segment))
      availableGlyphs.add(glyph);
  }
  for (const char of availableGlyphs) {
    const id = char.codePointAt(0)!;
    glyphs[char] = { id, bitmap: new AlphaImage({ width: 16, height: 24 }), metrics: { width: 10, height: 18, left: 0, top: 18, advance: /^\p{M}+$/u.test(char) ? 0 : 12 } };
  }
  const glyphMap = { Test: glyphs, Emphasis: glyphs };
  const atlas = new GlyphAtlas(glyphMap);
  const shaping = shapeText(text, glyphMap, atlas.positions, {}, 'Test', maxWidth, 24, 'center', 'center', 0, [0, 0], writingMode, false, 24, 24);
  expect(shaping).toBeTruthy();
  return shaping as Shaping;
}

function drawn(shaping: Shaping): string[] {
  return shaping.positionedLines.map(line => line.positionedGlyphs.map(glyph => glyph.glyph).join(''));
}

describe('default bidirectional label layout', () => {
  it('draws connected Arabic glyphs in visual order without configuring a plugin', () => {
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'places' }, {});
    layer.recalculate(new EvaluationParameters(0), []);
    const text = transformText(Formatted.fromString('سلام'), layer, { type: 1, properties: {} });
    expect(drawn(shape(text))).toEqual(['\uFEE1\uFEFC\uFEB3']);
  });

  it('places Hebrew in visual order while preserving English, numbers and brackets', () => {
    expect(drawn(shape(Formatted.fromString('שלום (Tel Aviv 12)')))).toEqual(['(Tel Aviv 12) םולש']);
    expect(drawn(shape(Formatted.fromString('אב (\u0301גד)')))).toEqual(['(דג)\u0301 בא']);
  });

  it('reorders each wrapped line using the direction of the whole paragraph', () => {
    expect(drawn(shape(Formatted.fromString('אב CD EF'), undefined, 36))).toEqual(['בא', 'CD', 'EF']);
    expect(drawn(shape(Formatted.fromString('אב\nCD')))).toEqual(['בא', 'CD']);
  });

  it('preserves supplementary characters and the style of each code point in a combining cluster', () => {
    const text = new Formatted([
      new FormattedSection('א', null, 1, 'Test', null, null),
      new FormattedSection('\u05B7', null, 2, 'Emphasis', null, null),
      new FormattedSection('ב 😀', null, 1, 'Test', null, null),
    ]);
    const shaping = shape(text);
    expect(drawn(shaping)).toEqual(['😀 בא\u05B7']);
    expect(shaping.positionedLines[0].positionedGlyphs.at(-1)).toMatchObject({ glyph: '\u05B7', fontStack: 'Emphasis', scale: 2 });
  });

  it('uses bidi isolates to place English text without drawing the directional controls', () => {
    expect(drawn(shape(Formatted.fromString('אב \u2066A12\u2069 גד')))).toEqual(['דג A12 בא']);
  });

  it('keeps section formatting after a missing glyph in a reordered label', () => {
    const text = new Formatted([
      new FormattedSection('אב', null, 1, 'Test', null, null),
      new FormattedSection(' 😀', null, 2, 'Emphasis', null, null),
    ]);
    const shaping = shape(text, ' אב');
    expect(shaping.positionedLines[0].positionedGlyphs.map(glyph => [glyph.glyph, glyph.fontStack, glyph.scale]))
      .toEqual([[' ', 'Emphasis', 2], ['ב', 'Test', 1], ['א', 'Test', 1]]);
  });
});

describe('text line boundaries and vertical mixed-script geometry', () => {
  // Line labels must rotate qualifying digits/codes back upright; the actual
  // atlas-backed quads distinguish a flag-only fix from correct rendered geometry.
  it('keeps numbers and short codes upright while long uppercase words follow the line', () => {
    const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'places' }, {});
    layer.recalculate(new EvaluationParameters(0), []);
    for (const [text, upright] of [
      ['반포대로21길', ['2', '1']],
      ['国道A1号', ['A', '1']],
      ['国道ISHIKAWA号', []],
    ] as const) {
      const shaped = shape(Formatted.fromString(text), text, Infinity, WritingMode.vertical);
      const glyphs = shaped.positionedLines.flatMap(line => line.positionedGlyphs);
      const quads = getGlyphQuads(shaped, [0, 0], layer, true, { type: 1, properties: {} }, {}, false);
      for (const [index, glyph] of glyphs.entries()) {
        const char = glyph.glyph;
        if (!/[A-Z0-9]/.test(char))
          continue;
        const vertical = (upright as readonly string[]).includes(char);
        expect(glyph.vertical, `${text}/${char}`).toBe(vertical);
        const corners = [quads[index].tl, quads[index].tr, quads[index].br, quads[index].bl];
        const width = Math.max(...corners.map(point => point.x)) - Math.min(...corners.map(point => point.x));
        const height = Math.max(...corners.map(point => point.y)) - Math.min(...corners.map(point => point.y));
        expect(width).toBeCloseTo(vertical ? 26 : 18);
        expect(height).toBeCloseTo(vertical ? 18 : 26);
      }
    }
  });

  it('draws the requested vertical punctuation inside an upright number run', () => {
    const shaped = shape(Formatted.fromString('国道1-2号'), '国道1-2号︲', Infinity, WritingMode.vertical);
    expect(drawn(shaped)).toEqual(['国道1︲2号']);
    expect(shaped.positionedLines[0].positionedGlyphs.every(glyph => glyph.vertical)).toBe(true);
  });

  // A CRLF represents one requested newline, including its bounds/collision height.
  it('keeps CRLF to two lines with one line-height of separation', () => {
    const shaped = shape(Formatted.fromString('AB\r\nCD'));
    expect(drawn(shaped)).toEqual(['AB', 'CD']);
    expect(shaped.bottom - shaped.top).toBe(48);
    expect(shaped.positionedLines[1].positionedGlyphs[0].y - shaped.positionedLines[0].positionedGlyphs[0].y).toBe(24);
    expect(drawn(shape(Formatted.fromString('AB\nCD')))).toEqual(['AB', 'CD']);
  });

  // Wrapping cannot orphan a combining mark, while the project's independent
  // formatting section for that mark must survive the stronger line boundary.
  it('wraps after the whole grapheme and preserves each code point’s formatting', () => {
    const text = new Formatted([
      new FormattedSection('文', null, 1, 'Test', null, null),
      new FormattedSection('\u0301', null, 2, 'Emphasis', null, null),
      new FormattedSection('字', null, 1, 'Test', null, null),
    ]);
    const shaped = shape(text, undefined, 12);
    expect(drawn(shaped)).toEqual(['文\u0301', '字']);
    expect(shaped.positionedLines[0].positionedGlyphs[1]).toMatchObject({ glyph: '\u0301', fontStack: 'Emphasis', scale: 2 });
    const sameSection = shape(Formatted.fromString('文\u0301字'), undefined, 12);
    expect(drawn(sameSection)).toEqual(['文\u0301', '字']);
    expect(sameSection.positionedLines[0].positionedGlyphs).toHaveLength(1);
    expect(sameSection.positionedLines[0].positionedGlyphs[0].glyph).toBe('文\u0301');
  });
});

describe('variable text-anchor layout', () => {
  it('keeps every justification available when a single-line label shares one placement', () => {
    const layer = new SymbolStyleLayer({
      id: 'labels',
      type: 'symbol',
      source: 'places',
      layout: {
        'text-font': ['Test'],
        'text-justify': 'auto',
        'text-variable-anchor': ['left', 'center', 'right'],
      },
    }, {});
    layer.recalculate(new EvaluationParameters(0), []);
    const bucket = new SymbolBucket({
      index: 0,
      layers: [layer],
      zoom: 0,
      pixelRatio: 1,
      overscaling: 1,
      collisionBoxArray: new CollisionBoxArray(),
      sourceLayerIndex: 0,
      sourceID: 'places',
    });
    bucket.features = [{
      index: 0,
      sourceLayerIndex: 0,
      type: 'Point',
      geometry: [[new Point(4096, 4096)]],
      properties: {},
      sortKey: undefined,
      text: Formatted.fromString('AB'),
      icon: new ResolvedImage({ name: '', available: false }),
    }];
    const glyphs: Record<string, StyleGlyph> = {};
    for (const char of ['A', 'B']) {
      const id = char.codePointAt(0)!;
      glyphs[char] = { id, bitmap: new AlphaImage({ width: 10, height: 18 }), metrics: { width: 10, height: 18, left: 0, top: 18, advance: 12 } };
    }
    const glyphMap = { Test: glyphs };
    const atlas = new GlyphAtlas(glyphMap);

    performSymbolLayout({ bucket, glyphMap, glyphPositions: atlas.positions, imageMap: {}, imagePositions: {}, canonical: new CanonicalTileID(0, 0, 0) });

    expect(bucket.symbolInstances.length).toBe(1);
    expect(bucket.text.placedSymbolArray.length).toBe(1);
    const instance = bucket.symbolInstances.get(0);
    expect(instance.leftJustifiedTextSymbolIndex).toBe(0);
    expect(instance.centerJustifiedTextSymbolIndex).toBe(0);
    expect(instance.rightJustifiedTextSymbolIndex).toBe(0);
  });
});
