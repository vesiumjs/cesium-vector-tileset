import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { BackgroundStyleLayer } from '../style-layer/background-style-layer';
import { Color, latest } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { EvaluationParameters } from '../evaluation-parameters';
import { Style } from '../style';

const emptyStyle: StyleSpecification = { version: 8, sources: {}, layers: [] };

async function loadStyle(specification: StyleSpecification): Promise<Style> {
  const style = new Style();
  const loaded = style.once('style.load');
  style.loadJSON(specification);
  await loaded;
  return style;
}

describe('style state replacement', () => {
  it('restores omitted light properties and allows the light to be removed', async () => {
    const specification = { ...emptyStyle, transition: { duration: 0, delay: 0 } };
    const style = await loadStyle({
      ...specification,
      light: {
        'color': '#ff0000',
        'position': [2, 90, 20],
        'intensity': 0.9,
        'intensity-transition': { duration: 900 },
      },
    });
    try {
      style.update(new EvaluationParameters(0));
      style.update(new EvaluationParameters(0, { now: 2000 }));
      expect(style.getRenderTransitionFlags().any).toBe(false);
      expect(style.light!.properties.get('intensity')).toBe(0.9);
      const next = { ...specification, light: { color: '#00ff00' } };
      const change = style.setState(next)!;
      expect(change.previous.light?.intensity).toBe(0.9);
      expect(change.next).toEqual(next);
      expect(change.changes).toEqual([{ command: 'setLight', args: [next.light] }]);
      style.update(new EvaluationParameters(0, { now: performance.now() + 2000 }));
      expect(style.light!.properties.get('intensity')).toBe(latest.light.intensity.default);
      expect(style.light!.properties.get('position')).toEqual(latest.light.position.default);
      expect(style.serialize()?.light?.['intensity-transition']).toBeUndefined();

      expect(() => style.setState(specification)).not.toThrow();
      style.update(new EvaluationParameters(0, { now: performance.now() + 2000 }));
      expect(style.serialize()?.light).toBeUndefined();
      expect(style.light!.getLight()).toEqual({});
      expect(style.light!.properties.get('color')).toEqual(Color.parse(latest.light.color.default));
      expect(style.setState(specification)).toBeUndefined();
    }
    finally {
      style.destroy();
    }
  });

  it('reevaluates light-only global state after a stable frame', async () => {
    const specification: StyleSpecification = {
      ...emptyStyle,
      transition: { duration: 0, delay: 0 },
      light: { intensity: ['coalesce', ['global-state', 'intensity'], 0.25] },
    };
    const style = await loadStyle({ ...specification, state: { intensity: { default: 0.8 } } });
    try {
      style.update(new EvaluationParameters(12));
      style.update(new EvaluationParameters(12));
      expect(style.getRenderTransitionFlags().any).toBe(false);
      expect(style.light!.properties.get('intensity')).toBe(0.8);

      style.setState({ ...specification, state: { intensity: { default: 0.2 } } });
      style.update(new EvaluationParameters(12));
      expect(style.light!.properties.get('intensity')).toBe(0.2);

      style.setState(specification);
      style.update(new EvaluationParameters(12));
      expect(style.light!.properties.get('intensity')).toBe(0.25);
    }
    finally {
      style.destroy();
    }
  });

  it('removes global state defaults when their keys or the whole state are removed', async () => {
    const layers: StyleSpecification['layers'] = [{
      id: 'background',
      type: 'background',
      layout: { visibility: ['case', ['==', ['global-state', 'remaining'], 1], 'none', 'visible'] },
      paint: { 'background-opacity': ['coalesce', ['global-state', 'opacity'], 0.25] },
    }];
    const style = await loadStyle({
      ...emptyStyle,
      layers,
      state: { opacity: { default: 0.75 }, remaining: { default: 1 } },
    });
    try {
      const layer = style.getLayer('background') as BackgroundStyleLayer;
      style.update(new EvaluationParameters(0));
      expect(layer.paint.get('background-opacity')).toBe(0.75);
      expect(layer.isHidden()).toBe(true);
      style.setState({ ...emptyStyle, layers, state: { remaining: { default: 1 } } });
      style.update(new EvaluationParameters(0, { now: performance.now() + 1000 }));
      expect(layer.paint.get('background-opacity')).toBe(0.25);
      style.setState({ ...emptyStyle, layers });
      style.update(new EvaluationParameters(0, { now: performance.now() + 1000 }));
      expect(layer.paint.get('background-opacity')).toBe(0.25);
      expect(style.serialize()?.state).toBeUndefined();
      expect(layer.isHidden()).toBe(false);
    }
    finally {
      style.destroy();
    }
  });

  it('validates direct light setters before changing the existing light', async () => {
    const style = await loadStyle(emptyStyle);
    const errors: Error[] = [];
    style.on('error', event => errors.push(event.error));
    try {
      style.setLight({ intensity: 2 });
      expect(errors).toHaveLength(1);
      expect(style.light!.properties.get('intensity')).toBe(latest.light.intensity.default);
      expect(style.setState({ ...emptyStyle, light: { intensity: 2 } })).toBeUndefined();
      expect(errors).toHaveLength(2);
    }
    finally {
      style.destroy();
    }
  });

  it('makes layers visible at formerly excluded zooms when bounds are removed', async () => {
    const layerSpecification = { id: 'background', type: 'background' as const, minzoom: 5, maxzoom: 10 };
    const style = await loadStyle({ ...emptyStyle, layers: [layerSpecification] });
    try {
      const layer = style.getLayer('background')!;
      style.update(new EvaluationParameters(2));
      expect(layer.isHidden(2)).toBe(true);
      expect(layer.isHidden(12)).toBe(true);

      style.setState({ ...emptyStyle, layers: [{ id: 'background', type: 'background', maxzoom: 10 }] });
      style.update(new EvaluationParameters(2));
      expect(layer.isHidden(2)).toBe(false);
      expect(layer.isHidden(12)).toBe(true);

      style.setState({ ...emptyStyle, layers: [{ id: 'background', type: 'background' }] });
      style.update(new EvaluationParameters(12));
      expect(layer.isHidden(12)).toBe(false);
      expect(layer.isHidden(24)).toBe(true);
    }
    finally {
      style.destroy();
    }
  });
});
