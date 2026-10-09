import type { Geometry, GeometryAttribute } from 'cesium';
import type { CanonicalLineInput, LineInput } from './line-input';
import type { LinePositionRecords, PreparedLinePositionTexture } from './line-position-packing';
import { BoundingSphere, ComponentDatatype, IndexDatatype, Matrix4 } from 'cesium';
import { packExtrusionAttributes } from './extrusion-attributes';
import { packAttributes, prepareLineInstances } from './geometry-line';
import { lineInputs } from './line-input';
import { compileLinePositionTexture } from './line-position-packing';
import { primitivePipeline } from './primitive-pipeline';

const indexDatatype = IndexDatatype as typeof IndexDatatype & {
  createTypedArray: (vertices: number, indices: number[]) => Uint16Array | Uint32Array;
};
const componentDatatype = ComponentDatatype as typeof ComponentDatatype & {
  createTypedArray: (datatype: ComponentDatatype, values: number[]) => Exclude<GeometryAttribute['values'], number[]>;
};

/** Native splitting returns arrays; packing and transfer require typed storage. */
function prepareTransferStorage(geometry: Geometry): void {
  const attributes = geometry.attributes as unknown as Record<string, GeometryAttribute>;
  for (const attribute of Object.values(attributes)) {
    if (attribute && Array.isArray(attribute.values))
      attribute.values = componentDatatype.createTypedArray(attribute.componentDatatype, attribute.values);
  }
  if (Array.isArray(geometry.indices))
    geometry.indices = indexDatatype.createTypedArray(attributes.batchId.values.length, geometry.indices) as unknown as Geometry['indices'];
}

export type GeometryLayout = 'native' | 'extrusion' | 'line' | 'surface-planar' | 'surface-morph';

export interface GeometryPrepareRequest {
  parameters: object;
  geometries: Geometry[];
  layout: GeometryLayout;
  lineInputs?: Array<LineInput | CanonicalLineInput>;
  scene3DOnly: boolean;
  maximumTextureSize: number;
}

export interface GeometryPrepareResult {
  combined: object;
  linePositions?: PreparedLinePositionTexture;
  lineBoundsCV?: Float64Array;
}

export interface GeometryPrepareBatchRequest {
  requests: GeometryPrepareRequest[];
}

export interface GeometryPrepareBatchResult {
  results: Array<{ result: GeometryPrepareResult } | { error: { name: string; message: string; stack?: string } }>;
}

/** Owns all mutable CPU assembly; input geometries arrive on detached copies. */
export function prepareGeometry(request: GeometryPrepareRequest, transfers: ArrayBuffer[]): GeometryPrepareResult {
  const packedInstances = (request.parameters as { packedInstances?: unknown })?.packedInstances;
  if (!(isFloat64Array(packedInstances)) || packedInstances.length === 0
    || !Number.isSafeInteger(packedInstances[0]) || packedInstances[0] < 0
    || packedInstances.length !== 1 + packedInstances[0] * (Matrix4.packedLength + 3)) {
    throw new RangeError('Unsupported Cesium geometry instance packet');
  }
  const parameters = primitivePipeline.unpackCombineGeometryParameters(request.parameters);
  if (parameters.instances.length !== request.geometries.length)
    throw new RangeError('geometry preparation requires one geometry per instance');
  for (let index = 0; index < parameters.instances.length; index++)
    parameters.instances[index].geometry = request.geometries[index];
  let linePositions: PreparedLinePositionTexture | undefined;
  let lineRecords: LinePositionRecords | undefined;
  let lineBoundsCV: Float64Array | undefined;
  let spheresCV: BoundingSphere[] | undefined;
  if (request.layout === 'line') {
    if (request.lineInputs?.length !== request.geometries.length)
      throw new RangeError('line preparation requires source topology for every instance');
    for (let index = 0; index < request.geometries.length; index++)
      lineInputs.set(request.geometries[index], request.lineInputs[index]);
    const prepared = finish(prepareLineInstances(parameters.instances, parameters.projection, request.scene3DOnly));
    parameters.instances = prepared.instances;
    spheresCV = prepared.spheresCV;
    lineRecords = prepared.records;
  }
  const combined = primitivePipeline.combineGeometry(parameters);
  if (combined.geometries?.length) {
    for (const geometry of combined.geometries) {
      prepareTransferStorage(geometry);
      if (request.layout === 'extrusion')
        packExtrusionAttributes(geometry);
      else
        finish(packAttributes(geometry, request.layout));
    }
    if (lineRecords) {
      linePositions = finish(compileLinePositionTexture(lineRecords, request.maximumTextureSize));
      transfers.push(linePositions.values.buffer as ArrayBuffer);
    }
    if (spheresCV) {
      combined.boundingSpheresCV = spheresCV;
      const sphere = BoundingSphere.fromBoundingSpheres(spheresCV);
      for (const geometry of combined.geometries)
        geometry.boundingSphereCV = BoundingSphere.clone(sphere);
      lineBoundsCV = new Float64Array(spheresCV.length * 4);
      for (let index = 0; index < spheresCV.length; index++) {
        BoundingSphere.pack(spheresCV[index], lineBoundsCV as unknown as number[], index * 4);
      }
      transfers.push(lineBoundsCV.buffer as ArrayBuffer);
    }
  }
  return { combined: primitivePipeline.packCombineGeometryResults(combined, transfers), linePositions, lineBoundsCV };
}

/** Preserve owner order and isolate assembly failures within a Worker batch. */
export function prepareGeometryBatch(batch: GeometryPrepareBatchRequest, transfers: ArrayBuffer[]): GeometryPrepareBatchResult {
  if (!Array.isArray(batch?.requests))
    throw new TypeError('Geometry preparation requires a request batch');
  return {
    results: batch.requests.map((request) => {
      const ownedTransfers: ArrayBuffer[] = [];
      try {
        const result = prepareGeometry(request, ownedTransfers);
        transfers.push(...ownedTransfers);
        return { result };
      }
      catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        return { error: { name: failure.name, message: failure.message, stack: failure.stack } };
      }
    }),
  };
}

function finish<T>(compiler: Generator<void, T>): T {
  let step = compiler.next();
  while (!step.done) step = compiler.next();
  return step.value;
}

function isFloat64Array(value: unknown): value is Float64Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Float64Array]';
}
