import type { LightSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSetterOptions } from '../style/style';
import type { LightProps, LightPropsPossiblyEvaluated } from './light-properties.g';

import type { PossiblyEvaluated, Transitioning, TransitionParameters } from './properties';
import { Cartesian3, Math as CesiumMath, Spherical } from 'cesium';
import { Evented } from '../util/evented';
import { EvaluationParameters } from './evaluation-parameters';
import { getProperties } from './light-properties.g';

import { TRANSITION_SUFFIX, Transitionable } from './properties';
import { validateAndEmit, validateStyle } from './validate-style';

/*
 * Represents the light used to light extruded features.
 */
export class Light extends Evented {
  _transitionable: Transitionable<LightProps>;
  _transitioning: Transitioning<LightProps>;
  properties: PossiblyEvaluated<LightProps, LightPropsPossiblyEvaluated>;

  constructor(lightOptions: LightSpecification, globalState: Record<string, any>, options: StyleSetterOptions = {}) {
    super();
    this._transitionable = new Transitionable(getProperties(), 'light', globalState);
    this.setLight(lightOptions, options);
    this._transitioning = this._transitionable.untransitioned();
    this.properties = this._transitioning.possiblyEvaluate(new EvaluationParameters(0));
  }

  getLight(): LightSpecification {
    return this._transitionable.serialize();
  }

  /**
   * Gets the light position in cartesian coordinates.
   */
  getCartesianPosition(): Cartesian3 {
    const [magnitude, azimuthal, polar] = this.properties.get('position');
    return Cartesian3.fromSpherical(new Spherical(CesiumMath.toRadians(azimuthal + 90), CesiumMath.toRadians(polar), magnitude));
  }

  setLight(light: LightSpecification, options: StyleSetterOptions = {}): void {
    if (validateAndEmit(this, validateStyle.light, { value: light }, options)) {
      return;
    }

    for (const name of Object.keys(getProperties().properties) as (keyof LightProps)[]) {
      this._transitionable.setValue(name, light[name]);
      const transitionName = `${name}${TRANSITION_SUFFIX}` as keyof LightSpecification;
      this._transitionable.setTransition(name, light[transitionName] as LightSpecification['color-transition']);
    }
  }

  updateTransitions(parameters: TransitionParameters): void {
    this._transitioning = this._transitionable.transitioned(parameters, this._transitioning);
  }

  hasTransition(): boolean {
    return this._transitioning.hasTransition();
  }

  recalculate(parameters: EvaluationParameters): void {
    this.properties = this._transitioning.possiblyEvaluate(parameters);
  }
}
