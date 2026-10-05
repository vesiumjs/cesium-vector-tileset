import type {
  Color,
  CompositeExpression,
  Expression,
  Feature,
  FeatureState,
  FormattedSection,
  SourceExpression,
} from '@maplibre/maplibre-gl-style-spec';
import type { DashEntry } from '../assets/dash-atlas';
import type { ImagePosition } from '../assets/image-atlas';
import type { FeatureStates } from '../source/source-state';
import type { TypedStyleLayer } from '../style/style-layer/typed-style-layer';
import type { CanonicalTileID } from '../tile/tile-id';
import type { StructArray } from '../util/struct-array';

import type { TransferRegistry } from '../worker/transfer-registry';
import { expressions, supportsPropertyExpression, ZoomConstantExpression, ZoomDependentExpression } from '@maplibre/maplibre-gl-style-spec';
import { EvaluationParameters } from '../style/evaluation-parameters';
import { PossiblyEvaluatedPropertyValue } from '../style/properties';
import { clamp } from '../util/math';
import { DashLayoutArray, PatternLayoutArray, StructArrayLayout1f4, StructArrayLayout2f8, StructArrayLayout4f16 } from './array-types.g';

function packColor(color: Color): [number, number] {
  return [
    packUint8ToFloat(255 * color.r, 255 * color.g),
    packUint8ToFloat(255 * color.b, 255 * color.a),
  ];
}

/**
 * Packs two numbers into a single float as 8-bit unsigned integers. The
 * decoder (see `decodeColorComponent`) is a port of MapLibre's
 * `unpack_float()`, so both channels must be clamped and floored here: an
 * unclamped low byte carries into the high byte, and an out-of-range high
 * byte shifts the whole value, so a single off-range channel corrupts both.
 */
function packUint8ToFloat(a: number, b: number): number {
  return 256 * clamp(Math.floor(a), 0, 255) + clamp(Math.floor(b), 0, 255);
}

function isColor(value: PaintValue): value is Color {
  return typeof value === 'object'
    && value !== null
    && 'r' in value
    && 'g' in value
    && 'b' in value
    && 'a' in value;
}

/**
 * Records a feature's range in its paint attribute arrays and its source-layer
 * index. Non-symbol buckets use one dense paint slot per feature; symbols use
 * one paint entry per layout vertex. Geometry ownership is stored by buckets.
 */
export interface FeaturePaintRange {
  /**
   * Index of the feature in the source layer.
   */
  index: number;
  start: number;
  end: number;
  id?: string | number;
  formattedSection?: FormattedSection;
}

export type FeatureLookup = (originalFeatureIndex: number) => Feature;

export interface PaintOptions {
  imagePositions: {
    [_: string]: ImagePosition;
  };
  dashPositions?: {
    [_: string]: DashEntry;
  };
  canonical?: CanonicalTileID;
  formattedSection?: FormattedSection;
  availableImages?: string[];
}

type PaintType = 'color' | 'number';
type PaintValue = number | Color;
type StructArrayConstructor = new () => StructArray;
type PaintPropertyResult = object | string | number | boolean | undefined;

interface PaintAccessor {
  get: (property: string) => PaintPropertyResult;
}

/** Evaluates feature paint into CPU arrays consumed by the Cesium backend. */
interface AttributeBinder {
  expression: SourceExpression | CompositeExpression;
  paintVertexArray: StructArray;
  populatePaintArray: (
    length: number,
    feature: Feature,
    options: PaintOptions,
  ) => void;
  updatePaintArray: (
    start: number,
    length: number,
    feature: Feature,
    featureState: FeatureState,
    options: PaintOptions,
  ) => void;
}

class SourceExpressionBinder implements AttributeBinder {
  expression: SourceExpression;
  type: PaintType;

  paintVertexArray: StructArray;

  constructor(expression: SourceExpression, type: PaintType, PaintVertexArray: StructArrayConstructor) {
    this.expression = expression;
    this.type = type;
    this.paintVertexArray = new PaintVertexArray();
  }

  populatePaintArray(newLength: number, feature: Feature, options: PaintOptions) {
    const start = this.paintVertexArray.length;
    const value: PaintValue = this.expression.evaluate(new EvaluationParameters(0, options), feature, {}, options.canonical, options.availableImages, options.formattedSection);
    this.paintVertexArray.resize(newLength);
    this._setPaintValue(start, newLength, value);
  }

