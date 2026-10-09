import type { BrowserContext } from 'playwright/test';

interface AdmissionTask {
  admissionId: number;
  admitted: number;
  frame?: number;
  inputBytes: number;
  inputViewCount: number;
  // A row is one scheduleTask call; requests are logical preparation owners inside it.
  requestCount: number;
  instances?: number;
  inputBackingBytes: number;
  inputBackingCount: number;
  posted?: number;
  workerTaskId?: number;
  received?: number;
  returned?: number;
  failed?: boolean;
  cancelled?: boolean;
  rejected?: boolean;
  stopped?: number;
  stopReason?: string;
}

interface InputPool {
  tasks: number;
  bytes: number;
}

interface AdmissionFrame {
  at: number;
  frame?: number;
  admittedNotPosted: InputPool;
  postedNotReceived: InputPool;
  completedUnuploadedBytes: number;
  completedUnuploadedBackingCount: number;
  visitedPendingObjects: number;
  slotWaitingOwners: number;
  slotWaitingRunnableOwners: number;
  waitingPendingCounts: Record<string, number>;
}

interface AdmissionObservation {
  diagnosticOnly: true;
  fairTiming: false;
  resultSampling: 'postRender';
  waitingPendingCountUnit: 'owners';
  excludes: string[];
  armed?: number;
  stopped?: number;
  observerCpuMs: number;
  unmatchedPosts: number;
  firstUnmatchedPost?: number;
  tasks: AdmissionTask[];
  frames: AdmissionFrame[];
  peaks: {
    admittedNotPostedBytes: number;
    postedNotReceivedBytes: number;
    completedUnuploadedBytes: number;
  };
}

interface AdmissionBridge {
  posted: (request: object, worker: Worker, taskId: number, at: number) => number | undefined;
  received: (admissionId: number, at: number, failed: boolean) => void;
  terminated: (worker: Worker) => void;
  stop: () => void;
}

