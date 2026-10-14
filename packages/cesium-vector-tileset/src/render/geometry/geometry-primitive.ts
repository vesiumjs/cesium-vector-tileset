import type { Appearance, Cartesian4, MapProjection, SceneMode } from 'cesium';
import type { Budget } from '../scene/frame-budget';
import type { ExtrusionAppearance } from './extrusion-appearance';
import type { GeometryPacket } from './geometry-packet';
import type { GeometryLayout, GeometryPrepareRequest, GeometryPrepareResult } from './geometry-preparation';
import type { LineIndexRange, LineVertexArray } from './line-geometry-upload';
import type { PreparedLinePositionTexture } from './line-position-packing';
import type { CombinedGeometry } from './primitive-pipeline';
import { BoundingSphere, GeographicProjection, Geometry, GeometryInstance, GeometryPipeline, Matrix4, Primitive, WebMercatorProjection } from 'cesium';
import { LinePositionTexture } from '../line/line-position-texture';
import { drawBatchForOwner, linePaintForOwner } from '../scene/draw-batch';
import { DrawCommandReplay } from '../scene/draw-command-replay';
import { createGeometryPacket, geometryPacketEnd } from './geometry-packet';
import { GeometryPrepareWorker } from './geometry-prepare-worker';
import { LineGeometryUpload } from './line-geometry-upload';
import { lineInputs } from './line-input';
import { mercatorTranslationPadding } from './mercator-translation';
import { geometryContextLimits, primitivePipeline, primitiveState } from './primitive-pipeline';
import { packSurfacePositions } from './surface-position';

interface GeometryFrame {
  frameNumber?: number;
  mode: SceneMode;
  mapProjection: MapProjection;
  scene3DOnly: boolean;
  context: { elementIndexUint: boolean };
  passes?: { render: boolean; pick: boolean };
  afterRender?: Array<() => boolean>;
  commandList?: Array<{ boundingVolume?: BoundingSphere }>;
}

/** Native batch storage shared by the physical primitive and family replays. */
export interface GeometryBatchTable {
  readonly attributes: Array<{ functionName: string }>;
  readonly numberOfInstances: number;
  _batchValues: Uint8Array | Float32Array;
  _batchValuesDirty: boolean;
  setBatchedAttribute: (instance: number, attribute: number, value: number | Cartesian4) => void;
  getUniformMapCallback: () => (uniforms: Record<string, () => unknown>) => Record<string, () => unknown>;
  update: (frameState: unknown) => void;
  destroy: () => void;
}

interface NativeBuffer {
  readonly sizeInBytes: number;
}

interface NativeVertexArray {
  readonly numberOfAttributes: number;
  readonly indexBuffer?: NativeBuffer;
  getAttribute: (index: number) => { vertexBuffer?: NativeBuffer };
}

/**
 * Cesium's assembly contract, owned here by the staged Primitive integration.
 * These fields exist in Native but are omitted from its public declarations.
 */
declare class _NativePrimitive extends Primitive {
  _state: number;
  _ready: boolean;
  _batchTable?: GeometryBatchTable;
  _geometries?: CombinedGeometry[];
  _attributeLocations: Record<string, number>;
  _pickOffsets?: LineIndexRange[];
  _instanceIds: Array<{ featureIndex?: number }>;
  _numberOfInstances: number;
  _va: NativeVertexArray[];
  _primitiveType: number;
  _boundingSpheres: BoundingSphere[];
  _boundingSphereWC: BoundingSphere[];
  _boundingSphereCV: BoundingSphere[];
  _boundingSphere2D: BoundingSphere[];
  _boundingSphereMorph: BoundingSphere[];
  _offsetInstanceExtend: unknown;
  _instanceBoundingSpheres: Array<BoundingSphere | undefined>;
  _instanceBoundingSpheresCV: Array<BoundingSphere | undefined>;
  _recomputeBoundingSpheres: boolean;
  _createPickOffsets: boolean;
  _createGeometryResults?: unknown;
  _error?: unknown;

  update(frameState?: GeometryFrame): void;

  static _updateBoundingVolumes(primitive: Primitive, frameState: GeometryFrame, modelMatrix: Matrix4, force: boolean): void;
}

/** Native releases construction instances after upload and again at destruction. */
export type NativePrimitiveRuntime = Omit<_NativePrimitive, 'geometryInstances'> & {
  geometryInstances: Primitive['geometryInstances'] | undefined;
};

const RuntimePrimitive = Primitive as typeof _NativePrimitive;

export type GeometryAppearanceForMode = (appearance: Appearance, mode: SceneMode) => Appearance;

const geometryFrameBudgets = new WeakMap<object, Budget>();
const geometryResourceAdmissions = new WeakMap<object, { turn?: object; deferred: boolean }>();

