import type { Appearance, MapProjection, SceneMode } from 'cesium';
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
  const state = (primitive as Primitive & { _state: number })._state;
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
export class GeometryPrimitive extends Primitive {
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

  private readonly _lineOffsetMeters: number;

  private _lineBoundingSpheres?: WeakMap<BoundingSphere, BoundingSphere>;

  private _expandedCommands?: WeakMap<object, DrawCommandReplay>;

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

  constructor(options: Pick<NonNullable<ConstructorParameters<typeof Primitive>[0]>, 'geometryInstances' | 'appearance' | 'vertexCacheOptimize' | 'compressVertices'>, layout: GeometryLayout, lineOffsetMeters = 0, appearanceForMode?: GeometryAppearanceForMode) {
    if (layout !== 'native' && layout !== 'extrusion' && Array.isArray(options.geometryInstances) && options.geometryInstances.length > 65536) {
      throw new RangeError('geometry instance IDs exceed unsigned 16-bit range');
    }
    // A centreline sphere cannot enclose arbitrary window-space widths/caps.
    // MVT covering owns tile visibility; Native retains depth testing, frustum
    // depth partitioning and shader near clipping, but must not reject the
    // expanded strip against that sphere (especially in the narrow pick view).
    super({ ...options, allowPicking: true, asynchronous: true, releaseGeometryInstances: true, cull: layout === 'native' || layout === 'extrusion' || layout === 'surface-planar' || layout === 'surface-morph' });
    this._layout = layout;
    this._lineOffsetMeters = Math.abs(lineOffsetMeters);
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
    const state = (this as unknown as { _state: number })._state;
    return state !== primitiveState.FAILED
      && !!(this as GeometryPrimitive & { _batchTable?: object })._batchTable
      && (state === primitiveState.COMBINED || this._lineUploadPending);
  }

