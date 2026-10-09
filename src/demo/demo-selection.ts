import type { DemoMode, DemoPresetId, StyleId } from './preset-catalog';
import { demoPresets, modeOptions, stylePresets } from './preset-catalog';

export interface DemoSelection {
  preset: DemoPresetId;
  source: StyleId;
  style: string;
  mode: DemoMode;
  resolutionRatio: number;
}

export const demoDefaults: DemoSelection = {
  preset: demoPresets[0].id,
  source: demoPresets[0].styleId,
  style: '',
  mode: modeOptions[0].id,
  resolutionRatio: 1,
};

export function createDemoSelection(id: DemoPresetId = demoDefaults.preset): DemoSelection {
  const preset = demoPresets.find(preset => preset.id === id)!;
  return { ...demoDefaults, preset: id, source: preset.styleId };
}

export function readDemoSelection(parameters: URLSearchParams): DemoSelection {
  const preset = demoPresets.find(preset => preset.id === parameters.get('preset')) ?? demoPresets[0];
  const selection = createDemoSelection(preset.id);
  const source = stylePresets.find(style => style.id === parameters.get('source'));
  const mode = modeOptions.find(mode => mode.id === parameters.get('mode'));
  let style = '';
  try {
    const url = new URL(parameters.get('style') ?? '');
    if (url.protocol === 'https:' || url.protocol === 'http:')
      style = url.href;
  }
  catch {
    // An absent or invalid custom style leaves the selected source in use.
  }
  const resolutionRatio = Number(parameters.get('resolutionRatio'));
  return {
    ...selection,
    source: source?.id ?? selection.source,
    mode: mode?.id ?? selection.mode,
    style,
    resolutionRatio: Number.isFinite(resolutionRatio) && resolutionRatio > 0 ? resolutionRatio : selection.resolutionRatio,
  };
}

export function demoMapConfig(selection: Pick<DemoSelection, 'source' | 'style'>) {
  const source = stylePresets.find(source => source.id === selection.source)!;
  return { url: selection.style || source.url, credit: selection.style ? '' : source.credit };
}

export function demoSearchParameters(selection: DemoSelection): URLSearchParams {
  const parameters = new URLSearchParams({ preset: selection.preset, source: selection.source, mode: selection.mode });
  if (selection.style)
    parameters.set('style', selection.style);
  if (selection.resolutionRatio !== demoDefaults.resolutionRatio)
    parameters.set('resolutionRatio', String(selection.resolutionRatio));
  return parameters;
}
