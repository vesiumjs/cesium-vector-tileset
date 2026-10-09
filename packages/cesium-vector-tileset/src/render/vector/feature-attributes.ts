import type { Bucket } from '../../data/bucket';
import type { CircleBucket, FillBucket, FillExtrusionBucket, LineBucket } from '../../data/bucket-runtime';
import type { FeaturePaintRange, ProgramConfiguration } from '../../data/program-configuration';
import type { CircleStyleLayer } from '../../style/style-layer/circle-style-layer';
import { Color } from 'cesium';
import { PossiblyEvaluatedPropertyValue } from '../../style/properties';

/**
 * Per-feature style extraction for the Buffer*Collection track.
 *
 * Paint properties are either constant (evaluated by the current style zoom)
 * or data-driven (per-feature slots written by ProgramConfiguration binders).
 * Composite data expressions contain values at two adjacent zooms; those
 * values are interpolated here with the same factor as MapLibre's shader.
 */

export interface FillFeatureStyle {
  color: Color;
  outlineColor: Color;
  outlineWidthPx: number;
}

export interface LineFeatureStyle {
  color: Color;
  /** width in pixels */
  widthPx: number;
}

export interface ExtrusionFeatureStyle {
  color: Color;
  /** extrusion height in meters */
  height: number;
  /** extrusion base height in meters */
  base: number;
  /**
   * Whether side faces get the MapLibre vertical gradient (the
   * fill-extrusion-vertical-gradient paint, default true).
   */
  verticalGradient: boolean;
}

export interface CircleFeatureStyle {
  color: Color;
  /** diameter in pixels */
  sizePx: number;
  outlineColor: Color;
  /** stroke width in pixels */
  outlineWidthPx: number;
}

export function circlePaintVisible(color: Color, outlineColor: Color, outlineWidth: number): boolean {
  return color.alpha > 0 || (outlineWidth > 0 && outlineColor.alpha > 0);
}

export function paintRevision(bucket: Bucket): number {
  let revision = (bucket as unknown as {
    programConfigurations?: { paintRevision?: number };
  }).programConfigurations?.paintRevision ?? 0;
  for (const layer of bucket.layers)
    revision += layer.paintRevision;
  return revision;
}

interface AttributeData {
  values: Float32Array;
  components: number;
  offset: number;
}

interface CachedFloat32View {
  buffer: ArrayBuffer;
  values: Float32Array;
}

const float32Views = new WeakMap<object, CachedFloat32View>();
const layerById = new WeakMap<object, Map<string, any>>();

export function findRange(bucket: FillBucket | LineBucket | CircleBucket<any> | FillExtrusionBucket, featureIndex: number): FeaturePaintRange {
  const range = bucket.programConfigurations.getFeatureRange(featureIndex);
  if (!range) {
    throw new Error(`No paint range found for feature ${featureIndex}`);
  }
  return range;
}

/**
 * Read the paint slot owned by a feature.
 * Returns null when the property is constant (no attribute array).
 */
function readAttribute(config: ProgramConfiguration, property: string, range: FeaturePaintRange): AttributeData | null {
  const array = config.getAttributeArray(property);
  if (!array) {
    return null;
  }
  // StructArray buffers are capacity-grown on the worker and are only trimmed
  // when serialized. Use the declared element size rather than the backing
  // buffer length so direct/main-thread buckets are decoded correctly too.
  const components = array.bytesPerElement / Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isInteger(components) || components <= 0 || range.start >= array.length) {
    return null;
  }
  let cached = float32Views.get(array);
  if (!cached || cached.buffer !== array.arrayBuffer) {
    cached = {
      buffer: array.arrayBuffer,
      values: new Float32Array(array.arrayBuffer),
    };
    float32Views.set(array, cached);
  }
  const offset = range.start * components;
  if (offset + components > array.length * components) {
    return null;
  }
  return { values: cached.values, components, offset };
}

