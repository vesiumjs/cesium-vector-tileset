import type { BrowserContext } from 'playwright/test';

interface TaskWakeTask {
  worker: number;
  message: number;
  classification: 'ownGeometry' | 'unknownNative';
  admissionId?: number;
  requestCount: number;
  posted: number;
}

interface TaskWakeTick {
  tick: number;
  at: number;
  frameBefore?: number;
  frameAfter?: number;
  newFrame?: boolean;
  realRender: boolean;
  sceneRequestedBefore: boolean;
  sceneRequestedAfter?: boolean;
  rootRequestedBefore: boolean;
  rootRequestedAfter?: boolean;
  firstUpdates: number;
  publishJobs: number;
  placementPending: boolean;
  placementRunnable: boolean;
  placementJobs: number;
  opacity: number;
  dynamic: number;
  rootReasons: Record<string, number>;
  work: Record<string, number>;
  publications: Record<string, number>;
  buildInspection?: { runnable: boolean; renderNeeded: boolean };
  renderFirstUpdates?: boolean;
  taskCallbacks: number[];
  taskRequestEdges: number[];
}

interface TaskWakeObservation {
  diagnosticOnly: true;
  fairTiming: false;
  armed?: number;
  stopped?: number;
  observerCpuMs: number;
  summary?: Record<string, number>;
  coverage: string[];
  tasks: TaskWakeTask[];
  events: Array<{ id: number; at: number; tick?: number; classification: 'ownGeometry' | 'unknownNative'; task?: TaskWakeTask; failed: boolean; appendedCallbacks: number; afterRenderBefore: number; afterRenderAfter?: number; sceneRequestedBefore: boolean; sceneRequestedAfter?: boolean; rootRequestedBefore: boolean; rootRequestedAfter?: boolean }>;
  callbacks: Array<{ id: number; event: number; enqueued: number; executed?: number; tick?: number; nextRenderTick?: number; sceneRequestCalls: number; sceneBefore?: boolean; sceneAfter?: boolean; rootGenerationBefore?: number; rootGenerationAfter?: number; threw?: boolean }>;
  ticks: TaskWakeTick[];
}

interface TaskWakeBridge {
  register: (worker: Worker) => void;
  posted: (worker: Worker, message: number, ownGeometry: boolean, requestCount: number, admissionId?: number) => void;
  withMessage: <T>(worker: Worker, message: unknown, operation: () => T) => T;
  stop: () => void;
}

