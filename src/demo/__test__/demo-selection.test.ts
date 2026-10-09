import { describe, expect, it } from 'vitest';
import { createDemoSelection, demoDefaults, demoMapConfig, demoSearchParameters, readDemoSelection } from '../demo-selection';
import { demoPresets, stylePresets } from '../preset-catalog';

describe('demo selection', () => {
  it('opens a preset with its own source and permits an explicit source override', () => {
    const selection = readDemoSelection(new URLSearchParams('preset=manhattan'));
    expect(selection).toMatchObject({ preset: 'manhattan', source: 'buildings' });
    expect(demoMapConfig(selection).url).toContain('/styles/buildings.json');
    const override = readDemoSelection(new URLSearchParams('preset=manhattan&source=bright'));
    expect(demoMapConfig(override).url).toBe('https://tiles.openfreemap.org/styles/bright');
  });

  it('normalizes unknown selections and non-positive or non-finite resolution ratios', () => {
    for (const ratio of ['0', '-1', 'Infinity', 'NaN']) {
      expect(readDemoSelection(new URLSearchParams(`preset=missing&source=missing&mode=missing&resolutionRatio=${ratio}`))).toEqual(demoDefaults);
    }
    expect(readDemoSelection(new URLSearchParams('preset=manhattan&source=missing'))).toMatchObject({ source: 'buildings' });
  });

  it('accepts absolute HTTP style URLs and rejects unsupported schemes and relative paths', () => {
    for (const style of ['javascript:alert(1)', 'file:///style.json', '/style.json', 'not a URL']) {
      const selection = readDemoSelection(new URLSearchParams({ preset: 'manhattan', style }));
      expect(selection.style).toBe('');
      expect(demoMapConfig(selection).credit).not.toBe('');
    }
    const selection = readDemoSelection(new URLSearchParams({ style: 'https://example.com/style.json?version=2' }));
    expect(demoMapConfig(selection)).toMatchObject({ url: selection.style, credit: '' });
  });

  it('round-trips every unified preset and explicit custom settings without legacy camera parameters', () => {
    for (const preset of demoPresets) {
      const selection = createDemoSelection(preset.id);
      expect(readDemoSelection(demoSearchParameters(selection))).toEqual(selection);
    }
    const selection = readDemoSelection(new URLSearchParams('preset=dateline&source=bright&mode=cv&resolutionRatio=2&style=https://example.com/style.json'));
    const parameters = demoSearchParameters(selection);
    expect(readDemoSelection(parameters)).toEqual(selection);
    expect([...parameters.keys()].sort()).toEqual(['mode', 'preset', 'resolutionRatio', 'source', 'style']);
    expect(readDemoSelection(new URLSearchParams('view=london&scenario=manhattan&angle=oblique&height=15&scale=512'))).toEqual(demoDefaults);
  });

  it('keeps each preset uniquely addressable with a valid default source', () => {
    expect(new Set(demoPresets.map(preset => preset.id)).size).toBe(demoPresets.length);
    const sources = new Set<string>(stylePresets.map(source => source.id));
    expect(demoPresets.every(preset => sources.has(preset.styleId))).toBe(true);
  });
});
