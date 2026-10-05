import type { Bucket } from '../../data/bucket';
import type { DashMaterial } from '../line/dash-material';
import type { LineBuildState } from '../line/line-renderer';
import type { Budget } from '../scene/frame-budget';
import type { ExtrusionLighting } from './extrusion-geometry';
import type { ExtrusionPrimitive } from './extrusion-primitive';
import type { TilePickObject } from './tile-conversion';
import type { VectorCollection, VectorTileRecord } from './vector-tile-renderer';
import {
  BlendOption,
  BufferPoint,
  BufferPointCollection,
  BufferPointMaterial,
  BufferPolygon,
  BufferPolygonCollection,
  BufferPolygonMaterial,
  Color,
  ColorGeometryInstanceAttribute,
  PrimitiveCollection,
  SceneMode,
  ShowGeometryInstanceAttribute,
} from 'cesium';
import { CircleBucket, FillBucket, FillExtrusionBucket } from '../../data/bucket-runtime';
import { samePaintZoom } from '../../style/render-transition';
import { beginLineBuild, canResumeLineBuild, canUpdateLinePaint, commitLineBuild, stepLineBuild, updateLinePaint } from '../line/line-renderer';
import { drawBatchForOwner } from '../scene/draw-batch';
import { UNBOUNDED_BUDGET } from '../scene/frame-budget';
import { deferredExtrusionLayers } from './extrusion-primitive';
import { circlePaintVisible, circleStyleForFeature, constantValue, fillStyleForFeature, layerFor, paintRevision } from './feature-attributes';
import { buildExtrusionCollection } from './vector-tile-builder';

const colorValue = new Uint8Array(4);
const showValue = new Uint8Array(1);

/** Fill and circle paint use a zoom-step cache; line uniforms follow continuous zoom. */
export const PAINT_ZOOM_STEP = 1 / 8;

/**
 * Integer style-cache key: a bucket index for ordinary paints (evaluated
 * values only change at integer zoom boundaries) and a quantized step index
 * for zoom-dependent ones. Integer keys compare exactly, so float noise in
 * the derived camera zoom can never split a step.
 */
function paintZoomKey(zoom: number, zoomDependent: boolean): number {
  return zoomDependent === true ? Math.round(zoom / PAINT_ZOOM_STEP) : Math.floor(zoom);
}

export interface VectorCollectionReplacement {
  tileId: string;
  old: VectorCollection;
  replacement: VectorCollection;
}

export interface VectorPaintPreparation {
  replacements: VectorCollectionReplacement[];
  /** False while current line geometry is still being built. */
  ready: boolean;
}

export interface VectorPaintFrame {
  zoom: number;
  /** Identifies one StyleEvaluation.evaluate shared by update and upload preparation. */
  evaluationId?: number;
  force?: boolean;
  styleRevision?: number;
  transitionLayerIds?: ReadonlySet<string>;
  pixelRatio?: number;
  lightRevision?: number;
  budget?: Budget;
}

interface PaintCacheEntry {
  zoomBucket: number;
  styleRevision: number;
  paintRevisions: readonly number[];
}

interface ExtrusionCacheEntry {
  zoomBucket: number;
  paintRevisions: readonly number[];
  lightRevision: number;
}

export interface VectorPaintState {
  buckets: readonly Bucket[];
  frozen: boolean;
  lastEvaluationId?: number;
  lastZoom?: number;
  lastStyleRevision?: number;
  lastPaintRevisions?: readonly number[];
  lastPixelRatio?: number;
  lastLightRevision?: number;
  extrusionZoomDependent: boolean;
  zoomDependentPaint: boolean;
  styleCache?: PaintCacheEntry;
  extrusionCache?: ExtrusionCacheEntry;
  lineCache?: PaintCacheEntry;
  lineBuild?: LineBuildState;
}

interface VectorPaintSeed {
  buckets: readonly Bucket[];
  paintRevisions: readonly number[];
  styleZoom: number;
  styleRevision?: number;
  lightRevision?: number;
  pixelRatio: number;
  standard: boolean;
}

