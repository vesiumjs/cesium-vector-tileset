import type {
  AllLayoutProperties,
  AllPaintProperties,
  FeatureFilter,
  FilterSpecification,
  LayerSpecification,
  VisibilityExpression,
  VisibilitySpecification,
} from '@maplibre/maplibre-gl-style-spec';

import type { CrossfadeParameters, EvaluationParameters } from './evaluation-parameters';
import type { PropertyValue, Transitioning, TransitionParameters } from './properties';

import type { StyleSetterOptions } from './style';
import type { Validator } from './validate-style';
import { createVisibilityExpression, featureFilter, supportsPropertyExpression } from '@maplibre/maplibre-gl-style-spec';
import { ErrorEvent, Evented } from '../util/evented';
import { filterObject } from '../util/objects';
import { Layout, PossiblyEvaluated, PossiblyEvaluatedPropertyValue, Properties, TRANSITION_SUFFIX, Transitionable } from './properties';
import { validateAndEmit, validateStyle } from './validate-style';

export type PaintPropertyEntry = { [K in keyof AllPaintProperties]: { name: K; value: AllPaintProperties[K] } }[keyof AllPaintProperties];

const ERROR_PAINT_NOT_LAYOUT = ' is a PAINT property not a LAYOUT property. Use get/setPaintProperty instead?';
const ERROR_LAYOUT_NOT_PAINT = ' is a LAYOUT property not a PAINT property. Use get/setLayoutProperty instead?';

/**
 * A base class for style layers
 *
 * @typeParam TPaintProps - the paint properties of the layer type
 * @typeParam TLayoutProps - the layout properties of the layer type
 * @typeParam TPaintPropsPossiblyEvaluated - the evaluated paint property values of the layer type
 * @typeParam TLayoutPropsPossiblyEvaluated - the evaluated layout property values of the layer type
 */
export abstract class StyleLayer<
  TPaintProps extends Record<string, any> = Record<string, any>,
  TLayoutProps extends Record<string, any> = Record<string, any>,
  TPaintPropsPossiblyEvaluated extends Record<string, any> = TPaintProps,
  TLayoutPropsPossiblyEvaluated extends Record<string, any> = TLayoutProps,