/** Only the upload queue may admit Native's cold preparation and upload. */
export function updateGeometryWithBudget(frameState: object, budget: Budget, update: () => void, resources?: { turn?: object; deferred: boolean }): void {
  const previous = geometryFrameBudgets.get(frameState);
  const previousResources = geometryResourceAdmissions.get(frameState);
  if (resources)
    geometryResourceAdmissions.set(frameState, resources);
  geometryFrameBudgets.set(frameState, budget);
  try {
    update();
  }
  finally {
    if (previous)
      geometryFrameBudgets.set(frameState, previous);
    else geometryFrameBudgets.delete(frameState);
    if (previousResources)
      geometryResourceAdmissions.set(frameState, previousResources);
    else geometryResourceAdmissions.delete(frameState);
  }
}

const maximumCreateBytes = 512 * 1024;
const maximumCreateInstances = 512;
/** Worker replies wake Scene; only executable continuations need another frame. */
export function hasRunnableGeometryUpdate(primitive: Primitive): boolean {
  if (primitive.ready)
    return false;
  if (primitive instanceof GeometryPrimitive)
    return primitive.hasRunnableUpdate;
  const state = (primitive as NativePrimitiveRuntime)._state;
  return state !== primitiveState.CREATING && state !== primitiveState.COMBINING;
}

function createChunk(geometries: Geometry[], start: number, layout: GeometryLayout): { geometries: Geometry[]; bytes: number } {
  const subTasks: Geometry[] = [];
  let bytes = 0;
  while (start + subTasks.length < geometries.length && subTasks.length < maximumCreateInstances) {
    const geometry = geometries[start + subTasks.length];
    const end = geometryPacketEnd(geometry, bytes, layout === 'line' ? lineInputs.get(geometry) : undefined);
    // Keep indivisible Geometry intact, including Native indices and bounds.
    // Each packet later receives one independent owner before Native transfer.
    if (subTasks.length > 0 && end > maximumCreateBytes)
      break;
    subTasks.push(geometry);
    bytes = end;
  }
  return { geometries: subTasks, bytes };
}

/**
 * One Native assembly path for solid meshes, line strips and flat surfaces.
 * Solid meshes retain Native projection and position encoding; extrusion
 * High values and normals use exact SHORT storage. Line centres are projected
 * once before encode-only combine, preserving discrete roles.
 * Surfaces retain Native date-line splitting and both position tracks;
 * each layout packs its active attributes before Native uploads the VA.
 * Planar line neighbours are projected only when the scene is available.
 * Native Primitive still owns batch tables, drawing, picking and destruction.
 */
export class GeometryPrimitive extends RuntimePrimitive {
  private _started = false;

  private _preparation?: Generator<void>;

  private _waitingForSlot?: GeometryPrepareWorker;

  private _waitingBytes = 0;

  private _combinedResult?: GeometryPrepareResult;

  private _preparedLinePositions?: PreparedLinePositionTexture;

  private _geometryOwner?: GeometryPrepareWorker;

  private readonly _layout: GeometryLayout;

  private _inputInstances?: Map<unknown, GeometryInstance>;

  private _inputAttributeCache?: Map<unknown, ReturnType<Primitive['getGeometryInstanceAttributes']>>;

  private _linePositions?: LinePositionTexture;

  private _lineUpload?: LineGeometryUpload;

  private _lineUploadSteps?: Generator<void>;

  private _lineUploadPending = false;

  private _lineUploadAdopted = false;

  private _lineUploadFrame?: number;

  private _lineUploadTurn?: object;

  private _lineResourcesComplete = false;

  private _deferLineResources = false;

  private _lineDrawCounts: number[] = [];

  private _lineResourceEnvironment?: Pick<GeometryFrame, 'context' | 'mode' | 'mapProjection' | 'scene3DOnly'>;

  private _lineFailurePending = false;

  private readonly _sourceAppearance?: Appearance;

  private readonly _appearanceForMode?: GeometryAppearanceForMode;

  constructor(options: Pick<NonNullable<ConstructorParameters<typeof Primitive>[0]>, 'geometryInstances' | 'appearance' | 'vertexCacheOptimize' | 'compressVertices'>, layout: GeometryLayout, appearanceForMode?: GeometryAppearanceForMode) {
    if (layout !== 'native' && layout !== 'extrusion' && Array.isArray(options.geometryInstances) && options.geometryInstances.length > 65536) {
      throw new RangeError('geometry instance IDs exceed unsigned 16-bit range');
    }
    // A centreline sphere cannot enclose arbitrary window-space widths/caps.
    // MVT covering owns tile visibility; Native retains depth testing, frustum
    // depth partitioning and shader near clipping, but must not reject the
    // expanded strip against that sphere (especially in the narrow pick view).
    super({ ...options, allowPicking: true, asynchronous: true, releaseGeometryInstances: true, cull: layout === 'native' || layout === 'extrusion' || layout === 'surface-planar' || layout === 'surface-morph' });
    this._layout = layout;
    this._sourceAppearance = options.appearance;
    this._appearanceForMode = appearanceForMode;
  }

