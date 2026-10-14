import type { FeatureStates } from '../source/source-state';
import type { CircleStyleLayer } from '../style/style-layer/circle-style-layer';
import type { FillExtrusionStyleLayer } from '../style/style-layer/fill-extrusion-style-layer';
import type { FillStyleLayer } from '../style/style-layer/fill-style-layer';
import type { LineStyleLayer } from '../style/style-layer/line-style-layer';
import type { SymbolStyleLayer } from '../style/style-layer/symbol-style-layer';
import type { SizeData } from '../symbol/symbol-size';
import type { TransferRegistry } from '../worker/transfer-registry';
import type { FillExtrusionLayoutArray, FillLayoutArray, GlyphOffsetArray, PosArray, SymbolInstanceArray, SymbolLineVertexArray, TextAnchorOffsetArray } from './array-types.g';
import type { Bucket } from './bucket';
import type { PackedLinePaths } from './line-path-transfer';
import type { FeatureLookup, PaintOptions, ProgramConfigurationSet } from './program-configuration';
import type { ProjectedBucketGeometry } from './projected-geometry';
import type { PackedProjectedGeometry } from './projected-geometry-transfer';
import { PlacedSymbolArray, SymbolLayoutArray, TriangleIndexArray } from './array-types.g';
import { restoreLinePaths, serializeLinePaths } from './line-path-transfer';
import { restoreProjectedGeometry, serializeProjectedGeometry } from './projected-geometry-transfer';
import { SegmentVector } from './segment';

/** Geometry span owned by a source feature; independent of its dense paint slot. */
export interface FeatureGeometryRange {
  featureIndex: number;
  start: number;
  end: number;
}

/**
 * Shared tile data and paint updates; worker builders initialize these declared
 * fields, and TransferRegistry restores them without running a constructor.
 */
export class CircleBucket<Layer extends CircleStyleLayer = CircleStyleLayer> implements Bucket {
  declare projectedGeometry?: ProjectedBucketGeometry;
  declare index: number;
  declare zoom: number;
  declare overscaling: number;
  declare layerIds: string[];
  declare layers: Layer[];
  declare stateDependentLayers: Layer[];
  declare stateDependentLayerIds: string[];

  /** One tile-local center per point, in feature / circle-sort-key order. */
  declare layoutVertexArray: PosArray;
  /** Point spans, with one entry per feature. */
  declare geometryRanges: FeatureGeometryRange[];

  declare hasDependencies: boolean;
  declare programConfigurations: ProgramConfigurationSet<Layer>;

  update(states: FeatureStates, lookup: FeatureLookup, options: PaintOptions): void {
    if (!this.stateDependentLayers.length)
      return;
    this.programConfigurations.updatePaintArrays(states, lookup, this.stateDependentLayers, options);
  }

  isEmpty(): boolean {
    return this.layoutVertexArray.length === 0;
  }
}

export class FillBucket implements Bucket {
  declare projectedGeometry?: ProjectedBucketGeometry;
  declare index: number;
  declare zoom: number;
  declare overscaling: number;
  declare layers: FillStyleLayer[];
  declare layerIds: string[];
  declare stateDependentLayers: FillStyleLayer[];
  declare stateDependentLayerIds: string[];

  declare layoutVertexArray: FillLayoutArray;

  declare indexArray: TriangleIndexArray;

  declare hasDependencies: boolean;
  declare programConfigurations: ProgramConfigurationSet<FillStyleLayer>;
  declare segments: SegmentVector;

  /**
   * One entry per polygon (or Uint16 segment chunk) added by `addFeature`:
   * its source feature index, vertex range within the
   * layout array, its triangle range within the index array, and the vertex
   * indices (relative to the polygon start) at which each hole ring starts.
   * Segments are buffer chunks that may contain several polygons, so this is
   * the authoritative per-polygon geometry used by the Cesium rendering
   * backend.
   * polygonGroupId identifies one original classified polygon, including
   * all of its segment chunks; separate components never share that ID.
   */
  declare polygons: Array<{ polygonGroupId: number; featureIndex: number; vertexOffset: number; vertexLength: number; primitiveOffset: number; primitiveLength: number; holes: number[] }>;

  update(states: FeatureStates, lookup: FeatureLookup, options: PaintOptions): void {
    if (!this.stateDependentLayers.length)
      return;
    this.programConfigurations.updatePaintArrays(states, lookup, this.stateDependentLayers, options);
  }

  isEmpty(): boolean {
    return this.layoutVertexArray.length === 0;
  }
}

export class FillExtrusionBucket implements Bucket {
  declare index: number;
  declare zoom: number;
  declare overscaling: number;
  declare layers: FillExtrusionStyleLayer[];
  declare layerIds: string[];
  declare stateDependentLayers: FillExtrusionStyleLayer[];
  declare stateDependentLayerIds: string[];

  declare layoutVertexArray: FillExtrusionLayoutArray;

  /** Layout-vertex spans covering every polygon and segment of each feature. */
  declare geometryRanges: FeatureGeometryRange[];

  declare indexArray: TriangleIndexArray;

  declare hasDependencies: boolean;
  declare programConfigurations: ProgramConfigurationSet<FillExtrusionStyleLayer>;
  declare segments: SegmentVector;

  update(states: FeatureStates, lookup: FeatureLookup, options: PaintOptions): void {
    if (!this.stateDependentLayers.length)
      return;
    this.programConfigurations.updatePaintArrays(states, lookup, this.stateDependentLayers, options);
  }