/** Seed the paint state from the values already evaluated during tile construction. */
export function createVectorPaintState(seed: VectorPaintSeed): VectorPaintState {
  const { buckets, paintRevisions, styleZoom, styleRevision, lightRevision, pixelRatio, standard } = seed;
  const zoomDependentPaint = hasZoomDependentPaint(buckets);
  const extrusionZoomDependent = hasZoomDependentExtrusionPaint(buckets);
  const seeded = styleRevision !== undefined && !standard;
  return {
    buckets,
    frozen: false,
    zoomDependentPaint,
    extrusionZoomDependent,
    styleCache: seeded
      ? { zoomBucket: paintZoomKey(styleZoom, zoomDependentPaint), styleRevision, paintRevisions }
      : undefined,
    extrusionCache: styleRevision !== undefined && lightRevision !== undefined
      ? { zoomBucket: extrusionZoomDependent ? Math.floor(styleZoom) : 0, paintRevisions, lightRevision }
      : undefined,
    lineCache: styleRevision !== undefined
      ? { zoomBucket: Math.floor(styleZoom), styleRevision, paintRevisions }
      : undefined,
    lastZoom: seeded ? styleZoom : undefined,
    lastStyleRevision: seeded ? styleRevision : undefined,
    lastPaintRevisions: seeded ? paintRevisions : undefined,
    lastPixelRatio: seeded ? pixelRatio : undefined,
    lastLightRevision: seeded ? lightRevision : undefined,
  };
}

interface VectorPaintOptions {
  records: () => Iterable<[string, VectorTileRecord]>;
  pixelRatio: () => number;
  lighting: () => ExtrusionLighting | undefined;
  dashMaterial?: DashMaterial;
  replace: (
    tileId: string,
    kind: string,
    old: VectorCollection,
    replacement: VectorCollection,
    replacements: VectorCollectionReplacement[],
  ) => void;
}

/** Evaluates paint and rebuilds affected geometry; the store applies ownership changes. */
export class VectorPaintUpdater {
  private readonly _options: VectorPaintOptions;
  private _lastZoom = -Infinity;
  private _lastStyleRevision = -1;
  private _lastPixelRatio = -1;
  private _lastLightRevision = -1;
  private _dirty = true;
  private _polygonMaterial?: BufferPolygonMaterial;
  private _pointMaterial?: BufferPointMaterial;
  needsContinuation = false;

  constructor(options: VectorPaintOptions) {
    this._options = options;
  }

  /** A restored or newly committed tile must enter the next paint walk. */
  invalidate(): void {
    this._dirty = true;
  }

  /** Held generations keep their committed paint until a rebuilt generation replaces them. */
  freezeExisting(): void {
    for (const [, record] of this._options.records()) {
      record.paint.frozen = true;
      record.paint.lineBuild = undefined;
    }
  }

  /**
   * Refresh paint values on already-created Buffer primitives. Geometry stays
   * in the collection, so continuous zoom expressions do not force a full ECEF
   * conversion on every frame.
   *
   * Line width and color update through a live uniform or per-instance
   * attribute. Their centerlines survive camera zoom changes.
   *
   * Returns collections whose baked geometry or line layout had to be rebuilt.
   * The caller retires the old scene owner and adds its replacement.
   */
  update(frame: VectorPaintFrame): VectorCollectionReplacement[] {
    const {
      zoom,
      force = false,
      styleRevision = 0,
      pixelRatio = this._options.pixelRatio(),
      lightRevision = 0,
      budget,
    } = frame;
    this.needsContinuation = false;
    if (!this._dirty && !force
      && samePaintZoom(this._lastZoom, zoom)
      && this._lastStyleRevision === styleRevision
      && this._lastPixelRatio === pixelRatio
      && this._lastLightRevision === lightRevision) {
      return [];
    }
    const replacements: Array<{ tileId: string; old: VectorCollection; replacement: VectorCollection }> = [];
    const buildFrame = budget ? frame : { ...frame, budget: UNBOUNDED_BUDGET };
    for (const [tileId, record] of this._options.records()) {
      if (!this._updateRecord(tileId, record, buildFrame, replacements, budget)) {
        this.needsContinuation = true;
        break;
      }
    }
    if (this.needsContinuation) {
      this._dirty = true;
    }
    else {
      this._lastZoom = zoom;
      this._lastStyleRevision = styleRevision;
      this._lastPixelRatio = pixelRatio;
      this._lastLightRevision = lightRevision;
      this._dirty = false;
    }
    return replacements;
  }