  /** Immutable geometry storage, shared by every layer replaying this owner. */
  get positionTexture(): LinePositionTexture['texture'] | undefined {
    return this._linePositions?.texture;
  }

  /** A drawable index prefix can coexist with unfinished page uploads. */
  get hasPendingUpload(): boolean {
    return this._lineUploadPending;
  }

  get hasDrawableGeometry(): boolean {
    return this.ready || this._lineUpload?.counts.some(count => count > 0) === true;
  }

  /** Resource writes have no Native update, command or readiness side effects. */
  get hasRunnableResourceUpload(): boolean {
    if (this.isDestroyed() || this.ready || this._layout !== 'line' || this._lineResourcesComplete)
      return false;
    const state = this._state;
    return state !== primitiveState.FAILED
      && !!this._batchTable
      && (state === primitiveState.COMBINED || this._lineUploadPending);
  }

  /**
   * @internal
   */
  private get _linePresentationNeeded(): boolean {
    return this._lineResourcesComplete || (!!this._lineUpload
      && (this._lineUploadAdopted || this._lineUpload.vertexArrays.length === this._geometries?.length)
      && this._lineUpload.counts.some((count, index) => count > (this._lineDrawCounts[index] ?? 0)));
  }

  /** Called only at a safe scene boundary, once per shared physical tick. */
  advanceResourceUpload(frameState: GeometryFrame, budget: Budget, turn: object): boolean {
    if (!this.hasRunnableResourceUpload || this._lineUploadTurn === turn)
      return false;
    const environment = this._lineResourceEnvironment;
    if (!environment || environment.context !== frameState.context
      || (this._geometryOwner && this._geometryOwner.context !== frameState.context)
      || environment.mode !== frameState.mode || environment.mapProjection !== frameState.mapProjection || environment.scene3DOnly !== frameState.scene3DOnly) {
      return true;
    }
    this._lineUploadTurn = turn;
    return this._advanceLineResources(frameState, budget, true);
  }

  /**
   * @internal
   */
  private _advanceLineResources(frameState: GeometryFrame, budget: Budget, detached: boolean): boolean {
    try {
      this._lineUploadPending = true;
      this._lineUploadSteps ??= this._uploadLine(frameState);
      do {
        if (this._lineUploadSteps.next().done) {
          this._lineUploadSteps = undefined;
          this._lineResourcesComplete = true;
          break;
        }
      } while (!budget.exhausted);
    }
    catch (error) {
      this._fail(frameState, error, detached);
      return true;
    }
    return this._linePresentationNeeded;
  }

  /** CPU continuation admitted with paint by an earlier real render. */
  get hasRunnableIdlePreparation(): boolean {
    if (this.ready || this.isDestroyed()
      || this._state === primitiveState.FAILED) {
      return false;
    }
    if (this._preparation) {
      const owner = this._waitingForSlot;
      return !owner || owner.error !== undefined || owner.queue.error !== undefined || owner.queue.canSchedule(this._waitingBytes);
    }
    return !!this._combinedResult;
  }

  /** Native initialization, prefix presentation and readiness require a real render. */
  get needsRenderUpdate(): boolean {
    if (this.isDestroyed())
      return false;
    if (this.ready)
      return true;
    if (this._deferLineResources && this.hasRunnableResourceUpload)
      return this._linePresentationNeeded;
    if (this._lineUploadPending)
      return true;
    const state = this._state;
    if (state === primitiveState.FAILED)
      return true;
    if (this._preparation || this._combinedResult)
      return false;
    if (!this._started)
      return true;
    if (!this._batchTable)
      return true;
    return state !== primitiveState.CREATING && state !== primitiveState.COMBINING;
  }

  /** Advances owned CPU copies, Worker posting or replies without Native/GPU work. */
  advancePreparation(frameState: GeometryFrame, budget: Budget): void {
    if (!this.hasRunnableIdlePreparation)
      return;
    this._preparation ??= this._prepareCombined(frameState);
    try {
      do {
        if (this._preparation.next().done) {
          this._preparation = undefined;
          break;
        }
        // Occupied dispatch slots do not block a replied owner's CPU restore.
      } while (!budget.exhausted && !this._waitingForSlot);
    }
    catch (error) {
      this._preparation = undefined;
      this._fail(frameState, error);
    }
  }