/** Opt-in payload and scheduler observation; its CPU cost invalidates fair timings. */
export async function observeCityAdmissions(context: BrowserContext) {
  await context.addInitScript(() => {
    const observation: AdmissionObservation = {
      diagnosticOnly: true,
      fairTiming: false,
      resultSampling: 'postRender',
      waitingPendingCountUnit: 'owners',
      excludes: ['Worker heap', 'GPU allocations', 'preparation-generator intermediate buffers', 'results consumed before postRender'],
      observerCpuMs: 0,
      unmatchedPosts: 0,
      tasks: [],
      frames: [],
      peaks: { admittedNotPostedBytes: 0, postedNotReceivedBytes: 0, completedUnuploadedBytes: 0 },
    };
    window.cityAdmissions = observation;
    const requests = new WeakMap<object, AdmissionTask>();
    const workers = new WeakMap<Worker, Set<number>>();
    const bufferIds = new WeakMap<ArrayBufferLike, number>();
    const inputOwners = new Map<number, Array<{ id: number; bytes: number }>>();
    const admittedBuffers = new Map<number, number>();
    const postedBuffers = new Map<number, number>();
    let nextBufferId = 0;
    const admitted: InputPool = { tasks: 0, bytes: 0 };
    const posted: InputPool = { tasks: 0, bytes: 0 };
    let stopped = false;
    let detach: (() => void) | undefined;
    let polling = 0;

    const measure = <T>(operation: () => T): T => {
      const start = performance.now();
      try {
        return operation();
      }
      finally {
        observation.observerCpuMs += performance.now() - start;
      }
    };
    const footprint = (values: unknown[]) => {
      const buffers = new Set<ArrayBufferLike>();
      // Count each view object once; distinct subviews sharing one buffer
      // remain distinct views, while backing storage is deduplicated.
      const visited = new Set<object>();
      let viewBytes = 0;
      let viewCount = 0;
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object' || visited.has(value))
          return;
        visited.add(value);
        if (ArrayBuffer.isView(value)) {
          viewBytes += value.byteLength;
          viewCount++;
          buffers.add(value.buffer);
          return;
        }
        if (value instanceof ArrayBuffer) {
          buffers.add(value);
          return;
        }
        for (const child of Object.values(value)) visit(child);
      };
      for (const value of values) visit(value);
      let backingBytes = 0;
      const backings: Array<{ id: number; bytes: number }> = [];
      for (const buffer of buffers) {
        const id = bufferIds.get(buffer) ?? nextBufferId++;
        bufferIds.set(buffer, id);
        backingBytes += buffer.byteLength;
        backings.push({ id, bytes: buffer.byteLength });
      }
      return { viewBytes, viewCount, backingBytes, backingCount: buffers.size, backings };
    };
    const peaks = (): void => {
      observation.peaks.admittedNotPostedBytes = Math.max(observation.peaks.admittedNotPostedBytes, admitted.bytes);
      observation.peaks.postedNotReceivedBytes = Math.max(observation.peaks.postedNotReceivedBytes, posted.bytes);
    };
    const changePool = (task: AdmissionTask, pool: InputPool, buffers: Map<number, number>, change: 1 | -1): void => {
      pool.tasks += change;
      for (const owner of inputOwners.get(task.admissionId) ?? []) {
        const previous = buffers.get(owner.id) ?? 0;
        const next = previous + change;
        if (change === 1 && previous === 0)
          pool.bytes += owner.bytes;
        if (next === 0) {
          pool.bytes -= owner.bytes;
          buffers.delete(owner.id);
        }
        else {
          buffers.set(owner.id, next);
        }
      }
    };
    const release = (task: AdmissionTask): void => {
      if (task.rejected || task.stopped !== undefined || task.received !== undefined || task.returned !== undefined)
        return;
      const pool = task.posted === undefined ? admitted : posted;
      changePool(task, pool, task.posted === undefined ? admittedBuffers : postedBuffers, -1);
      inputOwners.delete(task.admissionId);
    };
    window.cityAdmissionObserver = {
      posted: (request, worker, taskId, at) => measure(() => {
        if (stopped)
          return;
        const task = requests.get(request);
        if (!task) {
          observation.unmatchedPosts++;
          observation.firstUnmatchedPost ??= at;
          return;
        }
        if (task.posted !== undefined)
          return;
        changePool(task, admitted, admittedBuffers, -1);
        changePool(task, posted, postedBuffers, 1);
        task.posted = at;
        task.workerTaskId = taskId;
        const active = workers.get(worker) ?? new Set<number>();
        active.add(task.admissionId);
        workers.set(worker, active);
        peaks();
        return task.admissionId;
      }),
      received: (id, at, failed) => measure(() => {
        if (stopped)
          return;
        const task = observation.tasks[id];
        if (!task || task.received !== undefined)
          return;
        release(task);
        task.received = at;
        task.failed = failed;
      }),
      terminated: worker => measure(() => {
        if (stopped)
          return;
        for (const id of workers.get(worker) ?? []) {
          const task = observation.tasks[id];
          if (task.returned !== undefined || task.received !== undefined)
            continue;
          release(task);
          task.stopped = performance.now();
          task.stopReason = 'worker-terminated';
        }
      }),
      stop: () => {
        if (stopped)
          return;
        measure(() => {
          const at = performance.now();
          for (const task of observation.tasks) {
            if (task.returned !== undefined || task.received !== undefined || task.rejected || task.stopped !== undefined)
              continue;
            release(task);
            task.stopped = at;
            task.stopReason = 'observation-ended';
          }
          observation.stopped = at;
          stopped = true;
          cancelAnimationFrame(polling);
          detach?.();
          window.cityAdmissionObserver = undefined;
        });
      },
    };

    const attach = (): void => {
      if (stopped)
        return;
      const validation = window.renderValidation;
      const native = validation?.atlas?.cesium as unknown as {
        TaskProcessor?: { prototype: { scheduleTask: (request: Record<string, unknown>, transfers?: object[]) => Promise<unknown> | undefined } };
        PrimitiveState?: { COMBINED: number };
      } | undefined;
      if (!native?.TaskProcessor || !native.PrimitiveState || !validation?.tileset) {
        polling = requestAnimationFrame(attach);
        return;
      }
      const scene = validation.viewer.scene;
      const prototype = native.TaskProcessor.prototype;
      const original = prototype.scheduleTask;
      const wrapped = function (this: { _worker?: Worker }, request: Record<string, unknown>, transfers?: object[]): Promise<unknown> | undefined {
        if (!request || !(request.requests || request.geometries || request.subTasks || request.createGeometryResults))
          return original.call(this, request, transfers);
        const task = measure(() => {
          const bytes = footprint([
            // Canonical preparation batches contain owned single-request payloads.
            // Legacy fields remain observable for comparisons to frozen baselines.
            request.requests,
            request.geometries,
            request.lineInputs,
            request.parameters,
            request.subTasks,
            request.createGeometryResults,
            request.packedInstances,
          ]);
          const payloads = (Array.isArray(request.requests) ? request.requests : [request]) as Array<{
            geometries?: unknown[];
            subTasks?: unknown[];
            parameters?: { packedInstances?: Float64Array };
            packedInstances?: Float64Array;
          }>;
          const instances = payloads.map(request => request.geometries?.length ?? request.subTasks?.length ?? request.parameters?.packedInstances?.[0] ?? request.packedInstances?.[0]);
          const task: AdmissionTask = {
            admissionId: observation.tasks.length,
            admitted: performance.now(),
            frame: scene._frameState.frameNumber,
            inputBytes: bytes.viewBytes,
            inputViewCount: bytes.viewCount,
            requestCount: payloads.length,
            instances: instances.every(count => count !== undefined) ? instances.reduce<number>((sum, count) => sum + count!, 0) : undefined,
            inputBackingBytes: bytes.backingBytes,
            inputBackingCount: bytes.backingCount,
          };
          requests.set(request, task);
          observation.tasks.push(task);
          inputOwners.set(task.admissionId, bytes.backings);
          changePool(task, admitted, admittedBuffers, 1);
          return task;
        });
        const returned = (failed: boolean, error?: unknown): void => measure(() => {
          if (stopped)
            return;
          release(task);
          task.returned = performance.now();
          task.failed ||= failed;
          task.cancelled = !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
        });
        try {
          const result = original.call(this, request, transfers);
          if (!result) {
            release(task);
            task.rejected = true;
            task.returned = performance.now();
          }
          else {
            peaks();
            if (this._worker) {
              const active = workers.get(this._worker) ?? new Set<number>();
              active.add(task.admissionId);
              workers.set(this._worker, active);
            }
            void result.then(() => returned(false), error => returned(true, error));
          }
          return result;
        }
        catch (error) {
          returned(true, error);
          throw error;
        }
      };
      prototype.scheduleTask = wrapped;
      observation.armed = performance.now();
      const remove = scene.postRender.addEventListener(() => measure(() => {
        const pending = (validation.tileset as unknown as {
          _renderer: {
            collections: {
              _firstUpdates: Map<object, unknown>[];
            };
          };
        })._renderer.collections._firstUpdates;
        const owners = new Set<object>();
        const results: unknown[] = [];
        let slotWaitingOwners = 0;
        let slotWaitingRunnableOwners = 0;
        const waitingPendingCounts: Record<string, number> = {};
        const visit = (owner: object): void => {
          if (owners.has(owner))
            return;
          owners.add(owner);
          const value = owner as {
            primitive?: object;
            length?: number;
            get?: (index: number) => object;
            _combinedResult?: unknown;
            _preparedLinePositions?: unknown;
            _geometries?: unknown;
            _state?: number;
            _waitingForSlot?: { pending: Set<unknown> };
            hasRunnableUpdate?: boolean;
            isDestroyed?: () => boolean;
          };
          if (value.isDestroyed?.())
            return;
          if (value.primitive)
            visit(value.primitive);
          if (typeof value.get === 'function' && Number.isInteger(value.length)) {
            for (let index = 0; index < value.length!; index++) visit(value.get(index));
          }
          if (value._waitingForSlot) {
            slotWaitingOwners++;
            slotWaitingRunnableOwners += value.hasRunnableUpdate ? 1 : 0;
            // This Set tracks pending primitive owners. Multiple owners may
            // share one Native Task; only AdmissionTask rows count dispatches.
            const count = value._waitingForSlot.pending.size;
            waitingPendingCounts[count] = (waitingPendingCounts[count] ?? 0) + 1;
          }
          if (value._combinedResult)
            results.push(value._combinedResult);
          if (value._state === native.PrimitiveState!.COMBINED)
            results.push(value._geometries, value._preparedLinePositions);
        };
        for (const queue of pending) {
          for (const owner of queue.keys()) visit(owner);
        }
        const bytes = footprint(results);
        observation.peaks.completedUnuploadedBytes = Math.max(observation.peaks.completedUnuploadedBytes, bytes.backingBytes);
        observation.frames.push({
          at: performance.now(),
          frame: scene._frameState.frameNumber,
          admittedNotPosted: { ...admitted },
          postedNotReceived: { ...posted },
          completedUnuploadedBytes: bytes.backingBytes,
          completedUnuploadedBackingCount: bytes.backingCount,
          visitedPendingObjects: owners.size,
          slotWaitingOwners,
          slotWaitingRunnableOwners,
          waitingPendingCounts,
        });
      }));
      detach = () => {
        remove();
        if (prototype.scheduleTask === wrapped)
          prototype.scheduleTask = original;
      };
    };
    polling = requestAnimationFrame(attach);
  });
}

declare global {
  interface Window {
    cityAdmissions: AdmissionObservation;
    cityAdmissionObserver?: AdmissionBridge;
  }
}
