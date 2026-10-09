import type { Subscription } from '../util/evented';
import type { WorkerEndpoint } from './worker-channel';
import { browser } from '../util/browser';
import { config } from '../util/config';
import { ensureError } from '../util/errors';
import { subscribe } from '../util/evented';

interface WorkerState {
  failure?: Error;
  listeners: Set<(error: Error) => void>;
  subscriptions: Subscription[];
}

/**
 * Constructs a worker pool.
 */
export class WorkerPool {
  static workerCount: number;

  active: Record<string, boolean>;

  workersPromise?: Promise<WorkerEndpoint[]>;

  private readonly workerStates = new Map<WorkerEndpoint, WorkerState>();

  constructor() {
    this.active = {};
  }

  async acquire(mapId: number | string): Promise<WorkerEndpoint[]> {
    this.active[mapId] = true;
    if (!this.workersPromise) {
      const workers: WorkerEndpoint[] = [];
      while (workers.length < WorkerPool.workerCount) {
        const worker = config.WORKER_URL
          ? new Worker(config.WORKER_URL, { type: 'module' })
          : new Worker(new URL('./tile.worker.ts', import.meta.url), { type: 'module' });
        const state: WorkerState = { listeners: new Set(), subscriptions: [] };
        this.workerStates.set(worker, state);
        const fail = (error: Error): void => {
          if (state.failure) {
            return;
          }
          state.failure = error;
          for (const subscription of state.subscriptions) subscription.unsubscribe();
          worker.terminate?.();
          for (const listener of state.listeners) listener(error);
        };
        state.subscriptions = [
          subscribe<ErrorEvent>(worker, 'error', event => fail(event.error
            ? ensureError(event.error)
            : new Error(event.message || 'MVT worker failed to load or execute')), false),
          subscribe<MessageEvent>(worker, 'messageerror', () => fail(new Error('MVT worker message could not be decoded')), false),
        ];
        workers.push(worker);
      }
      this.workersPromise = Promise.resolve(workers);
    }
    return (await this.workersPromise).slice();
  }

  /** Replay an earlier failure when another client acquires the shared worker. */
  subscribeFailure(worker: WorkerEndpoint, listener: (error: Error) => void): Subscription {
    const state = this.workerStates.get(worker)!;
    state.listeners.add(listener);
    if (state.failure) {
      listener(state.failure);
    }
    return {
      unsubscribe: () => { state.listeners.delete(listener); },
    };
  }

  release(mapId: number | string): void {
    delete this.active[mapId];
    if (this.numActive() === 0 && this.workersPromise) {
      const promise = this.workersPromise;
      this.workersPromise = undefined;
      void promise.then((workers) => {
        for (const w of workers) {
          const state = this.workerStates.get(w)!;
          for (const subscription of state.subscriptions) subscription.unsubscribe();
          if (!state.failure)
            w.terminate?.();
          this.workerStates.delete(w);
        }
      });
    }
  }

  numActive(): number {
    return Object.keys(this.active).length;
  }
}

// Based on results from A/B testing: https://github.com/maplibre/maplibre-gl-js/pull/2354
// Upstream keeps a single worker outside Safari because that A/B result
// assumed several maps sharing one pool per tab. This library renders one
// dedicated tileset with a single dispatcher, so a lone worker would
// serialize every tile load; parallelize for every browser instead.
const availableLogicalProcessors = Math.floor(browser.hardwareConcurrency / 2);
WorkerPool.workerCount = Math.max(Math.min(availableLogicalProcessors, 3), 1);

let sharedWorkerPool: WorkerPool | undefined;

/** Lazily return the pool shared by this module's style instances. */
export function getSharedWorkerPool(): WorkerPool {
  sharedWorkerPool ||= new WorkerPool();
  return sharedWorkerPool;
}