  /** Cold CPU work, Native batch-table creation and upload can advance now. */
  get hasRunnableUpdate(): boolean {
    if (this.ready || this.isDestroyed())
      return false;
    if (this._lineUploadPending)
      return true;
    if (this._preparation) {
      const owner = this._waitingForSlot;
      return !owner || owner.error !== undefined || owner.queue.error !== undefined || owner.queue.canSchedule(this._waitingBytes);
    }
    if (this._combinedResult || !this._started)
      return true;
    // Solid preparation yields before Native gets its first update. Its
    // batch table still needs that frame while custom combine runs remotely.
    if (!this._batchTable)
      return true;
    const state = this._state;
    return state !== primitiveState.CREATING && state !== primitiveState.COMBINING;
  }

  // Native's accessor works as soon as its batch table exists, before ready.
  // Before the first update, write the same mutable construction attributes.
  getGeometryInstanceAttributes(id: unknown): ReturnType<Primitive['getGeometryInstanceAttributes']> {
    const native = this as NativePrimitiveRuntime;
    if (this._batchTable) {
      this._inputInstances = undefined;
      this._inputAttributeCache = undefined;
      return super.getGeometryInstanceAttributes(id);
    }
    if (id === undefined || id === null || !native.geometryInstances)
      return super.getGeometryInstanceAttributes(id);
    const cached = this._inputAttributeCache?.get(id);
    if (cached)
      return cached;
    if (!this._inputInstances) {
      const instances = native.geometryInstances;
      this._inputInstances = new Map((Array.isArray(instances) ? instances : [instances]).map(instance => [instance.id, instance]));
    }
    const instance = this._inputInstances.get(id);
    if (!instance)
      return undefined;
    const descriptors = Object.fromEntries(Object.entries(instance.attributes as Record<string, { value: number[] | Uint8Array | Float32Array }>).map(([name, attribute]) => [name, {
      get: () => attribute.value,
      set: (value: ArrayLike<number>) => {
        // Copy caller scratch arrays, just as Native's batch-table setter does.
        for (let i = 0; i < attribute.value.length; i++) attribute.value[i] = value[i];
      },
    }]));
    const attributes = Object.defineProperties({}, descriptors);
    (this._inputAttributeCache ??= new Map()).set(id, attributes);
    return attributes;
  }