  /**
   * @internal
   */
  private get _linePresentationNeeded(): boolean {
    const native = this as unknown as { _geometries?: Geometry[] };
    return this._lineResourcesComplete || (!!this._lineUpload
      && (this._lineUploadAdopted || this._lineUpload.vertexArrays.length === native._geometries?.length)
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
      || (this as unknown as { _state: number })._state === primitiveState.FAILED) {
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
    const state = (this as unknown as { _state: number })._state;
    if (state === primitiveState.FAILED)
      return true;
    if (this._preparation || this._combinedResult)
      return false;
    if (!this._started)
      return true;
    if (!(this as GeometryPrimitive & { _batchTable?: object })._batchTable)
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
    if (!(this as GeometryPrimitive & { _batchTable?: object })._batchTable)
      return true;
    const state = (this as unknown as { _state: number })._state;
    return state !== primitiveState.CREATING && state !== primitiveState.COMBINING;
  }

  // Native's accessor works as soon as its batch table exists, before ready.
  // Before the first update, write the same mutable construction attributes.
  getGeometryInstanceAttributes(id: unknown): ReturnType<Primitive['getGeometryInstanceAttributes']> {
    if ((this as GeometryPrimitive & { _batchTable?: object })._batchTable) {
      this._inputInstances = undefined;
      this._inputAttributeCache = undefined;
      return super.getGeometryInstanceAttributes(id);
    }
    if (id === undefined || id === null || !this.geometryInstances)
      return super.getGeometryInstanceAttributes(id);
    const cached = this._inputAttributeCache?.get(id);
    if (cached)
      return cached;
    if (!this._inputInstances) {
      const instances = this.geometryInstances;
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
    if ((!this.geometryInstances && !this._started)
      || (Array.isArray(this.geometryInstances) && this.geometryInstances.length === 0)
      || (frameState?.passes && !frameState.passes.render && !frameState.passes.pick)) {
      Reflect.apply(Primitive.prototype.update, this, [frameState]);
      return;
    }
    const nativeState = (this as unknown as { _state: number })._state;
    const rendering = !frameState?.passes || (frameState.passes.render && !frameState.passes.pick);
    const resourceAdmission = geometryResourceAdmissions.get(frameState);
    if (resourceAdmission)
      this._deferLineResources = resourceAdmission.deferred;
    if (this._lineFailurePending && frameState?.passes?.render && !frameState.passes.pick) {
      this._lineFailurePending = false;
      frameState.afterRender?.push(() => {
        if (!this.isDestroyed())
          Object.assign(this, { _ready: true });
        return true;
      });
    }
    // Family geometry also carries its primary paint, so only standalone
    // dash owners can skip Native without hiding a visible replay layer.
    if (this.ready && nativeState === primitiveState.COMPLETE && drawBatchForOwner(this)?.kind === 'dash') {
      const paint = linePaintForOwner(this);
      const batchTable = (this as GeometryPrimitive & { _batchTable?: { _batchValuesDirty: boolean } })._batchTable;
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
      this._preparation ??= this._combinedResult ? this._prepareCombined(frameState) : this._prepare(frameState);
      this.advancePreparation(frameState, budget);
      if (this._preparation || budget.exhausted)
        return;
      // Native mesh cloning and its batch-table creation retain separate
      // admissions; a line's already-budgeted encoding uses the same path.
      if ((this._layout === 'native' || this._layout === 'extrusion') && nativeState !== primitiveState.COMBINING
        && (this as unknown as { _state: number })._state === primitiveState.COMBINING) {
        return;
      }
    }
    const native = this as unknown as { _state: number; _geometries: Geometry[]; _attributeLocations: Record<string, number> };
    if (this._layout === 'line' && (native._state === primitiveState.COMBINED || this._lineUploadPending)) {
      try {
        if (rendering)
          this._lineResourceEnvironment = { context: frameState.context, mode: frameState.mode, mapProjection: frameState.mapProjection, scene3DOnly: frameState.scene3DOnly };
        if (!(this as GeometryPrimitive & { _batchTable?: object })._batchTable) {
          if (!budget || (frameState.passes && (!frameState.passes.render || frameState.passes.pick)))
            return;
          // Native initializes its own table; COMBINING prevents an atomic VA upload.
          native._state = primitiveState.COMBINING;
          try {
            Reflect.apply(Primitive.prototype.update, this, [frameState]);
          }
          finally {
            native._state = primitiveState.COMBINED;
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
    Reflect.apply(Primitive.prototype.update, this, [frameState]);
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
        Object.assign(this, { _geometries: undefined, geometryInstances: undefined });
        frameState.afterRender?.push(() => {
          if (!this.isDestroyed()) {
            this._lineUploadTurn = undefined;
            this._lineResourceEnvironment = undefined;
            Object.assign(this, { _ready: true });
          }
          return true;
        });
      }
    }
    // Native still partitions depth with its world sphere when cull=false.
    // Enclose every layer's shader height without mutating Native's raw bounds
    // or applying the model matrix's scale to a displacement in world metres.
    if (this._lineOffsetMeters > 0 && commands) {
      const bounds = this._lineBoundingSpheres ??= new WeakMap<BoundingSphere, BoundingSphere>();
      const replays = this._expandedCommands ??= new WeakMap<object, DrawCommandReplay>();
      for (let index = firstCommand; index < commands.length; index++) {
        const command = commands[index];
        const source = command.boundingVolume;
        if (!source)
          continue;
        let sphere = bounds.get(source);
        if (!sphere) {
          sphere = new BoundingSphere();
          bounds.set(source, sphere);
        }
        BoundingSphere.clone(source, sphere);
        sphere.radius += this._lineOffsetMeters;
        let replay = replays.get(command);
        if (!replay) {
          replay = new DrawCommandReplay(command);
          replays.set(command, replay);
        }
        commands[index] = replay.update(command, sphere);
      }
    }
    if ((this as GeometryPrimitive & { _batchTable?: object })._batchTable) {
      this._inputInstances = undefined;
      this._inputAttributeCache = undefined;
    }
  }

  /**
   * @internal
   */
  private* _uploadLine(frameState: GeometryFrame): Generator<void> {
    const native = this as unknown as GeometryPrimitive & {
      _geometries: CombinedGeometry[];
      _attributeLocations: Record<string, number>;
      _pickOffsets: LineIndexRange[];
      _instanceIds: Array<{ featureIndex?: number }>;
      _va: unknown[];
    };
    const geometries = native._geometries;
    this._linePositions = new LinePositionTexture(this._preparedLinePositions, this._sourceAppearance, frameState.context);
    this._preparedLinePositions = undefined;
    yield* this._linePositions.upload();
    const ranges: LineIndexRange[] = [];
    for (const [index, range] of native._pickOffsets.entries()) {
      const feature = native._instanceIds[index]?.featureIndex;
      const previous = ranges.at(-1);
      if (feature !== undefined && feature === native._instanceIds[index - 1]?.featureIndex
        && previous?.index === range.index && previous.offset + previous.count === range.offset) {
        previous.count += range.count;
      }
      else {
        ranges.push({ ...range });
      }
    }
    const upload = this._lineUpload = new LineGeometryUpload(geometries, native._attributeLocations, ranges, frameState.context);
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
    const geometries = (this as unknown as { _geometries?: CombinedGeometry[] })._geometries;
    if (!upload || !geometries || this._lineUploadAdopted || upload.vertexArrays.length !== geometries.length)
      return;
    this.appearance = this._linePositions.appearance;
    // Line instances have no Native offset/distance-display attributes.
    // Own only Native's VA completion contract; its tables, shaders,
    // command creation, projection, picking and destruction stay Native.
    Object.assign(this, {
      _va: upload.vertexArrays,
      _primitiveType: geometries[0].primitiveType,
      _boundingSpheres: geometries.map(geometry => BoundingSphere.clone(geometry.boundingSphere)),
      _boundingSphereWC: geometries.map(() => new BoundingSphere()),
      _boundingSphereCV: frameState.scene3DOnly
        ? []
        : geometries.map((geometry) => {
            const sphere = BoundingSphere.clone(geometry.boundingSphereCV);
            const { x, y, z } = sphere.center;
            sphere.center.x = z;
            sphere.center.y = x;
            sphere.center.z = y;
            return sphere;
          }),
      _boundingSphere2D: frameState.scene3DOnly ? [] : geometries.map(() => new BoundingSphere()),
      _boundingSphereMorph: frameState.scene3DOnly ? [] : geometries.map(() => new BoundingSphere()),
      _state: primitiveState.COMPLETE,
    });
    // Force Native's first WC/2D/morph transformation even for identity.
    Reflect.apply((Primitive as unknown as { _updateBoundingVolumes: (...args: unknown[]) => void })._updateBoundingVolumes, Primitive, [this, frameState, this.modelMatrix, true]);
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
    const instances = this.geometryInstances;
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
        createPickOffsets: this._layout === 'line' || (this as Primitive & { _createPickOffsets?: boolean })._createPickOffsets,
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
      const request: GeometryPrepareRequest = {
        parameters,
        geometries: packets.flatMap(packet => packet.subTasks.map(task => task.geometry)),
        layout: this._layout,
        lineInputs: this._layout === 'line' ? packets.flatMap(packet => packet.lineInputs) : undefined,
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
      Object.assign(this, {
        _numberOfInstances: source.length,
        _instanceIds: source.map(instance => instance.id),
        _state: primitiveState.COMBINING,
      });
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
    Object.assign(this, {
      _geometries: combined.geometries,
      _attributeLocations: GeometryPipeline.createAttributeLocations(combined.geometries[0]),
      modelMatrix: Matrix4.clone(combined.modelMatrix, this.modelMatrix),
      _pickOffsets: combined.pickOffsets,
      _offsetInstanceExtend: combined.offsetInstanceExtend,
      _instanceBoundingSpheres: combined.boundingSpheres,
      _instanceBoundingSpheresCV: combined.boundingSpheresCV,
      _recomputeBoundingSpheres: true,
      _state: primitiveState.COMBINED,
    });
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
      Object.assign(this, { _va: [] });
    this._lineUpload = undefined;
    this._linePositions?.destroy();
    this._linePositions = undefined;
    this._lineBoundingSpheres = undefined;
    this._expandedCommands = undefined;
    Object.assign(this, { geometryInstances: undefined, _geometries: undefined, _createGeometryResults: undefined });
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
      Object.assign(this, { _va: [] });
    this._lineUpload = undefined;
    this._linePositions?.destroy();
    this._linePositions = undefined;
    // Native checks the instance envelope before propagating a failure.
    // Preserve IDs, matrices and mutable paint attributes, but release the
    // mesh storage that a failed owner can never upload. Shared source and
    // cached Geometry objects remain untouched.
    const instances = this.geometryInstances;
    if (instances) {
      const metadata = (Array.isArray(instances) ? instances : [instances]).map(instance => new GeometryInstance({
        ...instance,
        geometry: new Geometry({ attributes: {} as Geometry['attributes'], boundingSphere: instance.geometry.boundingSphere, primitiveType: instance.geometry.primitiveType }),
      }));
      Object.assign(this, { geometryInstances: Array.isArray(instances) ? metadata : metadata[0] });
      this._inputInstances = this._inputInstances && new Map(metadata.map(instance => [instance.id, instance]));
    }
    Object.assign(this, { _geometries: undefined, _createGeometryResults: undefined, _error: error, _state: primitiveState.FAILED });
    if (detached) {
      this._lineFailurePending = true;
    }
    else {
      frameState.afterRender?.push(() => {
        if (!this.isDestroyed())
          Object.assign(this, { _ready: true });
        return true;
      });
    }
  }
}
