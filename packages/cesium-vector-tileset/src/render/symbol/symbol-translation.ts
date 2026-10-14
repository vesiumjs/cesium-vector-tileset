import type { SymbolStyleLayer } from '../../style/style-layer/symbol-style-layer';
import { Cartesian2 } from 'cesium';
import { mercatorTranslation } from '../geometry/mercator-translation';
import { WGS84_A } from '../geometry/tile-to-ecef';
import { symbolGroundPosition, symbolMercatorPosition } from './symbol-perspective';

/** Immutable paint input retained by a collision generation and a drawable half. */
export interface SymbolTranslation {
  readonly pixels: Readonly<Cartesian2>;
  readonly anchor: 'map' | 'viewport';
}

export const NO_SYMBOL_TRANSLATION: SymbolTranslation = Object.freeze({ pixels: Object.freeze(new Cartesian2()), anchor: 'map' });

/** Preserve input identity until evaluated paint actually changes. */
export function readSymbolTranslation(paint: SymbolStyleLayer['paint'], part: 'text' | 'icon', previous = NO_SYMBOL_TRANSLATION): SymbolTranslation {
  const pixels = paint.get(`${part}-translate`);
  if (!pixels[0] && !pixels[1])
    return NO_SYMBOL_TRANSLATION;
  const anchor = paint.get(`${part}-translate-anchor`);
  return previous.pixels.x === pixels[0] && previous.pixels.y === pixels[1] && previous.anchor === anchor
    ? previous
    : Object.freeze({ pixels: Object.freeze(new Cartesian2(pixels[0], pixels[1])), anchor });
}

/** Symbol draw and collision both translate in tile units before projection. */
export function resolveSymbolTranslation(translation: SymbolTranslation, zoom: number, bearing: number | undefined, result = new Cartesian2()): Cartesian2 {
  if (!translation.pixels.x && !translation.pixels.y) {
    result.x = result.y = 0;
    return result;
  }
  if (translation.anchor === 'viewport' && bearing === undefined)
    throw new TypeError('Viewport symbol translation requires the frozen camera bearing');
  mercatorTranslation(translation.pixels, translation.anchor === 'viewport', zoom, bearing, result);
  return result;
}

/** The CPU label plane uses east/south Mercator metres instead of normalized units. */
export function symbolTranslationMetres(translation: SymbolTranslation, zoom: number, bearing: number | undefined): Cartesian2 {
  return Cartesian2.multiplyByScalar(resolveSymbolTranslation(translation, zoom, bearing), 2 * Math.PI * WGS84_A, new Cartesian2());
}

export interface TranslatedSymbolPosition {
  x: number;
  y: number;
  z: number;
  /** Original Mercator anchor plus the paint offset, before longitude wrapping. */
  labelPlane?: { x: number; y: number };
}

export function translatedSymbolPosition(x: number, y: number, z: number, metres: Cartesian2): TranslatedSymbolPosition | undefined {
  if (!metres.x && !metres.y)
    return { x, y, z };
  const position = symbolMercatorPosition(x, y, z);
  if (!position)
    return undefined;
  const labelPlane = { x: position.x + metres.x, y: position.y + metres.y };
  const translated: TranslatedSymbolPosition = symbolGroundPosition(labelPlane.x, labelPlane.y);
  translated.labelPlane = labelPlane;
  return translated;
}
