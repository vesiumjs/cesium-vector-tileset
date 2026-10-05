// This file is generated. Edit build/generate-style-code.ts, then run 'npm run codegen'.

import type { Color, ResolvedImage, StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';

import type {
  CrossFaded,
  PossiblyEvaluatedPropertyValue,
} from '../properties';

import { latest as styleSpec } from '@maplibre/maplibre-gl-style-spec';

import {
  CrossFadedDataDrivenProperty,
  DataConstantProperty,
  DataDrivenProperty,
  Properties,
} from '../properties';

export interface FillLayoutProps {
  'fill-sort-key': DataDrivenProperty<number>;
}

export interface FillLayoutPropsPossiblyEvaluated {
  'fill-sort-key': PossiblyEvaluatedPropertyValue<number>;
}

let layout: Properties<FillLayoutProps>;
function getLayout(): Properties<FillLayoutProps> {
  return layout = layout || new Properties({
    'fill-sort-key': new DataDrivenProperty(styleSpec.layout_fill['fill-sort-key'] as any as StylePropertySpecification, 'fill-sort-key'),
  });
}

export interface FillPaintProps {
  'fill-antialias': DataConstantProperty<boolean>;
  'fill-opacity': DataDrivenProperty<number>;
  'fill-layer-opacity': DataConstantProperty<number>;
  'fill-color': DataDrivenProperty<Color>;
  'fill-outline-color': DataDrivenProperty<Color>;
  'fill-translate': DataConstantProperty<[number, number]>;
  'fill-translate-anchor': DataConstantProperty<'map' | 'viewport'>;
  'fill-pattern': CrossFadedDataDrivenProperty<ResolvedImage>;
}

export interface FillPaintPropsPossiblyEvaluated {
  'fill-antialias': boolean;
  'fill-opacity': PossiblyEvaluatedPropertyValue<number>;
  'fill-layer-opacity': number;
  'fill-color': PossiblyEvaluatedPropertyValue<Color>;
  'fill-outline-color': PossiblyEvaluatedPropertyValue<Color>;
  'fill-translate': [number, number];
  'fill-translate-anchor': 'map' | 'viewport';
  'fill-pattern': PossiblyEvaluatedPropertyValue<CrossFaded<ResolvedImage>>;
}

let paint: Properties<FillPaintProps>;
function getPaint(): Properties<FillPaintProps> {
  return paint = paint || new Properties({
    'fill-antialias': new DataConstantProperty(styleSpec.paint_fill['fill-antialias'] as any as StylePropertySpecification, 'fill-antialias'),
    'fill-opacity': new DataDrivenProperty(styleSpec.paint_fill['fill-opacity'] as any as StylePropertySpecification, 'fill-opacity'),
    'fill-layer-opacity': new DataConstantProperty(styleSpec.paint_fill['fill-layer-opacity'] as any as StylePropertySpecification, 'fill-layer-opacity'),
    'fill-color': new DataDrivenProperty(styleSpec.paint_fill['fill-color'] as any as StylePropertySpecification, 'fill-color'),
    'fill-outline-color': new DataDrivenProperty(styleSpec.paint_fill['fill-outline-color'] as any as StylePropertySpecification, 'fill-outline-color'),
    'fill-translate': new DataConstantProperty(styleSpec.paint_fill['fill-translate'] as any as StylePropertySpecification, 'fill-translate'),
    'fill-translate-anchor': new DataConstantProperty(styleSpec.paint_fill['fill-translate-anchor'] as any as StylePropertySpecification, 'fill-translate-anchor'),
    'fill-pattern': new CrossFadedDataDrivenProperty(styleSpec.paint_fill['fill-pattern'] as any as StylePropertySpecification, 'fill-pattern'),
  });
}

export default ({
  get paint(): Properties<FillPaintProps> { return getPaint(); },
  get layout(): Properties<FillLayoutProps> { return getLayout(); },
});
