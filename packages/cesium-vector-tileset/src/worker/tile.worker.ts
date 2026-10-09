import type { TileWorkerScope } from './scope';
import type { WorkerEndpoint } from './worker-channel';
import { projectWorkerBuckets } from '../render/vector/bucket-geometry';
import { isWorker } from './scope';
import { TileWorker } from './tile-worker';

if (isWorker(globalThis)) {
  const scope = globalThis as unknown as TileWorkerScope & WorkerEndpoint;
  scope.worker = new TileWorker(scope, (tile, tileID) => {
    projectWorkerBuckets(tile.buckets, tileID);
  });
}
