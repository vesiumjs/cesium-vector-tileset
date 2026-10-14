import { CircleBucket } from '../../data/bucket-runtime';
import { ProgramConfigurationSet } from '../../data/program-configuration';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { CircleStyleLayer } from '../../style/style-layer/circle-style-layer';
import { layerFor } from '../vector/feature-attributes';

const properties = ['circle-color', 'circle-opacity', 'circle-radius', 'circle-stroke-color', 'circle-stroke-opacity', 'circle-stroke-width', 'circle-blur', 'circle-pitch-alignment', 'circle-pitch-scale', 'circle-translate', 'circle-translate-anchor'] as const;
type PaintNode = CircleStyleLayer['_transitioningPaint']['_values'][typeof properties[number]];

/** Capture actual worker paint and the old expression tree before style mutation. */
export function freezeCircleCameraPaint(bucket: CircleBucket, layerId: string) {
  const layer = layerFor(bucket, layerId);
  const transitioning = layer._transitioningPaint;
  let camera = false;
  let featureCamera = false;
  for (const property of properties) {
    let current: PaintNode | undefined = transitioning._values[property];
    while (current) {
      const kind = current.value.expression.kind;
      if (kind === 'camera') {
        camera = true;
        if (property === 'circle-color' || property === 'circle-opacity' || property === 'circle-stroke-color' || property === 'circle-stroke-opacity')
          featureCamera = true;
      }
      current = current.prior;
    }
  }
  const original = bucket.programConfigurations.get(layerId);
  const composite = original.hasCompositeProperties();
  if (!camera && !composite)
    return;
  const now = layer.paint.get('circle-radius').parameters.now;
  const heldLayer = new CircleStyleLayer({ id: layerId, type: 'circle', source: layer.source! }, {});
  heldLayer._transitioningPaint = transitioning.snapshot(properties);
  const evaluate = (zoom: number) => heldLayer.recalculate(new EvaluationParameters(zoom, { now }), []);
  evaluate(layer.paint.get('circle-radius').parameters.zoom);
  const configurations = new ProgramConfigurationSet([heldLayer], bucket.zoom);
  configurations._featureRanges = bucket.programConfigurations.getFeatureRanges().map(range => ({ ...range }));
  configurations._featureRangeByIndex = undefined;
  const held = configurations.get(layerId);
  for (const [property, binder] of Object.entries(held.binders)) {
    const source = original.getAttributeArray(property);
    if (!source)
      throw new Error(`Missing committed circle paint ${layerId}.${property}`);
    const target = binder.paintVertexArray;
    target.resize(source.length);
    target.uint8.set(new Uint8Array(source.arrayBuffer, 0, source.length * source.bytesPerElement));
  }
  const heldBucket = new CircleBucket();
  heldBucket.zoom = bucket.zoom;
  heldBucket.layers = [heldLayer];
  heldBucket.programConfigurations = configurations;
  return { bucket: heldBucket, evaluate, featureCamera: featureCamera || composite };
}
