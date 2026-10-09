import type { GeometryPrepareBatchRequest, GeometryPrepareBatchResult, GeometryPrepareRequest, GeometryPrepareResult } from './geometry-preparation';

type Dispatch = (request: GeometryPrepareBatchRequest, transfers: ArrayBuffer[]) => Promise<GeometryPrepareBatchResult>;

interface PendingRequest {
  request: GeometryPrepareRequest;
  transfers: ArrayBuffer[];
  cancelled: () => boolean;
  resolve: (result: GeometryPrepareResult) => void;
  reject: (error: unknown) => void;
}

interface Batch {
  requests: PendingRequest[];
  bytes: number;
  dispatched: boolean;
}

const maximumBatchBytes = 512 * 1024;
const maximumBatches = 2;

/** Owns transfer admission, microtask batching, and request settlement for one context. */
export class GeometryPrepareQueue {
  private readonly batches: Batch[] = [];

  private readonly buffers = new Set<ArrayBuffer>();

  private flushScheduled = false;

  private failure: unknown;

  private readonly dispatch: Dispatch;

  private readonly onFailure?: (error: unknown) => void;

  constructor(dispatch: Dispatch, onFailure?: (error: unknown) => void) {
    this.dispatch = dispatch;
    this.onFailure = onFailure;
  }

  /** Admission for a positive-size request whose exact transfer bytes are not yet known. */
  get hasCapacity(): boolean {
    return this.canSchedule(1);
  }

  /** Checks transfer admission before allocating independent request buffers. */
  canSchedule(bytes: number): boolean {
    if (this.failure !== undefined)
      return false;
    if (this.batches.length < maximumBatches)
      return true;
    const batch = this.batches.at(-1);
    return batch !== undefined && !batch.dispatched && batch.bytes <= maximumBatchBytes && bytes <= maximumBatchBytes && batch.bytes + bytes <= maximumBatchBytes;
  }

  get error(): unknown | undefined {
    return this.failure;
  }

  schedule(request: GeometryPrepareRequest, transfers: ArrayBuffer[], cancelled: () => boolean): Promise<GeometryPrepareResult> | undefined {
    if (this.failure !== undefined)
      return Promise.reject(this.failure);
    if (cancelled())
      return Promise.reject(abortError());
    let bytes = 0;
    const owners = new Set<ArrayBuffer>();
    for (const buffer of transfers) {
      if (owners.has(buffer) || this.buffers.has(buffer))
        throw new RangeError('Geometry preparation requests require independent transfer buffers');
      owners.add(buffer);
      bytes += buffer.byteLength;
    }
    if (!this.canSchedule(bytes))
      return undefined;
    let batch = this.batches.at(-1);
    if (!batch || batch.dispatched || batch.bytes > maximumBatchBytes || bytes > maximumBatchBytes || batch.bytes + bytes > maximumBatchBytes) {
      batch = { requests: [], bytes: 0, dispatched: false };
      this.batches.push(batch);
    }
    const transfersOwned = [...transfers];
    for (const buffer of transfersOwned)
      this.buffers.add(buffer);
    const promise = new Promise<GeometryPrepareResult>((resolve, reject) => {
      batch.requests.push({ request, transfers: transfersOwned, cancelled, resolve, reject });
      batch.bytes += bytes;
    });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
    return promise;
  }

  fail(error: unknown): void {
    if (this.failure !== undefined)
      return;
    this.failure = error === undefined ? new Error('Geometry preparation failed') : error;
    for (const batch of this.batches) {
      for (const pending of batch.requests)
        pending.reject(this.failure);
    }
    this.batches.length = 0;
    this.buffers.clear();
    this.onFailure?.(this.failure);
  }

  destroy(): void {
    this.fail(abortError());
  }

  /**
   * @internal
   */
  private flush(): void {
    this.flushScheduled = false;
    if (this.failure !== undefined)
      return;
    for (const batch of [...this.batches]) {
      if (batch.dispatched)
        continue;
      try {
        batch.requests = batch.requests.filter((pending) => {
          if (!pending.cancelled())
            return true;
          for (const buffer of pending.transfers)
            this.buffers.delete(buffer);
          pending.reject(abortError());
          return false;
        });
        if (!batch.requests.length) {
          this.release(batch);
          continue;
        }
        batch.dispatched = true;
        const transfers = batch.requests.flatMap(pending => pending.transfers);
        const request = { requests: batch.requests.map(pending => pending.request) };
        this.dispatch(request, transfers).then(
          result => this.complete(batch, result),
          error => this.fail(error),
        );
      }
      catch (error) {
        this.fail(error);
        return;
      }
      if (this.failure !== undefined)
        return;
    }
  }

  /**
   * @internal
   */
  private complete(batch: Batch, result: GeometryPrepareBatchResult): void {
    if (this.failure !== undefined)
      return;
    try {
      if (!Array.isArray(result?.results) || result.results.length !== batch.requests.length)
        throw new RangeError('Geometry preparation batch result count does not match its requests');
      for (const entry of result.results) {
        if (!entry || typeof entry !== 'object' || ('result' in entry) === ('error' in entry))
          throw new TypeError('Invalid geometry preparation batch result');
        if ('result' in entry && (!entry.result || typeof entry.result !== 'object' || !entry.result.combined || typeof entry.result.combined !== 'object'))
          throw new TypeError('Invalid geometry preparation success result');
        if ('error' in entry && (!entry.error || typeof entry.error.name !== 'string' || typeof entry.error.message !== 'string' || (entry.error.stack !== undefined && typeof entry.error.stack !== 'string')))
          throw new TypeError('Invalid geometry preparation batch error');
      }
      // Release before settling so promise continuations can immediately admit another batch.
      this.release(batch);
      for (const [index, pending] of batch.requests.entries()) {
        const entry = result.results[index];
        if (pending.cancelled()) {
          pending.reject(abortError());
        }
        else if ('error' in entry) {
          const error = new Error(entry.error.message);
          error.name = entry.error.name;
          if (entry.error.stack !== undefined)
            error.stack = entry.error.stack;
          pending.reject(error);
        }
        else {
          pending.resolve(entry.result);
        }
      }
    }
    catch (error) {
      // Settlement callbacks cannot throw, but cancellation predicates can.
      for (const pending of batch.requests)
        pending.reject(error);
      this.fail(error);
    }
  }

  /**
   * @internal
   */
  private release(batch: Batch): void {
    const index = this.batches.indexOf(batch);
    if (index !== -1)
      this.batches.splice(index, 1);
    for (const pending of batch.requests) {
      for (const buffer of pending.transfers)
        this.buffers.delete(buffer);
    }
  }
}

function abortError(): Error {
  const error = new Error('Geometry preparation cancelled');
  error.name = 'AbortError';
  return error;
}
