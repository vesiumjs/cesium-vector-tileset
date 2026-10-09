import type { FillExtrusionLayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import Point from '@mapbox/point-geometry';
import { describe, expect, it } from 'vitest';
import { FillExtrusionBucket } from '../../../data/bucket/fill-extrusion-bucket';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { FillExtrusionStyleLayer } from '../../../style/style-layer/fill-extrusion-style-layer';
import { OverscaledTileID } from '../../../tile/tile-id';
import { extrusionStyleForFeature } from '../feature-attributes';

function extrusionPaint(binding: 'constant' | 'source' | 'composite', alpha: number, opacity = 0.8) {
  const color = `rgba(255, 0, 0, ${alpha})`;
  const nextColor = `rgba(0, 0, 255, ${alpha / 2})`;
  const layer = new FillExtrusionStyleLayer({
    id: 'buildings',
    type: 'fill-extrusion',
    source: 'city',
    paint: {
      'fill-extrusion-color': binding === 'constant' ? color : binding === 'source' ? ['get', 'color'] : ['interpolate', ['linear'], ['zoom'], 8, ['get', 'color'], 9, ['get', 'nextColor']],
      'fill-extrusion-opacity': opacity,
      'fill-extrusion-height': 120,
    },
  } satisfies FillExtrusionLayerSpecification, {});
  layer.recalculate(new EvaluationParameters(8.5), []);
  const bucket = new FillExtrusionBucket({ layers: [layer], zoom: 8 } as never);
  const tile = new OverscaledTileID(8, 0, 8, 128, 128);
  bucket.addFeature({ id: 1, type: 3, properties: { color, nextColor } } as never, [[new Point(100, 100), new Point(200, 100), new Point(200, 200), new Point(100, 200), new Point(100, 100)]], 0, tile.canonical, {});
  return extrusionStyleForFeature(bucket, 0, layer.id, 8.5);
}

describe('extrusion color alpha semantics', () => {
  it.each(['constant', 'source', 'composite'] as const)('preserves raw premultiplied %s RGB and uses only layer opacity', (binding) => {
    const { color } = extrusionPaint(binding, 0.5);
    const red = binding === 'constant' ? 0.5 : binding === 'source' ? 127 / 255 : 127 / 255 / 2;
    const blue = binding === 'composite' ? 63 / 255 / 2 : 0;
    expect(color.red).toBeCloseTo(red, 12);
    expect(color.green).toBe(0);
    expect(color.blue).toBeCloseTo(blue, 12);
    expect(color.alpha).toBe(0.8);
  });

  it.each(['constant', 'source', 'composite'] as const)('retains layer opacity for zero-alpha %s colors', (binding) => {
    const { color } = extrusionPaint(binding, 0);
    expect([color.red, color.green, color.blue, color.alpha]).toEqual([0, 0, 0, 0.8]);
  });

  it.each(['constant', 'source', 'composite'] as const)('uses zero layer opacity to hide %s colors', (binding) => {
    expect(extrusionPaint(binding, 0.5, 0).color.alpha).toBe(0);
  });

  it('retains the opaque-color positive control', () => {
    const { color } = extrusionPaint('constant', 1);
    expect([color.red, color.green, color.blue, color.alpha]).toEqual([1, 0, 0, 0.8]);
  });
});