/** Diagnostic only: preserve Native tasks, callback execution and Scene render ownership. */
export async function observeCityTaskWakes(context: BrowserContext) {
  await context.addInitScript(() => {
    const observation: TaskWakeObservation = {
      diagnosticOnly: true,
      fairTiming: false,
      observerCpuMs: 0,
      coverage: [
        'Owned geometry requires its known geometry Worker URL and version/layout/request schema, matched within the same synchronous Worker message callback scope; time proximity is never used. Unrecognized URLs remain unknownNative.',
        'Callbacks are exactly the observed Scene afterRender additions made during taskCompletedEvent.raiseEvent; their original this, arguments, return and throw are preserved.',
        'Scene.requestRender calls are counted inside the exact appended callback. The first subsequent physical render is linked, but other camera, Globe, network and Root requests can overlap; attribution is not exclusive.',
        'Physical ticks use preUpdate, not frameNumber. No scene.render replacement or Scene/geometry traversal.',
        'Work counters observe existing method calls. Missing build/render inspections remain unknown; unchanged command counts do not prove unchanged pixels.',
        'Native COMBINED-to-COMPLETE and batch-table creation are state transitions, not measurements of pure GPU upload.',
        'Arming follows atlas exposure; earlier tasks/events are excluded. Measured probe operations contribute observerCpuMs; timer/dispatch and Worker listener-map bookkeeping overhead is not fully measured. Observer overhead invalidates fair timing.',
      ],
      tasks: [],
      events: [],
      callbacks: [],
      ticks: [],
    };
    window.cityTaskWakes = observation;
    const workers = new WeakMap<Worker, { id: number; tasks: Map<number, TaskWakeTask> }>();
    let nextWorker = 0;
    let stopped = false;
    let polling = 0;
    let activeMessage: { task: TaskWakeTask; completed: boolean } | undefined;
    let activeTick: TaskWakeTick | undefined;
    let nextTick = 0;
    let reason: string | undefined;
    let pendingReasons: Record<string, number> = {};
    const pendingEdges: number[] = [];
    let awaitingRender: number[] = [];
    let activeCallback: TaskWakeObservation['callbacks'][number] | undefined;
    const restore: Array<() => void> = [];
    const callbacks = new WeakMap<() => unknown, () => unknown>();
    const measure = <T>(operation: () => T): T => {
      const start = performance.now();
      try {
        return operation();
      }
      finally {
        observation.observerCpuMs += performance.now() - start;
      }
    };
    const increment = (values: Record<string, number>, key: string, amount = 1): void => {
      values[key] = (values[key] ?? 0) + amount;
    };
    const work = (key: string, amount = 1): void => {
      if (activeTick)
        increment(activeTick.work, key, amount);
    };
    const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    let finish: (() => void) | undefined;
    window.cityTaskWakeObserver = {
      register: worker => measure(() => {
        if (!stopped && !workers.has(worker))
          workers.set(worker, { id: ++nextWorker, tasks: new Map() });
      }),
      posted: (worker, message, ownGeometry, requestCount, admissionId) => measure(() => {
        if (stopped)
          return;
        const known = workers.get(worker);
        if (!known)
          return;
        const task: TaskWakeTask = {
          worker: known.id,
          message,
          classification: ownGeometry ? 'ownGeometry' : 'unknownNative',
          requestCount,
          admissionId,
          posted: performance.now(),
        };
        known.tasks.set(message, task);
        observation.tasks.push(task);
      }),
      withMessage: (worker, message, operation) => {
        if (stopped)
          return operation();
        const previous = activeMessage;
        const known = workers.get(worker);
        measure(() => {
          const task = typeof message === 'number' ? known?.tasks.get(message) : undefined;
          activeMessage = task && { task, completed: false };
        });
        try {
          return operation();
        }
        finally {
          measure(() => {
            if (activeMessage?.completed)
              known?.tasks.delete(activeMessage.task.message);
            activeMessage = previous;
          });
        }
      },
      stop: () => {
        if (stopped)
          return;
        finish?.();
        stopped = true;
        cancelAnimationFrame(polling);
        for (const operation of restore.reverse()) operation();
        measure(() => {
          const summary: Record<string, number> = { posted: observation.tasks.length, ticks: observation.ticks.length };
          for (const event of observation.events) {
            increment(summary, `${event.classification}Events`);
            increment(summary, 'appendedCallbacks', event.appendedCallbacks);
          }
          for (const callback of observation.callbacks) {
            if (callback.executed !== undefined)
              increment(summary, 'executedCallbacks');
            increment(summary, 'callbackSceneRequestCalls', callback.sceneRequestCalls);
            if (callback.sceneBefore === false && callback.sceneAfter === true)
              increment(summary, 'callbackRequestEdges');
            if (callback.nextRenderTick !== undefined)
              increment(summary, 'callbacksWithSubsequentRender');
          }
          for (const tick of observation.ticks) {
            if (tick.realRender)
              increment(summary, 'realRenders');
            for (const [key, count] of Object.entries(tick.rootReasons))
              increment(summary, `root:${key}`, count);
            for (const [key, count] of Object.entries(tick.work))
              increment(summary, `work:${key}`, count);
            for (const [key, count] of Object.entries(tick.publications))
              increment(summary, `published:${key}`, count);
          }
          observation.summary = summary;
        });
        observation.stopped = performance.now();
        window.cityTaskWakeObserver = undefined;
      },
    };
    const attach = (): void => {
      if (stopped)
        return;
      const validation = window.renderValidation;
      const native = validation?.atlas?.cesium as unknown as {
        TaskProcessor?: { taskCompletedEvent: { raiseEvent: (...args: unknown[]) => unknown } };
        Primitive?: { prototype: { update: (...args: unknown[]) => unknown } };
        PrimitiveState?: { COMBINED: number; COMPLETE: number };
      } | undefined;
      if (!native?.TaskProcessor || !native.Primitive || !native.PrimitiveState || !validation?.tileset) {
        polling = requestAnimationFrame(attach);
        return;
      }
      const scene = validation.viewer.scene as unknown as {
        _renderRequested: boolean;
        requestRender: (...args: unknown[]) => unknown;
        _frameState: { frameNumber?: number; newFrame?: boolean; afterRender: Array<() => unknown> };
        preUpdate: { addEventListener: (listener: () => void) => () => void };
        postUpdate: { addEventListener: (listener: () => void) => () => void };
        postRender: { addEventListener: (listener: () => void) => () => void };
      };
      const tileset = validation.tileset as unknown as {
        _renderRequested: boolean;
        _renderRequestGeneration: number;
        _requestRender: () => unknown;
        _continueSymbolPlacement: () => unknown;
        _tickSymbolFades: () => unknown;
        _tilePublishQueue: Record<string, unknown> & { size: number };
        _sceneCollections: Record<string, unknown> & { pendingFirstUpdateCount: number };
        _symbolRenderer: { hasPendingWork: boolean; hasRunnableWork: boolean; _pendingOpacityHalves: Set<unknown>; _pendingDynamicHalves: Set<unknown>; _targetPlacement: Record<string, unknown>; _visiblePlacement: Record<string, unknown>; _handoffPlacement: Record<string, unknown> };
      };
      const symbols = tileset._symbolRenderer;
      const scopes = [symbols._targetPlacement, symbols._visiblePlacement, symbols._handoffPlacement];
      finish = () => {
        if (!activeTick)
          return;
        measure(() => {
          activeTick!.sceneRequestedAfter = scene._renderRequested;
          activeTick!.rootRequestedAfter = tileset._renderRequested;
          observation.ticks.push(activeTick!);
          activeTick = undefined;
        });
      };
      restore.push(scene.preUpdate.addEventListener(() => {
        finish?.();
        measure(() => {
          activeTick = {
            tick: ++nextTick,
            at: performance.now(),
            frameBefore: numeric(scene._frameState.frameNumber),
            realRender: false,
            sceneRequestedBefore: scene._renderRequested,
            rootRequestedBefore: tileset._renderRequested,
            firstUpdates: tileset._sceneCollections.pendingFirstUpdateCount,
            publishJobs: tileset._tilePublishQueue.size,
            placementPending: symbols.hasPendingWork,
            placementRunnable: symbols.hasRunnableWork,
            placementJobs: scopes.filter(scope => !!scope.job).length,
            opacity: symbols._pendingOpacityHalves.size,
            dynamic: symbols._pendingDynamicHalves.size,
            rootReasons: pendingReasons,
            work: {},
            publications: {},
            taskCallbacks: [],
            taskRequestEdges: pendingEdges.splice(0),
          };
          pendingReasons = {};
        });
        const tick = activeTick;
        queueMicrotask(() => {
          if (activeTick === tick)
            finish?.();
        });
      }));
      restore.push(scene.postUpdate.addEventListener(() => measure(() => {
        if (activeTick) {
          activeTick.frameAfter = numeric(scene._frameState.frameNumber);
          activeTick.newFrame = scene._frameState.newFrame;
        }
      })));
      restore.push(scene.postRender.addEventListener(() => measure(() => {
        if (activeTick) {
          activeTick.realRender = true;
          awaitingRender = awaitingRender.filter((id) => {
            const callback = observation.callbacks[id];
            // afterRender requests cannot cause the already-drawn frame.
            if (callback.tick !== undefined && callback.tick < activeTick!.tick) {
              callback.nextRenderTick = activeTick!.tick;
              return false;
            }
            return true;
          });
        }
      })));
      const sceneRequest = scene.requestRender;
      const wrappedSceneRequest = function (this: unknown, ...args: unknown[]) {
        measure(() => {
          if (activeCallback)
            activeCallback.sceneRequestCalls++;
          work('sceneRequestCalls');
        });
        return Reflect.apply(sceneRequest, this, args);
      };
      scene.requestRender = wrappedSceneRequest;
      restore.push(() => {
        if (scene.requestRender === wrappedSceneRequest)
          scene.requestRender = sceneRequest;
      });
      const event = native.TaskProcessor.taskCompletedEvent;
      const raise = event.raiseEvent;
      const wrappedRaise = function (this: unknown, ...args: unknown[]) {
        const row = measure(() => {
          if (activeMessage)
            activeMessage.completed = true;
          const value: TaskWakeObservation['events'][number] = { id: observation.events.length, at: performance.now(), tick: activeTick?.tick, classification: activeMessage?.task.classification ?? 'unknownNative', task: activeMessage?.task, failed: args[0] !== undefined, appendedCallbacks: 0, afterRenderBefore: scene._frameState.afterRender.length, sceneRequestedBefore: scene._renderRequested, rootRequestedBefore: tileset._renderRequested };
          observation.events.push(value);
          return value;
        });
        const first = scene._frameState.afterRender.length;
        try {
          return Reflect.apply(raise, this, args);
        }
        finally {
          measure(() => {
            const queue = scene._frameState.afterRender;
            row.afterRenderAfter = queue.length;
            row.sceneRequestedAfter = scene._renderRequested;
            row.rootRequestedAfter = tileset._renderRequested;
            for (let index = first; index < queue.length; index++) {
              const original = queue[index];
              const value: TaskWakeObservation['callbacks'][number] = { id: observation.callbacks.length, event: row.id, enqueued: performance.now(), sceneRequestCalls: 0 };
              observation.callbacks.push(value);
              row.appendedCallbacks++;
              const wrapped = function (this: unknown, ...callbackArgs: unknown[]) {
                const previous = activeCallback;
                measure(() => {
                  value.executed = performance.now();
                  value.tick = activeTick?.tick;
                  value.sceneBefore = scene._renderRequested;
                  value.rootGenerationBefore = tileset._renderRequestGeneration;
                  activeCallback = value;
                });
                try {
                  return Reflect.apply(original, this, callbackArgs);
                }
                catch (error) {
                  value.threw = true;
                  throw error;
                }
                finally {
                  measure(() => {
                    value.sceneAfter = scene._renderRequested;
                    value.rootGenerationAfter = tileset._renderRequestGeneration;
                    activeTick?.taskCallbacks.push(value.id);
                    if (!value.sceneBefore && value.sceneAfter)
                      pendingEdges.push(value.id);
                    if (value.sceneRequestCalls > 0)
                      awaitingRender.push(value.id);
                    activeCallback = previous;
                  });
                }
              };
              callbacks.set(wrapped, original);
              queue[index] = wrapped;
            }
          });
        }
      };
      event.raiseEvent = wrappedRaise;
      restore.push(() => {
        if (event.raiseEvent === wrappedRaise)
          event.raiseEvent = raise;
        const queue = scene._frameState.afterRender;
        for (let index = 0; index < queue.length; index++) {
          const original = callbacks.get(queue[index]);
          if (original)
            queue[index] = original;
        }
      });
      const hook = (object: Record<string, unknown>, name: string, category: string, observed?: (args: unknown[], result: unknown) => void): void => {
        const original = object[name];
        if (typeof original !== 'function')
          return;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          const previous = reason;
          reason = category;
          measure(() => work(category));
          try {
            const result = Reflect.apply(original, this, args);
            if (observed)
              measure(() => observed(args, result));
            return result;
          }
          finally {
            reason = previous;
          }
        };
        object[name] = wrapped;
        restore.push(() => {
          if (object[name] === wrapped)
            object[name] = original;
        });
      };
      const root = tileset as unknown as Record<string, unknown>;
      const request = tileset._requestRender;
      const wrappedRequest = function (this: unknown, ...args: unknown[]) {
        measure(() => increment(activeTick?.rootReasons ?? pendingReasons, reason ?? 'unclassifiedRoot'));
        return Reflect.apply(request, this, args);
      };
      tileset._requestRender = wrappedRequest;
      restore.push(() => {
        if (tileset._requestRender === wrappedRequest)
          tileset._requestRender = request;
      });
      hook(root, '_continueSymbolPlacement', 'placementContinuation');
      hook(root, '_tickSymbolFades', 'symbolFades');
      hook(tileset._tilePublishQueue, '_requestBuildContinuation', 'buildContinuation');
      hook(tileset._sceneCollections, '_requestFirstUpdateContinuation', 'uploadContinuation');
      hook(tileset._tilePublishQueue, '_buildVector', 'vectorCpu');
      hook(tileset._tilePublishQueue, '_stepSymbol', 'symbolBuild');
      hook(tileset._tilePublishQueue, '_stepPattern', 'patternBuild');
      hook(tileset._tilePublishQueue._options as Record<string, unknown>, 'publish', 'publication', (args) => {
        const result = args[0] as { stage?: string } | undefined;
        if (activeTick && typeof result?.stage === 'string')
          increment(activeTick.publications, result.stage);
      });
      hook(tileset._tilePublishQueue, 'inspectBuilds', 'buildInspection', (_, result) => {
        if (activeTick) {
          const inspection = result as { runnable: boolean; renderNeeded: boolean };
          activeTick.buildInspection = { runnable: inspection.runnable, renderNeeded: inspection.renderNeeded };
        }
      });
      hook(tileset._sceneCollections, '_hasRenderFirstUpdates', 'renderFirstUpdates', (_, result) => {
        if (activeTick && typeof result === 'boolean')
          activeTick.renderFirstUpdates = result;
      });
      hook(tileset._sceneCollections, 'advancePreparations', 'idleGeometryPreparation');
      hook(tileset._tilePublishQueue, 'advanceBuilds', 'idleVectorBuild');
      for (const [index, scope] of scopes.entries())
        hook(scope, 'advance', `placementScope${index}`);
      const primitive = native.Primitive.prototype;
      const update = primitive.update;
      const combined = native.PrimitiveState.COMBINED;
      const complete = native.PrimitiveState.COMPLETE;
      const wrappedUpdate = function (this: { _state?: number; _batchTable?: object }, ...args: unknown[]) {
        if (!activeTick || args[0] !== scene._frameState)
          return Reflect.apply(update, this, args);
        const before = this._state;
        const tableBefore = !!this._batchTable;
        try {
          return Reflect.apply(update, this, args);
        }
        finally {
          measure(() => {
            if (!tableBefore && this._batchTable)
              work('nativeBatchTableCreated');
            if (before === combined && this._state === complete)
              work('nativeCombinedToComplete');
          });
        }
      };
      primitive.update = wrappedUpdate;
      restore.push(() => {
        if (primitive.update === wrappedUpdate)
          primitive.update = update;
      });
      observation.armed = performance.now();
    };
    polling = requestAnimationFrame(attach);
  });
}

declare global {
  interface Window {
    cityTaskWakes: TaskWakeObservation;
    cityTaskWakeObserver?: TaskWakeBridge;
  }
}
