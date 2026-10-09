import type { RenderTransitionFlags } from '../../style/render-transition';
import type { Style } from '../../style/style';
import type { ExtrusionLighting } from '../vector/extrusion-geometry';
import type { RenderLayerIndex } from './render-layer-index';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { samePaintZoom } from '../../style/render-transition';

let nextEvaluationId = 0;

export interface VisibilityChange {
  flipped: Set<string>;
  newlyVisible: Set<string>;
}

export interface EvaluatedStyle {
  evaluationId: number;
  transitions: RenderTransitionFlags;
  visibility?: VisibilityChange;
  lighting?: ExtrusionLighting;
  lightRevision: number;
  retiredPaintChanged: boolean;
}

function diffVisibility(previous: ReadonlyMap<string, boolean>, current: ReadonlyMap<string, boolean>): VisibilityChange {
  const flipped = new Set<string>();
  const newlyVisible = new Set<string>();
  for (const [layerId, before] of previous) {
    if (current.get(layerId) !== before) {
      flipped.add(layerId);
    }
  }
  for (const [layerId, after] of current) {
    const before = previous.get(layerId);
    if (before !== after) {
      flipped.add(layerId);
      if (after) {
        newlyVisible.add(layerId);
      }
    }
  }
  return { flipped, newlyVisible };
}

/** Owns the style values and invalidation revisions consumed by one scene frame. */
export class StyleEvaluation {
  private _style: Style;

  private _layers: RenderLayerIndex;

  private _zoom = 0;

  private _previousZoom = 0;

  private _visibility: ReadonlyMap<string, boolean> = new Map();

  private _lighting?: ExtrusionLighting;

  private _lightRevision = 0;

  private _retiredStyleRevision = -1;

  private _evaluationId = 0;

  constructor(style: Style, layers: RenderLayerIndex) {
    this._style = style;
    this._layers = layers;
    this.acceptVisibility();
  }

  get zoom(): number {
    return this._zoom;
  }

  get evaluationId(): number {
    return this._evaluationId;
  }

  /** Style replacement already rebuilds the render tracks. */
  acceptVisibility(): void {
    this._visibility = this._layers.visibility();
  }

  evaluate(coveringZoom: number | undefined): EvaluatedStyle {
    this._evaluationId = ++nextEvaluationId;
    const style = this._style;
    this._zoom = coveringZoom ?? this._zoom;
    const time = Date.now();
    if (coveringZoom !== undefined) {
      style.zoomHistory.update(coveringZoom, time);
    }
    const zoomChanged = coveringZoom !== undefined && !samePaintZoom(coveringZoom, this._previousZoom);
    if (coveringZoom !== undefined) {
      this._previousZoom = coveringZoom;
    }
    const transitions = style.update(new EvaluationParameters(this._zoom, {
      now: time,
      zoomHistory: style.zoomHistory,
      fadeDuration: zoomChanged ? 0 : style.fadeDuration,
    })) ?? style.getRenderTransitionFlags();

    const currentVisibility = this._layers.visibility();
    const visibility = currentVisibility === this._visibility ? undefined : diffVisibility(this._visibility, currentVisibility);
    this._visibility = currentVisibility;

    const light = style.light;
    if (light) {
      const position = light.getCartesianPosition();
      const color = light.properties.get('color');
      const intensity = light.properties.get('intensity');
      const previous = this._lighting;
      if (!previous || previous.position[0] !== position[0] || previous.position[1] !== position[1] || previous.position[2] !== position[2]
        || previous.color.red !== color.r || previous.color.green !== color.g || previous.color.blue !== color.b || previous.intensity !== intensity) {
        this._lighting = {
          position: [position[0], position[1], position[2]],
          color: { red: color.r, green: color.g, blue: color.b },
          intensity,
        };
        this._lightRevision++;
      }
    }
    else if (this._lighting) {
      this._lighting = undefined;
      this._lightRevision++;
    }
    const retiredPaintChanged = this._retiredStyleRevision !== style.styleRevision;
    this._retiredStyleRevision = style.styleRevision;
    return { evaluationId: this._evaluationId, transitions, visibility, lighting: this._lighting, lightRevision: this._lightRevision, retiredPaintChanged };
  }
}
