// This file is generated. Edit build/generate-style-code.ts, then run 'npm run codegen'.

import type { Color, ResolvedImage, StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';

import type {
  CrossFaded,
} from '../properties';

import { latest as styleSpec } from '@maplibre/maplibre-gl-style-spec';

import {
  CrossFadedProperty,
  DataConstantProperty,
  Properties,
} from '../properties';

export interface BackgroundPaintProps {
  'background-color': DataConstantProperty<Color>;
  'background-pattern': CrossFadedProperty<ResolvedImage>;
  'background-opacity': DataConstantProperty<number>;
}

export interface BackgroundPaintPropsPossiblyEvaluated {
  'background-color': Color;
  'background-pattern': CrossFaded<ResolvedImage>;
  'background-opacity': number;
}

let paint: Properties<BackgroundPaintProps>;
function getPaint(): Properties<BackgroundPaintProps> {
  return paint = paint || new Properties({
    'background-color': new DataConstantProperty(styleSpec.paint_background['background-color'] as any as StylePropertySpecification, 'background-color'),
    'background-pattern': new CrossFadedProperty(styleSpec.paint_background['background-pattern'] as any as StylePropertySpecification, 'background-pattern'),
    'background-opacity': new DataConstantProperty(styleSpec.paint_background['background-opacity'] as any as StylePropertySpecification, 'background-opacity'),
  });
}

export default ({
  get paint(): Properties<BackgroundPaintProps> { return getPaint(); },

});
