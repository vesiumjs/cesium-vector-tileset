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
import { shapeText, WritingMode } from '../shaping';
import { performSymbolLayout } from '../symbol-layout';
import { transformText } from '../transform-text';

function shape(text: Formatted, availableText = text.toString(), maxWidth = Infinity): Shaping {
  const glyphs: Record<number, StyleGlyph> = {};
  for (const char of availableText) {
    const id = char.codePointAt(0)!;
    glyphs[id] = { id, bitmap: new AlphaImage({ width: 0, height: 0 }), metrics: { width: 10, height: 18, left: 0, top: 18, advance: 12 } };
  }
  const glyphMap = { Test: glyphs, Emphasis: glyphs };
  const shaping = shapeText(text, glyphMap, {}, {}, 'Test', maxWidth, 24, 'center', 'center', 0, [0, 0], WritingMode.horizontal, false, 24, 24);
  expect(shaping).toBeTruthy();
  return shaping as Shaping;
}

function drawn(shaping: Shaping): string[] {
  return shaping.positionedLines.map(line => line.positionedGlyphs.map(glyph => String.fromCodePoint(glyph.glyph)).join(''));
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
    expect(shaping.positionedLines[0].positionedGlyphs.at(-1)).toMatchObject({ glyph: 0x05B7, fontStack: 'Emphasis', scale: 2 });
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
    expect(shaping.positionedLines[0].positionedGlyphs.map(glyph => [String.fromCodePoint(glyph.glyph), glyph.fontStack, glyph.scale]))
      .toEqual([[' ', 'Emphasis', 2], ['ב', 'Test', 1], ['א', 'Test', 1]]);
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
    const glyphs: Record<number, StyleGlyph> = {};
    for (const id of [65, 66]) {
      glyphs[id] = { id, bitmap: new AlphaImage({ width: 10, height: 18 }), metrics: { width: 10, height: 18, left: 0, top: 18, advance: 12 } };
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
