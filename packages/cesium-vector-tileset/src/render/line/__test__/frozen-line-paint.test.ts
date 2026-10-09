import type { LineLayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { LineStyleLayer } from '../../../style/style-layer/line-style-layer';
import { freezeLineCameraPaint } from '../frozen-line-paint';

describe('committed line camera paint', () => {
  it('finishes a delayed zero-duration transition at its exact boundary', () => {
    const layer = new LineStyleLayer({
      id: 'roads',
      type: 'line',
      source: 'city',
      paint: { 'line-width': 8 },
    } satisfies LineLayerSpecification, {});
    layer.recalculate(new EvaluationParameters(8), []);
    layer.setPaintProperty('line-width', 20);
    layer.updateTransitions({ now: 0, transition: { duration: 0, delay: 100 } });
    layer.recalculate(new EvaluationParameters(8, { now: 100 }), []);
    const held = freezeLineCameraPaint(layer);
    expect(held(12).widthPx).toBe(20);
  });

  it('owns the old camera expression and global state after the live schema changes', () => {
    const state = { alpha: 0.4 };
    const layer = new LineStyleLayer({
      id: 'roads',
      type: 'line',
      source: 'city',
      paint: {
        'line-width': ['step', ['zoom'], 8, 10, 0],
        'line-color': '#ff0000',
        'line-opacity': ['global-state', 'alpha'],
      },
    } satisfies LineLayerSpecification, state);
    layer.recalculate(new EvaluationParameters(8, { now: 50 }), []);
    const held = freezeLineCameraPaint(layer);
    state.alpha = 1;
    layer.setPaintProperty('line-width', ['get', 'width']);
    layer.setPaintProperty('line-color', '#0000ff');
    layer.updateTransitions({ now: 100, transition: { duration: 0 } });
    layer.recalculate(new EvaluationParameters(12, { now: 100 }), []);
    expect(held(8).widthPx).toBe(8);
    expect(held(8).color.alpha).toBe(0.4);
    expect(held(8).color.red).toBe(1);
    expect(held(12).widthPx).toBe(0);
    expect(held(12).color.red).toBe(1);
  });

  it('freezes the committed transition weights while evaluating both old curves at camera zoom', () => {
    const layer = new LineStyleLayer({
      id: 'roads',
      type: 'line',
      source: 'city',
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0, 24, 24],
        'line-color': '#0000ff',
        'line-opacity': 1,
      },
    } satisfies LineLayerSpecification, {});
    layer.recalculate(new EvaluationParameters(8, { now: 100 }), []);
    layer.setPaintProperty('line-width', ['interpolate', ['linear'], ['zoom'], 0, 0, 24, 48]);
    layer.setPaintProperty('line-color', '#ff0000');
    layer.setPaintProperty('line-opacity', 0);
    layer.updateTransitions({ now: 100, transition: { duration: 100, delay: 0 } });
    layer.recalculate(new EvaluationParameters(8, { now: 150 }), []);
    const held = freezeLineCameraPaint(layer);
    const committed = held(8);
    expect(committed.widthPx).toBe(12);
    expect(committed.color.red).toBe(0.5);
    expect(committed.color.blue).toBe(0.5);
    expect(committed.color.alpha).toBe(0.5);
    // Live evaluation expires and mutates the original transition tree.
    layer.recalculate(new EvaluationParameters(12, { now: 500 }), []);
    expect(held(12).widthPx).toBe(18);
    expect(held(12).color.alpha).toBe(0.5);
    expect(held(0).widthPx).toBe(0);
  });
});
