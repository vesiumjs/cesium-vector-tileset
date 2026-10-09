import type { BrowserContext } from 'playwright/test';

/** Opt-in scheduling diagnosis; these samples are excluded from fair timing runs. */
export async function observeCityUploads(context: BrowserContext) {
  await context.addInitScript(() => {
    const observations: Array<Record<string, unknown>> = [];
    const target = window as unknown as {
      cityUploadFrames: typeof observations;
      renderValidation?: { tileset: any; viewer: any; atlas: { cesium: any } };
    };
    target.cityUploadFrames = observations;
    const attach = () => {
      const tileset = target.renderValidation?.tileset;
      if (!tileset) {
        requestAnimationFrame(attach);
        return;
      }
      const scene = target.renderValidation!.viewer.scene;
      const native = target.renderValidation!.atlas.cesium;
      let sample: any;
      let frameWork: any;
      let observedLease: any;
      let tick = 0;
      let observerCpu = 0;
      let nextOwner = 0;
      const ownerIds = new WeakMap<object, number>();
      const wrappedOwners = new WeakSet<object>();
      const observe = <T>(operation: () => T): T => {
        const start = performance.now();
        try {
          return operation();
        }
        finally {
          observerCpu += performance.now() - start;
        }
      };
      const deadline = (budget: any): number | undefined => {
        // SceneStageBudget may tighten its original FrameBudget deadline.
        if (typeof budget?._end === 'number')
          return budget._end;
        return typeof budget?.deadline === 'number' ? budget.deadline : undefined;
      };
      const remaining = (budget: any, now: number): number | undefined => {
        const end = deadline(budget);
        return end === undefined ? undefined : end - now;
      };
      const ownerId = (owner: object): number => {
        let id = ownerIds.get(owner);
        if (id === undefined) {
          id = nextOwner++;
          ownerIds.set(owner, id);
        }
        return id;
      };
      const physicalOwner = (value: any): any => {
        if (value.primitive instanceof native.Primitive)
          return value.primitive;
        return value instanceof native.Primitive ? value : undefined;
      };
      const wrapPreparation = (owner: any): void => {
        if (wrappedOwners.has(owner) || typeof owner.advancePreparation !== 'function')
          return;
        wrappedOwners.add(owner);
        const id = ownerId(owner);
        const original = owner.advancePreparation;
        owner.advancePreparation = function (...args: any[]) {
          const current = sample;
          const before = observe(() => ({
            started: this._started,
            state: this._state,
            result: !!this._combinedResult,
            waiting: !!this._waitingForSlot,
          }));
          const start = performance.now();
          try {
            return original.apply(this, args);
          }
          finally {
            const duration = performance.now() - start;
            observe(() => {
              if (!current)
                return;
              const progress = current.geometry;
              progress.calls++;
              progress.cpuMs += duration;
              progress.scheduled += !before.started && this._started && this._state === native.PrimitiveState.COMBINING ? 1 : 0;
              progress.restored += this._state === native.PrimitiveState.COMBINED && before.state !== this._state ? 1 : 0;
              const phase = this._waitingForSlot
                ? 'slot'
                : before.started ? 'restore' : 'copy';
              progress[phase]++;
              if (progress.owners.length < 32) {
                progress.owners.push({ id, phase, duration, stateBefore: before.state, stateAfter: this._state, resultBefore: before.result, waitingBefore: before.waiting, preparingAfter: !!this._preparation });
              }
              else {
                progress.omittedOwners++;
              }
            });
          }
        };
      };
      const queueReasons = () => {
        const owners = new Set<any>();
        const visit = (value: any): void => {
          if (value.isDestroyed())
            return;
          const owner = physicalOwner(value);
          if (owner) {
            owners.add(owner);
            wrapPreparation(owner);
          }
          else if (value instanceof native.PrimitiveCollection) {
            for (let index = 0; index < value.length; index++) visit(value.get(index));
          }
        };
        const ready = (value: any): boolean => {
          const owner = physicalOwner(value);
          if (owner)
            return owner.ready;
          if (value instanceof native.PrimitiveCollection) {
            for (let index = 0; index < value.length; index++) {
              if (!ready(value.get(index)))
                return false;
            }
          }
          return true;
        };
        const counts = { owners: 0, fresh: 0, preparation: 0, waitingSlot: 0, waitingSlotRunnable: 0, noBatch: 0, combined: 0, result: 0, ready: 0, wholeReady: 0, renderFresh: 0, renderNoBatch: 0, renderCombined: 0, renderFailed: 0, renderOther: 0 };
        for (const queue of tileset._renderer.collections._firstUpdates) {
          for (const collection of queue.keys()) {
            if (collection.isDestroyed())
              continue;
            counts.wholeReady += ready(collection) ? 1 : 0;
            visit(collection);
          }
        }
        counts.owners = owners.size;
        for (const owner of owners) {
          const owned = typeof owner.advancePreparation === 'function';
          counts.fresh += owned && !owner._started && !owner._preparation ? 1 : 0;
          counts.preparation += owner._preparation ? 1 : 0;
          counts.waitingSlot += owner._waitingForSlot ? 1 : 0;
          counts.waitingSlotRunnable += owner._waitingForSlot && owner.hasRunnableUpdate ? 1 : 0;
          counts.noBatch += !owner._batchTable ? 1 : 0;
          counts.combined += owner._state === native.PrimitiveState.COMBINED ? 1 : 0;
          counts.result += owner._combinedResult ? 1 : 0;
          counts.ready += owner.ready ? 1 : 0;
          if (owner.ready)
            continue;
          if (owned) {
            if (owner._state === native.PrimitiveState.FAILED)
              counts.renderFailed++;
            else if (owner._preparation || owner._combinedResult)
              continue;
            else if (!owner._started)
              counts.renderFresh++;
            else if (!owner._batchTable)
              counts.renderNoBatch++;
            else if (owner._state === native.PrimitiveState.COMBINED)
              counts.renderCombined++;
            else if (owner.needsRenderUpdate)
              counts.renderOther++;
          }
          else if (owner._state !== native.PrimitiveState.CREATING && owner._state !== native.PrimitiveState.COMBINING) {
            counts.renderOther++;
          }
        }
        return counts;
      };
      const captureFrame = () => {
        const lease = tileset._renderer.preparation._sceneBudget;
        if (!lease || lease === observedLease)
          return;
        observedLease = lease;
        const originalFrame = lease.frame;
        lease.frame = function (...args: any[]) {
          frameWork = originalFrame.apply(this, args);
          const original = frameWork.continuation;
          frameWork.continuation = function (stage: string, runnable: any) {
            const budget = stage === 'placement' ? this.placementBudget : this.tileBudget;
            const before = observe(() => ({ exhausted: budget.exhausted, remaining: remaining(budget, performance.now()) }));
            const result = original.call(this, stage, runnable);
            observe(() => {
              if (sample)
                sample.continuations.push({ stage, ...before, runnable: { ...runnable }, granted: !!result, minimum: !!result && result !== budget });
            });
            return result;
          };
          return frameWork;
        };
      };
      const wrapStage = (owner: any, method: string, stage: string, budgetIndex: number, pending?: () => number) => {
        const original = owner[method];
        owner[method] = function (...args: any[]) {
          const current = sample;
          const before = observe(() => ({ pendingBefore: pending?.(), reasonsBefore: stage === 'upload' || stage === 'idleUpload' ? queueReasons() : undefined, callsBefore: current?.geometry.calls ?? 0 }));
          const start = performance.now();
          const budget = args[budgetIndex];
          const allowance = observe(() => ({ remaining: remaining(budget, start), exhausted: budget?.exhausted }));
          let result: any;
          try {
            result = original.apply(this, args);
            return result;
          }
          finally {
            const duration = performance.now() - start;
            observe(() => {
              if (!current)
                return;
              const record = { stage, duration, ...allowance, ...before, pendingAfter: pending?.(), reasonsAfter: stage === 'upload' || stage === 'idleUpload' ? queueReasons() : undefined, cpuCalls: current.geometry.calls - before.callsBefore, units: stage === 'idleUpload' ? result?.units : undefined, renderNeeded: result?.renderNeeded };
              current.stageCalls.push(record);
              current.stages[stage] = record;
            });
          }
        };
      };
      wrapStage(tileset._renderer.collections, 'pumpFirstUpdates', 'upload', 1, () => tileset._renderer.collections.pendingFirstUpdateCount);
      wrapStage(tileset._renderer.collections, 'advancePreparations', 'idleUpload', 1, () => tileset._renderer.collections.pendingFirstUpdateCount);
      wrapStage(tileset._renderer.publishQueue, 'drain', 'build', 0, () => tileset._renderer.publishQueue.size);
      wrapStage(tileset._renderer.publishQueue, 'advanceBuilds', 'idleBuild', 0, () => tileset._renderer.publishQueue.size);
      const originalPrePasses = tileset.prePassesUpdate;
      tileset.prePassesUpdate = function (frame: any) {
        observe(() => {
          captureFrame();
          if (sample) {
            sample.frame = frame.frameNumber;
            sample.idle = frame.newFrame === false;
            sample.reasonsBefore = queueReasons();
            sample.ownRenderRequestedBefore = tileset._renderer.wake.requested;
          }
        });
        try {
          return originalPrePasses.call(this, frame);
        }
        finally {
          observe(() => {
            captureFrame();
            if (sample)
              sample.ownRenderRequestedAfterPrePasses = tileset._renderer.wake.requested;
          });
        }
      };
      const originalUpdate = tileset.update;
      tileset.update = function (frame: any) {
        observe(captureFrame);
        const current = sample;
        const start = performance.now();
        try {
          return originalUpdate.call(this, frame);
        }
        finally {
          const duration = performance.now() - start;
          observe(() => {
            captureFrame();
            if (current) {
              current.cpu += duration;
              current.updateCalls++;
              current.ownRenderRequestedAfterUpdate = tileset._renderer.wake.requested;
            }
          });
        }
      };
      scene.preUpdate.addEventListener(() => observe(() => {
        frameWork = undefined;
        const current: any = sample = {
          diagnosticOnly: true,
          fairTiming: false,
          inexactAttribution: 'advancePreparation calls, not generator quanta or copy bytes; scheduled precedes Worker.postMessage',
          tick: ++tick,
          at: performance.now(),
          cpu: 0,
          updateCalls: 0,
          realRender: false,
          idle: false,
          sceneRenderRequestedBefore: scene._renderRequested,
          stages: {},
          stageCalls: [],
          continuations: [],
          geometry: { calls: 0, cpuMs: 0, copy: 0, restore: 0, slot: 0, scheduled: 0, restored: 0, owners: [], omittedOwners: 0 },
        };
        const beforeObserver = observerCpu;
        queueMicrotask(() => {
          observe(() => {
            const work = frameWork?._frame;
            Object.assign(current, {
              frameStart: work?.start,
              physicalBudgetTick: work?.tick,
              tileDeadline: deadline(work?.tileBudget),
              deferred: work?.deferredMs,
              continuation: work?.continued,
              continuationMs: work?.continuationMs,
              selectedParticipant: work?.participant === tileset,
              stageSequence: work?.stage,
              commands: tileset._renderer._lastSubmittedCommands,
              zoom: tileset._renderer.symbol.cameraZoom,
              firstUpdates: tileset._renderer.collections.pendingFirstUpdateCount,
              publishes: tileset._renderer.publishQueue.size,
              paint: tileset._renderer.vector.needsPaintUpdate,
              placement: tileset._renderer.symbol.hasRunnableWork,
              ownRenderRequestedAfter: tileset._renderer.wake.requested,
              sceneRenderRequestedAfter: scene._renderRequested,
              reasonsAfter: queueReasons(),
            });
            observations.push(current);
            if (sample === current)
              sample = undefined;
          });
          current.observerCpuMs = observerCpu - beforeObserver;
        });
      }));
      scene.postUpdate.addEventListener(() => observe(() => {
        if (sample) {
          sample.frame = scene._frameState.frameNumber;
          sample.idle = scene._frameState.newFrame === false;
        }
      }));
      scene.postRender.addEventListener(() => observe(() => {
        if (sample)
          sample.realRender = true;
      }));
    };
    requestAnimationFrame(attach);
  });
}