  updatePaintArray(start: number, end: number, feature: Feature, featureState: FeatureState, options: PaintOptions) {
    const value: PaintValue = this.expression.evaluate(new EvaluationParameters(0, options), feature, featureState, options.canonical, options.availableImages, options.formattedSection);
    this._setPaintValue(start, end, value);
  }

  private _setPaintValue(start: number, end: number, value: PaintValue): void {
    if (this.type === 'color') {
      if (!isColor(value)) {
        throw new Error('A color paint expression returned a non-color value');
      }
      const color = packColor(value);
      for (let i = start; i < end; i++) {
        this.paintVertexArray.emplace(i, color[0], color[1]);
      }
    }
    else {
      if (typeof value !== 'number') {
        throw new TypeError('A numeric paint expression returned a non-numeric value');
      }
      for (let i = start; i < end; i++) {
        this.paintVertexArray.emplace(i, value);
      }
    }
  }
}

class CompositeExpressionBinder implements AttributeBinder {
  expression: CompositeExpression;
  type: PaintType;
  zoom: number;

  paintVertexArray: StructArray;

  constructor(expression: CompositeExpression, type: PaintType, zoom: number, PaintVertexArray: {
    new (): StructArray;
  }) {
    this.expression = expression;
    this.type = type;
    this.zoom = zoom;
    this.paintVertexArray = new PaintVertexArray();
  }

  populatePaintArray(newLength: number, feature: Feature, options: PaintOptions) {
    const min: PaintValue = this.expression.evaluate(new EvaluationParameters(this.zoom, options), feature, {}, options.canonical, options.availableImages, options.formattedSection);
    const max: PaintValue = this.expression.evaluate(new EvaluationParameters(this.zoom + 1, options), feature, {}, options.canonical, options.availableImages, options.formattedSection);
    const start = this.paintVertexArray.length;
    this.paintVertexArray.resize(newLength);
    this._setPaintValue(start, newLength, min, max);
  }

  updatePaintArray(start: number, end: number, feature: Feature, featureState: FeatureState, options: PaintOptions) {
    const min: PaintValue = this.expression.evaluate(new EvaluationParameters(this.zoom, options), feature, featureState, options.canonical, options.availableImages, options.formattedSection);
    const max: PaintValue = this.expression.evaluate(new EvaluationParameters(this.zoom + 1, options), feature, featureState, options.canonical, options.availableImages, options.formattedSection);
    this._setPaintValue(start, end, min, max);
  }

  private _setPaintValue(start: number, end: number, min: PaintValue, max: PaintValue): void {
    if (this.type === 'color') {
      if (!isColor(min) || !isColor(max)) {
        throw new Error('A color paint expression returned a non-color value');
      }
      const minColor = packColor(min);
      const maxColor = packColor(max);
      for (let i = start; i < end; i++) {
        this.paintVertexArray.emplace(i, minColor[0], minColor[1], maxColor[0], maxColor[1]);
      }
    }
    else {
      if (typeof min !== 'number' || typeof max !== 'number') {
        throw new TypeError('A numeric paint expression returned a non-numeric value');
      }
      for (let i = start; i < end; i++) {
        this.paintVertexArray.emplace(i, min, max);
      }
    }
  }
}

abstract class CrossFadedBinder<T> implements AttributeBinder {
  expression: CompositeExpression;
  zoom: number;
  layerId: string;

  paintVertexArray: StructArray;

  constructor(expression: CompositeExpression, zoom: number, PaintVertexArray: StructArrayConstructor, layerId: string) {
    this.expression = expression;
    this.zoom = zoom;
    this.layerId = layerId;

    this.paintVertexArray = new PaintVertexArray();
  }

  populatePaintArray(length: number, feature: Feature, options: PaintOptions) {
    const start = this.paintVertexArray.length;
    this.paintVertexArray.resize(length);
    this._setPaintValues(start, length, this.getPositionIds(feature), options);
  }

  updatePaintArray(start: number, end: number, feature: Feature, _featureState: FeatureState, options: PaintOptions) {
    this._setPaintValues(start, end, this.getPositionIds(feature), options);
  }

  protected abstract getPositionIds(feature: Feature): { min: string; mid: string } | undefined;
  protected abstract getPositions(options: PaintOptions): { [_: string]: T } | undefined;
  protected abstract emplace(array: StructArray, index: number, fromPos: T, toPos: T): void;

