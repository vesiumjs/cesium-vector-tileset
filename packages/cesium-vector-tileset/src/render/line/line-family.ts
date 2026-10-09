import type { Color, GeometryInstance, Primitive } from 'cesium';
import type { LineBucket } from '../../data/bucket-runtime';
import type { LineStyleLayer } from '../../style/style-layer/line-style-layer';
import type { LinePaintUniforms } from '../scene/draw-batch';
import type { ReplayDrawCommand } from '../scene/draw-command-replay';
import type { LineFeatureStyle } from '../vector/feature-attributes';
import type { FrozenLineCameraPaint } from './frozen-line-paint';
import type { LineTileClip } from './line-tile-clip';
import * as Cesium from 'cesium';
import { Cartesian4, Color as CesiumColor, ColorGeometryInstanceAttribute } from 'cesium';
import { GeometryPrimitive } from '../geometry/geometry-primitive';
import { registerDrawBatch, registerLinePaint, registerUniformLineExtent } from '../scene/draw-batch';
import { sharePrimitiveBytes } from '../scene/resource-memory';
import { layerFor, lineStyleForFeature } from '../vector/feature-attributes';
import { freezeLineCameraPaint } from './frozen-line-paint';
import { lineAppearanceForMode } from './line-appearance-mode';
import { lineGroundScale } from './line-ground-scale';

interface BatchAttribute {
  functionName: string;
}

interface BatchTable {
  readonly attributes: BatchAttribute[];
  readonly numberOfInstances: number;
  _batchValues: Uint8Array | Float32Array;
  _batchValuesDirty: boolean;
  setBatchedAttribute: (instance: number, attribute: number, value: number | Cartesian4) => void;
  getUniformMapCallback: () => (uniforms: Record<string, () => unknown>) => Record<string, () => unknown>;
  update: (frameState: unknown) => void;
  destroy: () => void;
}

interface LineFrame {
  commandList?: ReplayDrawCommand[];
  context?: { createPickId: (object: object) => { color: Color; destroy: () => void } };
}

interface CesiumRuntime {
  BatchTable: new (context: unknown, attributes: BatchAttribute[], instances: number) => BatchTable;
  DrawCommand: { shallowClone: (source: ReplayDrawCommand, target?: ReplayDrawCommand) => ReplayDrawCommand };
}

const BatchTable = (Cesium as unknown as CesiumRuntime).BatchTable;
const DrawCommand = (Cesium as unknown as CesiumRuntime).DrawCommand;

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
  const layer = layerFor(bucket, layerId) as LineStyleLayer;
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
  CesiumColor.clone(cached.style.color, uniforms.color);
  appliedUniformStyles.set(uniforms, cached.style);
}

export interface LineFamilyLayer {
  layerId: string;
  bucket: LineBucket;
  offsetMeters: number;
  paintMode: 'uniform' | 'instance';
  zoomDependent: boolean;
  instancePaint?: ReadonlyMap<number, LineFeatureStyle>;
}

interface LayerPaint {
  layer: LineFamilyLayer;
  uniforms: LinePaintUniforms;
  owner: object;
  table?: BatchTable;
  pickIds: Array<{ destroy: () => void }>;
  held?: { evaluate: FrozenLineCameraPaint; zoom?: number };
  committedInstances?: ReadonlyMap<number, LineFeatureStyle>;
  heldInstances?: ReadonlyMap<number, LineFeatureStyle>;
}

interface CommandClone {
  command: ReplayDrawCommand;
  baseUniformMap?: ReplayDrawCommand['uniformMap'];
  uniformMap?: ReplayDrawCommand['uniformMap'];
}

/** Cesium DrawCommand clone fields, with replay ownership and uniforms kept local. */
function updateReplayCommand(source: ReplayDrawCommand, target: ReplayDrawCommand): void {
  // Native setters invalidate derivatives only when the corresponding field
  // changes. Keep each replay's dirty state, shadow epoch and derivatives.
  target.boundingVolume = source.boundingVolume;
  target.orientedBoundingBox = source.orientedBoundingBox;
  target.modelMatrix = source.modelMatrix;
  target.primitiveType = source.primitiveType;
  target.vertexArray = source.vertexArray;
  target.count = source.count;
  target.offset = source.offset;
  target.instanceCount = source.instanceCount;
  target.shaderProgram = source.shaderProgram;
  target.renderState = source.renderState;
  target.framebuffer = source.framebuffer;
  target.pass = source.pass;
  target.debugOverlappingFrustums = source.debugOverlappingFrustums;
  target.pickId = source.pickId;
  target.snapId = source.snapId;
  target.pickedMetadataInfo = source.pickedMetadataInfo;
  target.cull = source.cull;
  target.occlude = source.occlude;
  target.executeInClosestFrustum = source.executeInClosestFrustum;
  target.debugShowBoundingVolume = source.debugShowBoundingVolume;
  target.castShadows = source.castShadows;
  target.receiveShadows = source.receiveShadows;
  target.pickOnly = source.pickOnly;
  target.depthForTranslucentClassification = source.depthForTranslucentClassification;
  // Native exposes metadata permission through a getter without a setter.
  if (target._pickMetadataAllowed !== source._pickMetadataAllowed) {
    target._pickMetadataAllowed = source._pickMetadataAllowed;
    target.dirty = true;
  }
}

interface InstanceId {
  featureIndex: number;
}

function paintUniforms(clip: LineTileClip, offset: number, zoom: number): LinePaintUniforms {
  const uniforms = {
    clip,
    width: 1,
    color: CesiumColor.WHITE.clone(),
    offset,
    metersPerPixel: lineGroundScale(zoom),
    widthUniform: () => uniforms.width,
    colorUniform: () => uniforms.color,
    offsetUniform: () => uniforms.offset,
    metersPerPixelUniform: () => uniforms.metersPerPixel,
  };
  return uniforms;
}

