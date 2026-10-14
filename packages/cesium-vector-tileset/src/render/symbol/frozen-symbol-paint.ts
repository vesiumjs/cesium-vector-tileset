import type { SymbolStyleLayer } from '../../style/style-layer/symbol-style-layer';
import { EvaluationParameters } from '../../style/evaluation-parameters';

export type FrozenSymbolCameraPaint = (zoom: number) => SymbolStyleLayer['paint'];

/** Keep the committed transition weights and globals, but evaluate camera curves at the new zoom. */
export function freezeSymbolCameraPaint(layer: SymbolStyleLayer, part: 'text' | 'icon'): FrozenSymbolCameraPaint | undefined {
  const properties = [`${part}-color`, `${part}-opacity`, `${part}-halo-color`, `${part}-halo-width`, `${part}-halo-blur`, `${part}-translate`, `${part}-translate-anchor`] as const;
  const transitioning = layer._transitioningPaint;
  const camera = properties.some((property) => {
    let value: typeof transitioning._values[typeof property] | undefined = transitioning._values[property];
    while (value) {
      if (value.value.expression.kind === 'camera')
        return true;
      value = value.prior;
    }
    return false;
  });
  // Source/composite endpoints remain owned by the worker binder. Constant
  // uniforms need no expression snapshot or evaluation during camera motion.
  if (!camera)
    return;
  const now = layer.paint.get(`${part}-color`).parameters.now;
  const committed = transitioning.snapshot(properties);
  return zoom => committed.possiblyEvaluate(new EvaluationParameters(zoom, { now }));
}