  protected _setPaintValues(start: number, end: number, positionIds: { min: string; mid: string } | undefined, options: PaintOptions): void {
    const positions = this.getPositions(options);
    if (!positions || !positionIds)
      return;
    const min = positions[positionIds.min];
    const mid = positions[positionIds.mid];
    if (!min || !mid)
      return;

    // Cesium reads the previous integer zoom's value and the current value.
    for (let i = start; i < end; i++) {
      this.emplace(this.paintVertexArray, i, min, mid);
    }
  }
}

class CrossFadedPatternBinder extends CrossFadedBinder<ImagePosition> {
  protected getPositions(options: PaintOptions): { [_: string]: ImagePosition } {
    return options.imagePositions;
  }

  protected getPositionIds(feature: Feature): { min: string; mid: string } | undefined {
    return feature.patterns?.[this.layerId];
  }

  protected emplace(array: StructArray, index: number, fromPos: ImagePosition, toPos: ImagePosition): void {
    array.emplace(index, fromPos.tlbr[0], fromPos.tlbr[1], fromPos.tlbr[2], fromPos.tlbr[3], toPos.tlbr[0], toPos.tlbr[1], toPos.tlbr[2], toPos.tlbr[3], fromPos.pixelRatio, toPos.pixelRatio);
  }
}

class CrossFadedDasharrayBinder extends CrossFadedBinder<DashEntry> {
  protected getPositions(options: PaintOptions): { [_: string]: DashEntry } | undefined {
    return options.dashPositions;
  }

  protected getPositionIds(feature: Feature): { min: string; mid: string } | undefined {
    return feature.dashes?.[this.layerId];
  }

  protected emplace(array: StructArray, index: number, fromPos: DashEntry, toPos: DashEntry): void {
    array.emplace(index, 0, fromPos.y, fromPos.height, fromPos.width, 0, toPos.y, toPos.height, toPos.width);
  }
}

/**
 * ProgramConfiguration evaluates paint properties per feature. Non-data-driven
 * property values stay in layer paint; data-driven property values are written
 * into CPU-side attribute arrays. Non-symbol buckets append one slot per
 * feature; symbol buckets append one entry per layout vertex.
 * @internal
 */
export class ProgramConfiguration {
  binders: { [_: string]: AttributeBinder };

  constructor(layer: TypedStyleLayer, zoom: number, filterProperties: (_: string) => boolean) {
    this.binders = {};

    for (const property in layer.paint._values) {
      if (!filterProperties(property))
        continue;
      const value = getPaintProperty(layer, property);
      if (!(value instanceof PossiblyEvaluatedPropertyValue) || !supportsPropertyExpression(value.property.specification)) {
        continue;
      }
      const expression = value.value;
      if (expression.kind === 'constant')
        continue;
      const type = value.property.specification.type;
      const propType = value.property.specification['property-type'];
      const isCrossFaded = propType === 'cross-faded' || propType === 'cross-faded-data-driven';
      const paintType = toPaintType(type);
      if (!paintType && !isCrossFaded) {
        continue;
      }

      if (expression.kind === 'source' || isCrossFaded) {
        const StructArrayLayout = layoutType(property, type, 'source');
        if (!StructArrayLayout) {
          continue;
        }
        this.binders[property] = isCrossFaded
          ? property === 'line-dasharray'
            ? new CrossFadedDasharrayBinder(expression as CompositeExpression, zoom, StructArrayLayout, layer.id)
            : new CrossFadedPatternBinder(expression as CompositeExpression, zoom, StructArrayLayout, layer.id)
          : new SourceExpressionBinder(expression as SourceExpression, paintType!, StructArrayLayout);
      }
      else if (expression.kind === 'composite') {
        const StructArrayLayout = layoutType(property, type, 'composite');
        if (!StructArrayLayout) {
          continue;
        }
        this.binders[property] = new CompositeExpressionBinder(expression, paintType!, zoom, StructArrayLayout);
      }
    }
  }

  /**
   * Returns the CPU-side attribute array for a data-driven or
   * cross-faded paint property, or undefined for constant properties.
   */
  getAttributeArray(property: string): StructArray | undefined {
    return this.binders[property]?.paintVertexArray;
  }