  isEmpty(): boolean {
    return this.layoutVertexArray.length === 0;
  }
}

export interface LineJoinCap {
  join: string;
  cap: string;
  miterLimit: number;
  roundLimit: number;
}

export class LineBucket implements Bucket {
  declare projectedGeometry?: ProjectedBucketGeometry;
  declare index: number;
  declare zoom: number;
  declare layers: LineStyleLayer[];
  declare layerIds: string[];
  declare stateDependentLayers: LineStyleLayer[];
  declare stateDependentLayerIds: string[];
  declare linePaths: Array<{ featureIndex: number; points: Int16Array }>;
  declare lineJoinCap: LineJoinCap;
  declare featureLineJoinCaps: Record<number, LineJoinCap>;
  declare programConfigurations: ProgramConfigurationSet<LineStyleLayer>;
  declare hasDependencies: boolean;

  update(states: FeatureStates, lookup: FeatureLookup, options: PaintOptions): void {
    if (!this.stateDependentLayers.length)
      return;
    this.programConfigurations.updatePaintArrays(states, lookup, this.stateDependentLayers, options);
  }

  isEmpty(): boolean {
    return this.linePaths.length === 0;
  }
}

export class SymbolBuffers {
  layoutVertexArray: SymbolLayoutArray;

  indexArray: TriangleIndexArray;

  programConfigurations: ProgramConfigurationSet<SymbolStyleLayer>;
  segments: SegmentVector;

  placedSymbolArray: PlacedSymbolArray;

  constructor(programConfigurations: ProgramConfigurationSet<SymbolStyleLayer>) {
    this.layoutVertexArray = new SymbolLayoutArray();
    this.indexArray = new TriangleIndexArray();
    this.programConfigurations = programConfigurations;
    this.segments = new SegmentVector();
    this.placedSymbolArray = new PlacedSymbolArray();
  }
}

export class SymbolBucket implements Bucket {
  declare zoom: number;
  declare layers: SymbolStyleLayer[];
  declare layerIds: string[];
  declare stateDependentLayers: SymbolStyleLayer[];
  declare stateDependentLayerIds: string[];

  declare index: number;
  declare sdfIcons?: boolean;
  declare justReloaded: boolean;
  declare hasDependencies: boolean;

  declare textSizeData: SizeData;
  declare iconSizeData: SizeData;

  declare glyphOffsetArray: GlyphOffsetArray;
  declare lineVertexArray: SymbolLineVertexArray;
  declare symbolInstances: SymbolInstanceArray;
  declare textAnchorOffsets: TextAnchorOffsetArray;
  declare tilePixelRatio: number;

  declare text: SymbolBuffers;
  declare icon: SymbolBuffers;

  update(states: FeatureStates, lookup: FeatureLookup, options: PaintOptions): void {
    if (!this.stateDependentLayers.length)
      return;
    this.text.programConfigurations.updatePaintArrays(states, lookup, this.layers, options);
    this.icon.programConfigurations.updatePaintArrays(states, lookup, this.layers, options);
  }

  isEmpty(): boolean {
    return this.symbolInstances.length === 0;
  }
}

/** Worker builder subclasses retain these wire identities through their runtime parent. */
export function registerBucketTransfers(registry: TransferRegistry): void {
  registry.register<CircleBucket & { availableImages?: string[] }>('CircleBucket', CircleBucket, { omit: ['layers', 'stateDependentLayers', 'availableImages'], serialize: serializeProjectedBucket, restore: restoreProjectedBucket });
  registry.register<FillBucket & { patternFeatures?: unknown; availableImages?: string[] }>('FillBucket', FillBucket, { omit: ['layers', 'patternFeatures', 'stateDependentLayers', 'availableImages'], serialize: serializeProjectedBucket, restore: restoreProjectedBucket });
  registry.register<FillExtrusionBucket & { features?: unknown; availableImages?: string[] }>('FillExtrusionBucket', FillExtrusionBucket, { omit: ['layers', 'features', 'stateDependentLayers', 'availableImages'] });
  registry.register<LineBucket & { patternFeatures?: unknown; availableImages?: string[] }>('LineBucket', LineBucket, {
    omit: ['layers', 'patternFeatures', 'stateDependentLayers', 'availableImages'],
    serialize: bucket => ({ ...serializeProjectedBucket(bucket), linePaths: serializeLinePaths(bucket.linePaths) }),
    restore: (bucket) => {
      const packed = bucket as unknown as { linePaths: PackedLinePaths };
      bucket.linePaths = restoreLinePaths(packed.linePaths);
      restoreProjectedBucket(bucket);
    },
  });
  registry.register('SymbolBuffers', SymbolBuffers);
  registry.register<SymbolBucket & { collisionBoxArray?: unknown; features?: unknown; compareText?: unknown; availableImages?: string[] }>('SymbolBucket', SymbolBucket, {
    omit: ['layers', 'collisionBoxArray', 'features', 'compareText', 'availableImages'],
  });
}

function serializeProjectedBucket(bucket: { projectedGeometry?: ProjectedBucketGeometry }): Record<string, unknown> {
  return { ...bucket, projectedGeometry: bucket.projectedGeometry && serializeProjectedGeometry(bucket.projectedGeometry) };
}

function restoreProjectedBucket(bucket: { projectedGeometry?: ProjectedBucketGeometry }): void {
  const packed = bucket as unknown as { projectedGeometry?: PackedProjectedGeometry };
  if (packed.projectedGeometry)
    bucket.projectedGeometry = restoreProjectedGeometry(packed.projectedGeometry);
}