  /** Refresh one restored owner before its collections can re-enter the scene. */
  refresh(tileId: string, record: VectorTileRecord, frame: VectorPaintFrame): VectorPaintPreparation {
    const replacements: VectorCollectionReplacement[] = [];
    const ready = this._updateRecord(tileId, record, frame, replacements);
    if (!ready) {
      this.needsContinuation = true;
      this.invalidate();
    }
    return { replacements, ready };
  }

  private _updateRecord(tileId: string, record: VectorTileRecord, frame: VectorPaintFrame, replacements: VectorCollectionReplacement[], budget?: Budget): boolean {
    const {
      zoom,
      force = false,
      styleRevision = 0,
      transitionLayerIds,
      pixelRatio = this._options.pixelRatio(),
      lightRevision = 0,
    } = frame;
    if (record.paint.frozen) {
      return true;
    }
    const styleChanged = record.paint.lastStyleRevision !== styleRevision;
    const zoomChanged = record.paint.lastZoom !== zoom;
    const paintChanged = !samePaintRevisions(record);
    // Line strips use Cesium's pixel-ratio uniform in every mode.
    const pixelRatioChanged = record.paint.lastPixelRatio !== pixelRatio;
    // Extrusion light uniforms change without a style revision
    // (setLight, light transitions).
    const lightChanged = record.paint.lastLightRevision !== lightRevision;
    const inputsChanged = styleChanged || zoomChanged || paintChanged || pixelRatioChanged || lightChanged;
    const alreadyEvaluated = frame.evaluationId !== undefined && record.paint.lastEvaluationId === frame.evaluationId;
    const forceRecord = force
      && !(alreadyEvaluated && !inputsChanged)
      && (!transitionLayerIds || record.layerIds.some(layerId => transitionLayerIds.has(layerId)));
    const unchanged = !record.paint.lineBuild && !forceRecord && !inputsChanged;
    if (unchanged) {
      record.paint.lastEvaluationId = frame.evaluationId;
      return true;
    }
    if (record.paint.lineBuild && (!frame.budget || frame.budget.exhausted)) {
      return false;
    }
    // A zoom change cannot affect source-data or truly constant paint
    // values. Do not walk every feature just because Style recalculated its
    // zoom. A style mutation or feature-state update still takes the normal
    // path; constant paints with zoom (camera) expressions take the walk.
    if (!forceRecord && zoomChanged && !styleChanged && !paintChanged && !pixelRatioChanged && !lightChanged
      && !record.paint.zoomDependentPaint && !record.paint.lineBuild) {
      record.paint.lastZoom = zoom;
      record.paint.lastEvaluationId = frame.evaluationId;
      return true;
    }
    // Upload preparation can already have refreshed this record. Only spend
    // the budget on remaining feature work; cheap cache checks must finish so
    // an exhausted frame does not keep a ready source replacement pending.
    if (budget?.exhausted) {
      return false;
    }
    // A style mutation can change which paints are zoom-dependent; refresh
    // the flags once this record can take its remaining feature work.
    if (styleChanged) {
      record.paint.zoomDependentPaint = hasZoomDependentPaint(record.paint.buckets);
      record.paint.extrusionZoomDependent = hasZoomDependentExtrusionPaint(record.paint.buckets);
    }
    const paintRevisions = paintChanged ? record.paint.buckets.map(paintRevision) : record.paint.lastPaintRevisions!;
    const zoomBucket = Math.floor(zoom);
    // Native owners retain their applied paint across frames. The cache
    // records the inputs applied to those owners: the zoom key, the style
    // revision, and the paint revisions. Transition frames (forceRecord)
    // re-evaluate because transitioning paints change continuously.
    //
    // Zoom-dependent paints use a finer key: their values
    // interpolate with the camera zoom (ProgramConfiguration applies the
    // interpolation factor every frame), so a whole-bucket key would freeze
    // them for the bucket and make widths/colors step. They key on a
    // quantized zoom step instead: fine enough to keep the interpolation
    // looking continuous (see PAINT_ZOOM_STEP), coarse enough that the cache
    // survives the frames inside one step - which matters because a miss
    // re-evaluates every feature of the record.
    const styleCacheZoom = paintZoomKey(zoom, record.paint.zoomDependentPaint);
    const styleCache = record.paint.styleCache;
    const styleCacheValid = styleCache !== undefined
      && styleCache.zoomBucket === styleCacheZoom
      && styleCache.styleRevision === styleRevision
      && sameRevisions(styleCache.paintRevisions, paintRevisions);
    const useStyleCache = !forceRecord && styleCacheValid;
    // Line paint follows continuous zoom independently of the style cache;
    // retaining an applied polygon color must not freeze a line uniform.
    const lineCache = record.paint.lineCache;
    const lineCacheValid = lineCache !== undefined
      && lineCache.styleRevision === styleRevision
      && lineCache.zoomBucket === zoomBucket
      && sameRevisions(lineCache.paintRevisions, paintRevisions);
    const dash = this._options.dashMaterial ? { material: this._options.dashMaterial, rows: record.dashRows } : undefined;
    const lines = record.collections.get('lines');
    if (lines instanceof PrimitiveCollection) {
      // Once admitted, validation and at least one feature form a progress
      // unit. Validation spending the deadline cannot strand every frame.
      const canBuild = frame.budget !== undefined && !frame.budget.exhausted;
      if ((!lineCacheValid || record.paint.lineBuild) && !canUpdateLinePaint(lines, record.buckets, dash)) {
        if (!canBuild) {
          return false;
        }
        if (!record.paint.lineBuild || !canResumeLineBuild(record.paint.lineBuild)) {
          record.paint.lineBuild = beginLineBuild(record.linePrimitives, record.buckets, tileId, record.tileID, record.generationId, zoom, record.mode !== SceneMode.SCENE3D, dash);
        }
        const build = record.paint.lineBuild;
        build.zoom = zoom;
        if (!stepLineBuild(build, frame.budget!)) {
          return false;
        }
        const replacement = commitLineBuild(build) ?? new PrimitiveCollection();
        // Paint may have changed while geometry was built across frames.
        // Apply one current evaluation to every new instance before upload.
        updateLinePaint(replacement, record.buckets, zoom, true);
        record.paint.lineBuild = undefined;
        this._options.replace(tileId, 'lines', lines, replacement, replacements);
        record.paint.lineCache = { zoomBucket, styleRevision, paintRevisions };
      }
      else if (record.paint.lineBuild || !lineCacheValid || styleChanged || paintChanged || zoomChanged || forceRecord) {
        // A style reverting to the old layout cancels an unfinished rebuild.
        // Restored geometry must receive current paint before it draws.
        // A material-only revision needs no asynchronous scene handoff.
        const refresh = !!record.paint.lineBuild || !lineCacheValid || styleChanged || paintChanged;
        record.paint.lineBuild = undefined;
        updateLinePaint(lines, record.buckets, zoom, refresh || forceRecord, refresh ? undefined : transitionLayerIds);
        record.paint.lineCache = { zoomBucket, styleRevision, paintRevisions };
      }
    }
    if (!styleCacheValid) {
      record.paint.styleCache = {
        zoomBucket: styleCacheZoom,
        styleRevision,
        paintRevisions,
      };
    }
    if (record.standard) {
      if (!useStyleCache) {
        updateStandardRenderEntries(record, zoom);
      }
    }
    else {
      if (!useStyleCache) {
        const polygonMaterial = this._polygonMaterial ??= new BufferPolygonMaterial();
        const pointMaterial = this._pointMaterial ??= new BufferPointMaterial();
        // Native wrappers retain their collection and its CPU buffers after get().
        // Reuse them within this walk without keeping an evicted owner alive.
        const polygon = new BufferPolygon();
        const point = new BufferPoint();
        for (const collection of record.collections.values()) {
          if (!(collection instanceof BufferPolygonCollection)) {
            continue;
          }
          let opaque = true;
          for (let index = 0; index < collection.primitiveCount; index++) {
            collection.get(index, polygon);
            const { layerId, featureIndex } = polygon.pickObject as TilePickObject;
            const bucket = record.buckets[layerId];
            if (!(bucket instanceof FillBucket)) {
              continue;
            }
            const style = fillStyleForFeature(bucket, featureIndex, layerId, zoom);
            const currentMaterial = polygon.getMaterial(polygonMaterial);
            opaque &&= style.color.alpha >= 1;
            if (!samePackedColor(currentMaterial.color, style.color)) {
              Color.clone(style.color, currentMaterial.color);
              polygon.setMaterial(currentMaterial);
            }
            const show = style.color.alpha > 0;
            if (polygon.show !== show) {
              polygon.show = show;
            }
          }
          collection.blendOption = opaque ? BlendOption.OPAQUE : BlendOption.TRANSLUCENT;
        }

        for (const collection of record.collections.values()) {
          if (!(collection instanceof BufferPointCollection)) {
            continue;
          }
          for (let index = 0; index < collection.primitiveCount; index++) {
            collection.get(index, point);
            const { layerId, featureIndex } = point.pickObject as TilePickObject;
            const bucket = record.buckets[layerId];
            if (!(bucket instanceof CircleBucket)) {
              continue;
            }
            const style = circleStyleForFeature(bucket, featureIndex, layerId, zoom);
            const currentMaterial = point.getMaterial(pointMaterial) as BufferPointMaterial;
            const outlineWidth = packedByte(style.outlineWidthPx);
            const size = packedByte(style.sizePx, 1);
            if (!samePackedColor(currentMaterial.color, style.color)
              || !samePackedColor(currentMaterial.outlineColor, style.outlineColor)
              || currentMaterial.outlineWidth !== outlineWidth
              || currentMaterial.size !== size) {
              Color.clone(style.color, currentMaterial.color);
              Color.clone(style.outlineColor, currentMaterial.outlineColor);
              currentMaterial.outlineWidth = outlineWidth;
              currentMaterial.size = size;
              point.setMaterial(currentMaterial);
            }
            const show = style.sizePx > 0 && circlePaintVisible(style.color, style.outlineColor, outlineWidth);
            if (point.show !== show) {
              point.show = show;
            }
          }
        }
      }
    }
    this._refreshExtrusions(
      tileId,
      record,
      zoom,
      zoomBucket,
      paintRevisions,
      lightRevision,
      replacements,
    );
    record.paint.lastEvaluationId = frame.evaluationId;
    record.paint.lastZoom = zoom;
    record.paint.lastStyleRevision = styleRevision;
    record.paint.lastPaintRevisions = paintRevisions;
    record.paint.lastPixelRatio = pixelRatio;
    record.paint.lastLightRevision = lightRevision;

    return true;
  }

