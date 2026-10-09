import type { LightSpecification, TransitionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { vec3 } from 'gl-matrix';
import type { StyleSetterOptions } from '../style/style';
import type { LightProps, LightPropsPossiblyEvaluated } from './light-properties.g';

import type { PossiblyEvaluated, Transitioning, TransitionParameters } from './properties';
import { Evented } from '../util/evented';
import { sphericalToCartesian } from '../util/math';
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

  constructor(lightOptions: LightSpecification, globalState: Record<string, any>) {
    super();
    this._transitionable = new Transitionable(getProperties(), 'light', globalState);
    this.setLight(lightOptions);
    this._transitioning = this._transitionable.untransitioned();
    this.properties = this._transitioning.possiblyEvaluate(new EvaluationParameters(0));
  }

  getLight(): LightSpecification {
    return this._transitionable.serialize();
  }

  /**
   * Gets the light position in cartesian coordinates.
   */
  getCartesianPosition(): vec3 {
    return sphericalToCartesian(this.properties.get('position'));
  }

  setLight(light: LightSpecification, options: StyleSetterOptions = {}): void {
    if (validateAndEmit(this, validateStyle.light, { value: light }, options)) {
      return;
    }

    for (const [name, value] of Object.entries(light)) {
      if (name.endsWith(TRANSITION_SUFFIX)) {
        const propertyName = name.slice(0, -TRANSITION_SUFFIX.length);
        if (isLightProperty(propertyName) && isTransitionSpecification(value)) {
          this._transitionable.setTransition(propertyName, value);
        }
      }
      else if (isLightProperty(name)) {
        this._transitionable.setValue(name, value);
      }
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

function isLightProperty(name: string): name is keyof LightProps {
  return Object.hasOwn(getProperties().properties, name);
}

function isTransitionSpecification(value: unknown): value is TransitionSpecification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).every(key => key === 'delay' || key === 'duration');
}
