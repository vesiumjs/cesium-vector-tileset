import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Style } from '../../style/style';
import { diff as diffStyles } from '@maplibre/maplibre-gl-style-spec';

/**
 * Classifies paint changes after Style has checked worker attribute requirements.
 * @internal
 */
export function classifyStyleChange(previousStyle: StyleSpecification, nextStyle: StyleSpecification, style: Style) {
  const changes = diffStyles(previousStyle, nextStyle);
  const paintOnly = changes.every((change) => {
    if (change.command === 'setLight' || change.command === 'setTransition' || change.command === 'setProjection') {
      return true;
    }
    if (change.command !== 'setPaintProperty') {
      return false;
    }
    const layerId = change.args[0] as string;
    const layer = style.getLayer(layerId);
    // MapLibre marks paint changes that need new worker attributes as
    // layer updates. Their old buckets must keep their committed paint.
    if (!layer || layer.type === 'symbol' || style._updatedLayers[layerId]) {
      return false;
    }
    const previous = previousStyle.layers.find(layer => layer.id === layerId)!;
    const track = (spec: StyleSpecification['layers'][number]): string => {
      const paint = spec.paint as Record<string, unknown> | undefined;
      if (paint?.[`${spec.type}-pattern`] != null) {
        return 'pattern';
      }
      return spec.type === 'line' && paint?.['line-dasharray'] != null ? 'dash' : spec.type;
    };
    return track(previous) === track(layer.serialize());
  });
  return { changes, paintOnly };
}