  // Cesium's declaration omits the runtime frame parameter entirely. The
  // optional annotation keeps this override assignable to its Primitive type.
  update(frameState?: GeometryFrame): void {
    if (!frameState)
      throw new TypeError('Geometry update requires a Native frame state');
    const native = this as NativePrimitiveRuntime;
    if ((!native.geometryInstances && !this._started)
      || (Array.isArray(native.geometryInstances) && native.geometryInstances.length === 0)
      || (frameState?.passes && !frameState.passes.render && !frameState.passes.pick)) {
      super.update(frameState);
      return;
    }
    const nativeState = this._state;
    const rendering = !frameState?.passes || (frameState.passes.render && !frameState.passes.pick);
    const resourceAdmission = geometryResourceAdmissions.get(frameState);
    if (resourceAdmission)
      this._deferLineResources = resourceAdmission.deferred;
    if (this._lineFailurePending && frameState?.passes?.render && !frameState.passes.pick) {
      this._lineFailurePending = false;
      frameState.afterRender?.push(() => {
        if (!this.isDestroyed())
          this._ready = true;
        return true;
      });
    }
    // Family geometry also carries its primary paint, so only standalone
    // dash owners can skip Native without hiding a visible replay layer.
    if (this.ready && nativeState === primitiveState.COMPLETE && drawBatchForOwner(this)?.kind === 'dash') {
      const paint = linePaintForOwner(this);
      const batchTable = this._batchTable;
      if (paint && (paint.width <= 0 || paint.color.alpha <= 0) && !batchTable?._batchValuesDirty)
        return;
    }
    const cold = nativeState !== primitiveState.COMPLETE && nativeState !== primitiveState.FAILED;
    const budget = geometryFrameBudgets.get(frameState);
    // Ordinary scene traversal draws uploaded owners; it never starts cold CPU
    // preparation, Native batch-table creation, or a newly combined upload.
    if (cold && !this._lineUploadPending && (!budget || !this.hasRunnableUpdate))
      return;
    if (nativeState !== primitiveState.FAILED && (!this._started || this._combinedResult || this._preparation)) {
      if (!budget)
        return;
      this._preparation ??= this._combinedResult ? this._prepareCombined(frameState) : this._prepare(frameState);
      this.advancePreparation(frameState, budget);
      if (this._preparation || budget.exhausted)
        return;
      // Native mesh cloning and its batch-table creation retain separate
      // admissions; a line's already-budgeted encoding uses the same path.
      if ((this._layout === 'native' || this._layout === 'extrusion') && nativeState !== primitiveState.COMBINING
        && this._state === primitiveState.COMBINING) {
        return;
      }
    }
    if (this._layout === 'line' && (this._state === primitiveState.COMBINED || this._lineUploadPending)) {
      try {
        if (rendering)
          this._lineResourceEnvironment = { context: frameState.context, mode: frameState.mode, mapProjection: frameState.mapProjection, scene3DOnly: frameState.scene3DOnly };
        if (!this._batchTable) {
          if (!budget || (frameState.passes && (!frameState.passes.render || frameState.passes.pick)))
            return;
          // Native initializes its own table; COMBINING prevents an atomic VA upload.
          this._state = primitiveState.COMBINING;
          try {
            super.update(frameState);
          }
          finally {
            this._state = primitiveState.COMBINED;
          }
          if (frameState.frameNumber !== undefined)
            this._lineUploadFrame = frameState.frameNumber;
          if (resourceAdmission)
            this._lineUploadTurn = resourceAdmission.turn;
          if (budget.exhausted)
            return;
        }
        this._lineUploadPending = true;
        if (!this._deferLineResources && !this._lineResourcesComplete && budget
          && (!frameState.passes || (frameState.passes.render && !frameState.passes.pick))
          && (resourceAdmission?.turn
            ? this._lineUploadTurn !== resourceAdmission.turn
            : frameState.frameNumber === undefined || this._lineUploadFrame !== frameState.frameNumber)) {
          this._lineUploadFrame = frameState.frameNumber;
          this._lineUploadTurn = resourceAdmission?.turn;
          this._advanceLineResources(frameState, budget, false);
        }
        if (rendering)
          this._adoptLineUpload(frameState);
      }
      catch (error) {
        this._fail(frameState, error);
      }
      if (!this._lineUploadAdopted || !this._lineUpload?.counts.some(count => count > 0))
        return;
    }
    const commands = frameState.commandList;
    const firstCommand = commands?.length ?? 0;
    if (this._appearanceForMode) {
      // Packing adds record-load guards and binds this owner's position
      // texture. Always specialize that complete original, never a variant.
      const source = this._linePositions?.appearance ?? this._sourceAppearance;
      if (source)
        this.appearance = this._appearanceForMode(source, frameState.mode);
    }
    super.update(frameState);
    if (this._lineUpload && commands) {
      for (let index = firstCommand; index < commands.length; index++) {
        const command = commands[index] as { count: number; vertexArray: unknown };
        const count = this._lineUpload.count(command.vertexArray);
        const presented = this._lineDrawCounts[this._lineUpload.vertexArrays.indexOf(command.vertexArray as LineVertexArray)] ?? 0;
        command.count = rendering ? count : Math.min(count, presented);
      }
    }
    if (this._lineUpload && rendering) {
      this._lineDrawCounts = [...this._lineUpload.counts];
      if (this._lineResourcesComplete && this._lineUploadPending) {
        this._lineUploadPending = false;
        this._geometries = undefined;
        native.geometryInstances = undefined;
        frameState.afterRender?.push(() => {
          if (!this.isDestroyed()) {
            this._lineUploadTurn = undefined;
            this._lineResourceEnvironment = undefined;
            this._ready = true;
          }
          return true;
        });
      }
    }
    if (this._batchTable) {
      this._inputInstances = undefined;
      this._inputAttributeCache = undefined;
    }
  }

  /**
   * @internal
   */
  private* _uploadLine(frameState: GeometryFrame): Generator<void> {
    const geometries = this._geometries;
    const prepared = this._preparedLinePositions;
    const pickOffsets = this._pickOffsets;
    if (!geometries || !prepared || !pickOffsets)
      throw new TypeError('Line upload requires combined geometry, positions and pick offsets');
    const positions = this._linePositions = new LinePositionTexture(prepared, this._sourceAppearance, frameState.context);
    this._preparedLinePositions = undefined;
    yield* positions.upload();
    const ranges: LineIndexRange[] = [];
    for (const [index, range] of pickOffsets.entries()) {
      const feature = this._instanceIds[index]?.featureIndex;
      const previous = ranges.at(-1);
      if (feature !== undefined && feature === this._instanceIds[index - 1]?.featureIndex
        && previous?.index === range.index && previous.offset + previous.count === range.offset) {
        previous.count += range.count;
      }
      else {
        ranges.push({ ...range });
      }
    }
    const upload = this._lineUpload = new LineGeometryUpload(geometries, this._attributeLocations, ranges, frameState.context);
    while (!upload.complete) {
      upload.advance();
      if (!upload.complete)
        yield;
    }
  }

