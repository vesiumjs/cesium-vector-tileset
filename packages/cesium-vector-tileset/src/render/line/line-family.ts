import type { Color, GeometryInstance } from 'cesium';
import type { LineBucket } from '../../data/bucket-runtime';
import type { FeatureIndex } from '../../data/feature-index';
import type { LineStyleLayer } from '../../style/style-layer/line-style-layer';
import type { GeometryBatchTable } from '../geometry/geometry-primitive';
import type { LinePaintUniforms } from '../scene/draw-batch';
import type { ReplayDrawCommand } from '../scene/draw-command-replay';
import type { LineFeatureStyle } from '../vector/feature-attributes';
import type { FrozenLineCameraPaint } from './frozen-line-paint';
import type { LineTileClip } from './line-tile-clip';
import * as Cesium from 'cesium';
import { Cartesian3, Cartesian4, Color as CesiumColor, ColorGeometryInstanceAttribute } from 'cesium';
import { GeometryPrimitive } from '../geometry/geometry-primitive';
import { registerDrawBatch, registerLinePaint, registerUniformLineExtent } from '../scene/draw-batch';
import { DrawCommandReplay } from '../scene/draw-command-replay';
import { FeaturePicking } from '../scene/feature-picking';
import { sharePrimitiveBytes } from '../scene/resource-memory';
import { layerFor, lineStyleForFeature } from '../vector/feature-attributes';
import { freezeLineCameraPaint, freezeLineFeaturePaint } from './frozen-line-paint';
import { lineAppearanceForMode } from './line-appearance-mode';
import { lineGroundScale } from './line-ground-scale';

interface BatchAttribute {
  functionName: string;
}

interface LineFrame {
  commandList?: ReplayDrawCommand[];
  context?: { createPickId: (object: object) => { color: Color; destroy: () => void } };
}

interface CesiumRuntime {
  BatchTable: new (context: unknown, attributes: BatchAttribute[], instances: number) => GeometryBatchTable;
}

const BatchTable = (Cesium as unknown as CesiumRuntime).BatchTable;

interface UniformLineStyle {
  paint: LineStyleLayer['paint'];
  zoom: number;
  style: LineFeatureStyle;
}

const uniformLineStyles = new WeakMap<LineStyleLayer, UniformLineStyle>();
const appliedUniformStyles = new WeakMap<LinePaintUniforms, LineFeatureStyle>();

/** Uniform owners share scalar paint from the same evaluated StyleLayer. */
export function updateLineUniforms(uniforms: LinePaintUniforms, bucket: LineBucket, featureIndex: number, layerId: string, zoom: number): void {
  uniforms.metersPerPixel = lineGroundScale(zoom);
  const layer = layerFor(bucket, layerId);
  let cached = uniformLineStyles.get(layer);
  // Style.update retains paint on steady frames; recalculate replaces it for
  // camera, style/global-state mutations and every active transition step.
  // evaluationId increments even when those evaluated inputs did not change.
  if (!cached || cached.paint !== layer.paint || cached.zoom !== zoom) {
    cached = { paint: layer.paint, zoom, style: lineStyleForFeature(bucket, featureIndex, layerId, zoom) };
    uniformLineStyles.set(layer, cached);
  }
  if (appliedUniformStyles.get(uniforms) === cached.style)
    return;
  uniforms.width = Math.max(0, cached.style.widthPx);
  uniforms.shape.x = cached.style.gapWidthPx;
  uniforms.shape.y = cached.style.offsetPx;
  uniforms.shape.z = cached.style.blurPx;
  CesiumColor.clone(cached.style.color, uniforms.color);
  appliedUniformStyles.set(uniforms, cached.style);
}

export interface LineFamilyLayer {
  layerId: string;
  bucket: LineBucket;
  paintMode: 'uniform' | 'instance';
  zoomDependent: boolean;
  instancePaint?: ReadonlyMap<number, LineFeatureStyle>;
  instanceCameraPaint?: ReadonlyMap<number, FrozenLineCameraPaint>;
}

interface ReplayPickAttributes { show: Uint8Array }

interface LayerOwner {
  show?: boolean;
  getGeometryInstanceAttributes?: (id: InstanceId) => ReplayPickAttributes | undefined;
}

