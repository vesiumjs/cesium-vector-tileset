// This file is generated. Edit build/generate-style-code.ts, then run 'npm run codegen'.

import type { Color, StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';

import { latest as styleSpec } from '@maplibre/maplibre-gl-style-spec';

import {
  DataConstantProperty,
  Properties,
} from './properties';

export interface LightProps {
  anchor: DataConstantProperty<'map' | 'viewport'>;
  position: DataConstantProperty<[number, number, number]>;
  color: DataConstantProperty<Color>;
  intensity: DataConstantProperty<number>;
}

export interface LightPropsPossiblyEvaluated {
  anchor: 'map' | 'viewport';
  position: [number, number, number];
  color: Color;
  intensity: number;
}

let properties: Properties<LightProps>;
export function getProperties(): Properties<LightProps> {
  return properties = properties || new Properties({
    anchor: new DataConstantProperty(styleSpec.light.anchor as any as StylePropertySpecification, 'anchor'),
    position: new DataConstantProperty(styleSpec.light.position as any as StylePropertySpecification, 'position'),
    color: new DataConstantProperty(styleSpec.light.color as any as StylePropertySpecification, 'color'),
    intensity: new DataConstantProperty(styleSpec.light.intensity as any as StylePropertySpecification, 'intensity'),
  });
}