  /**
   * @internal
   */
  private _adoptLineUpload(frameState: GeometryFrame): void {
    const upload = this._lineUpload;
    const geometries = this._geometries;
    if (!upload || !geometries || this._lineUploadAdopted || upload.vertexArrays.length !== geometries.length)
      return;
    const positions = this._linePositions;
    const primitiveType = geometries[0].primitiveType;
    if (!positions || primitiveType === undefined)
      throw new TypeError('Line upload adoption requires its position texture and primitive type');
    this.appearance = positions.appearance;
    // Line instances have no Native offset/distance-display attributes.
    // Own only Native's VA completion contract; its tables, shaders,
    // command creation, projection, picking and destruction stay Native.
    this._va = upload.vertexArrays;
    this._primitiveType = primitiveType;
    this._boundingSpheres = geometries.map((geometry) => {
      if (!geometry.boundingSphere)
        throw new TypeError('Combined line geometry requires a spatial bounding sphere');
      return BoundingSphere.clone(geometry.boundingSphere);
    });
    this._boundingSphereWC = geometries.map(() => new BoundingSphere());
    this._boundingSphereCV = frameState.scene3DOnly
      ? []
      : geometries.map((geometry) => {
          if (!geometry.boundingSphereCV)
            throw new TypeError('Projected line geometry requires a planar bounding sphere');
          const sphere = BoundingSphere.clone(geometry.boundingSphereCV);
          const { x, y, z } = sphere.center;
          sphere.center.x = z;
          sphere.center.y = x;
          sphere.center.z = y;
          return sphere;
        });
    this._boundingSphere2D = frameState.scene3DOnly ? [] : geometries.map(() => new BoundingSphere());
    this._boundingSphereMorph = frameState.scene3DOnly ? [] : geometries.map(() => new BoundingSphere());
    this._state = primitiveState.COMPLETE;
    // Force Native's first WC/2D/morph transformation even for identity.
    RuntimePrimitive._updateBoundingVolumes(this, frameState, this.modelMatrix, true);
    this._lineUploadAdopted = true;
  }

  /**
   * @internal
   */
  private* _prepare(frameState: GeometryFrame): Generator<void> {
    const projection = frameState.mapProjection;
    if (!(projection instanceof GeographicProjection) && !(projection instanceof WebMercatorProjection)) {
      throw new TypeError('Native asynchronous combine requires GeographicProjection or WebMercatorProjection');
    }
    this._lineResourceEnvironment = { context: frameState.context, mode: frameState.mode, mapProjection: frameState.mapProjection, scene3DOnly: frameState.scene3DOnly };
    const owner = this._geometryOwner ??= GeometryPrepareWorker.acquire(frameState.context);
    if (owner.error !== undefined) {
      this._fail(frameState, owner.error);
      return;
    }
    const instances = (this as NativePrimitiveRuntime).geometryInstances;
    if (!instances)
      throw new TypeError('Geometry preparation requires construction instances');
    const source = Array.isArray(instances) ? instances : [instances];
    let task: Promise<GeometryPrepareResult> | undefined;
    try {
      // Do not allocate Native metadata while both dispatch slots are busy.
      this._waitingBytes = 1;
      while (!owner.queue.hasCapacity) {
        if (owner.queue.error !== undefined)
          throw owner.queue.error;
        this._waitingForSlot = owner;
        yield;
      }
      this._waitingForSlot = undefined;
      const transferableObjects: ArrayBuffer[] = [];
      const parameters = primitivePipeline.packCombineGeometryParameters({
        createGeometryResults: [],
        instances: source,
        ellipsoid: projection.ellipsoid,
        projection,
        elementIndexUintSupported: frameState.context.elementIndexUint,
        scene3DOnly: this._layout === 'line' || frameState.scene3DOnly,
        vertexCacheOptimize: this.vertexCacheOptimize,
        compressVertices: this.compressVertices,
        modelMatrix: Matrix4.clone(this.modelMatrix),
        createPickOffsets: this._layout === 'line' || this._createPickOffsets,
      }, transferableObjects);
      const geometries = source.map(instance => instance.geometry);
      const chunks: Array<ReturnType<typeof createChunk>> = [];
      let bytes = transferableObjects.reduce((total, buffer) => total + buffer.byteLength, 0);
      for (let start = 0; start < geometries.length;) {
        const chunk = createChunk(geometries, start, this._layout);
        chunks.push(chunk);
        bytes += chunk.bytes;
        start += chunk.geometries.length;
        if (start < geometries.length)
          yield;
      }
      // Count exact aligned packet and Native metadata bytes before copying.
      // A queued batch can accept another small request even with two slots
      // occupied; a larger request must wait without allocating raw clones.
      this._waitingBytes = bytes;
      while (!owner.queue.canSchedule(bytes)) {
        if (owner.queue.error !== undefined)
          throw owner.queue.error;
        this._waitingForSlot = owner;
        yield;
      }
      this._waitingForSlot = undefined;
      const packets: GeometryPacket[] = [];
      for (const chunk of chunks)
        packets.push(yield* createGeometryPacket(chunk.geometries, this._layout === 'line' ? lineInputs : undefined));
      const inputs: GeometryPrepareRequest['lineInputs'] = this._layout === 'line' ? [] : undefined;
      if (inputs) {
        for (const packet of packets) {
          if (!packet.lineInputs)
            throw new TypeError('Line geometry packets require source coordinates');
          inputs.push(...packet.lineInputs);
        }
      }
      const request: GeometryPrepareRequest = {
        parameters,
        geometries: packets.flatMap(packet => packet.subTasks.map(task => task.geometry)),
        layout: this._layout,
        lineInputs: inputs,
        scene3DOnly: frameState.scene3DOnly,
        maximumTextureSize: geometryContextLimits.maximumTextureSize,
      };
      for (const packet of packets) transferableObjects.push(...packet.transfers);
      // Keep the owned packet across yields if another owner filled the batch
      // while its CPU copy was advancing; source geometry is never recopied.
      task = owner.queue.schedule(request, transferableObjects, () => this.isDestroyed());
      while (!task) {
        this._waitingForSlot = owner;
        yield;
        task = owner.queue.schedule(request, transferableObjects, () => this.isDestroyed());
      }
      this._waitingForSlot = undefined;
      this._numberOfInstances = source.length;
      this._instanceIds = source.map(instance => instance.id);
      this._state = primitiveState.COMBINING;
      this._started = true;
    }
    catch (error) {
      this._fail(frameState, error);
    }
    if (task) {
      void task.then((packedResult) => {
        if (this.isDestroyed())
          return;
        this._combinedResult = packedResult;
      }).catch((error) => {
        if (!this.isDestroyed())
          this._fail(frameState, error);
      });
      // Raw cloning and Native batch-table creation both consume main-thread
      // time. Give solid meshes a separate update for the latter.
    }
  }