interface LayerPaint {
  layer: LineFamilyLayer;
  uniforms: LinePaintUniforms;
  owner: GeometryPrimitive | LayerOwner;
  pickAttributes?: Map<number, ReplayPickAttributes>;
  table?: GeometryBatchTable;
  pickIds: Array<{ destroy: () => void }>;
  held?: { evaluate: FrozenLineCameraPaint; zoom?: number };
  committedInstances?: ReadonlyMap<number, LineFeatureStyle>;
  committedPaint?: ReadonlyMap<number, FrozenLineCameraPaint>;
  heldInstances?: ReadonlyMap<number, FrozenLineCameraPaint>;
  heldZoom?: number;
}

interface CommandClone {
  replay: DrawCommandReplay;
  baseUniformMap?: ReplayDrawCommand['uniformMap'];
  uniformMap?: ReplayDrawCommand['uniformMap'];
}

interface InstanceId {
  featureIndex: number;
}

export function linePaintUniforms(clip: LineTileClip, width = 1, color: Color = CesiumColor.WHITE, zoom = 0): LinePaintUniforms {
  const uniforms = {
    clip,
    width,
    color: CesiumColor.clone(color),
    shape: new Cartesian3(),
    shapeUniform: () => uniforms.shape,
    metersPerPixel: lineGroundScale(zoom),
    widthUniform: () => uniforms.width,
    colorUniform: () => uniforms.color,
    metersPerPixelUniform: () => uniforms.metersPerPixel,
  };
  return uniforms;
}

function setColor(table: GeometryBatchTable, instance: number, attribute: number, color: Color, bytes: Uint8Array, value: Cartesian4): void {
  ColorGeometryInstanceAttribute.toValue(color, bytes);
  value.x = bytes[0];
  value.y = bytes[1];
  value.z = bytes[2];
  value.w = bytes[3];
  table.setBatchedAttribute(instance, attribute, value);
}

/** One uploaded strip chunk, replayed by each style layer in its bucket family. */
export class LineFamilyChunk {
  show = true;
  readonly primitive: GeometryPrimitive;

  private readonly _layers: LayerPaint[];

  private readonly _ids: InstanceId[];

  private readonly _tileId: string;

  private readonly _generationId: number;

  private readonly _picking: FeaturePicking;

  private readonly _featureIndex?: FeatureIndex;

  private readonly _featureInstances?: Map<number, number[]>;

  private readonly _clones = new Map<ReplayDrawCommand, CommandClone[]>();

  private _zoom: number;

  private _initialized = false;

  private readonly _maximumMiterLimit?: number;

  private _destroyed = false;

  constructor(
    instances: GeometryInstance[],
    layers: readonly LineFamilyLayer[],
    tileId: string,
    generationId: number,
    zoom: number,
    appearance: Cesium.PolylineColorAppearance,
    clip: LineTileClip,
    maximumMiterLimit?: number,
    picking = new FeaturePicking(),
    featureIndex?: FeatureIndex,
  ) {
    this._maximumMiterLimit = maximumMiterLimit;
    this._picking = picking;
    this._featureIndex = featureIndex;
    this._ids = instances.map(instance => instance.id as InstanceId);
    if (picking.enabled('line')) {
      this._featureInstances = new Map();
      for (const [index, id] of this._ids.entries()) {
        const indices = this._featureInstances.get(id.featureIndex);
        if (indices)
          indices.push(index);
        else this._featureInstances.set(id.featureIndex, [index]);
      }
    }
    this._tileId = tileId;
    this._generationId = generationId;
    this._zoom = zoom;
    this.primitive = new GeometryPrimitive({
      allowPicking: this._picking.enabled('line'),
      geometryInstances: instances,
      appearance,
    }, 'line', lineAppearanceForMode);
    registerDrawBatch(this.primitive, { layerId: layers[0].layerId, tileId, kind: 'line' });
    sharePrimitiveBytes(this, this.primitive);
    this._layers = layers.map((layer, index): LayerPaint => {
      const owner = index === 0
        ? this.primitive
        : picking.enabled('line')
          ? {
              show: true,
              getGeometryInstanceAttributes: (id: InstanceId) => this._replayPickAttributes(this._layers[index], id),
            }
          : {};
      const uniforms = linePaintUniforms(clip, 1, CesiumColor.WHITE, zoom);
      registerDrawBatch(owner, { layerId: layer.layerId, tileId, kind: 'line' });
      registerLinePaint(owner, uniforms);
      const paint: LayerPaint = { layer, uniforms, owner, pickIds: [], committedInstances: layer.instancePaint, committedPaint: layer.instanceCameraPaint };
      return paint;
    });
    for (const paint of this._layers) {
      this._writeUniform(paint);
    }
  }

