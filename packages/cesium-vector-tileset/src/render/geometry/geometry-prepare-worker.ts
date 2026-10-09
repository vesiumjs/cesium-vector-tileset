import type { GeometryPrepareBatchRequest, GeometryPrepareBatchResult } from './geometry-preparation';
import { TaskProcessor } from 'cesium';
import geometryWorkerUrl from '../../worker/geometry.worker.ts?worker&url';
import { GeometryPrepareQueue } from './geometry-prepare-queue';

interface WorkerEntry {
  processor: TaskProcessor;
  worker?: Worker;
  bootstrapUrl?: string;
}

const contextWorkers = new WeakMap<object, GeometryPrepareWorker>();

/** Owns one context's bounded queue, lazy Worker, fatal failures and final disposal. */
export class GeometryPrepareWorker {
  readonly queue = new GeometryPrepareQueue(
    (request, transfers) => this.dispatch(request, transfers),
    error => this.fail(error),
  );

  private references = 0;

  private failure: unknown;

  private entry?: WorkerEntry;
  readonly context: object;
  /**
   * @internal
   */
  private readonly onError = (event: ErrorEvent): void => {
    this.fail(event.error instanceof Error ? event.error : new Error(`Cesium geometry worker failed: ${event.message}`));
  };

  /**
   * @internal
   */
  private readonly onMessageError = (): void => {
    this.fail(new Error('Cesium geometry worker could not deserialize a message'));
  };

  /**
   * @internal
   */
  private constructor(context: object) {
    this.context = context;
  }

  static acquire(context: object): GeometryPrepareWorker {
    let owner = contextWorkers.get(context);
    if (!owner) {
      owner = new GeometryPrepareWorker(context);
      contextWorkers.set(context, owner);
    }
    owner.references++;
    return owner;
  }

  get error(): unknown {
    return this.failure;
  }

  release(): void {
    if (--this.references !== 0)
      return;
    contextWorkers.delete(this.context);
    this.fail(new Error('Cesium geometry workers were destroyed'));
  }

  /**
   * @internal
   */
  private fail(error: unknown): void {
    if (this.failure !== undefined)
      return;
    this.failure = error === undefined ? new Error('Cesium geometry worker failed') : error;
    this.queue.fail(this.failure);
    const entry = this.entry;
    if (!entry)
      return;
    this.entry = undefined;
    entry.worker?.removeEventListener('error', this.onError);
    entry.worker?.removeEventListener('messageerror', this.onMessageError);
    entry.processor.destroy();
    if (entry.bootstrapUrl)
      URL.revokeObjectURL(entry.bootstrapUrl);
  }

  /**
   * @internal
   */
  private dispatch(request: GeometryPrepareBatchRequest, transfers: ArrayBuffer[]): Promise<GeometryPrepareBatchResult> {
    if (this.failure !== undefined)
      throw this.failure;
    try {
      let entry = this.entry;
      if (!entry) {
        const workerUrl = new URL(geometryWorkerUrl, window.location.href).href;
        entry = this.entry = { processor: new TaskProcessor(workerUrl) };
        if (new URL(workerUrl).origin !== window.location.origin) {
          // TaskProcessor owns transport; this module owns its cross-origin shim URL.
          entry.bootstrapUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(workerUrl)};`], { type: 'application/javascript' }));
          (entry.processor as TaskProcessor & { _worker: Worker })._worker = new Worker(entry.bootstrapUrl, { type: 'module' });
        }
      }
      const task = entry.processor.scheduleTask(request, transfers) as Promise<GeometryPrepareBatchResult>;
      if (!entry.worker) {
        // Fatal browser events otherwise leave TaskProcessor requests pending.
        entry.worker = (entry.processor as TaskProcessor & { _worker: Worker })._worker;
        entry.worker.addEventListener('error', this.onError);
        entry.worker.addEventListener('messageerror', this.onMessageError);
      }
      return task.catch((error: unknown) => {
        this.fail(error);
        throw error;
      });
    }
    catch (error) {
      this.fail(error);
      throw error;
    }
  }
}
