import type { SceneMode } from 'cesium';
import type { Style } from '../../style/style';
import type { StyleLayer } from '../../style/style-layer';
import type { BackgroundPaint } from './background-ground';
import type { RenderFrameState } from './render-frame';
import { Color } from 'cesium';
import { constantValue } from '../vector/feature-attributes';
import { BackgroundGround } from './background-ground';
import { registerDrawBatch } from './draw-batch';

function imageName(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const name = (value as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

function backgroundPaint(layer: StyleLayer, style: Style): BackgroundPaint | undefined {
  const opacity = constantValue(layer, 'background-opacity') as number;
  if (opacity <= 0) {
    return undefined;
  }
  const pattern = constantValue(layer, 'background-pattern') as { from: unknown; to: unknown } | undefined;
  if (pattern) {
    const fromName = imageName(pattern.from);
    const toName = imageName(pattern.to);
    const from = fromName && style.getImage(fromName);
    const to = toName && style.getImage(toName);
    // A specified but missing sprite suppresses the layer, as in MapLibre.
    if (!from || !to || !from.data || !to.data) {
      return undefined;
    }
    const crossfade = layer.getCrossfadeParameters();
    return {
      color: Color.TRANSPARENT,
      opacity,
      pattern: { from, to, fade: crossfade.t, fromScale: crossfade.fromScale, toScale: crossfade.toScale },
    };
  }
  const value = constantValue(layer, 'background-color') as { r: number; g: number; b: number; a: number };
  if (value.a <= 0) {
    return undefined;
  }
  return { color: new Color(value.r * opacity, value.g * opacity, value.b * opacity, value.a * opacity), opacity };
}

/** Owns every style background and submits them into the common paint order. */
export class BackgroundRenderer {
  private _layers: StyleLayer[] = [];
  private _revision = -1;
  private _draws = new Map<string, BackgroundGround>();
  private readonly _createGround: () => BackgroundGround;

  constructor(createGround: () => BackgroundGround = () => new BackgroundGround()) {
    this._createGround = createGround;
  }

  reset(): void {
    this.destroy();
  }

  destroy(): void {
    for (const draw of this._draws.values()) {
      draw.destroy();
    }
    this._draws.clear();
    this._layers = [];
    this._revision = -1;
  }

  update(style: Style, frameState: RenderFrameState, mode: SceneMode, requestRender: () => void): void {
    if (this._revision !== style.styleRevision) {
      this._layers = style._getLayerOrder()
        .map(id => style.getLayer(id))
        .filter((layer): layer is StyleLayer => layer?.type === 'background');
      const ids = new Set(this._layers.map(layer => layer.id));
      for (const [id, draw] of this._draws) {
        if (!ids.has(id)) {
          draw.destroy();
          this._draws.delete(id);
        }
      }
      this._revision = style.styleRevision;
    }
    for (const layer of this._layers) {
      if (layer.isHidden(style.z)) {
        continue;
      }
      const paint = backgroundPaint(layer, style);
      if (!paint) {
        continue;
      }
      let draw = this._draws.get(layer.id);
      if (!draw) {
        draw = this._createGround();
        registerDrawBatch(draw, { layerId: layer.id, kind: 'background' });
        this._draws.set(layer.id, draw);
      }
      draw.update(frameState, mode, style.z, paint);
      if (paint.pattern && paint.pattern.fade > 0 && paint.pattern.fade < 1) {
        requestRender();
      }
    }
  }
}
