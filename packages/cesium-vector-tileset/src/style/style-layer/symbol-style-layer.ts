import type { Expression, Feature, LayerSpecification, ResolvedImage, SourceExpression } from '@maplibre/maplibre-gl-style-spec';

import type { SymbolFeature } from '../../data/bucket/symbol-bucket';
import type { CanonicalTileID } from '../../tile/tile-id';
import type { EvaluationParameters } from '../evaluation-parameters';

import type { Layout, PossiblyEvaluated, PropertyValue } from '../properties';
import type { SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated, SymbolPaintProps, SymbolPaintPropsPossiblyEvaluated } from './symbol-style-layer-properties.g';

import { FormatExpression, Formatted, FormattedType, isExpression, Literal, StyleExpression, typeOf, ZoomConstantExpression, ZoomDependentExpression } from '@maplibre/maplibre-gl-style-spec';

import { FormatSectionOverride } from '../format-section-override';
import {

  PossiblyEvaluatedPropertyValue,

} from '../properties';
import { resolveTokens } from '../resolve-tokens';
import { StyleLayer } from '../style-layer';
import properties from './symbol-style-layer-properties.g';

export class SymbolStyleLayer extends StyleLayer<
  SymbolPaintProps,
  SymbolLayoutProps,
  SymbolPaintPropsPossiblyEvaluated,
  SymbolLayoutPropsPossiblyEvaluated
