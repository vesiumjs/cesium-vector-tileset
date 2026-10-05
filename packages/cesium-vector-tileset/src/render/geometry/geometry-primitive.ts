import type { MapProjection, SceneMode } from 'cesium';
import * as Cesium from 'cesium';
import { BoundingSphere, buildModuleUrl, Cartesian3, Cartographic, Math as CesiumMath, ComponentDatatype, GeographicProjection, Geometry, GeometryAttribute, GeometryInstance, GeometryPipeline, Matrix4, Primitive, TaskProcessor, WebMercatorProjection } from 'cesium';
import { LinePositionTexture } from '../line/line-position-texture';
import { packSurfacePositions } from './surface-position';

interface GeometryFrame {
  mode: SceneMode;
  mapProjection: MapProjection;
  scene3DOnly: boolean;
  context: { elementIndexUint: boolean };
  passes?: { render: boolean; pick: boolean };
  afterRender?: Array<() => boolean>;
  commandList?: Array<{ boundingVolume?: BoundingSphere }>;
}

interface CreatedGeometry {
  packedData: Float64Array;
}

interface PackedCombineParameters {
  createGeometryResults: CreatedGeometry[];
}

interface CombineParameters {
  createGeometryResults: CreatedGeometry[];
  instances: GeometryInstance[];
  ellipsoid: MapProjection['ellipsoid'];
  projection: MapProjection;
  elementIndexUintSupported: boolean;
  scene3DOnly: boolean;
  vertexCacheOptimize: boolean;
  compressVertices: boolean;
  modelMatrix: Matrix4;
  createPickOffsets?: boolean;
}

interface CombinedGeometry extends Geometry {
  boundingSphereCV?: BoundingSphere;
}

interface CombineResult {
  geometries: CombinedGeometry[];
  modelMatrix: Matrix4;
  pickOffsets: unknown;
  offsetInstanceExtend: unknown;
  boundingSpheres: Array<BoundingSphere | undefined>;
  boundingSpheresCV: Array<BoundingSphere | undefined>;
}

// Cesium 1.146 exports these pipeline contracts at runtime, but omits them
// from its declarations. Keep the private integration inside this adapter.
interface CesiumRuntime {
  EncodedCartesian3: { encode: (value: number, result: { high: number; low: number }) => { high: number; low: number } };
  PrimitivePipeline: {
    packCombineGeometryParameters: (parameters: CombineParameters, transferableObjects: object[]) => PackedCombineParameters;
    unpackCombineGeometryResults: (result: object) => CombineResult;
  };
  PrimitiveState: { COMBINING: number; COMBINED: number; FAILED: number };
}

const PrimitivePipeline = (Cesium as unknown as CesiumRuntime).PrimitivePipeline;
const PrimitiveState = (Cesium as unknown as CesiumRuntime).PrimitiveState;
const EncodedCartesian3 = (Cesium as unknown as CesiumRuntime).EncodedCartesian3;
const attributeDatatypes = ComponentDatatype as typeof ComponentDatatype & {
  getSizeInBytes: (datatype: ComponentDatatype) => number;
};

const maximumActiveTasks = 2;
const maximumCreateBytes = 512 * 1024;
const maximumCreateInstances = 512;
type GeometryLayout = 'native' | 'line' | 'surface-planar' | 'surface-morph';
type GeometryStage = 'createGeometry' | 'combineGeometry';
interface GeometryProcessor {
  processor: TaskProcessor;
  worker?: Worker;
  bootstrapUrl?: string;
}
interface GeometryOwner {
  context: GeometryFrame['context'];
  references: number;
  pending: Set<(error: unknown) => void>;
  processors: Partial<Record<GeometryStage, GeometryProcessor>>;
  error?: unknown;
  onError: (event: ErrorEvent) => void;
  onMessageError: () => void;
}
const geometryOwners = new WeakMap<GeometryFrame['context'], GeometryOwner>();

function acquireOwner(context: GeometryFrame['context']): GeometryOwner {
  let owner = geometryOwners.get(context);
  if (!owner) {
    const created: GeometryOwner = {
      context,
      references: 0,
      pending: new Set(),
      processors: {},
      onError: event => failOwner(created, event.error instanceof Error ? event.error : new Error(`Cesium geometry worker failed: ${event.message}`)),
      onMessageError: () => failOwner(created, new Error('Cesium geometry worker could not deserialize a message')),
    };
    owner = created;
    geometryOwners.set(context, owner);
  }
  owner.references++;
  return owner;
}

