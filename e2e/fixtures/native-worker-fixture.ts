import type { Geometry } from 'cesium';
import type { GeometryPrepareResult } from '../../packages/cesium-vector-tileset/src/render/geometry/geometry-preparation';
import type { PreparedLinePositionTexture } from '../../packages/cesium-vector-tileset/src/render/geometry/line-position-packing';
import type { NativeWorkerBlob, NativeWorkerObservation } from '../native-worker.spec';
import * as Cesium from 'cesium';
import {
  buildModuleUrl,
  Cartesian3,
  ComponentDatatype,
  GeometryInstance,
  GeometryInstanceAttribute,
  Primitive,
  Scene,
  TaskProcessor,
  WebMercatorProjection,
} from 'cesium';
import { GeometryPrimitive, updateGeometryWithBudget } from '../../packages/cesium-vector-tileset/src/render/geometry/geometry-primitive';
import { primitivePipeline } from '../../packages/cesium-vector-tileset/src/render/geometry/primitive-pipeline';
import { createLineGeometry } from '../../packages/cesium-vector-tileset/src/render/line/line-geometry';
import { UNBOUNDED_BUDGET } from '../../packages/cesium-vector-tileset/src/render/scene/frame-budget';

type Public<T> = { [Key in keyof T]: T[Key] };
type RuntimeGeometryPrimitive = Public<GeometryPrimitive> & {
  _state: number;
  _error?: Error;
  _instanceIds?: string[];
  _geometries?: Geometry[];
  _combinedResult?: GeometryPrepareResult;
  _preparedLinePositions?: PreparedLinePositionTexture;
  _instanceBoundingSpheresCV?: Cesium.BoundingSphere[];
};

const PrimitiveState = (Cesium as unknown as { PrimitiveState: Record<string, number> }).PrimitiveState;
const nativeUpdate = Primitive.prototype.update;
const nativeCombine = primitivePipeline.combineGeometry;
const nativePackResults = primitivePipeline.packCombineGeometryResults;
const nativePackParameters = primitivePipeline.packCombineGeometryParameters;
let mainAssemblyCalls = 0;
let mainPackCalls = 0;
let mainMetadataCalls = 0;
primitivePipeline.combineGeometry = (parameters) => {
  mainAssemblyCalls++;
  return nativeCombine(parameters);
};
primitivePipeline.packCombineGeometryResults = (results, transfers) => {
  mainPackCalls++;
  return nativePackResults(results, transfers);
};
primitivePipeline.packCombineGeometryParameters = (parameters, transfers) => {
  mainMetadataCalls++;
  return nativePackParameters(parameters, transfers);
};

const baseUrl = new URLSearchParams(location.search).get('cesiumBaseUrl');
if (baseUrl)
  (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl: (url: string) => void }).setBaseUrl(baseUrl);

// Initialize Native WebGL limits. All geometry assembly and reply adoption
// below stay on the CPU; line texture and geometry GPU uploads are excluded.
const canvas = document.body.appendChild(document.createElement('canvas'));
const capabilityScene = new Scene({ canvas });
const context = (capabilityScene as Scene & { readonly context: { readonly elementIndexUint: boolean } }).context;
const frame = { mode: Cesium.SceneMode.SCENE3D, mapProjection: new WebMercatorProjection(), scene3DOnly: false, context, afterRender: [] as Array<() => boolean> };
let completedTasks = 0;
let wakes = 0;
const stopCompleted = (TaskProcessor as typeof TaskProcessor & { taskCompletedEvent: Cesium.Event }).taskCompletedEvent.addEventListener(() => {
  completedTasks++;
  wakes++;
  capabilityScene.requestRender();
});
const point = Cartesian3.fromDegrees(-74, 40.7);
const next = Cartesian3.fromDegrees(-73.9999, 40.7);
const lineOptions = { join: 'miter', cap: 'butt', miterLimit: 2, roundLimit: 1.05, widthPx: 8 };
const geometry = createLineGeometry(Float64Array.from([point.x, point.y, point.z, next.x, next.y, next.z]), lineOptions)!;
const instanceCounts = [513, 513, 4097];
let primitives: RuntimeGeometryPrimitive[] = [];

function flushAfterRender(): void {
  for (const callback of frame.afterRender.splice(0)) {
    if (callback()) {
      wakes++;
      capabilityScene.requestRender();
    }
  }
}

function update(targets: RuntimeGeometryPrimitive[]): void {
  updateGeometryWithBudget(frame, UNBOUNDED_BUDGET, () => {
    for (const primitive of targets) {
      if (!primitive.isDestroyed())
        primitive.update(frame);
    }
  });
  flushAfterRender();
}

