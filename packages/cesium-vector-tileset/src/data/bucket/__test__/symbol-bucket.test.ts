import type { SymbolLayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { StyleGlyph } from '../../../style/style-glyph';
import type { PopulateParameters } from '../../bucket';
import Point from '@mapbox/point-geometry';
import { expect, it } from 'vitest';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { SymbolStyleLayer } from '../../../style/style-layer/symbol-style-layer';
import { shapeText, WritingMode } from '../../../symbol/shaping';
import { OverscaledTileID } from '../../../tile/tile-id';
import { AlphaImage } from '../../../util/image';
import { CollisionBoxArray } from '../../array-types.g';
import { FeatureIndex } from '../../feature-index';
import { SymbolBucket } from '../symbol-bucket';

function drawRequestedGlyphs(layout: SymbolLayerSpecification['layout']) {
  const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
  const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'places', layout }, {});
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
  const options: PopulateParameters = {
    featureIndex: new FeatureIndex(),
    iconDependencies: {},
    patternDependencies: {},
    glyphDependencies: {},
    dashDependencies: {},
    availableImages: [],
  };
  bucket.populate([{
    feature: { type: 1, id: 1, extent: 8192, properties: {}, loadGeometry: () => [[new Point(4096, 4096)]] },
    index: 0,
    sourceLayerIndex: 0,
  }], options, tileID.canonical);
  const glyphMap: Record<string, Record<number, StyleGlyph>> = {};
  // A glyph response contains only the requested IDs, even when the font has other characters.
  for (const [fontStack, dependencies] of Object.entries(options.glyphDependencies)) {
    const glyphs: Record<number, StyleGlyph> = glyphMap[fontStack] = {};
    for (const key of Object.keys(dependencies)) {
      const id = Number(key);
      glyphs[id] = { id, bitmap: new AlphaImage({ width: 0, height: 0 }), metrics: { width: 10, height: 18, left: 0, top: 18, advance: 12 } };
    }
  }
  const text = bucket.features[0]?.text;
  if (!text)
    throw new Error('Expected populated label');
  const shaping = shapeText(text, glyphMap, {}, {}, 'Test', Infinity, 24, 'center', 'center', 0, [0, 0], WritingMode.horizontal, false, 24, 24);
  if (!shaping)
    throw new Error('Expected shaped label');
  return shaping.positionedLines[0].positionedGlyphs.map(glyph => [String.fromCodePoint(glyph.glyph), glyph.fontStack]);
}

it('draws a mirrored unpaired bracket in mixed RTL text using the glyphs requested by the bucket', () => {
  expect(drawRequestedGlyphs({ 'text-field': 'אב CD12 (', 'text-font': ['Test'] }))
    .toEqual([[')', 'Test'], [' ', 'Test'], ['C', 'Test'], ['D', 'Test'], ['1', 'Test'], ['2', 'Test'], [' ', 'Test'], ['ב', 'Test'], ['א', 'Test']]);
});

it('requests mirrored brackets in their own formatted fonts when another section establishes RTL direction', () => {
  expect(drawRequestedGlyphs({
    'text-font': ['Test'],
    'text-field': ['format', '(', { 'text-font': ['literal', ['Opening']] }, 'אב', {}, ')', { 'text-font': ['literal', ['Closing']] }],
  })).toEqual([['(', 'Closing'], ['ב', 'Test'], ['א', 'Test'], [')', 'Opening']]);
});
