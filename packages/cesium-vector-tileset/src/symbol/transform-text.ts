import type { Feature, Formatted } from '@maplibre/maplibre-gl-style-spec';

import type { SymbolStyleLayer } from '../style/style-layer/symbol-style-layer';
import { rtlWorkerPlugin } from '../source/rtl-text-plugin-worker';

function transformTextInternal(text: string, layer: SymbolStyleLayer, feature: Feature) {
  const transform = layer.layout.get('text-transform').evaluate(feature, {});
  if (transform === 'uppercase') {
    text = text.toLocaleUpperCase();
  }
  else if (transform === 'lowercase') {
    text = text.toLocaleLowerCase();
  }

  if (rtlWorkerPlugin.applyArabicShaping) {
    text = rtlWorkerPlugin.applyArabicShaping(text);
  }

  return text;
}

export function transformText(text: Formatted, layer: SymbolStyleLayer, feature: Feature): Formatted {
  for (const section of text.sections) {
    section.text = transformTextInternal(section.text, layer, feature);
  }
  return text;
}