  /**
   * Apply extrusion paint through Native attributes and uniforms, rebuilding
   * only changed height/base or a layer's deferred first upload. Validate its
   * own revisions even when surface paint is cached.
   */
  private _refreshExtrusions(
    tileId: string,
    record: VectorTileRecord,
    zoom: number,
    zoomBucket: number,
    paintRevisions: readonly number[],
    lightRevision: number,
    replacements: Array<{ tileId: string; old: VectorCollection; replacement: VectorCollection }>,
  ): void {
    const extrusions = record.collections.get('extrusions');
    if (!(extrusions instanceof PrimitiveCollection)) {
      return;
    }
    // Only zoom-dependent extrusion paint needs a zoom bucket. Constant
    // buildings keep their applied paint across unrelated camera changes.
    const extrusionZoomBucket = record.paint.extrusionZoomDependent ? zoomBucket : 0;
    const extrusionCache = record.paint.extrusionCache;
    let paintChanged = extrusionCache === undefined || extrusionCache.zoomBucket !== extrusionZoomBucket;
    if (!paintChanged) {
      for (let index = 0; index < record.paint.buckets.length; index++) {
        if (record.paint.buckets[index] instanceof FillExtrusionBucket
          && extrusionCache!.paintRevisions[index] !== paintRevisions[index]) {
          paintChanged = true;
          break;
        }
      }
    }
    const lightChanged = extrusionCache?.lightRevision !== lightRevision;
    if (!paintChanged && !lightChanged) {
      return;
    }
    const lighting = this._options.lighting();
    // An initially invisible layer deferred extraction. Its first visible
    // paint needs geometry once; subsequent paint keeps that Native owner.
    let rebuild = paintChanged && (deferredExtrusionLayers.get(extrusions) ?? [])
      .some(layerId => constantValue(layerFor(record.buckets[layerId], layerId), 'fill-extrusion-opacity') !== 0);
    for (let index = 0; index < extrusions.length; index++) {
      const primitive = extrusions.get(index) as ExtrusionPrimitive;
      if (paintChanged) {
        const layerId = drawBatchForOwner(primitive)!.layerId;
        if (!primitive.updatePaint(record.buckets[layerId] as FillExtrusionBucket, layerId, zoom)) {
          rebuild = true;
          break;
        }
      }
      if (lightChanged) {
        primitive.setLighting(lighting);
      }
    }
    if (rebuild) {
      const replacement = buildExtrusionCollection(record.buckets, record.tileID, tileId, record.generationId, zoom, lighting)
        ?? new PrimitiveCollection();
      this._options.replace(tileId, 'extrusions', extrusions, replacement, replacements);
    }
    record.paint.extrusionCache = {
      zoomBucket: extrusionZoomBucket,
      paintRevisions,
      lightRevision,
    };
  }
}