  get ready(): boolean {
    return this.primitive.ready;
  }

  update(frameState: unknown): void {
    if (!this.show || this._destroyed) {
      return;
    }
    // Native must finish its first upload and replay initialization even
    // with zero paint. Ready uniform owners can retain those resources
    // until any layer becomes visible; instance paint still needs Native.
    if (this._initialized && this.ready && this._layers.every(paint =>
      paint.layer.paintMode === 'uniform' && (paint.uniforms.width <= 0 || paint.uniforms.color.alpha <= 0))) {
      return;
    }
    const frame = frameState as LineFrame;
    const commands = frame.commandList;
    const first = commands?.length ?? 0;
    this.primitive.update(frameState as Parameters<GeometryPrimitive['update']>[0]);
    // Native submits its first complete commands before afterRender ready.
    // Initialize and upload current family paint before those commands draw.
    if (!commands || commands.length === first) {
      return;
    }
    if (!this._initialized) {
      this._initialize(frame);
    }
    for (const paint of this._layers) {
      paint.table!.update(frameState);
    }
    const originals = commands.slice(first);
    for (const original of originals) {
      const clones = this._clones.get(original) ?? [];
      for (let index = 1; index < this._layers.length; index++) {
        const paint = this._layers[index];
        if (paint.owner.show === false)
          continue;
        const entry = clones[index - 1] ?? { replay: new DrawCommandReplay(original) };
        const clone = entry.replay.update(original);
        if (entry.baseUniformMap !== original.uniformMap) {
          entry.baseUniformMap = original.uniformMap;
          entry.uniformMap = {
            ...original.uniformMap,
            ...paint.table!.getUniformMapCallback()({}),
            ...paint.uniforms.clip.uniforms,
            u_line_width: paint.uniforms.widthUniform,
            u_line_shape: paint.uniforms.shapeUniform,
            u_line_color: paint.uniforms.colorUniform,
            u_line_meters_per_pixel: paint.uniforms.metersPerPixelUniform,
          };
        }
        clone.owner = paint.owner;
        clone.uniformMap = entry.uniformMap;
        clones[index - 1] = entry;
        commands.push(clone);
      }
      this._clones.set(original, clones);
    }
  }

  updatePaint(zoom: number, force: boolean, transitionLayerIds?: ReadonlySet<string>): void {
    this._zoom = zoom;
    for (const paint of this._layers) {
      if (paint.layer.zoomDependent || (force && (!transitionLayerIds || transitionLayerIds.has(paint.layer.layerId)))) {
        if (paint.layer.paintMode === 'uniform') {
          this._writeUniform(paint);
        }
        else if (this._initialized) {
          this._writePaint(paint);
        }
        else {
          paint.committedInstances = this._instancePaint(paint);
          paint.committedPaint = freezeLineFeaturePaint(paint.layer.bucket, paint.layer.layerId, this._ids.map(id => id.featureIndex));
        }
      }
    }
  }

  /** Camera paint stays live even while instance work awaits its allowance. */
  updateUniformPaint(zoom: number): void {
    this._zoom = zoom;
    for (const paint of this._layers) {
      this._writeUniform(paint);
    }
  }