  /**
   * Return the same interpolation factor MapLibre supplies to the composite
   * attribute shader. The worker stores values at the bucket zoom and the next
   * integer zoom; the Cesium adapter must apply the factor every frame instead
   * of freezing the first value forever.
   */
  getInterpolationFactor(property: string, zoom: number): number {
    const binder = this.binders[property];
    if (!(binder instanceof CompositeExpressionBinder)) {
      return 0;
    }
    const factor = binder.expression.interpolationFactor(zoom, binder.zoom, binder.zoom + 1);
    return Math.max(0, Math.min(1, Number.isFinite(factor) ? factor : 0));
  }

  /** Whether a paint property has zoom-interpolated per-feature values. */
  isCompositeProperty(property: string): boolean {
    return this.binders[property] instanceof CompositeExpressionBinder;
  }

  hasCompositeProperties(): boolean {
    for (const property in this.binders) {
      if (this.binders[property] instanceof CompositeExpressionBinder) {
        return true;
      }
    }
    return false;
  }

  hasStateDependentGeometry(): boolean {
    return Object.values(this.binders).some(binder =>
      binder.expression.isStateDependent
      && (binder.expression instanceof ZoomConstantExpression || binder.expression instanceof ZoomDependentExpression)
      && expressionNeedsGeometry(binder.expression._styleExpression.expression),
    );
  }

  populatePaintArrays(newLength: number, feature: Feature, options: PaintOptions): void {
    for (const property in this.binders) {
      this.binders[property].populatePaintArray(newLength, feature, options);
    }
  }

  updatePaintArrays(
    featureStates: FeatureStates,
    rangesById: ReadonlyMap<string, FeaturePaintRange[]>,
    lookup: FeatureLookup,
    layer: TypedStyleLayer,
    options: PaintOptions,
  ): boolean {
    let dirty: boolean = false;
    for (const fs of featureStates) {
      const positions = rangesById.get(String(fs.id)) ?? [];

      for (const pos of positions) {
        const feature = lookup(pos.index);

        for (const property in this.binders) {
          const binder = this.binders[property];
          if (binder.expression.isStateDependent === true) {
            // Refresh the binder from the layer's current evaluated state expression.
            const value = getPaintProperty(layer, property);
            if (value instanceof PossiblyEvaluatedPropertyValue && value.value.kind !== 'constant') {
              binder.expression = value.value;
              binder.updatePaintArray(pos.start, pos.end, feature, fs.state, { ...options, formattedSection: pos.formattedSection });
              dirty = true;
            }
          }
        }
      }
    }
    return dirty;
  }
}

export class ProgramConfigurationSet<Layer extends TypedStyleLayer> {
  programConfigurations: { [_: string]: ProgramConfiguration };
  _bufferOffset: number;
  _featureRanges: FeaturePaintRange[];
  /** Increments when feature-state paint attributes are changed in place. */
  paintRevision = 0;
  /** Main-thread lookup cache; omitted from worker transfer and rebuilt lazily. */
  _featureRangeByIndex?: Map<number, FeaturePaintRange>;
  _featureRangesById?: Map<string, FeaturePaintRange[]>;

  constructor(layers: readonly Layer[], zoom: number, filterProperties: (_: string) => boolean = () => true) {
    this.programConfigurations = {};
    for (const layer of layers) {
      this.programConfigurations[layer.id] = new ProgramConfiguration(layer, zoom, filterProperties);
    }
    this._bufferOffset = 0;
    this._featureRanges = [];
    this._featureRangeByIndex = new Map();
  }

  populatePaintArrays(length: number, feature: Feature, index: number, options: PaintOptions): void {
    for (const key in this.programConfigurations) {
      this.programConfigurations[key].populatePaintArrays(length, feature, options);
    }

    const range: FeaturePaintRange = {
      index,
      start: this._bufferOffset,
      end: length,
      id: feature.id,
      formattedSection: options.formattedSection ? { ...options.formattedSection } : undefined,
    };
    this._featureRanges.push(range);
    this._featureRangeByIndex?.set(index, range);
    this._featureRangesById = undefined;
    this._bufferOffset = length;
  }