function sameColor(a: Color | undefined, b: Color): boolean {
  return !!a
    && a.red === b.red
    && a.green === b.green
    && a.blue === b.blue
    && a.alpha === b.alpha;
}

function packedColorByte(value: number): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return clamped === 1 ? 255 : Math.floor(clamped * 256);
}

function samePackedColor(a: Color | undefined, b: Color): boolean {
  return !!a
    && packedColorByte(a.red) === packedColorByte(b.red)
    && packedColorByte(a.green) === packedColorByte(b.green)
    && packedColorByte(a.blue) === packedColorByte(b.blue)
    && packedColorByte(a.alpha) === packedColorByte(b.alpha);
}

function packedByte(value: number, minimum = 0): number {
  const clamped = Math.max(minimum, Math.min(255, Number.isFinite(value) ? value : minimum));
  return Math.floor(clamped);
}

interface LayerTransitionablePaintInternals {
  value?: { expression?: { kind?: string } };
}

/**
 * A constant paint fed by a zoom (camera) expression changes value on every
 * zoom frame because Style.recalculate re-evaluates the expression at the
 * continuous camera zoom. Such paints are invisible to
 * ProgramConfiguration.hasCompositeProperties() (they produce uniform, not
 * vertex, binders), so the zoom walk must be kept alive for their layers too.
 */