  /** Snapshot committed replay paint before its style can mutate. */
  captureCameraPaint(): (zoom: number) => void {
    const paints = this._layers.filter(paint => paint.layer.paintMode === 'uniform').map(paint => ({
      paint,
      evaluate: freezeLineCameraPaint(paint.layer.bucket.layers.find(layer => layer.id === paint.layer.layerId)!),
    }));
    const instances = this._layers.filter(paint => paint.layer.paintMode === 'instance').map(paint => ({
      paint,
      styles: paint.committedPaint!,
    }));
    return (zoom) => {
      this._zoom = zoom;
      for (const { paint, styles } of instances) {
        paint.heldInstances ??= styles;
        paint.uniforms.metersPerPixel = lineGroundScale(zoom);
        if (paint.heldZoom !== zoom) {
          if (this._initialized)
            this._writePaint(paint);
          else paint.committedInstances = this._instancePaint(paint);
          paint.heldZoom = zoom;
        }
      }
      for (const { paint, evaluate } of paints) {
        paint.held ??= { evaluate };
        this._writeUniform(paint);
      }
    };
  }

  isDestroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    for (const paint of this._layers.slice(1)) {
      for (const pickId of paint.pickIds) pickId.destroy();
      paint.table?.destroy();
      paint.pickAttributes?.clear();
    }
    this.primitive.destroy();
    this._clones.clear();
    this._featureInstances?.clear();
  }

  /**
   * @internal
   */
  private _initialize(frame: LineFrame): void {
    const base = this.primitive._batchTable;
    if (!base || !frame.context) {
      throw new TypeError('Cesium line Primitive did not create a batch table');
    }
    const pickAttribute = base.attributes.findIndex(attribute => attribute.functionName === 'czm_batchTable_pickColor');
    const showAttribute = base.attributes.findIndex(attribute => attribute.functionName === 'czm_batchTable_show');
    if ((this._picking.enabled('line') && (pickAttribute < 0 || showAttribute < 0)) || base.numberOfInstances !== this._ids.length) {
      throw new TypeError('Cesium line batch table does not match its instances');
    }
    this._layers[0].table = base;
    // Each replay layer owns an additional RGBA batch-table texture with
    // the same typed storage as the native Primitive's table.
    sharePrimitiveBytes(this, this.primitive, (this._layers.length - 1) * base._batchValues.byteLength);
    for (const paint of this._layers.slice(1)) {
      const table = new BatchTable(frame.context, base.attributes, base.numberOfInstances);
      table._batchValues.set(base._batchValues);
      table._batchValuesDirty = true;
      paint.table = table;
      if (!this._picking.enabled('line'))
        continue;
      const pickColor = new Cartesian4();
      for (let index = 0; index < this._ids.length; index++) {
        const id = frame.context.createPickId({
          primitive: paint.owner,
          id: {
            ...this._picking.feature(layerFor(paint.layer.bucket, paint.layer.layerId), this._featureIndex, this._ids[index].featureIndex),
            tileId: this._tileId,
            layerId: paint.layer.layerId,
            featureIndex: this._ids[index].featureIndex,
            generationId: this._generationId,
          },
        });
        paint.pickIds.push(id);
        pickColor.x = CesiumColor.floatToByte(id.color.red);
        pickColor.y = CesiumColor.floatToByte(id.color.green);
        pickColor.z = CesiumColor.floatToByte(id.color.blue);
        pickColor.w = CesiumColor.floatToByte(id.color.alpha);
        table.setBatchedAttribute(index, pickAttribute, pickColor);
      }
    }
    for (const paint of this._layers) {
      this._writePaint(paint, paint.committedInstances);
    }
    this._initialized = true;
  }

  /** Native drillPick hides only this replay's feature, then restores its show value. */
  private _replayPickAttributes(paint: LayerPaint, id: InstanceId): ReplayPickAttributes | undefined {
    const instances = this._featureInstances?.get(id.featureIndex);
    if (!instances)
      return undefined;
    const cached = paint.pickAttributes?.get(id.featureIndex);
    if (cached)
      return cached;
    const table = paint.table;
    if (!table)
      throw new Error('Picking a line replay requires its initialized batch table');
    const attribute = table.attributes.findIndex(candidate => candidate.functionName === 'czm_batchTable_show');
    if (attribute < 0)
      throw new Error('Picking a line replay requires the Native show attribute');
    const show = new Uint8Array([1]);
    const attributes = {
      get show(): Uint8Array { return show; },
      set show(value: Uint8Array) {
        show[0] = value[0];
        for (const instance of instances)
          table.setBatchedAttribute(instance, attribute, show[0]);
      },
    };
    paint.pickAttributes ??= new Map();
    paint.pickAttributes.set(id.featureIndex, attributes);
    return attributes;
  }

  /**
   * @internal
   */
  private _instancePaint(paint: LayerPaint): ReadonlyMap<number, LineFeatureStyle> {
    if (paint.heldInstances)
      return new Map([...paint.heldInstances].map(([index, evaluate]) => [index, evaluate(this._zoom)]));
    const styles = new Map<number, LineFeatureStyle>();
    for (const { featureIndex } of this._ids) {
      if (!styles.has(featureIndex))
        styles.set(featureIndex, lineStyleForFeature(paint.layer.bucket, featureIndex, paint.layer.layerId, this._zoom));
    }
    return styles;
  }

  /**
   * @internal
   */
  private _writePaint(paint: LayerPaint, committed?: ReadonlyMap<number, LineFeatureStyle>): void {
    const table = paint.table!;
    const layer = paint.layer;
    const colorAttribute = table.attributes.findIndex(attribute => attribute.functionName === 'czm_batchTable_color');
    const widthAttribute = table.attributes.findIndex(attribute => attribute.functionName === 'czm_batchTable_lineWidth');
    if (colorAttribute < 0 || widthAttribute < 0) {
      throw new TypeError('Cesium line batch table lacks paint attributes');
    }
    const bytes = new Uint8Array(4);
    const color = new Cartesian4();
    const shape = new Cartesian4(1, 0, 0, 0);
    if (layer.paintMode === 'uniform') {
      this._writeUniform(paint);
      // A copied table may contain instance paint from the family's first layer.
      // Normalize its factors once; later uniform changes never touch the table.
      for (let index = 0; index < this._ids.length; index++) {
        table.setBatchedAttribute(index, widthAttribute, shape);
        setColor(table, index, colorAttribute, CesiumColor.WHITE, bytes, color);
      }
      if (this._maximumMiterLimit !== undefined)
        registerUniformLineExtent(paint.owner, { widthFactor: 1, miterLimit: this._maximumMiterLimit });
      return;
    }
    paint.uniforms.width = 1;
    Cartesian3.clone(Cartesian3.ZERO, paint.uniforms.shape);
    CesiumColor.clone(CesiumColor.WHITE, paint.uniforms.color);
    const styles = paint.heldInstances ? this._instancePaint(paint) : committed ?? this._instancePaint(paint);
    for (let index = 0; index < this._ids.length; index++) {
      const featureIndex = this._ids[index].featureIndex;
      const style = styles.get(featureIndex)!;
      shape.x = Math.max(0, style.widthPx);
      shape.y = style.gapWidthPx;
      shape.z = style.offsetPx;
      shape.w = style.blurPx;
      table.setBatchedAttribute(index, widthAttribute, shape);
      setColor(table, index, colorAttribute, style.color, bytes, color);
    }
    paint.committedInstances = styles;
    if (!paint.heldInstances && !committed)
      paint.committedPaint = freezeLineFeaturePaint(layer.bucket, layer.layerId, this._ids.map(id => id.featureIndex));
  }

  /**
   * @internal
   */
  private _writeUniform(paint: LayerPaint): void {
    paint.uniforms.metersPerPixel = lineGroundScale(this._zoom);
    if (paint.layer.paintMode !== 'uniform')
      return;
    if (paint.held) {
      if (paint.held.zoom !== this._zoom) {
        const style = paint.held.evaluate(this._zoom);
        paint.uniforms.width = Math.max(0, style.widthPx);
        paint.uniforms.shape.x = style.gapWidthPx;
        paint.uniforms.shape.y = style.offsetPx;
        paint.uniforms.shape.z = style.blurPx;
        CesiumColor.clone(style.color, paint.uniforms.color);
        paint.held.zoom = this._zoom;
      }
      return;
    }
    updateLineUniforms(paint.uniforms, paint.layer.bucket, this._ids[0].featureIndex, paint.layer.layerId, this._zoom);
  }
}