  /**
   * @internal
   */
  private* _prepareCombined(frameState: GeometryFrame): Generator<void> {
    const result = this._combinedResult;
    if (!result)
      throw new TypeError('Combined geometry preparation requires a Worker reply');
    this._combinedResult = undefined;
    const combined = primitivePipeline.unpackCombineGeometryResults(result.combined);
    if (!combined.geometries?.length) {
      this._fail(frameState, undefined);
      return;
    }
    if (result.lineBoundsCV) {
      const spheres: BoundingSphere[] = [];
      for (let offset = 0; offset < result.lineBoundsCV.length; offset += 4) {
        spheres.push(BoundingSphere.unpack(result.lineBoundsCV as unknown as number[], offset));
        if (spheres.length % 32 === 0 && offset + 4 < result.lineBoundsCV.length)
          yield;
      }
      combined.boundingSpheresCV = spheres;
    }
    this._preparedLinePositions = result.linePositions;
    if (this._layout === 'extrusion')
      (this.appearance as ExtrusionAppearance).configurePositions(combined.geometries[0]);
    if (this._layout === 'surface-planar' || this._layout === 'surface-morph')
      this.appearance = packSurfacePositions(combined.geometries, this.appearance, this._layout === 'surface-morph');
    this._geometries = combined.geometries;
    this._attributeLocations = GeometryPipeline.createAttributeLocations(combined.geometries[0]);
    Matrix4.clone(combined.modelMatrix, this.modelMatrix);
    this._pickOffsets = combined.pickOffsets;
    this._offsetInstanceExtend = combined.offsetInstanceExtend;
    this._instanceBoundingSpheres = combined.boundingSpheres;
    this._instanceBoundingSpheresCV = combined.boundingSpheresCV;
    this._recomputeBoundingSpheres = true;
    this._state = primitiveState.COMBINED;
  }