> {
  declare _unevaluatedLayout: Layout<SymbolLayoutProps>;

  constructor(layer: LayerSpecification, globalState: Record<string, any>) {
    super(layer, properties, globalState);
  }

  recalculate(parameters: EvaluationParameters, availableImages: string[]): void {
    super.recalculate(parameters, availableImages);

    // `icon-rotation-alignment` is data-driven in the style spec, so a plain
    // comparison against 'auto' would test an object. Resolve 'auto' (and a
    // non-constant expression, which MapLibre also resolves) into a constant
    // evaluated value, matching the property's data-driven shape.
    const iconRotationAlignment = this.layout.get('icon-rotation-alignment');
    if (iconRotationAlignment.value.kind !== 'constant' || iconRotationAlignment.value.value === 'auto') {
      this.layout._values['icon-rotation-alignment'] = new PossiblyEvaluatedPropertyValue(
        iconRotationAlignment.property,
        { kind: 'constant', value: this.layout.get('symbol-placement') !== 'point' ? 'map' : 'viewport' },
        iconRotationAlignment.parameters,
      );
    }

    if (this.layout.get('text-rotation-alignment') === 'auto') {
      if (this.layout.get('symbol-placement') !== 'point') {
        this.layout._values['text-rotation-alignment'] = 'map';
      }
      else {
        this.layout._values['text-rotation-alignment'] = 'viewport';
      }
    }

    // If unspecified, `*-pitch-alignment` inherits `*-rotation-alignment`
    if (this.layout.get('text-pitch-alignment') === 'auto') {
      this.layout._values['text-pitch-alignment'] = this.layout.get('text-rotation-alignment') === 'map' ? 'map' : 'viewport';
    }
    if (this.layout.get('icon-pitch-alignment') === 'auto') {
      this.layout._values['icon-pitch-alignment'] = this.layout.get('icon-rotation-alignment').constantOr('viewport');
    }

    if (this.layout.get('symbol-placement') === 'point') {
      const writingModes = this.layout.get('text-writing-mode');
      if (writingModes) {
        // remove duplicates, preserving order
        const deduped: Array<'horizontal' | 'vertical'> = [];
        for (const m of writingModes) {
          if (!deduped.includes(m))
            deduped.push(m);
        }
        this.layout._values['text-writing-mode'] = deduped;
      }
      else {
        this.layout._values['text-writing-mode'] = ['horizontal'];
      }
    }

    this._setPaintOverrides();
  }

  getValueAndResolveTokens(name: 'text-field', feature: Feature, canonical: CanonicalTileID, availableImages: string[]): Formatted;
  getValueAndResolveTokens(name: 'icon-image', feature: Feature, canonical: CanonicalTileID, availableImages: string[]): ResolvedImage | string;
  getValueAndResolveTokens(name: 'text-field' | 'icon-image', feature: Feature, canonical: CanonicalTileID, availableImages: string[]): Formatted | ResolvedImage | string {
    const value = this.layout.get(name).evaluate(feature, {}, canonical, availableImages);
    const unevaluated = this._unevaluatedLayout._values[name];
    if (!unevaluated.isDataDriven() && !isExpression(unevaluated.value) && typeof value === 'string') {
      return resolveTokens(feature.properties, value);
    }

    return value;
  }

  _setPaintOverrides(): void {
    for (const overridable of properties.paint.overridableProperties) {
      if (!SymbolStyleLayer.hasPaintOverride(this.layout, overridable)) {
        continue;
      }
      const overridden = this.paint.get(overridable as keyof SymbolPaintPropsPossiblyEvaluated) as PossiblyEvaluatedPropertyValue<number>;
      const override = new FormatSectionOverride(overridden);
      const styleExpression = new StyleExpression(override, `layers[${this.id}].paint.${overridden.property.name}`, overridden.property.specification);
      let expression = null;
      if (overridden.value.kind === 'constant' || overridden.value.kind === 'source') {
        expression = new ZoomConstantExpression('source', styleExpression) as SourceExpression;
      }
      else {
        expression = new ZoomDependentExpression('composite', styleExpression, overridden.value.zoomStops);
      }
      this.paint._values[overridable] = new PossiblyEvaluatedPropertyValue(overridden.property, expression, overridden.parameters);
    }
  }

  _handleOverridablePaintPropertyUpdate<T, R>(name: string, oldValue: PropertyValue<T, R>, newValue: PropertyValue<T, R>): boolean {
    if (!this.layout || oldValue.isDataDriven() || newValue.isDataDriven()) {
      return false;
    }
    return SymbolStyleLayer.hasPaintOverride(this.layout, name);
  }

  static hasPaintOverride(layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>, propertyName: string): boolean {
    if (!isSymbolPaintProperty(propertyName)) {
      return false;
    }
    const textField = layout.get('text-field');
    const property = properties.paint.properties[propertyName];
    let hasOverrides = false;

    const checkSections = (sections: Formatted['sections']): void => {
      for (const section of sections) {
        if ('overrides' in property && property.overrides?.hasOverride(section)) {
          hasOverrides = true;
          return;
        }
      }
    };

    if (textField.value.kind === 'constant' && textField.value.value instanceof Formatted) {
      checkSections(textField.value.value.sections);
    }
    else if (textField.value.kind === 'source' || textField.value.kind === 'composite') {
      const checkExpression = (expression: Expression) => {
        if (hasOverrides)
          return;

        if (expression instanceof Literal && typeOf(expression.value) === FormattedType) {
          const formatted = Formatted.factory(expression.value as string | Formatted);
          checkSections(formatted.sections);
        }
        else if (expression instanceof FormatExpression) {
          checkSections(expression.sections as unknown as Formatted['sections']);
        }
        else {
          expression.eachChild(checkExpression);
        }
      };

      const expr = textField.value as ZoomConstantExpression<'source'>;
      if (expr._styleExpression) {
        checkExpression(expr._styleExpression.expression);
      }
    }

    return hasOverrides;
  }
}

function isSymbolPaintProperty(name: string): name is keyof SymbolPaintProps {
  return Object.hasOwn(properties.paint.properties, name);
}

export type SymbolPadding = [number, number, number, number];

export function getIconPadding(layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>, feature: SymbolFeature, canonical: CanonicalTileID, pixelRatio = 1): SymbolPadding {
  // Support text-padding in addition to icon-padding? Unclear how to apply asymmetric text-padding to the radius for collision circles.
  const result = layout.get('icon-padding').evaluate(feature, {}, canonical);
  const values = result?.values;
  if (!values) {
    return [0, 0, 0, 0];
  }

  return [
    values[0] * pixelRatio,
    values[1] * pixelRatio,
    values[2] * pixelRatio,
    values[3] * pixelRatio,
  ];
}
