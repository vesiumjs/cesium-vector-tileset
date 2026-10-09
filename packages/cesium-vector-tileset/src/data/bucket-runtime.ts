import type { FeatureStates } from '../source/source-state';
import type { CircleStyleLayer } from '../style/style-layer/circle-style-layer';
import type { FillExtrusionStyleLayer } from '../style/style-layer/fill-extrusion-style-layer';
import type { FillStyleLayer } from '../style/style-layer/fill-style-layer';
import type { LineStyleLayer } from '../style/style-layer/line-style-layer';
import type { SymbolStyleLayer } from '../style/style-layer/symbol-style-layer';
import type { SizeData } from '../symbol/symbol-size';
import type { TransferRegistry } from '../worker/transfer-registry';
import type { FillExtrusionLayoutArray, FillLayoutArray, GlyphOffsetArray, PosArray, SymbolInstanceArray, SymbolLineVertexArray } from './array-types.g';
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

/** Shared tile data and paint updates; geometry and symbol builders stay in the worker. */
export class CircleBucket<Layer extends CircleStyleLayer = CircleStyleLayer> implements Bucket {
  projectedGeometry?: ProjectedBucketGeometry;
  index: number;
  zoom: number;
  overscaling: number;
  layerIds: string[];
  layers: Layer[];
  stateDependentLayers: Layer[];
  stateDependentLayerIds: string[];

  /** One tile-local center per point, in feature / circle-sort-key order. */
  layoutVertexArray: PosArray;
  /** Point spans, with one entry per feature. */
  geometryRanges: FeatureGeometryRange[];

  hasDependencies: boolean;
  programConfigurations: ProgramConfigurationSet<Layer>;

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
  projectedGeometry?: ProjectedBucketGeometry;
  index: number;
  zoom: number;
  overscaling: number;
  layers: FillStyleLayer[];
  layerIds: string[];
  stateDependentLayers: FillStyleLayer[];
  stateDependentLayerIds: string[];

  layoutVertexArray: FillLayoutArray;

  indexArray: TriangleIndexArray;

  hasDependencies: boolean;
  programConfigurations: ProgramConfigurationSet<FillStyleLayer>;
  segments: SegmentVector;

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
  polygons: Array<{ polygonGroupId: number; featureIndex: number; vertexOffset: number; vertexLength: number; primitiveOffset: number; primitiveLength: number; holes: number[] }>;

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
  index: number;
  zoom: number;
  overscaling: number;
  layers: FillExtrusionStyleLayer[];
  layerIds: string[];
  stateDependentLayers: FillExtrusionStyleLayer[];
  stateDependentLayerIds: string[];

  layoutVertexArray: FillExtrusionLayoutArray;

  /** Layout-vertex spans covering every polygon and segment of each feature. */
  geometryRanges: FeatureGeometryRange[];

  indexArray: TriangleIndexArray;

  hasDependencies: boolean;
  programConfigurations: ProgramConfigurationSet<FillExtrusionStyleLayer>;
  segments: SegmentVector;

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
  projectedGeometry?: ProjectedBucketGeometry;
  index: number;
  zoom: number;
  layers: LineStyleLayer[];
  layerIds: string[];
  stateDependentLayers: LineStyleLayer[];
  stateDependentLayerIds: string[];
  linePaths: Array<{ featureIndex: number; points: Int16Array }>;
  lineJoinCap: LineJoinCap;
  featureLineJoinCaps: Record<number, LineJoinCap>;
  programConfigurations: ProgramConfigurationSet<LineStyleLayer>;
  hasDependencies: boolean;

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
  zoom: number;
  layers: SymbolStyleLayer[];
  layerIds: string[];
  stateDependentLayers: SymbolStyleLayer[];
  stateDependentLayerIds: string[];

  index: number;
  sdfIcons?: boolean;
  justReloaded: boolean;
  hasDependencies: boolean;

  textSizeData: SizeData;
  iconSizeData: SizeData;

  glyphOffsetArray: GlyphOffsetArray;
  lineVertexArray: SymbolLineVertexArray;
  symbolInstances: SymbolInstanceArray;
  tilePixelRatio: number;

  text: SymbolBuffers;
  icon: SymbolBuffers;
  hasRTLText: boolean;

  update(states: FeatureStates, lookup: FeatureLookup, options: PaintOptions): void {
    if (!this.stateDependentLayers.length)
      return;
    this.text.programConfigurations.updatePaintArrays(states, lookup, this.layers, options);
    this.icon.programConfigurations.updatePaintArrays(states, lookup, this.layers, options);
  }

  isEmpty(): boolean {
    // When the bucket encounters only rtl-text but the plugin isn't loaded, no symbol instances will be created.
    // In order for the bucket to be serialized, and not discarded as an empty bucket both checks are necessary.
    return this.symbolInstances.length === 0 && !this.hasRTLText;
  }

  hasTextData(): boolean {
    return this.text.segments.get().length > 0;
  }

  hasIconData(): boolean {
    return this.icon.segments.get().length > 0;
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