  destroy(): void {
    const owner = this._geometryOwner;
    this._geometryOwner = undefined;
    this._inputInstances = undefined;
    this._inputAttributeCache = undefined;
    this._preparation?.return(undefined);
    this._preparation = undefined;
    this._waitingForSlot = undefined;
    this._combinedResult = undefined;
    this._preparedLinePositions = undefined;
    this._lineUploadSteps?.return(undefined);
    this._lineUploadSteps = undefined;
    this._lineUploadPending = false;
    this._lineUploadAdopted = false;
    this._lineUploadTurn = undefined;
    this._lineResourceEnvironment = undefined;
    this._lineResourcesComplete = false;
    this._lineDrawCounts = [];
    this._lineFailurePending = false;
    this._lineUpload?.destroy();
    if (this._lineUpload)
      this._va = [];
    this._lineUpload = undefined;
    this._linePositions?.destroy();
    this._linePositions = undefined;
    (this as NativePrimitiveRuntime).geometryInstances = undefined;
    this._geometries = undefined;
    this._createGeometryResults = undefined;
    super.destroy();
    if (owner)
      owner.release();
  }

  /**
   * @internal
   */
  private _fail(frameState: GeometryFrame, error: unknown, detached = false): void {
    this._started = true;
    this._preparation = undefined;
    this._waitingForSlot = undefined;
    this._combinedResult = undefined;
    this._preparedLinePositions = undefined;
    this._lineUploadSteps?.return(undefined);
    this._lineUploadSteps = undefined;
    this._lineUploadPending = false;
    this._lineUploadAdopted = false;
    this._lineUploadTurn = undefined;
    this._lineResourceEnvironment = undefined;
    this._lineResourcesComplete = false;
    this._lineDrawCounts = [];
    this._lineFailurePending = false;
    this._lineUpload?.destroy();
    if (this._lineUpload)
      this._va = [];
    this._lineUpload = undefined;
    this._linePositions?.destroy();
    this._linePositions = undefined;
    // Native checks the instance envelope before propagating a failure.
    // Preserve IDs, matrices and mutable paint attributes, but release the
    // mesh storage that a failed owner can never upload. Shared source and
    // cached Geometry objects remain untouched.
    const native = this as NativePrimitiveRuntime;
    const instances = native.geometryInstances;
    if (instances) {
      const metadata = (Array.isArray(instances) ? instances : [instances]).map(instance => new GeometryInstance({
        ...instance,
        geometry: new Geometry({ attributes: {} as Geometry['attributes'], boundingSphere: instance.geometry.boundingSphere, primitiveType: instance.geometry.primitiveType }),
      }));
      native.geometryInstances = Array.isArray(instances) ? metadata : metadata[0];
      this._inputInstances = this._inputInstances && new Map(metadata.map(instance => [instance.id, instance]));
    }
    this._geometries = undefined;
    this._createGeometryResults = undefined;
    this._error = error;
    this._state = primitiveState.FAILED;
    if (detached) {
      this._lineFailurePending = true;
    }
    else {
      frameState.afterRender?.push(() => {
        if (!this.isDestroyed())
          this._ready = true;
        return true;
      });
    }
  }
}

/** Solid and patterned extrusion commands share translation and depth bounds. */
export class ExtrusionGeometryPrimitive extends GeometryPrimitive {
  private readonly _maxHeight: number;
  private readonly _translationAppearance: ExtrusionAppearance;
  private readonly _bounds = new WeakMap<BoundingSphere, BoundingSphere>();
  private readonly _commands = new WeakMap<object, DrawCommandReplay>();

  constructor(options: { geometryInstances: GeometryInstance[]; appearance: ExtrusionAppearance; compressVertices?: boolean }) {
    super(options, 'extrusion');
    this._translationAppearance = options.appearance;
    this._maxHeight = options.geometryInstances.reduce((height, instance) => {
      const shape = instance.attributes.extrusionShape.value;
      return Math.max(height, shape[0], shape[1]);
    }, 0);
  }

  override update(frameState?: GeometryFrame): void {
    if (frameState)
      Object.assign(this._translationAppearance.uniforms, { u_extrusionMercator: frameState.mapProjection instanceof WebMercatorProjection });
    const start = frameState?.commandList?.length ?? 0;
    super.update(frameState);
    const translate = this._translationAppearance.translation;
    if (!frameState?.commandList || (translate.x === 0 && translate.y === 0))
      return;
    const padding = mercatorTranslationPadding(translate, frameState.mapProjection.ellipsoid, frameState.mode, this._maxHeight);
    for (let index = start; index < frameState.commandList.length; index++) {
      const command = frameState.commandList[index] as { owner?: object; boundingVolume?: BoundingSphere };
      const source = command.boundingVolume;
      if (command.owner !== this || !source)
        continue;
      let bounds = this._bounds.get(source);
      if (!bounds) {
        bounds = new BoundingSphere();
        this._bounds.set(source, bounds);
      }
      BoundingSphere.clone(source, bounds);
      bounds.radius += padding;
      let replay = this._commands.get(command);
      if (!replay) {
        replay = new DrawCommandReplay(command);
        this._commands.set(command, replay);
      }
      frameState.commandList[index] = replay.update(command, bounds);
    }
  }
}
