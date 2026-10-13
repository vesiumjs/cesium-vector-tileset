import { Formatted } from '@maplibre/maplibre-gl-style-spec';
import { expect, it } from 'vitest';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { SymbolStyleLayer } from '../../style/style-layer/symbol-style-layer';
import { transformText } from '../transform-text';

it('selects connected Arabic forms and lam-alef ligatures before glyph lookup by default', () => {
  const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'places' }, {});
  layer.recalculate(new EvaluationParameters(0), []);
  // Seen right-to-left, these are the connected seen, final lam-alef, and isolated meem.
  expect(transformText(Formatted.fromString('سلام'), layer, { type: 1, properties: {} }).toString())
    .toBe('\uFEB3\uFEFC\uFEE1');
});

it.each(['\u200F', '\u034F'])('keeps Arabic joining across transparent control %j before glyph lookup', (control) => {
  const layer = new SymbolStyleLayer({ id: 'labels', type: 'symbol', source: 'places' }, {});
  layer.recalculate(new EvaluationParameters(0), []);
  expect(transformText(Formatted.fromString(`ب${control}ب`), layer, { type: 1, properties: {} }).toString())
    .toBe(`\uFE91${control}\uFE90`);
});