function decodeColorComponent(value: number, highByte: boolean): number {
  const packed = Math.round(value);
  return highByte ? Math.floor(packed / 256) / 255 : (packed % 256) / 255;
}

/**
 * Style-spec colors carry premultiplied alpha: `Color` multiplies rgb by
 * alpha, and MapLibre blends with ONE / ONE_MINUS_SRC_ALPHA. Cesium's
 * materials blend straight alpha (SRC_ALPHA / ONE_MINUS_SRC_ALPHA), so a
 * premultiplied color handed to Cesium is darkened by a second alpha factor.
 * Undo the premultiply at the style-to-Cesium boundary; every consumer of a
 * style color must go through this function.
 */
export function straightAlphaColor(red: number, green: number, blue: number, alpha: number): Color {
  if (!(alpha > 0)) {
    return new Color(0, 0, 0, 0);
  }
  if (alpha >= 1) {
    return new Color(red, green, blue, alpha);
  }
  return new Color(
    Math.min(1, red / alpha),
    Math.min(1, green / alpha),
    Math.min(1, blue / alpha),
    alpha,
  );
}

function readColor(config: ProgramConfiguration, property: string, range: FeaturePaintRange, zoom: number): Color | null {
  const values = readAttribute(config, property, range);
  if (!values) {
    return null;
  }
  // Source colors use two packed floats; composite colors use min/max pairs.
  const fromRed = decodeColorComponent(values.values[values.offset], true);
  const fromGreen = decodeColorComponent(values.values[values.offset], false);
  const fromBlue = decodeColorComponent(values.values[values.offset + 1], true);
  const fromAlpha = decodeColorComponent(values.values[values.offset + 1], false);
  if (values.components < 4) {
    return straightAlphaColor(fromRed, fromGreen, fromBlue, fromAlpha);
  }
  const toRed = decodeColorComponent(values.values[values.offset + 2], true);
  const toGreen = decodeColorComponent(values.values[values.offset + 2], false);
  const toBlue = decodeColorComponent(values.values[values.offset + 3], true);
  const toAlpha = decodeColorComponent(values.values[values.offset + 3], false);
  const factor = config.getInterpolationFactor(property, zoom);
  // Interpolate in premultiplied space (exactly what MapLibre's binders do),
  // then undo the premultiply once for Cesium.
  return straightAlphaColor(
    fromRed + (toRed - fromRed) * factor,
    fromGreen + (toGreen - fromGreen) * factor,
    fromBlue + (toBlue - fromBlue) * factor,
    fromAlpha + (toAlpha - fromAlpha) * factor,
  );
}

/**
 * The straight-alpha data-driven color at one layout vertex, or null when the
 * property is constant (no per-vertex array). Symbol buckets write their
 * paint arrays parallel to the layout vertex array (`populatePaintArrays` is
 * called with the array length after every feature), so the vertex index is
 * the feature's paint slot — the same contract MapLibre's symbol
 * `a_fill_color`/`a_halo_color` attributes rely on.
 */
export function vertexColor(
  config: ProgramConfiguration,
  property: string,
  vertexStart: number,
  zoom: number,
): Color | null {
  return readColor(config, property, { index: 0, start: vertexStart, end: vertexStart + 1 }, zoom);
}

function readNumber(config: ProgramConfiguration, property: string, range: FeaturePaintRange, zoom: number): number | null {
  const values = readAttribute(config, property, range);
  if (!values) {
    return null;
  }
  if (values.components < 2) {
    return values.values[values.offset];
  }
  const factor = config.getInterpolationFactor(property, zoom);
  const from = values.values[values.offset];
  const to = values.values[values.offset + 1];
  return from + (to - from) * factor;
}

/**
 * The evaluated value of a constant paint property, unwrapping the
 * PossiblyEvaluatedPropertyValue wrapper the style system produces.
 */
export function constantValue(layer: { paint: { get: (property: string) => unknown } }, property: string): unknown {
  const value = layer.paint.get(property);
  if (value instanceof PossiblyEvaluatedPropertyValue) {
    return value.isConstant() ? value.constantOr(undefined) : undefined;
  }
  return value;
}

