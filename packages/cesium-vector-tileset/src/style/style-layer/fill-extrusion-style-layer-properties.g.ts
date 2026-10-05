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

export interface FillExtrusionLayoutProps {
  'fill-extrusion-rounded-corner-distance': DataConstantProperty<number>;
}

export interface FillExtrusionLayoutPropsPossiblyEvaluated {
  'fill-extrusion-rounded-corner-distance': number;
}

let layout: Properties<FillExtrusionLayoutProps>;
function getLayout(): Properties<FillExtrusionLayoutProps> {
  return layout = layout || new Properties({
    'fill-extrusion-rounded-corner-distance': new DataConstantProperty(styleSpec['layout_fill-extrusion']['fill-extrusion-rounded-corner-distance'] as any as StylePropertySpecification, 'fill-extrusion-rounded-corner-distance'),
  });
}

export interface FillExtrusionPaintProps {
  'fill-extrusion-opacity': DataConstantProperty<number>;
  'fill-extrusion-color': DataDrivenProperty<Color>;
  'fill-extrusion-translate': DataConstantProperty<[number, number]>;
  'fill-extrusion-translate-anchor': DataConstantProperty<'map' | 'viewport'>;
  'fill-extrusion-pattern': CrossFadedDataDrivenProperty<ResolvedImage>;
  'fill-extrusion-height': DataDrivenProperty<number>;
  'fill-extrusion-base': DataDrivenProperty<number>;
  'fill-extrusion-vertical-gradient': DataConstantProperty<boolean>;
}

export interface FillExtrusionPaintPropsPossiblyEvaluated {
  'fill-extrusion-opacity': number;
  'fill-extrusion-color': PossiblyEvaluatedPropertyValue<Color>;
  'fill-extrusion-translate': [number, number];
  'fill-extrusion-translate-anchor': 'map' | 'viewport';
  'fill-extrusion-pattern': PossiblyEvaluatedPropertyValue<CrossFaded<ResolvedImage>>;
  'fill-extrusion-height': PossiblyEvaluatedPropertyValue<number>;
  'fill-extrusion-base': PossiblyEvaluatedPropertyValue<number>;
  'fill-extrusion-vertical-gradient': boolean;
}

let paint: Properties<FillExtrusionPaintProps>;
function getPaint(): Properties<FillExtrusionPaintProps> {
  return paint = paint || new Properties({
    'fill-extrusion-opacity': new DataConstantProperty(styleSpec['paint_fill-extrusion']['fill-extrusion-opacity'] as any as StylePropertySpecification, 'fill-extrusion-opacity'),
    'fill-extrusion-color': new DataDrivenProperty(styleSpec['paint_fill-extrusion']['fill-extrusion-color'] as any as StylePropertySpecification, 'fill-extrusion-color'),
    'fill-extrusion-translate': new DataConstantProperty(styleSpec['paint_fill-extrusion']['fill-extrusion-translate'] as any as StylePropertySpecification, 'fill-extrusion-translate'),
    'fill-extrusion-translate-anchor': new DataConstantProperty(styleSpec['paint_fill-extrusion']['fill-extrusion-translate-anchor'] as any as StylePropertySpecification, 'fill-extrusion-translate-anchor'),
    'fill-extrusion-pattern': new CrossFadedDataDrivenProperty(styleSpec['paint_fill-extrusion']['fill-extrusion-pattern'] as any as StylePropertySpecification, 'fill-extrusion-pattern'),
    'fill-extrusion-height': new DataDrivenProperty(styleSpec['paint_fill-extrusion']['fill-extrusion-height'] as any as StylePropertySpecification, 'fill-extrusion-height'),
    'fill-extrusion-base': new DataDrivenProperty(styleSpec['paint_fill-extrusion']['fill-extrusion-base'] as any as StylePropertySpecification, 'fill-extrusion-base'),
    'fill-extrusion-vertical-gradient': new DataConstantProperty(styleSpec['paint_fill-extrusion']['fill-extrusion-vertical-gradient'] as any as StylePropertySpecification, 'fill-extrusion-vertical-gradient'),
  });
}

export default ({
  get paint(): Properties<FillExtrusionPaintProps> { return getPaint(); },
  get layout(): Properties<FillExtrusionLayoutProps> { return getLayout(); },
});
