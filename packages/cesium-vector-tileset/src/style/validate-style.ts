import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { TilesetStyleSpecification as StyleSpecification } from '../tileset-options';
import type { Evented } from '../util/evented';
import type { StyleSetterOptions } from './style';

import { derefLayers, latest as styleSpec, validate, validateStyleMin, ValidationError } from '@maplibre/maplibre-gl-style-spec';
import { warnOnce } from '../util/errors';
import { ErrorEvent } from '../util/evented';

/**
 * Validates a single part of a style, e.g. a source, a filter or a paint property.
 * The options it takes are the ones assembled by {@link validateAndEmit}.
 */
export interface ValidatorOptions {
  value: unknown;
  styleSpec: typeof styleSpec;
  key?: string;
  style?: StyleSpecification;
  arrayIndex?: number;
  layerType?: LayerSpecification['type'];
  objectKey?: string;
}

export type Validator = (options: ValidatorOptions) => readonly ValidationError[];

interface ValidateStyle {
  source: Validator;
  sprite: Validator;
  glyphs: Validator;
  layer: Validator;
  light: Validator;
  sky: Validator;
  terrain: Validator;
  filter: Validator;
  paintProperty: Validator;
  layoutProperty: Validator;
  (style: StyleSpecification): readonly ValidationError[];
}

export const validateStyle = validateStyleMin as ValidateStyle;

const canvasStyleSpec = {
  ...styleSpec,
  source_canvas: {
    type: { type: 'enum', values: ['canvas'], required: true },
    coordinates: styleSpec.source_image.coordinates,
    canvas: { type: '*', required: true },
    animate: { type: 'boolean' },
  },
};

/** Validate the adapter's Canvas fields with the same object/array rules as native sources. */
export function validateCanvasSource(options: ValidatorOptions): readonly ValidationError[] {
  const key = options.key ?? '';
  const errors = validate({
    ...options,
    key,
    valueSpec: { type: 'source_canvas' },
    styleSpec: canvasStyleSpec,
    style: options.style,
  });
  if (typeof options.value !== 'object' || options.value === null)
    return errors;
  const canvas = (options.value as Record<string, unknown>).canvas;
  if (canvas !== undefined && typeof canvas !== 'string'
    && !(typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement)) {
    errors.push(new ValidationError(key ? `${key}.canvas` : 'canvas', canvas, 'string or HTMLCanvasElement expected'));
  }
  return errors;
}

export const SPEC_SOURCE_TYPES: ReadonlySet<string> = new Set(
  Object.keys(styleSpec)
    .filter(key => key.startsWith('source_'))
    .map(key => key.slice('source_'.length).replaceAll('_', '-')),
);

/**
 * Validates the native style schema and the adapter's declarative Canvas sources.
 *
 * @param emitter - the object to fire {@link ErrorEvent}s on
 * @param style - the style to validate
 * @returns whether validation failed, i.e. whether the caller should give up on the style
 */
export function validateStyleAndEmit(emitter: Evented, style: StyleSpecification): boolean {
  const errors = validateStyle(style).filter(error => error.identifier !== 'source.canvas');
  for (const [id, source] of Object.entries(style.sources ?? {})) {
    if (source.type === 'canvas') {
      errors.push(...validateCanvasSource({ value: source, key: `sources.${id}`, style, styleSpec }));
    }
  }
  if (!errors.some(error => error.severity !== 'warning')) {
    for (const [index, layer] of derefLayers(style.layers).entries()) {
      if (layer.type === 'line' && layer.paint?.['line-gradient'] !== undefined) {
        errors.push(new ValidationError(`layers[${index}].paint.line-gradient`, layer.paint['line-gradient'], 'line-gradient is not supported by the Cesium Primitive renderer.'));
      }
    }
  }
  return emitValidationErrors(emitter, errors);
}

/**
 * Emits everything a validator found, and reports whether any of it was severe enough to abort.
 *
 * Warnings are logged rather than emitted as errors: the style still renders, just not necessarily
 * as its author intended (e.g. a filter mixing deprecated syntax into an expression tree). Treating
 * them as errors would abort the whole style load and leave a blank map.
 * See https://github.com/maplibre/maplibre-style-spec/issues/1751
 *
 * @param emitter - the object to fire {@link ErrorEvent}s on
 * @param errors - what validation turned up, if anything
 * @returns whether validation failed, i.e. whether the caller should give up on the value
 */
export function emitValidationErrors(emitter: Evented, errors: readonly ValidationError[]): boolean {
  let hasErrors = false;
  for (const error of errors) {
    if (error.severity === 'warning') {
      warnOnce(error.message);
      continue;
    }
    emitter.fire(new ErrorEvent(new Error(error.message)));
    hasErrors = true;
  }
  return hasErrors;
}

/**
 * Runs a validator over a value and emits whatever it finds.
 *
 * @param emitter - the object to fire {@link ErrorEvent}s on
 * @param validator - the validator to run, e.g. {@link validateFilter}
 * @param params - what to validate: the `value`, plus whatever context the validator needs, such as
 * the `key` locating it in the style, or the surrounding `style` that {@link validateStyle.layer} looks at
 * @param options - setter options; validation is skipped entirely when `validate` is `false`
 * @returns whether validation failed, i.e. whether the caller should give up on the value
 */
export function validateAndEmit(
  emitter: Evented,
  validator: Validator,
  params: Omit<ValidatorOptions, 'styleSpec'>,
  options?: StyleSetterOptions,
): boolean {
  if (options?.validate === false) {
    return false;
  }
  return emitValidationErrors(emitter, validator({
    styleSpec,
    ...params,
  }));
}
