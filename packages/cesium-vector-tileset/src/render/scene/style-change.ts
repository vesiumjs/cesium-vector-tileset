import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Style, StyleStateChange } from '../../style/style';
import { SceneMode } from 'cesium';

/**
 * Classifies paint changes after Style has checked worker attribute requirements.
 * @internal
 */
export function classifyStyleChange({ previous: previousStyle, changes }: StyleStateChange, style: Style, mode: SceneMode) {
  const paintOnly = changes.every((change) => {
    if (change.command === 'setLight' || change.command === 'setTransition' || change.command === 'setProjection') {
      return true;
    }
    if (change.command !== 'setPaintProperty') {
      return false;
    }
    const layerId = change.args[0] as string;
    const layer = style.getLayer(layerId);
    // Globe map circles tessellate their curved ground quad. Switching the
    // alignment changes topology and must use the normal budgeted handoff.
    if (mode === SceneMode.SCENE3D && layer?.type === 'circle' && change.args[1] === 'circle-pitch-alignment')
      return false;
    // MapLibre marks paint changes that need new worker attributes as
    // layer updates. Their old buckets must keep their committed paint.
    if (!layer || style._updatedLayers[layerId]) {
      return false;
    }
    if (layer.type === 'symbol') {
      const property = change.args[1] as string;
      return /^(?:text|icon)-translate(?:-anchor|-transition)?$/.test(property);
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