// Native update would begin GPU work once the CPU result has been adopted.
// Keep admission real, then use advancePreparation to consume replies safely.
Primitive.prototype.update = () => {};

function snapshot() {
  return {
    states: primitives.map(primitive => ({
      state: Object.keys(PrimitiveState).find(name => PrimitiveState[name] === primitive._state),
      destroyed: primitive.isDestroyed(),
      ready: primitive.ready,
      error: String(primitive._error ?? ''),
      hasCombinedReply: !!primitive._combinedResult,
      runnableCPU: primitive.hasRunnableIdlePreparation,
    })),
    transferProbePending: (TaskProcessor as typeof TaskProcessor & { _canTransferArrayBuffer: boolean | Promise<boolean> })._canTransferArrayBuffer instanceof Promise,
    workers: window.nativeWorkers,
    blobs: window.nativeWorkerBlobs,
    unhandledRejections: window.nativeWorkerUnhandledRejections,
    inputBytes: (geometry.attributes.position.values as Float64Array).byteLength,
    inputValues: Array.from(geometry.attributes.position.values),
    inputIndices: Array.from(geometry.indices),
    inputAttributes: Object.fromEntries(Object.entries(geometry.attributes).map(([name, attribute]) => [name, Array.from(attribute.values)])),
    instanceCounts,
    instanceIds: primitives.map(primitive => primitive._instanceIds),
    mainAssemblyCalls,
    mainPackCalls,
    mainMetadataCalls,
    completedTasks,
    wakes,
    prepared: primitives.map(primitive => ({
      geometryCount: primitive._geometries?.length ?? 0,
      attributes: Object.keys(primitive._geometries?.[0]?.attributes ?? {}).sort(),
      textureBytes: primitive._preparedLinePositions?.values.byteLength ?? 0,
      boundsCVCount: primitive._instanceBoundingSpheresCV?.length ?? 0,
      boundsCVFinite: primitive._instanceBoundingSpheresCV?.every(sphere => [sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius].every(Number.isFinite)) ?? false,
    })),
  };
}

const fixture = {
  async start() {
    primitives = instanceCounts.map(count => new GeometryPrimitive({
      geometryInstances: Array.from({ length: count }, (_, index) => new GeometryInstance({
        geometry,
        id: `feature-${index}`,
        attributes: {
          lineMiterLimit: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, value: [Math.fround(lineOptions.miterLimit)] }),
        },
      })),
    }, 'line') as unknown as RuntimeGeometryPrimitive);
    // Separate real microtask flushes fill both production queue slots. The
    // oversize third owner must wait before allocating Native metadata/copies.
    for (const primitive of primitives) {
      update([primitive]);
      await Promise.resolve();
    }
    return snapshot();
  },
  admitWaiting() {
    for (const primitive of primitives) {
      if (!primitive.isDestroyed() && primitive._state === PrimitiveState.READY)
        primitive.advancePreparation(frame, UNBOUNDED_BUDGET);
    }
    flushAfterRender();
    return snapshot();
  },
  advance() {
    for (const primitive of primitives) {
      if (!primitive.isDestroyed() && primitive._state !== PrimitiveState.READY)
        primitive.advancePreparation(frame, UNBOUNDED_BUDGET);
    }
    flushAfterRender();
    return snapshot();
  },
  snapshot,
  releaseReply(id: number) {
    window.nativeWorkerRelease(id);
  },
  failMessage() {
    window.nativeWorkerFailMessage();
  },
  cancel(index: number) {
    primitives[index].destroy();
    return snapshot();
  },
  destroy() {
    for (const primitive of primitives) {
      if (!primitive.isDestroyed())
        primitive.destroy();
    }
    return snapshot();
  },
  finish() {
    for (const primitive of primitives) {
      if (!primitive.isDestroyed())
        primitive.destroy();
    }
    Primitive.prototype.update = nativeUpdate;
    primitivePipeline.combineGeometry = nativeCombine;
    primitivePipeline.packCombineGeometryResults = nativePackResults;
    primitivePipeline.packCombineGeometryParameters = nativePackParameters;
    stopCompleted();
    capabilityScene.destroy();
    canvas.remove();
  },
};

window.nativeWorkerFixture = fixture;
declare global {
  interface Window {
    nativeWorkers: NativeWorkerObservation[];
    nativeWorkerBlobs: NativeWorkerBlob[];
    nativeWorkerUnhandledRejections: string[];
    nativeWorkerFixture: typeof fixture;
    nativeWorkerRelease: (id: number) => void;
    nativeWorkerFailMessage: () => void;
  }
}