  updatePaintArrays(featureStates: FeatureStates, lookup: FeatureLookup, layers: readonly TypedStyleLayer[], options: PaintOptions): void {
    if (!this._featureRangesById) {
      this._featureRangesById = new Map();
      for (const range of this._featureRanges) {
        if (range.id === undefined)
          continue;
        const id = String(range.id);
        const ranges = this._featureRangesById.get(id);
        if (ranges)
          ranges.push(range);
        else
          this._featureRangesById.set(id, [range]);
      }
    }
    let changed = false;
    for (const layer of layers) {
      changed = this.programConfigurations[layer.id].updatePaintArrays(
        featureStates,
        this._featureRangesById,
        lookup,
        layer,
        options,
      ) || changed;
    }
    if (changed) {
      this.paintRevision++;
    }
  }

  get(layerId: string): ProgramConfiguration {
    const configuration = this.programConfigurations[layerId];
    if (!configuration) {
      throw new Error(`No program configuration found for layer ${layerId}`);
    }
    return configuration;
  }

  hasCompositeProperties(): boolean {
    for (const configuration of Object.values(this.programConfigurations)) {
      if (configuration.hasCompositeProperties()) {
        return true;
      }
    }
    return false;
  }

  hasStateDependentGeometry(): boolean {
    return Object.values(this.programConfigurations).some(configuration => configuration.hasStateDependentGeometry());
  }

  /**
   * The per-feature ranges within the paint attribute arrays, in
   * feature processing order.
   */
  getFeatureRanges(): FeaturePaintRange[] {
    return this._featureRanges;
  }

  /**
   * Resolve a feature range in O(1). Style evaluation runs once per rendered
   * feature and the previous linear scan turned a bucket with F features into
   * another O(F²) pass on every frame.
   */
  getFeatureRange(featureIndex: number): FeaturePaintRange | undefined {
    if (!this._featureRangeByIndex) {
      this._featureRangeByIndex = new Map(
        this._featureRanges.map(range => [range.index, range]),
      );
    }
    return this._featureRangeByIndex.get(featureIndex);
  }
}

function expressionNeedsGeometry(expression: Expression): boolean {
  if ([expressions.within, expressions.distance].some(ExpressionType => expression instanceof ExpressionType))
    return true;
  let needsGeometry = false;
  expression.eachChild((child) => {
    needsGeometry = needsGeometry || expressionNeedsGeometry(child);
  });
  return needsGeometry;
}

type BinderType = 'source' | 'composite';

function getLayoutException(property: string): Partial<Record<BinderType, StructArrayConstructor>> | undefined {
  const propertyExceptions: Record<string, Partial<Record<BinderType, StructArrayConstructor>>> = {
    'line-pattern': {
      source: PatternLayoutArray,
      composite: PatternLayoutArray,
    },
    'fill-pattern': {
      source: PatternLayoutArray,
      composite: PatternLayoutArray,
    },
    'fill-extrusion-pattern': {
      source: PatternLayoutArray,
      composite: PatternLayoutArray,
    },
    'line-dasharray': {
      source: DashLayoutArray,
      composite: DashLayoutArray,
    },
  };

  return propertyExceptions[property];
}

function layoutType(property: string, type: string, binderType: BinderType): StructArrayConstructor | undefined {
  const defaultLayouts: Record<PaintType, Record<BinderType, StructArrayConstructor>> = {
    color: {
      source: StructArrayLayout2f8,
      composite: StructArrayLayout4f16,
    },
    number: {
      source: StructArrayLayout1f4,
      composite: StructArrayLayout2f8,
    },
  };

  const layoutException = getLayoutException(property);
  return layoutException?.[binderType] ?? defaultLayouts[type as PaintType]?.[binderType];
}

function toPaintType(type: string): PaintType | undefined {
  return type === 'color' || type === 'number' ? type : undefined;
}

function getPaintProperty(layer: TypedStyleLayer, property: string): PaintPropertyResult {
  return (layer.paint as PaintAccessor).get(property);
}

export function registerProgramConfigurationTransfers(registry: TransferRegistry): void {
  registry.register('SourceExpressionBinder', SourceExpressionBinder);
  registry.register('CrossFadedPatternBinder', CrossFadedPatternBinder);
  registry.register('CrossFadedDasharrayBinder', CrossFadedDasharrayBinder);
  registry.register('CompositeExpressionBinder', CompositeExpressionBinder);
  registry.register('ProgramConfiguration', ProgramConfiguration);
  registry.register('ProgramConfigurationSet', ProgramConfigurationSet, { omit: ['_featureRangeByIndex', '_featureRangesById'] });
}