function setColor(table: BatchTable, instance: number, attribute: number, color: Color, bytes: Uint8Array, value: Cartesian4): void {
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
  readonly primitive: Primitive;
  private readonly _layers: LayerPaint[];
  private readonly _ids: InstanceId[];
  private readonly _tileId: string;
  private readonly _generationId: number;
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
  ) {
    this._maximumMiterLimit = maximumMiterLimit;
    this._ids = instances.map(instance => instance.id as InstanceId);
    this._tileId = tileId;
    this._generationId = generationId;
    this._zoom = zoom;
    this.primitive = new GeometryPrimitive({
      geometryInstances: instances,
      appearance,
    }, 'line', Math.max(...layers.map(layer => Math.abs(layer.offsetMeters))), lineAppearanceForMode);
    registerDrawBatch(this.primitive, { layerId: layers[0].layerId, tileId, kind: 'line' });
    sharePrimitiveBytes(this, this.primitive);
    this._layers = layers.map((layer, index) => {
      const owner = index === 0 ? this.primitive : {};
      const uniforms = paintUniforms(clip, layer.offsetMeters, zoom);
      registerDrawBatch(owner, { layerId: layer.layerId, tileId, kind: 'line' });
      registerLinePaint(owner, uniforms);
      return { layer, uniforms, owner, pickIds: [], committedInstances: layer.instancePaint };
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
    (this.primitive as unknown as { update: (state: unknown) => void }).update(frameState);
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
        const entry = clones[index - 1] ?? { command: DrawCommand.shallowClone(original) };
        const clone = entry.command;
        updateReplayCommand(original, clone);
        if (entry.baseUniformMap !== original.uniformMap) {
          entry.baseUniformMap = original.uniformMap;
          entry.uniformMap = {
            ...original.uniformMap,
            ...paint.table!.getUniformMapCallback()({}),
            ...paint.uniforms.clip.uniforms,
            u_line_width: paint.uniforms.widthUniform,
            u_line_color: paint.uniforms.colorUniform,
            u_line_layer_offset: paint.uniforms.offsetUniform,
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
        if (paint.layer.paintMode === 'uniform')
          this._writeUniform(paint);
        else if (this._initialized)
          this._writePaint(paint);
        else
          paint.committedInstances = this._instancePaint(paint);
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
      styles: paint.committedInstances!,
    }));
    return (zoom) => {
      this._zoom = zoom;
      for (const { paint, styles } of instances) {
        paint.heldInstances ??= styles;
        paint.uniforms.metersPerPixel = lineGroundScale(zoom);
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
    }
    this.primitive.destroy();
    this._clones.clear();
  }

  private _initialize(frame: LineFrame): void {
    const base = (this.primitive as Primitive & { _batchTable?: BatchTable })._batchTable;
    if (!base || !frame.context) {
      throw new TypeError('Cesium line Primitive did not create a batch table');
    }
    const pickAttribute = base.attributes.findIndex(attribute => attribute.functionName === 'czm_batchTable_pickColor');
    if (pickAttribute < 0 || base.numberOfInstances !== this._ids.length) {
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
      const pickColor = new Cartesian4();
      for (let index = 0; index < this._ids.length; index++) {
        const id = frame.context.createPickId({
          primitive: this,
          id: {
            type: 'line',
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

  private _instancePaint(paint: LayerPaint): ReadonlyMap<number, LineFeatureStyle> {
    if (paint.heldInstances)
      return paint.heldInstances;
    const styles = new Map<number, LineFeatureStyle>();
    for (const { featureIndex } of this._ids) {
      if (!styles.has(featureIndex))
        styles.set(featureIndex, lineStyleForFeature(paint.layer.bucket, featureIndex, paint.layer.layerId, this._zoom));
    }
    return styles;
  }

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
    if (layer.paintMode === 'uniform') {
      this._writeUniform(paint);
      // A copied table may contain instance paint from the family's first layer.
      // Normalize its factors once; later uniform changes never touch the table.
      for (let index = 0; index < this._ids.length; index++) {
        table.setBatchedAttribute(index, widthAttribute, 1);
        setColor(table, index, colorAttribute, CesiumColor.WHITE, bytes, color);
      }
      if (this._maximumMiterLimit !== undefined)
        registerUniformLineExtent(paint.owner, { widthFactor: 1, miterLimit: this._maximumMiterLimit });
      return;
    }
    paint.uniforms.width = 1;
    CesiumColor.clone(CesiumColor.WHITE, paint.uniforms.color);
    const styles = paint.heldInstances ?? committed ?? this._instancePaint(paint);
    for (let index = 0; index < this._ids.length; index++) {
      const featureIndex = this._ids[index].featureIndex;
      const style = styles.get(featureIndex)!;
      table.setBatchedAttribute(index, widthAttribute, Math.max(0, style.widthPx));
      setColor(table, index, colorAttribute, style.color, bytes, color);
    }
    paint.committedInstances = styles;
  }

  private _writeUniform(paint: LayerPaint): void {
    paint.uniforms.metersPerPixel = lineGroundScale(this._zoom);
    if (paint.layer.paintMode !== 'uniform')
      return;
    if (paint.held) {
      if (paint.held.zoom !== this._zoom) {
        const style = paint.held.evaluate(this._zoom);
        paint.uniforms.width = Math.max(0, style.widthPx);
        CesiumColor.clone(style.color, paint.uniforms.color);
        paint.held.zoom = this._zoom;
      }
      return;
    }
    updateLineUniforms(paint.uniforms, paint.layer.bucket, this._ids[0].featureIndex, paint.layer.layerId, this._zoom);
  }
}