function disposeWorkers(owner: GeometryOwner): void {
  for (const stage of ['createGeometry', 'combineGeometry'] as const) {
    const entry = owner.processors[stage];
    if (!entry)
      continue;
    delete owner.processors[stage];
    entry.worker?.removeEventListener('error', owner.onError);
    entry.worker?.removeEventListener('messageerror', owner.onMessageError);
    entry.processor.destroy();
    if (entry.bootstrapUrl)
      URL.revokeObjectURL(entry.bootstrapUrl);
  }
}

function failOwner(owner: GeometryOwner, error: unknown): void {
  owner.error ??= error;
  const pending = [...owner.pending.values()];
  owner.pending.clear();
  disposeWorkers(owner);
  for (const reject of pending) reject(owner.error);
}

function releaseOwner(owner: GeometryOwner): void {
  if (--owner.references !== 0)
    return;
  geometryOwners.delete(owner.context);
  failOwner(owner, new Error('Cesium geometry workers were destroyed'));
}

function nativeTask(owner: GeometryOwner, stage: GeometryStage, parameters: object, transfers: object[]): Promise<object> {
  if (owner.error)
    throw owner.error;
  try {
    let entry = owner.processors[stage];
    if (!entry) {
      const workerUrl = buildModuleUrl(`Workers/${stage}.js`);
      entry = owner.processors[stage] = { processor: new TaskProcessor(workerUrl) };
      if (new URL(workerUrl, window.location.href).origin !== window.location.origin) {
        // Native treats even local blob URLs as cross-origin and does not
        // revoke its shim. Own this CDN Worker URL, then let TaskProcessor
        // schedule and destroy the Worker through its existing runtime slot.
        entry.bootstrapUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(workerUrl)};`], { type: 'application/javascript' }));
        (entry.processor as TaskProcessor & { _worker: Worker })._worker = new Worker(entry.bootstrapUrl, { type: 'module' });
      }
    }
    const task = entry.processor.scheduleTask(parameters, transfers);
    if (!entry.worker) {
      // Native owns message IDs, transfer negotiation and serialized errors.
      // Its runtime Worker is only observed for fatal browser failures, which
      // TaskProcessor otherwise leaves pending indefinitely.
      entry.worker = (entry.processor as TaskProcessor & { _worker: Worker })._worker;
      entry.worker.addEventListener('error', owner.onError);
      entry.worker.addEventListener('messageerror', owner.onMessageError);
    }
    return task;
  }
  catch (error) {
    failOwner(owner, error);
    throw error;
  }
}

function createChunk(geometries: Geometry[], start: number): Array<{ geometry: Geometry }> {
  const subTasks: Array<{ geometry: Geometry }> = [];
  let bytes = 0;
  while (start + subTasks.length < geometries.length && subTasks.length < maximumCreateInstances) {
    const geometry = geometries[start + subTasks.length];
    const indices = geometry.indices as unknown as Uint16Array | Uint32Array | undefined;
    let geometryBytes = indices?.byteLength ?? 0;
    for (const attribute of Object.values(geometry.attributes)) {
      if (attribute?.values)
        geometryBytes += attribute.values.length * attributeDatatypes.getSizeInBytes(attribute.componentDatatype);
    }
    // Keep indivisible Geometry intact, including Native indices and bounds.
    // Later pieces are sent only after the original create Worker replies.
    if (subTasks.length > 0 && bytes + geometryBytes > maximumCreateBytes)
      break;
    subTasks.push({ geometry });
    bytes += geometryBytes;
  }
  return subTasks;
}

async function combineGeometry(owner: GeometryOwner, geometries: Geometry[], parameters: PackedCombineParameters, transfers: object[], cancelled: () => boolean): Promise<object> {
  for (let start = 0; start < geometries.length;) {
    const subTasks = createChunk(geometries, start);
    const result = await nativeTask(owner, 'createGeometry', { subTasks }, []) as CreatedGeometry;
    if (cancelled())
      return undefined;
    parameters.createGeometryResults.push(result);
    transfers.push(result.packedData.buffer);
    start += subTasks.length;
  }
  // Only independent Native outputs transfer. The shared source arrays stay
  // intact; no main-thread create serializer or synchronous fallback exists.
  return nativeTask(owner, 'combineGeometry', parameters, transfers);
}

function scheduleGeometry(owner: GeometryOwner, geometries: Geometry[], parameters: PackedCombineParameters, transfers: object[], cancelled: () => boolean): Promise<object> {
  return new Promise<object>((resolve, reject) => {
    owner.pending.add(reject);
    void combineGeometry(owner, geometries, parameters, transfers, cancelled).then((result) => {
      owner.pending.delete(reject);
      resolve(result);
    }, (error) => {
      owner.pending.delete(reject);
      reject(error);
    });
  });
}

/** Source topology stays local; Native only receives the prepared attributes. */
export interface LineInput {
  positions: Float64Array;
  vertices: Uint32Array;
  closed: boolean;
}
export interface CanonicalLineInput extends LineInput {
  longitudes: Float64Array;
}
export const lineInputs = new WeakMap<Geometry, CanonicalLineInput | LineInput>();

function projectedSourceLine(input: LineInput | CanonicalLineInput, projection: MapProjection, records: Float32Array, recordOffset: number, transformed: boolean): Float64Array {
  const count = input.positions.length / 3;
  // Each final record has 48 bytes. Its first 24 bytes temporarily hold
  // DOUBLE xyz; the last 24 already hold the final FLOAT neighbour offsets.
  const source = new Float64Array(records.buffer, records.byteOffset + recordOffset * 48, input.positions.length * 2);
  const position = new Cartesian3();
  const cartographic = new Cartographic();
  const projected = new Cartesian3();
  for (let index = 0; index < count; index++) {
    Cartesian3.unpack(input.positions as unknown as number[], index * 3, position);
    const point = projection.ellipsoid.cartesianToCartographic(position, cartographic);
    if (!point)
      throw new TypeError('source line position cannot be projected to cartographic coordinates');
    if ('longitudes' in input) {
      const longitude = input.longitudes[index];
      point.longitude = transformed ? longitude + CesiumMath.negativePiToPi(point.longitude - longitude) : longitude;
    }
    projection.project(point, projected);
    Cartesian3.pack(projected, source as unknown as number[], index * 6);
  }
  for (let point = 0; point < count; point++) {
    const prior = input.closed ? (point + count - 1) % count : Math.max(0, point - 1);
    const following = input.closed ? (point + 1) % count : Math.min(count - 1, point + 1);
    for (let component = 0; component < 3; component++) {
      const center = source[point * 6 + component];
      const offset = (recordOffset + point) * 12 + component;
      // The missing endpoint neighbour is mirrored after scene projection.
      // It has no original ECEF or source coordinate to inverse-project.
      records[offset + 6] = !input.closed && point === 0
        ? center - source[following * 6 + component]
        : source[prior * 6 + component] - center;
      records[offset + 9] = !input.closed && point === count - 1
        ? center - source[prior * 6 + component]
        : source[following * 6 + component] - center;
    }
  }
  return source;
}

function lineInstance(instance: GeometryInstance, projection: MapProjection, records: { spatial: Float32Array; planar?: Float32Array }, recordOffset: number): GeometryInstance {
  const source = instance.geometry;
  const input = lineInputs.get(source);
  if (!input)
    throw new TypeError('line geometry requires source coordinates');
  let positions = input.positions;
  let sphere = source.boundingSphere;
  const transformed = !Matrix4.equals(instance.modelMatrix, Matrix4.IDENTITY);
  if (transformed) {
    // Native's multi-mode contract uses world coordinates. Transform only
    // owned source storage; the cached Geometry and caller's matrix survive.
    const geometry = new Geometry({
      attributes: { position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions.slice() }) } as Geometry['attributes'],
      boundingSphere: BoundingSphere.clone(sphere),
    });
    const world = new GeometryInstance({ geometry, modelMatrix: Matrix4.clone(instance.modelMatrix) });
    (GeometryPipeline as typeof GeometryPipeline & { transformToWorldCoordinates: (instance: GeometryInstance) => GeometryInstance }).transformToWorldCoordinates(world);
    positions = geometry.attributes.position.values as Float64Array;
    sphere = geometry.boundingSphere;
  }
  const pointCount = positions.length / 3;
  const projected = records.planar ? projectedSourceLine({ ...input, positions }, projection, records.planar, recordOffset, transformed) : undefined;
  const sphereCV = projected ? BoundingSphere.fromVertices(projected as unknown as number[], Cartesian3.ZERO, 6) : undefined;
  const centers = transformed || !source.attributes.position
    ? new Float64Array(input.vertices.length * 3)
    : source.attributes.position.values as Float64Array;
  const ids = new Float32Array(input.vertices.length);
  for (let vertex = 0; vertex < input.vertices.length; vertex++) {
    const point = input.vertices[vertex];
    ids[vertex] = recordOffset + point;
    if (transformed || !source.attributes.position) {
      for (let component = 0; component < 3; component++) centers[vertex * 3 + component] = positions[point * 3 + component];
    }
  }
  const encoded = { high: 0, low: 0 };
  let maximumProjectionErrorSquared = 0;
  for (let point = 0; point < pointCount; point++) {
    const record = recordOffset + point;
    if (Math.fround(record) !== record)
      throw new RangeError('line position record ID exceeds exact FLOAT integer representation');
    const prior = input.closed ? (point + pointCount - 1) % pointCount : Math.max(0, point - 1);
    const following = input.closed ? (point + 1) % pointCount : Math.min(pointCount - 1, point + 1);
    // Read the DOUBLE planar scratch before overwriting it with final words.
    const planarX = projected?.[point * 6];
    const planarY = projected?.[point * 6 + 1];
    const planarZ = projected?.[point * 6 + 2];
    let projectionErrorSquared = 0;
    for (let component = 0; component < 3; component++) {
      const output = record * 12 + component;
      const center = positions[point * 3 + component];
      EncodedCartesian3.encode(center, encoded);
      records.spatial[output] = encoded.high === 0 ? 0 : encoded.high / 65536;
      records.spatial[output + 3] = encoded.low;
      const previous = !input.closed && point === 0 ? center + (center - positions[following * 3 + component]) : positions[prior * 3 + component];
      const next = !input.closed && point === pointCount - 1 ? center + (center - positions[prior * 3 + component]) : positions[following * 3 + component];
      records.spatial[output + 6] = previous - center;
      records.spatial[output + 9] = next - center;
      if (records.planar) {
        EncodedCartesian3.encode(component === 0 ? planarX : component === 1 ? planarY : planarZ, encoded);
        records.planar[output] = encoded.high === 0 ? 0 : encoded.high / 65536;
        records.planar[output + 3] = encoded.low;
        const delta = records.planar[output] * 65536 + records.planar[output + 3] - (component === 0 ? planarX : component === 1 ? planarY : planarZ);
        projectionErrorSquared += delta * delta;
      }
    }
    maximumProjectionErrorSquared = Math.max(maximumProjectionErrorSquared, projectionErrorSquared);
  }
  if (sphereCV)
    sphereCV.radius += Math.sqrt(maximumProjectionErrorSquared);
  const attributes = {
    ...source.attributes,
    position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: centers }),
    a_lineRecord: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: ids }),
  };
  const geometry = Object.assign(new Geometry({ attributes: attributes as Geometry['attributes'] }), source, { attributes, boundingSphere: sphere, boundingSphereCV: sphereCV });
  return Object.assign(new GeometryInstance({ geometry }), instance, { geometry, modelMatrix: Matrix4.clone(Matrix4.IDENTITY) });
}

/** Pack only the attributes consumed by the layout's explicit position shader. */
function packAttributes(geometry: Geometry, layout: GeometryLayout): void {
  if (layout === 'native')
    return;
  const attributes = geometry.attributes as unknown as Record<string, GeometryAttribute>;
  // Native assigns each vertex its original instance index, including both
  // date-line halves. The constructor bounds those indices to 16 bits.
  attributes.batchId = new GeometryAttribute({
    componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
    componentsPerAttribute: 1,
    values: new Uint16Array(attributes.batchId.values),
  });
  if (layout === 'line') {
    // Native needed the centres for batch IDs, cache reordering and bounds.
    // Rendering now reads immutable source records through a_lineRecord.
    for (const name of ['position3DHigh', 'position3DLow', 'position2DHigh', 'position2DLow'])
      delete attributes[name];
  }
}

/**
 * One Native assembly path for solid meshes, line strips and flat surfaces.
 * Solid meshes keep Native attributes and appearance. Line centres
 * are projected once before encode-only combine, preserving discrete roles.
 * Surfaces retain Native date-line splitting and both position tracks;
 * each layout packs its active attributes before Native uploads the VA.
 * Planar line neighbours are projected only when the scene is available.
 * Native Primitive still owns batch tables, drawing, picking and destruction.
 */
export class GeometryPrimitive extends Primitive {
  private _started = false;
  private _geometryOwner?: GeometryOwner;
  private readonly _layout: GeometryLayout;
  private _inputInstances?: Map<unknown, GeometryInstance>;
  private _linePositions?: LinePositionTexture;
  private _linePositionData?: { spatial: Float32Array; planar?: Float32Array };
  private readonly _lineOffsetMeters: number;
  private _lineBoundingSpheres?: WeakMap<BoundingSphere, BoundingSphere>;

  constructor(options: Pick<NonNullable<ConstructorParameters<typeof Primitive>[0]>, 'geometryInstances' | 'appearance' | 'vertexCacheOptimize' | 'compressVertices'>, layout: GeometryLayout, lineOffsetMeters = 0) {
    if (layout !== 'native' && Array.isArray(options.geometryInstances) && options.geometryInstances.length > 65536) {
      throw new RangeError('geometry instance IDs exceed unsigned 16-bit range');
    }
    // A centreline sphere cannot enclose arbitrary window-space widths/caps.
    // MVT covering owns tile visibility; Native retains depth testing, frustum
    // depth partitioning and shader near clipping, but must not reject the
    // expanded strip against that sphere (especially in the narrow pick view).
    super({ ...options, allowPicking: true, asynchronous: true, releaseGeometryInstances: true, cull: layout === 'native' || layout === 'surface-planar' || layout === 'surface-morph' });
    this._layout = layout;
    this._lineOffsetMeters = Math.abs(lineOffsetMeters);
  }

  /** Immutable geometry storage, shared by every layer replaying this owner. */
  get positionTexture(): LinePositionTexture['texture'] | undefined {
    return this._linePositions?.texture;
  }

  // Native's accessor works as soon as its batch table exists, before ready.
  // Before the first update, write the same mutable construction attributes.
  getGeometryInstanceAttributes(id: unknown): ReturnType<Primitive['getGeometryInstanceAttributes']> {
    if ((this as GeometryPrimitive & { _batchTable?: object })._batchTable)
      return super.getGeometryInstanceAttributes(id);
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
    return Object.defineProperties({}, descriptors);
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
    if (!this._started) {
      const projection = frameState.mapProjection;
      if (!(projection instanceof GeographicProjection) && !(projection instanceof WebMercatorProjection)) {
        throw new TypeError('Native asynchronous combine requires GeographicProjection or WebMercatorProjection');
      }
      const owner = this._geometryOwner ??= acquireOwner(frameState.context);
      if (owner.error) {
        this._fail(frameState, owner.error);
        Reflect.apply(Primitive.prototype.update, this, [frameState]);
        return;
      }
      // Admission precedes neighbour projection and the raw Geometry clone.
      // A full owner leaves READY untouched; the tileset retries next frame.
      if (owner.pending.size >= maximumActiveTasks)
        return;
      const instances = this.geometryInstances;
      const source = Array.isArray(instances) ? instances : [instances];
      let task: Promise<object> | undefined;
      let lineSpheresCV: BoundingSphere[] | undefined;
      try {
        let prepared = source;
        if (this._layout === 'line') {
          // A full-mode Scene owns both position tracks for its lifetime.
          // Only Native's immutable scene3DOnly capability omits projection.
          const recordCount = source.reduce((count, instance) => {
            const input = lineInputs.get(instance.geometry);
            if (!input)
              throw new TypeError('line geometry requires source coordinates');
            return count + input.positions.length / 3;
          }, 0);
          const records = this._linePositionData = { spatial: new Float32Array(recordCount * 12), planar: frameState.scene3DOnly ? undefined : new Float32Array(recordCount * 12) };
          let recordOffset = 0;
          prepared = source.map((instance) => {
            const result = lineInstance(instance, projection, records, recordOffset);
            recordOffset += lineInputs.get(instance.geometry).positions.length / 3;
            return result;
          });
          if (records.planar)
            lineSpheresCV = prepared.map(instance => (instance.geometry as CombinedGeometry).boundingSphereCV);
        }
        const transferableObjects: object[] = [];
        const parameters = PrimitivePipeline.packCombineGeometryParameters({
          createGeometryResults: [],
          instances: prepared,
          ellipsoid: projection.ellipsoid,
          projection,
          elementIndexUintSupported: frameState.context.elementIndexUint,
          scene3DOnly: this._layout === 'line' || frameState.scene3DOnly,
          vertexCacheOptimize: this.vertexCacheOptimize,
          compressVertices: this.compressVertices,
          modelMatrix: Matrix4.clone(this.modelMatrix),
          createPickOffsets: (this as Primitive & { _createPickOffsets?: boolean })._createPickOffsets,
        }, transferableObjects);
        task = scheduleGeometry(owner, prepared.map(instance => instance.geometry), parameters, transferableObjects, () => this.isDestroyed());
        Object.assign(this, {
          geometryInstances: Array.isArray(instances) ? prepared : prepared[0],
          _numberOfInstances: prepared.length,
          _instanceIds: prepared.map(instance => instance.id),
          _state: PrimitiveState.COMBINING,
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
          const combined = PrimitivePipeline.unpackCombineGeometryResults(packedResult);
          if (!combined.geometries?.length) {
            this._fail(frameState, undefined);
            return;
          }
          if (lineSpheresCV) {
            // Native packs instance bounds into FLOAT during Worker transport.
            // Keep the prepared DOUBLE projection bounds for narrow frusta.
            combined.boundingSpheresCV = lineSpheresCV;
            const sphere = BoundingSphere.fromBoundingSpheres(lineSpheresCV);
            for (const geometry of combined.geometries) geometry.boundingSphereCV = BoundingSphere.clone(sphere);
          }
          combined.geometries.forEach(geometry => packAttributes(geometry, this._layout));
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
            _state: PrimitiveState.COMBINED,
          });
        }).catch((error) => {
          if (!this.isDestroyed())
            this._fail(frameState, error);
        });
        // Raw cloning and Native batch-table creation both consume main-thread
        // time. Give solid meshes a separate update for the latter.
        if (this._layout === 'native')
          return;
      }
    }
    const native = this as unknown as { _state: number; _geometries: Geometry[]; _attributeLocations: Record<string, number> };
    if (native._state === PrimitiveState.COMBINED && this.appearance && !this._linePositions
      && this._layout === 'line') {
      try {
        this._linePositions = new LinePositionTexture(this._linePositionData, this.appearance, frameState.context);
        this._linePositionData = undefined;
        this.appearance = this._linePositions.appearance;
      }
      catch (error) {
        this._fail(frameState, error);
      }
    }
    const commands = frameState.commandList;
    const firstCommand = commands?.length ?? 0;
    Reflect.apply(Primitive.prototype.update, this, [frameState]);
    // Native still partitions depth with its world sphere when cull=false.
    // Enclose every layer's shader height without mutating Native's raw bounds
    // or applying the model matrix's scale to a displacement in world metres.
    if (this._lineOffsetMeters > 0 && commands) {
      const bounds = this._lineBoundingSpheres ??= new WeakMap<BoundingSphere, BoundingSphere>();
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
        command.boundingVolume = sphere;
      }
    }
    if ((this as GeometryPrimitive & { _batchTable?: object })._batchTable)
      this._inputInstances = undefined;
  }

  destroy(): void {
    const owner = this._geometryOwner;
    this._geometryOwner = undefined;
    this._inputInstances = undefined;
    this._linePositions?.destroy();
    this._linePositions = undefined;
    this._linePositionData = undefined;
    this._lineBoundingSpheres = undefined;
    Object.assign(this, { geometryInstances: undefined, _geometries: undefined, _createGeometryResults: undefined });
    super.destroy();
    if (owner)
      releaseOwner(owner);
  }

  private _fail(frameState: GeometryFrame, error: unknown): void {
    this._started = true;
    this._linePositionData = undefined;
    Object.assign(this, { _error: error, _state: PrimitiveState.FAILED });
    frameState.afterRender?.push(() => {
      if (!this.isDestroyed())
        Object.assign(this, { _ready: true });
      return true;
    });
  }
}