function layerHasZoomDependentConstantPaint(layer: unknown): boolean {
  const transitionable = (layer as {
    _transitionablePaint?: { _values?: Record<string, LayerTransitionablePaintInternals> };
  })._transitionablePaint;
  if (!transitionable?._values) {
    return false;
  }
  for (const property in transitionable._values) {
    if (transitionable._values[property].value?.expression?.kind === 'camera') {
      return true;
    }
  }
  return false;
}

export function hasZoomDependentPaint(buckets: readonly Bucket[]): boolean {
  return buckets.some(bucketHasZoomDependentPaint);
}

function bucketHasZoomDependentPaint(bucket: Bucket): boolean {
  const configurations = (bucket as unknown as {
    programConfigurations?: { hasCompositeProperties?: () => boolean };
  }).programConfigurations;
  if (configurations?.hasCompositeProperties?.() ?? false) {
    return true;
  }
  return bucket.layers.some(layerHasZoomDependentConstantPaint);
}

/**
 * Whether the tile's extrusion paints depend on zoom. Extrusion geometry and
 * lighting are baked per feature, so a zoom-dependent extrusion paint needs a
 * zoom-bucket key; a constant one (Liberty's height/base/color are all
 * source-driven) must not rebuild when an unrelated zoom-dependent layer -
 * a road width ramp, a label size - moves the record's own zoom flag.
 */
