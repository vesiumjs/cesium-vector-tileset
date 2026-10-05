import type { Geometry } from 'cesium';
import type { NativeWorkerBlob, NativeWorkerObservation } from '../native-worker.spec';
import * as Cesium from 'cesium';
import {
  buildModuleUrl,
  Cartesian3,
  ComponentDatatype,
  GeometryInstance,
  GeometryInstanceAttribute,
  Primitive,
  TaskProcessor,
  WebMercatorProjection,
} from 'cesium';
import { GeometryPrimitive } from '../../packages/cesium-vector-tileset/src/render/geometry/geometry-primitive';
import { createLineGeometry } from '../../packages/cesium-vector-tileset/src/render/line/line-geometry';

const PrimitiveState = (Cesium as unknown as { PrimitiveState: Record<string, number> }).PrimitiveState;
type RuntimeGeometryPrimitive = GeometryPrimitive & { _state: number; _error?: Error; _instanceIds?: string[] };

const nativeUpdate = Primitive.prototype.update;
const pipeline = (Cesium as unknown as {
  PrimitivePipeline: { packCreateGeometryResults: (geometries: Geometry[], transfers: object[]) => object };
}).PrimitivePipeline;
const nativePackCreate = pipeline.packCreateGeometryResults;
let mainPackCalls = 0;
pipeline.packCreateGeometryResults = (geometries, transfers) => {
  mainPackCalls++;
  return nativePackCreate(geometries, transfers);
};
const baseUrl = new URLSearchParams(location.search).get('cesiumBaseUrl');
if (baseUrl)
  (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl(baseUrl);
const context = { elementIndexUint: true };
const frame = { mode: Cesium.SceneMode.SCENE3D, mapProjection: new WebMercatorProjection(), scene3DOnly: false, context };
const point = Cartesian3.fromDegrees(-74, 40.7);
const next = Cartesian3.fromDegrees(-73.9999, 40.7);
const lineOptions = {
  join: 'miter',
  cap: 'butt',
  miterLimit: 2,
  roundLimit: 1.05,
  widthPx: 8,
};
const geometry = createLineGeometry(Float64Array.from([point.x, point.y, point.z, next.x, next.y, next.z]), lineOptions)!;
let primitives: RuntimeGeometryPrimitive[] = [];

// Exclude GPU creation while exercising the real adapter, serialization,
// Original createGeometry/combineGeometry assets and actual clone/transfer.
Primitive.prototype.update = () => {};
function snapshot() {
  return {
    states: primitives.map(primitive => ({
      state: Object.keys(PrimitiveState).find(name => PrimitiveState[name] === primitive._state),
      destroyed: primitive.isDestroyed(),
      ready: primitive.ready,
      error: String(primitive._error ?? ''),
    })),
    transferProbePending: (TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer: boolean | Promise<boolean> })._canTransferArrayBuffer instanceof Promise,
    workers: window.nativeWorkers,
    blobs: window.nativeWorkerBlobs,
    inputBytes: (geometry.attributes.position.values as Float64Array).byteLength,
    inputValues: Array.from(geometry.attributes.position.values),
    inputIndices: Array.from(geometry.indices),
    instanceIds: primitives.map(primitive => primitive._instanceIds),
    mainPackCalls,
  };
}
const fixture = {
  start() {
    primitives = Array.from(
      { length: 3 },
      () => new GeometryPrimitive({ geometryInstances: Array.from({ length: 513 }, (_, index) => new GeometryInstance({
        geometry,
        id: `feature-${index}`,
        attributes: {
          lineMiterLimit: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, value: [Math.fround(lineOptions.miterLimit)] }),
        },
      })) }, 'line') as RuntimeGeometryPrimitive,
    );
    primitives.forEach(primitive => primitive.update(frame));
    return snapshot();
  },
  update() {
    primitives.forEach(primitive => primitive.update(frame));
    return snapshot();
  },
  snapshot,
  destroy() {
    primitives.forEach(primitive => primitive.destroy());
  },
  finish() {
    primitives.filter(primitive => !primitive.isDestroyed()).forEach(primitive => primitive.destroy());
    Primitive.prototype.update = nativeUpdate;
    pipeline.packCreateGeometryResults = nativePackCreate;
  },
};

window.nativeWorkerFixture = fixture;
declare global {
  interface Window {
    nativeWorkers: NativeWorkerObservation[];
    nativeWorkerBlobs: NativeWorkerBlob[];
    nativeWorkerFixture: typeof fixture;
  }
}