function colorFor(config: ProgramConfiguration, layer: any, property: string, range: FeaturePaintRange, zoom: number): Color {
  const fromAttribute = readColor(config, property, range, zoom);
  if (fromAttribute) {
    return fromAttribute;
  }
  const value = constantValue(layer, property) as { r: number; g: number; b: number; a: number } | undefined;
  if (!value) {
    return Color.TRANSPARENT.clone();
  }
  return straightAlphaColor(value.r, value.g, value.b, value.a);
}

function numberFor(config: ProgramConfiguration, layer: any, property: string, range: FeaturePaintRange, zoom: number): number {
  const fromAttribute = readNumber(config, property, range, zoom);
  if (fromAttribute !== null) {
    return fromAttribute;
  }
  const value = constantValue(layer, property);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function layerFor(bucket: { layers: Array<{ id: string }> }, layerId?: string): any {
  if (bucket.layers.length === 1) {
    return bucket.layers[0];
  }
  let layers = layerById.get(bucket);
  // A bucket's layer list grows when a new style layer reuses it, so a map
  // cached from a shorter list would miss the new id and throw mid-render.
  // Rebuild whenever the layer count moved.
  if (!layers || layers.size !== bucket.layers.length) {
    layers = new Map(bucket.layers.map(layer => [layer.id, layer]));
    layerById.set(bucket, layers);
  }
  const layer = layerId ? layers.get(layerId) : bucket.layers[0];
  if (!layer) {
    throw new Error(`No style layer ${layerId ?? '<first>'} found in bucket`);
  }
  return layer;
}

function layerOpacity(layer: any, property: string): number {
  const value = constantValue(layer, property);
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

export function fillPatternOpacityForFeature(bucket: FillBucket, featureIndex: number, layerId?: string, zoom = bucket.zoom): number {
  const layer = layerFor(bucket, layerId);
  const range = findRange(bucket, featureIndex);
  const config = bucket.programConfigurations.get(layer.id);
  return numberFor(config, layer, 'fill-opacity', range, zoom) * layerOpacity(layer, 'fill-layer-opacity');
}

export function linePatternOpacityForFeature(bucket: LineBucket, featureIndex: number, layerId?: string, zoom = bucket.zoom): number {
  const layer = layerFor(bucket, layerId);
  const range = findRange(bucket, featureIndex);
  const config = bucket.programConfigurations.get(layer.id);
  return numberFor(config, layer, 'line-opacity', range, zoom) * layerOpacity(layer, 'line-layer-opacity');
}

export function extrusionPatternOpacityForFeature(bucket: FillExtrusionBucket, featureIndex: number, layerId?: string, zoom = bucket.zoom): number {
  const layer = layerFor(bucket, layerId);
  const range = findRange(bucket, featureIndex);
  const config = bucket.programConfigurations.get(layer.id);
  return numberFor(config, layer, 'fill-extrusion-opacity', range, zoom);
}

export function fillStyleForFeature(bucket: FillBucket, featureIndex: number, layerId?: string, zoom = bucket.zoom): FillFeatureStyle {
  const layer = layerFor(bucket, layerId);
  const range = findRange(bucket, featureIndex);
  const config = bucket.programConfigurations.get(layer.id);
  const color = colorFor(config, layer, 'fill-color', range, zoom);
  const opacity = numberFor(config, layer, 'fill-opacity', range, zoom);
  const opacityMultiplier = opacity * layerOpacity(layer, 'fill-layer-opacity');
  color.alpha *= opacityMultiplier;

  // MapLibre draws a fill outline whenever fill-antialias is enabled. When
  // fill-outline-color is omitted, FillStyleLayer.recalculate aliases the
  // evaluated paint value to fill-color; use the already evaluated fill color
  // here rather than asking the data-driven binder for an implicit property.
  const antialias = constantValue(layer, 'fill-antialias') !== false;
  const outline = layer.getPaintProperty?.('fill-outline-color');
  const hasExplicitOutline = outline !== undefined && outline !== null;
  const outlineColor = !antialias
    ? Color.TRANSPARENT.clone()
    : hasExplicitOutline
      ? colorFor(config, layer, 'fill-outline-color', range, zoom)
      : color.clone();
  if (hasExplicitOutline) {
    outlineColor.alpha *= opacityMultiplier;
  }
  return {
    color,
    outlineColor,
    outlineWidthPx: antialias ? 1 : 0,
  };
}

export function lineStyleForFeature(bucket: LineBucket, featureIndex: number, layerId?: string, zoom = bucket.zoom): LineFeatureStyle {
  const layer = layerFor(bucket, layerId);
  const range = findRange(bucket, featureIndex);
  const config = bucket.programConfigurations.get(layer.id);
  const color = colorFor(config, layer, 'line-color', range, zoom);
  const opacity = numberFor(config, layer, 'line-opacity', range, zoom);
  color.alpha *= opacity * layerOpacity(layer, 'line-layer-opacity');
  return {
    color,
    widthPx: numberFor(config, layer, 'line-width', range, zoom),
  };
}

export function extrusionStyleForFeature(bucket: FillExtrusionBucket, featureIndex: number, layerId?: string, zoom = bucket.zoom): ExtrusionFeatureStyle {
  const layer = layerFor(bucket, layerId);
  const range = findRange(bucket, featureIndex);
  const config = bucket.programConfigurations.get(layer.id);
  const color = colorFor(config, layer, 'fill-extrusion-color', range, zoom);
  const opacity = numberFor(config, layer, 'fill-extrusion-opacity', range, zoom);
  // MapLibre shades the original premultiplied RGB but ignores color alpha
  // when assigning the extrusion layer's final opacity.
  color.red *= color.alpha;
  color.green *= color.alpha;
  color.blue *= color.alpha;
  color.alpha = opacity;
  return {
    color,
    // MapLibre clamps subterranean floors and ceilings to ground level in
    // the vertex shader. Apply the same rule before converting to Cesium
    // Cartographic heights; passing negative values would put the whole
    // primitive below the ellipsoid instead of clamping each endpoint.
    height: Math.max(0, numberFor(config, layer, 'fill-extrusion-height', range, zoom)),
    base: Math.max(0, numberFor(config, layer, 'fill-extrusion-base', range, zoom)),
    verticalGradient: constantValue(layer, 'fill-extrusion-vertical-gradient') !== false,
  };
}

export function circleStyleForFeature(bucket: CircleBucket<CircleStyleLayer>, featureIndex: number, layerId?: string, zoom = bucket.zoom): CircleFeatureStyle {
  const layer = layerFor(bucket, layerId) as CircleStyleLayer;
  const range = findRange(bucket, featureIndex);
  const config = bucket.programConfigurations.get(layer.id);
  const color = colorFor(config, layer, 'circle-color', range, zoom);
  const opacity = numberFor(config, layer, 'circle-opacity', range, zoom);
  color.alpha *= opacity;
  // Native circles interpolate RGB and alpha independently at the stroke
  // boundary. A transparent fill must not contribute its old hue there.
  if (color.alpha === 0)
    Color.TRANSPARENT.clone(color);
  const outlineColor = colorFor(config, layer, 'circle-stroke-color', range, zoom);
  const strokeOpacity = numberFor(config, layer, 'circle-stroke-opacity', range, zoom);
  outlineColor.alpha *= strokeOpacity;
  if (outlineColor.alpha === 0)
    Color.TRANSPARENT.clone(outlineColor);
  return {
    color,
    sizePx: numberFor(config, layer, 'circle-radius', range, zoom) * 2,
    outlineColor,
    outlineWidthPx: numberFor(config, layer, 'circle-stroke-width', range, zoom),
  };
}