> extends Evented {
  id: string;
  metadata: LayerSpecification['metadata'];
  type: LayerSpecification['type'];
  source?: string;
  sourceLayer?: string;
  minzoom: number;
  maxzoom: number;
  filter?: FilterSpecification;
  visibility: VisibilitySpecification;

  private _evaluatedVisibility: 'visible' | 'none';

  private _visibilitySet: boolean;

  _crossfadeParameters: CrossfadeParameters = { fromScale: 1, toScale: 1, t: 1 };

  _unevaluatedLayout?: Layout<TLayoutProps>;
  layout: PossiblyEvaluated<TLayoutProps, TLayoutPropsPossiblyEvaluated>;

  _transitionablePaint: Transitionable<TPaintProps>;
  _transitioningPaint: Transitioning<TPaintProps>;
  paint: PossiblyEvaluated<TPaintProps, TPaintPropsPossiblyEvaluated>;
  /** Changes to this layer's paint, including transition evaluations. */
  paintRevision = 0;

  _featureFilter: FeatureFilter;

  _visibilityExpression: VisibilityExpression;

  private _globalState: Record<string, any>; // reference to global state

  constructor(layer: LayerSpecification, properties: Readonly<{
    layout?: Properties<TLayoutProps>;
    paint?: Properties<TPaintProps>;
  }>, globalState: Record<string, any>) {
    super();

    this.id = layer.id;
    this.type = layer.type;
    this._globalState = globalState;
    this.visibility = layer.layout?.visibility ?? 'visible';
    this._visibilitySet = layer.layout?.visibility !== undefined;
    this._evaluatedVisibility = this.visibility === 'none' ? 'none' : 'visible';
    this._featureFilter = { filter: () => true, needGeometry: false, getGlobalStateRefs: () => new Set<string>() };
    this._visibilityExpression = createVisibilityExpression(this.visibility, `layers[${this.id}].layout.visibility`, globalState);

    this.metadata = layer.metadata;
    this.minzoom = layer.minzoom ?? 0;
    this.maxzoom = layer.maxzoom ?? 24;

    if (layer.type !== 'background') {
      this.source = layer.source;
      this.sourceLayer = layer['source-layer'];
      this.filter = layer.filter ?? undefined;
      this._featureFilter = featureFilter(layer.filter, `layers[${this.id}].filter`, globalState);
    }

    const layoutProperties = properties.layout ?? Properties.empty<TLayoutProps>();
    if (properties.layout) {
      this._unevaluatedLayout = new Layout(properties.layout, `layers[${this.id}].layout`, globalState);
    }
    this.layout = new PossiblyEvaluated<TLayoutProps, TLayoutPropsPossiblyEvaluated>(layoutProperties);

    const paintProperties = properties.paint ?? Properties.empty<TPaintProps>();
    this._transitionablePaint = new Transitionable(paintProperties, `layers[${this.id}].paint`, globalState);

    for (const property in layer.paint) {
      this.setPaintProperty(property as keyof AllPaintProperties, layer.paint[property as keyof typeof layer.paint], { validate: false });
    }
    for (const property in layer.layout) {
      this.setLayoutProperty(property as keyof AllLayoutProperties, layer.layout[property as keyof typeof layer.layout], { validate: false });
    }

    this._transitioningPaint = this._transitionablePaint.untransitioned();
    this.paint = new PossiblyEvaluated<TPaintProps, TPaintPropsPossiblyEvaluated>(paintProperties);
  }

  setFilter(filter?: FilterSpecification): void {
    this.filter = filter;
    this._featureFilter = featureFilter(filter, `layers[${this.id}].filter`, this._globalState);
  }

  getCrossfadeParameters(): CrossfadeParameters {
    return this._crossfadeParameters;
  }

  getLayoutProperty<K extends keyof AllLayoutProperties>(name: K): AllLayoutProperties[K] {
    if (name === 'visibility') {
      return this.visibility as AllLayoutProperties[K];
    }
    if (!this._unevaluatedLayout) {
      throw new Error(`Cannot get layout property "${name}" on layer type "${this.type}" which has no layout properties.`);
    }
    if (this._transitionablePaint.hasProperty(name)) {
      throw new Error(name + ERROR_PAINT_NOT_LAYOUT);
    }
    return this._unevaluatedLayout.getValue(name) as AllLayoutProperties[K];
  }

  /**
   * Get list of global state references that are used within layout or filter properties.
   * This is used to determine if layer source need to be reloaded when global state property changes.
   *
   */
  getLayoutAffectingGlobalStateRefs(): Set<string> {
    const globalStateRefs = new Set<string>();

    for (const globalStateRef of this._visibilityExpression.getGlobalStateRefs()) {
      globalStateRefs.add(globalStateRef);
    }

    if (this._unevaluatedLayout) {
      for (const propertyName in this._unevaluatedLayout._values) {
        const value = this._unevaluatedLayout._values[propertyName];

        for (const globalStateRef of value.getGlobalStateRefs()) {
          globalStateRefs.add(globalStateRef);
        }
      }
    }

    for (const globalStateRef of this._featureFilter.getGlobalStateRefs()) {
      globalStateRefs.add(globalStateRef);
    }

    return globalStateRefs;
  }

  /**
   * Get list of global state references that are used within paint properties.
   * This is used to determine if layer needs to be repainted when global state property changes.
   *
   */
  getPaintAffectingGlobalStateRefs(): globalThis.Map<string, PaintPropertyEntry[]> {
    const globalStateRefs = new globalThis.Map<string, PaintPropertyEntry[]>();

    if (this._transitionablePaint) {
      for (const propertyName in this._transitionablePaint._values) {
        const value = this._transitionablePaint._values[propertyName].value;

        for (const globalStateRef of value.getGlobalStateRefs()) {
          const properties = globalStateRefs.get(globalStateRef) ?? [];
          properties.push({ name: propertyName as keyof AllPaintProperties, value: value.value } as PaintPropertyEntry);
          globalStateRefs.set(globalStateRef, properties);
        }
      }
    }

    return globalStateRefs;
  }

  /**
   * Get list of global state references that are used within visibility expression.
   * This is used to determine if layer visibility needs to be updated when global state property changes.
   */
  getVisibilityAffectingGlobalStateRefs(): Set<string> {
    return this._visibilityExpression.getGlobalStateRefs();
  }

  setLayoutProperty<K extends keyof AllLayoutProperties>(name: K, value: AllLayoutProperties[K], options: StyleSetterOptions = {}): void {
    if (name === 'visibility') {
      this.visibility = value as VisibilitySpecification;
      this._visibilitySet = value !== undefined;
      this._visibilityExpression.setValue(value as VisibilitySpecification);
      this.recalculateVisibility();
      return;
    }

    if (this._transitionablePaint?.hasProperty(name)) {
      this.fire(new ErrorEvent(new Error(name + ERROR_PAINT_NOT_LAYOUT)));
      return;
    }

    if (value !== null && value !== undefined && this._validate(validateStyle.layoutProperty, `layers.${this.id}.layout.${name}`, name, value, options))
      return;

    if (!this._unevaluatedLayout) {
      throw new Error(`Cannot set layout property "${name}" on layer type "${this.type}" which has no layout properties.`);
    }
    this._unevaluatedLayout.setValue(name, value);
  }

  getPaintProperty<K extends keyof AllPaintProperties>(name: K): AllPaintProperties[K] {
    if (name.endsWith(TRANSITION_SUFFIX)) {
      const baseName = name.slice(0, -TRANSITION_SUFFIX.length);
      if (baseName === 'visibility' || this._unevaluatedLayout?.hasProperty(baseName)) {
        throw new Error(name + ERROR_LAYOUT_NOT_PAINT);
      }
      return this._transitionablePaint.getTransition(baseName) as AllPaintProperties[K];
    }
    else {
      if (name as any === 'visibility' || this._unevaluatedLayout?.hasProperty(name)) {
        throw new Error(name + ERROR_LAYOUT_NOT_PAINT);
      }
      return this._transitionablePaint.getValue(name) as AllPaintProperties[K];
    }
  }

  setPaintProperty<K extends keyof AllPaintProperties>(name: K, value: AllPaintProperties[K], options: StyleSetterOptions = {}): boolean {
    if (name as any === 'visibility' || this._unevaluatedLayout?.hasProperty(name)) {
      this.fire(new ErrorEvent(new Error(name + ERROR_LAYOUT_NOT_PAINT)));
      return false;
    }

    if (value !== null && value !== undefined && this._validate(validateStyle.paintProperty, `layers.${this.id}.paint.${name}`, name, value, options))
      return false;

    if (name.endsWith(TRANSITION_SUFFIX)) {
      this._transitionablePaint.setTransition(name.slice(0, -TRANSITION_SUFFIX.length), (value as any) || undefined);
      return false;
    }
    else {
      const transitionable = this._transitionablePaint._values[name];
      const isCrossFadedProperty = transitionable.property.specification['property-type'] === 'cross-faded-data-driven';
      const wasDataDriven = transitionable.value.isDataDriven();
      const oldValue = transitionable.value;

      // Transitionable.setValue uses a free-floating T that can't unify with the AllPaintProperties union -> better types downstream of this code needed
      this._transitionablePaint.setValue(name, value as any);
      this.paintRevision++;

      const newValue = this._transitionablePaint._values[name].value;
      const isDataDriven = newValue.isDataDriven();

      // if a cross-faded value is changed, we need to make sure the new icons get added to each tile's iconAtlas
      // so a call to _updateLayer is necessary, and we return true from this function so it gets called in
      // Style.setPaintProperty
      return isDataDriven || wasDataDriven || isCrossFadedProperty || this.handleOverridablePaintPropertyUpdate(name, oldValue, newValue);
    }
  }

  /**
   * @internal
   */
  handleOverridablePaintPropertyUpdate<T, R>(_name: string, _oldValue: PropertyValue<T, R>, _newValue: PropertyValue<T, R>): boolean {
    // No-op; can be overridden by derived classes.
    return false;
  }

  isHidden(zoom: number = this.minzoom, roundMinZoom: boolean = false): boolean {
    if (this.minzoom && zoom < (roundMinZoom ? Math.floor(this.minzoom) : this.minzoom))
      return true;
    if (this.maxzoom && zoom >= this.maxzoom)
      return true;
    return this._evaluatedVisibility === 'none';
  }

  updateTransitions(parameters: TransitionParameters): void {
    this._transitioningPaint = this._transitionablePaint.transitioned(parameters, this._transitioningPaint);
  }

  hasTransition(): boolean {
    return this._transitioningPaint.hasTransition();
  }

  recalculateVisibility(): void {
    this._evaluatedVisibility = this._visibilityExpression.evaluate();
  }

  recalculate(parameters: EvaluationParameters, availableImages: string[]): void {
    if (parameters.getCrossfadeParameters) {
      this._crossfadeParameters = parameters.getCrossfadeParameters();
    }

    if (this._unevaluatedLayout) {
      this.layout = this._unevaluatedLayout.possiblyEvaluate(parameters, undefined, availableImages);
    }

    // Evaluation completes expired transitions, so capture their final frame too.
    if (this.hasTransition())
      this.paintRevision++;
    this.paint = this._transitioningPaint.possiblyEvaluate(parameters, undefined, availableImages);
  }

  serialize(): LayerSpecification {
    const output = {
      'id': this.id,
      'type': this.type as LayerSpecification['type'],
      'source': this.source,
      'source-layer': this.sourceLayer,
      'metadata': this.metadata,
      'minzoom': this.minzoom === 0 ? undefined : this.minzoom,
      'maxzoom': this.maxzoom === 24 ? undefined : this.maxzoom,
      'filter': this.filter,
      'layout': this._unevaluatedLayout?.serialize(),
      'paint': this._transitionablePaint.serialize(),
    };

    if (this._visibilitySet && this.visibility !== undefined) {
      output.layout ||= {};
      output.layout.visibility = this.visibility;
    }

    return filterObject(output, (value, key) => {
      return value !== undefined
        && !(key === 'layout' && !Object.keys(value as object).length)
        && !(key === 'paint' && !Object.keys(value as object).length);
    }) as LayerSpecification;
  }

  /**
   * @internal
   */
  private _validate(validate: Validator, key: string, name: string, value: unknown, options: StyleSetterOptions = {}): boolean {
    return validateAndEmit(this, validate, {
      key,
      layerType: this.type,
      objectKey: name,
      value,
    }, options);
  }

  is3D(): boolean {
    return false;
  }

  isTileClipped(): boolean {
    return false;
  }

  hasOffscreenPass(): boolean {
    return false;
  }

  resize(): void {
    // noop
  }

  isStateDependent(): boolean {
    for (const property of Object.keys(this.paint._values)) {
      const value: unknown = this.paint.get(property as keyof TPaintPropsPossiblyEvaluated);
      if (!(value instanceof PossiblyEvaluatedPropertyValue) || !supportsPropertyExpression(value.property.specification)) {
        continue;
      }

      if ((value.value.kind === 'source' || value.value.kind === 'composite')
        && value.value.isStateDependent) {
        return true;
      }
    }
    return false;
  }
}
