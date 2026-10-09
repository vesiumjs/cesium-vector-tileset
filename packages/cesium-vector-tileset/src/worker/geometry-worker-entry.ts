import type { GeometryPrepareBatchRequest } from '../render/geometry/geometry-preparation';
import * as Cesium from 'cesium';
import { prepareGeometryBatch } from '../render/geometry/geometry-preparation';

const createTaskProcessorWorker = (Cesium as unknown as {
  createTaskProcessorWorker: (task: (request: GeometryPrepareBatchRequest, transfers: ArrayBuffer[]) => object) => unknown;
}).createTaskProcessorWorker;

createTaskProcessorWorker(prepareGeometryBatch);