export function hasZoomDependentExtrusionPaint(buckets: readonly Bucket[]): boolean {
  return buckets.some(bucket => bucket instanceof FillExtrusionBucket && bucketHasZoomDependentPaint(bucket));
}

function samePaintRevisions(record: VectorTileRecord): boolean {
  const previous = record.paint.lastPaintRevisions;
  const buckets = record.paint.buckets;
  if (!previous || previous.length !== buckets.length) {
    return false;
  }
  for (let index = 0; index < buckets.length; index++) {
    if (previous[index] !== paintRevision(buckets[index])) {
      return false;
    }
  }
  return true;
}

function sameRevisions(a: readonly number[] | undefined, b: readonly number[]): boolean {
  if (!a || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function updateStandardRenderEntries(record: VectorTileRecord, zoom: number): void {
  const standard = record.standard;
  if (!standard) {
    return;
  }
  for (const entry of standard.polygons) {
    const { layerId, featureIndex } = entry.id;
    const bucket = record.buckets[layerId];
    if (!(bucket instanceof FillBucket)) {
      continue;
    }
    const style = fillStyleForFeature(bucket, featureIndex, layerId, zoom);
    const rgba = style.color.toRgba();
    const show = style.color.alpha > 0;
    if (entry.rgba !== rgba || entry.show !== show) {
      const attributes = entry.primitive.getGeometryInstanceAttributes(entry.id);
      if (!attributes) {
        throw new Error(`Missing Cesium geometry instance ${entry.id.layerId}/${entry.id.featureIndex} in ${entry.id.tileId}`);
      }
      if (entry.rgba !== rgba) {
        attributes.color = ColorGeometryInstanceAttribute.toValue(style.color, colorValue);
        entry.rgba = rgba;
      }
      if (entry.show !== show) {
        attributes.show = ShowGeometryInstanceAttribute.toValue(show, showValue);
        entry.show = show;
      }
    }
  }
  for (const point of standard.points) {
    const { layerId, featureIndex } = point.id as TilePickObject;
    const bucket = record.buckets[layerId];
    if (!(bucket instanceof CircleBucket)) {
      continue;
    }
    const style = circleStyleForFeature(bucket, featureIndex, layerId, zoom);
    if (!sameColor(point.color, style.color)) {
      point.color = style.color;
    }
    if (!sameColor(point.outlineColor, style.outlineColor)) {
      point.outlineColor = style.outlineColor;
    }
    const outlineWidth = Math.max(0, Math.min(255, style.outlineWidthPx));
    if (point.outlineWidth !== outlineWidth) {
      point.outlineWidth = outlineWidth;
    }
    const pixelSize = Math.max(1, Math.min(255, style.sizePx));
    if (point.pixelSize !== pixelSize) {
      point.pixelSize = pixelSize;
    }
    const show = style.sizePx > 0 && circlePaintVisible(style.color, style.outlineColor, outlineWidth);
    if (point.show !== show) {
      point.show = show;
    }
  }
}
