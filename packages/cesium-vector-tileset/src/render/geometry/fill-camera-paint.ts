import type { FillStyleLayer } from '../../style/style-layer/fill-style-layer';
import { Cartesian2 } from 'cesium';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { FillStyleLayer as HeldFillStyleLayer } from '../../style/style-layer/fill-style-layer';
import { mercatorTranslation } from './mercator-translation';

export interface FillCameraPaintOwner {
  updateCameraPaint: (layer: FillStyleLayer, zoom: number, bearing?: number) => void;
  captureCameraPaint: (layer: FillStyleLayer) => (zoom: number, bearing?: number) => void;
}

/** Publication collections own this index until their geometry is destroyed. */
export const fillCameraPaintOwners = new WeakMap<object, Array<{ layerId: string; paint: FillCameraPaintOwner }>>();

/** Shared camera paint for shader fills, Native polygons and fill outlines. */
export class FillCameraPaint {
  readonly translation = new Cartesian2();
  private readonly _pixels = new Cartesian2();

  update(layer: FillStyleLayer, zoom: number, bearing?: number): boolean {
    const pixels = layer.paint.get('fill-translate');
    this._pixels.x = pixels[0];
    this._pixels.y = pixels[1];
    const { x, y } = this.translation;
    mercatorTranslation(this._pixels, layer.paint.get('fill-translate-anchor') === 'viewport', zoom, bearing, this.translation);
    return x !== this.translation.x || y !== this.translation.y;
  }

  capture(layer: FillStyleLayer, apply?: () => void): (zoom: number, bearing?: number) => void {
    const held = new HeldFillStyleLayer({ id: layer.id, type: 'fill', source: layer.source! }, {});
    held._transitioningPaint = layer._transitioningPaint.snapshot(['fill-translate', 'fill-translate-anchor']);
    const now = layer.paint.get('fill-color').parameters.now;
    let evaluatedZoom: number | undefined;
    return (zoom, bearing) => {
      if (evaluatedZoom !== zoom) {
        held.recalculate(new EvaluationParameters(zoom, { now }), []);
        evaluatedZoom = zoom;
      }
      if (this.update(held, zoom, bearing))
        apply?.();
    };
  }
}
