import type { BrowserContext } from 'playwright/test';

/** Opt-in diagnosis: timings and omitted draws never count as fair performance. */
export async function observeCityDraws(context: BrowserContext, omitted: string[] = []) {
  await context.addInitScript((omitted) => {
    const target = window as unknown as { cityDrawFrames: object[]; renderValidation?: any };
    const frames: object[] = target.cityDrawFrames = [];
    const attach = () => {
      const validation = target.renderValidation;
      const scene = validation?.viewer.scene;
      if (!scene) {
        requestAnimationFrame(attach);
        return;
      }
      let current: any;
      let groups = new Map<string, any>();
      const identities = new WeakMap<object, number>();
      let nextIdentity = 1;
      const identity = (value: unknown): number | 'unknown' => {
        if ((typeof value !== 'object' || value === null) && typeof value !== 'function')
          return 'unknown';
        const object = value as object;
        let id = identities.get(object);
        if (id === undefined) {
          id = nextIdentity++;
          identities.set(object, id);
        }
        return id;
      };
      const numeric = (value: unknown): number | 'unknown' => typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
      const sample = () => {
        const frame = scene._frameState.frameNumber;
        if (current?.frame !== frame) {
          const index = frames.length;
          const expiredIndex = index - 60;
          if (expiredIndex >= 0 && expiredIndex % 60 !== 0) {
            // Only this frame just left the recent window. Never scan history
            // or reuse its detail array for another frame.
            const expired = frames[expiredIndex] as typeof current;
            expired.census.groups.length = 0;
            expired.census.detailRetained = false;
          }
          groups = new Map();
          current = {
            frame,
            at: performance.now(),
            kinds: {},
            census: {
              diagnosticOnly: true,
              fairTiming: false,
              boundary: 'Context.draw calls before execution; omitted calls are counted separately',
              positionTextureCoverage: 'unknown: uniform getter identity is not verified',
              ...(index === 0
                ? {
                    detailRetention: 'Keep the newest 60 frames and representatives at zero-based frames array indices 0, 60, 120, ...; Native frameNumber gaps do not affect retention. Older non-representative groups are cleared; kind counters and observerCpuMs remain.',
                  }
                : {}),
              detailRetained: true,
              observerCpuMs: 0,
              groups: [],
            },
          };
          frames.push(current);
        }
        return current;
      };
      const batchFor = (command: any) => validation.drawBatch(command) ?? validation.drawBatch(command.owner);
      const kindFor = (command: any) => batchFor(command)?.kind ?? 'native';
      const record = (command: any) => {
        const kinds = sample().kinds;
        const kind = kindFor(command);
        return kinds[kind] ??= { draws: 0, duration: 0, omitted: 0, derivations: 0, dirtyDerivations: 0 };
      };
      const recordDraw = (context: any, command: any, args: any[], isOmitted: boolean) => {
        const start = performance.now();
        const census = sample().census;
        const batch = batchFor(command);
        // Match Context.draw's actual override/default resolution. Native may
        // change the viewport and frustum after tileset command preparation.
        const passState = args[0] ?? context._defaultPassState;
        const viewport = passState?.viewport;
        const frustum = context.uniformState.currentFrustum;
        const values = {
          kind: batch?.kind ?? 'native',
          layerId: typeof batch?.layerId === 'string' ? batch.layerId : 'unknown',
          tileId: typeof batch?.tileId === 'string' ? batch.tileId : 'unknown',
          ownerId: identity(command.owner),
          vertexArrayId: identity(command.vertexArray),
          shaderProgramId: identity(args[1] ?? command.shaderProgram),
          renderStateId: identity(command.renderState ?? context._defaultRenderState),
          framebufferId: identity(command.framebuffer ?? passState?.framebuffer),
          // Even the expected lineRecord_texture name does not prove an
          // arbitrary command's getter is side-effect free. Never invoke it.
          positionTextureId: 'unknown',
          count: numeric(command.count),
          offset: numeric(command.offset),
          instanceCount: numeric(command.instanceCount),
          // Verified Native scalar getters. They read stored counts without
          // walking geometry or evaluating command uniform functions.
          geometryInstances: numeric(command.owner?._batchTable?.numberOfInstances),
          vertices: numeric(command.vertexArray?.numberOfVertices),
          indices: numeric(command.vertexArray?.indexBuffer?.numberOfIndices),
          bytesPerIndex: numeric(command.vertexArray?.indexBuffer?.bytesPerIndex),
          primitiveType: numeric(command.primitiveType),
          pass: numeric(command.pass),
          viewportX: numeric(viewport?.x),
          viewportY: numeric(viewport?.y),
          viewportWidth: numeric(viewport?.width),
          viewportHeight: numeric(viewport?.height),
          frustumNear: numeric(frustum?.x),
          frustumFar: numeric(frustum?.y),
        };
        const key = JSON.stringify(values);
        let group = groups.get(key);
        if (!group) {
          group = { ...values, calls: 0, omitted: 0 };
          groups.set(key, group);
          census.groups.push(group);
        }
        group.calls++;
        group.omitted += Number(isOmitted);
        census.observerCpuMs += performance.now() - start;
      };
      const originalDraw = scene.context.draw;
      scene.context.draw = function (command: any, ...args: any[]) {
        const value = record(command);
        value.draws++;
        const isOmitted = omitted.includes(kindFor(command));
        recordDraw(this, command, args, isOmitted);
        if (isOmitted) {
          value.omitted++;
          return;
        }
        const start = performance.now();
        try {
          return originalDraw.call(this, command, ...args);
        }
        finally {
          value.duration += performance.now() - start;
        }
      };
      const originalDerived = scene.updateDerivedCommands;
      scene.updateDerivedCommands = function (command: any, ...args: any[]) {
        const value = record(command);
        value.derivations++;
        value.dirtyDerivations += Number(command.dirty);
        return originalDerived.call(this, command, ...args);
      };
    };
    requestAnimationFrame(attach);
  }, omitted);
}

interface OwnerUpdateSample {
  ownerId: number;
  calls: number;
  nativeCpuMs: number;
  thrownCalls: number;
  readyBefore: boolean | 'unknown';
  readyAfter: boolean | 'unknown';
  nativeStateBefore: number | 'unknown';
  nativeStateAfter: number | 'unknown';
  submittedCommands: number;
  submittedVertexArrayIds: number[];
  unknownVertexArrays: number;
  foreignCommandOwners: number;
  association?: 'drawn' | 'neverDrawn' | 'sharedVA' | 'unknown' | 'noSubmittedCommands';
  completedDrawCalls?: number;
}

interface OwnerUpdateTick {
  tick: number;
  at: number;
  frameBefore: number | 'unknown';
  frameAfter?: number | 'unknown';
  newFrame?: boolean | 'unknown';
  realRender: boolean;
  renderCompleted: 'unknown';
  renderErrorEvents: number;
  finalizedBy?: 'microtask' | 'nextPreUpdate' | 'stop';
  observerCpuMs: number;
  finalizeObserverCpuMs: number;
  detailRetained: boolean;
  nativeCpuMs: number;
  updateCalls: number;
  unknownDrawCalls: number;
  unmatchedCompletedDrawCalls?: number;
  owners: OwnerUpdateSample[];
  vertexArrays: Array<{ vertexArrayId: number; completedDrawCalls: number; omittedCalls: number; thrownDrawCalls: number; updateOwnerIds: number[]; drawCommandOwnerIds: number[]; exclusiveUpdateOwner: boolean; sharedDrawCommandOwners: boolean; exclusive: boolean }>;
  summary?: Record<string, { owners: number; calls: number; nativeCpuMs?: number }>;
  ownerStateSummary?: Record<string, { owners: number; calls: number; nativeCpuMs: number }>;
}

/** Native calls and real VA draws only; no early visibility or update changes. */
export async function observeCityOwnerUpdates(context: BrowserContext, omitted: string[] = []) {
  await context.addInitScript((omitted) => {
    const target = window as unknown as {
      renderValidation?: any;
      cityOwnerUpdates: {
        diagnosticOnly: true;
        fairTiming: false;
        boundary: string;
        coverage: string;
        attribution: string;
        armed?: number;
        stopped?: number;
        observerCpuMs: number;
        observerErrors: number;
        outsideTickUpdateCalls: number;
        outsideTickNativeCpuMs: number;
        outsideTickDrawCalls: number;
        owners: Array<{ ownerId: number; kind: string; layerId: string; tileId: string }>;
        ticks: OwnerUpdateTick[];
      };
      cityOwnerUpdateObserver?: { stop: () => void };
    };
    const observation = target.cityOwnerUpdates = {
      diagnosticOnly: true,
      fairTiming: false,
      boundary: 'Original Native Primitive.prototype.update elapsed CPU; Context.draw VA association after successful original return. Native Scene.preUpdate starts each independent tick, including idle calls; microtask finalization follows synchronous draws. Scene.render is never replaced.',
      coverage: 'Armed after renderValidation and atlas.cesium are exposed; earlier calls excluded. Only the observed Scene frameState is included. No scene traversal or uniform getter calls. postUpdate records frameAfter/newFrame; postRender marks actual render. Render completion/throw has no reliable event-only boundary and remains unknown; renderError events are counted. All tick summaries remain; owner/VA detail retains the newest 60 ticks and representatives at zero-based indices 0, 60, 120, ... . Owner state summary keys use kind:association:firstNativeState->lastNativeState within the tick, not separate per-call transitions.',
      attribution: 'Drawn/neverDrawn CPU is exclusive only when every submitted VA has one Native updating owner and at most one actual draw-command owner in that tick. Replay association uses VA identity, not command.owner equality. Shared VA owner costs remain individually reported but are not added to attributed buckets. No-submission and unknown costs do not establish safe early culling. Native timings are inclusive; other enabled probes may contribute.',
      observerCpuMs: 0,
      observerErrors: 0,
      outsideTickUpdateCalls: 0,
      outsideTickNativeCpuMs: 0,
      outsideTickDrawCalls: 0,
      owners: [],
      ticks: [],
    } as typeof target.cityOwnerUpdates;
    const identities = new WeakMap<object, number>();
    const knownOwners = new Set<number>();
    const ownerKinds = new Map<number, string>();
    let nextIdentity = 1;
    let nextTick = 1;
    let stopped = false;
    let current: {
      sample: OwnerUpdateTick;
      owners: Map<number, OwnerUpdateSample>;
      vertexArrays: Map<number, OwnerUpdateTick['vertexArrays'][number]>;
      finished: boolean;
    } | undefined;
    const numeric = (value: unknown): number | 'unknown' => typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
    const identity = (value: unknown): number | undefined => {
      if ((typeof value !== 'object' || value === null) && typeof value !== 'function')
        return undefined;
      let id = identities.get(value as object);
      if (id === undefined) {
        id = nextIdentity++;
        identities.set(value as object, id);
      }
      return id;
    };
    const observe = (tick: typeof current, operation: () => void) => {
      const start = performance.now();
      try {
        operation();
      }
      catch {
        // An observer failure must not replace a Native return or exception.
        observation.observerErrors++;
      }
      finally {
        const duration = performance.now() - start;
        observation.observerCpuMs += duration;
        if (tick)
          tick.sample.observerCpuMs += duration;
      }
    };
    const vertexArray = (tick: NonNullable<typeof current>, id: number) => {
      let value = tick.vertexArrays.get(id);
      if (!value) {
        value = { vertexArrayId: id, completedDrawCalls: 0, omittedCalls: 0, thrownDrawCalls: 0, updateOwnerIds: [], drawCommandOwnerIds: [], exclusiveUpdateOwner: false, sharedDrawCommandOwners: false, exclusive: false };
        tick.vertexArrays.set(id, value);
        tick.sample.vertexArrays.push(value);
      }
      return value;
    };
    const attach = () => {
      if (stopped)
        return;
      const validation = target.renderValidation;
      const scene = validation?.viewer.scene;
      const primitive = validation?.atlas?.cesium?.Primitive?.prototype;
      if (!scene || !primitive) {
        requestAnimationFrame(attach);
        return;
      }
      observation.armed = performance.now();
      const originalUpdate = primitive.update;
      const originalDraw = scene.context.draw;
      const ready = (owner: any): boolean | 'unknown' => typeof owner._ready === 'boolean' ? owner._ready : 'unknown';
      const wrappedUpdate = function (this: any, ...args: any[]) {
        if (stopped || args[0] !== scene._frameState)
          return originalUpdate.apply(this, args);
        const tick = current;
        let value: OwnerUpdateSample | undefined;
        let firstCommand = 0;
        observe(tick, () => {
          if (!tick)
            return;
          const ownerId = identity(this)!;
          if (!knownOwners.has(ownerId)) {
            knownOwners.add(ownerId);
            const batch = validation.drawBatch(this);
            ownerKinds.set(ownerId, typeof batch?.kind === 'string' ? batch.kind : 'native');
            observation.owners.push({
              ownerId,
              kind: typeof batch?.kind === 'string' ? batch.kind : 'native',
              layerId: typeof batch?.layerId === 'string' ? batch.layerId : 'unknown',
              tileId: typeof batch?.tileId === 'string' ? batch.tileId : 'unknown',
            });
          }
          value = tick.owners.get(ownerId);
          if (!value) {
            value = { ownerId, calls: 0, nativeCpuMs: 0, thrownCalls: 0, readyBefore: ready(this), readyAfter: 'unknown', nativeStateBefore: numeric(this._state), nativeStateAfter: 'unknown', submittedCommands: 0, submittedVertexArrayIds: [], unknownVertexArrays: 0, foreignCommandOwners: 0 };
            tick.owners.set(ownerId, value);
            tick.sample.owners.push(value);
          }
          firstCommand = args[0].commandList?.length ?? 0;
        });
        const start = performance.now();
        let completed = false;
        try {
          const result = originalUpdate.apply(this, args);
          completed = true;
          return result;
        }
        finally {
          const duration = performance.now() - start;
          observe(tick, () => {
            if (!tick) {
              observation.outsideTickUpdateCalls++;
              observation.outsideTickNativeCpuMs += duration;
              return;
            }
            tick.sample.updateCalls++;
            tick.sample.nativeCpuMs += duration;
            if (!value)
              return;
            value.calls++;
            value.nativeCpuMs += duration;
            value.thrownCalls += Number(!completed);
            value.readyAfter = ready(this);
            value.nativeStateAfter = numeric(this._state);
            const commands = args[0].commandList;
            for (let index = firstCommand; index < (commands?.length ?? 0); index++) {
              const command = commands[index];
              value.submittedCommands++;
              if (command.owner !== this) {
                value.foreignCommandOwners++;
                continue;
              }
              const id = identity(command.vertexArray);
              if (id === undefined) {
                value.unknownVertexArrays++;
                continue;
              }
              if (!value.submittedVertexArrayIds.includes(id))
                value.submittedVertexArrayIds.push(id);
              const va = vertexArray(tick, id);
              if (!va.updateOwnerIds.includes(value.ownerId))
                va.updateOwnerIds.push(value.ownerId);
            }
          });
        }
      };
      const wrappedDraw = function (this: any, command: any, ...args: any[]) {
        if (stopped)
          return originalDraw.call(this, command, ...args);
        const tick = current;
        let id: number | undefined;
        let ownerId: number | undefined;
        let isOmitted = false;
        observe(tick, () => {
          id = identity(command.vertexArray);
          ownerId = identity(command.owner);
          if (omitted.length > 0) {
            const batch = validation.drawBatch(command) ?? validation.drawBatch(command.owner);
            isOmitted = omitted.includes(batch?.kind ?? 'native');
          }
        });
        let completed = false;
        try {
          const result = originalDraw.call(this, command, ...args);
          completed = true;
          return result;
        }
        finally {
          observe(tick, () => {
            if (!tick) {
              observation.outsideTickDrawCalls++;
              return;
            }
            if (id === undefined) {
              tick.sample.unknownDrawCalls++;
              return;
            }
            const va = vertexArray(tick, id);
            if (ownerId !== undefined && !va.drawCommandOwnerIds.includes(ownerId))
              va.drawCommandOwnerIds.push(ownerId);
            va.completedDrawCalls += Number(completed && !isOmitted);
            va.omittedCalls += Number(isOmitted);
            va.thrownDrawCalls += Number(!completed);
          });
        }
      };
      const finish = (tick: typeof current, finalizedBy: NonNullable<OwnerUpdateTick['finalizedBy']>) => {
        if (!tick || tick.finished)
          return;
        tick.finished = true;
        const before = tick.sample.observerCpuMs;
        observe(tick, () => {
          tick.sample.finalizedBy = finalizedBy;
          tick.sample.unmatchedCompletedDrawCalls = 0;
          const summary: NonNullable<OwnerUpdateTick['summary']> = {};
          const stateSummary: NonNullable<OwnerUpdateTick['ownerStateSummary']> = {};
          for (const va of tick.vertexArrays.values()) {
            va.exclusiveUpdateOwner = va.updateOwnerIds.length === 1;
            va.sharedDrawCommandOwners = va.drawCommandOwnerIds.length > 1;
            va.exclusive = va.exclusiveUpdateOwner && !va.sharedDrawCommandOwners;
            if (va.updateOwnerIds.length === 0)
              tick.sample.unmatchedCompletedDrawCalls += va.completedDrawCalls;
          }
          for (const owner of tick.owners.values()) {
            const arrays = owner.submittedVertexArrayIds.map(id => tick.vertexArrays.get(id)!);
            const completedDrawCalls = arrays.reduce((total, va) => total + va.completedDrawCalls, 0);
            owner.association = owner.foreignCommandOwners || owner.unknownVertexArrays || owner.thrownCalls
              ? 'unknown'
              : arrays.some(va => !va.exclusive)
                ? 'sharedVA'
                : arrays.length === 0
                  ? 'noSubmittedCommands'
                  : completedDrawCalls > 0 ? 'drawn' : 'neverDrawn';
            if (owner.association !== 'sharedVA' && owner.association !== 'unknown')
              owner.completedDrawCalls = completedDrawCalls;
            const bucket = summary[owner.association] ??= { owners: 0, calls: 0, ...(owner.association === 'sharedVA' ? {} : { nativeCpuMs: 0 }) };
            bucket.owners++;
            bucket.calls += owner.calls;
            if (bucket.nativeCpuMs !== undefined)
              bucket.nativeCpuMs += owner.nativeCpuMs;
            const key = `${ownerKinds.get(owner.ownerId)}:${owner.association}:${owner.nativeStateBefore}->${owner.nativeStateAfter}`;
            const state = stateSummary[key] ??= { owners: 0, calls: 0, nativeCpuMs: 0 };
            state.owners++;
            state.calls += owner.calls;
            state.nativeCpuMs += owner.nativeCpuMs;
          }
          tick.sample.summary = summary;
          tick.sample.ownerStateSummary = stateSummary;
          const expiredIndex = observation.ticks.length - 60;
          if (expiredIndex >= 0 && expiredIndex % 60 !== 0) {
            const expired = observation.ticks[expiredIndex];
            expired.owners.length = 0;
            expired.vertexArrays.length = 0;
            expired.detailRetained = false;
          }
          observation.ticks.push(tick.sample);
        });
        tick.sample.finalizeObserverCpuMs += tick.sample.observerCpuMs - before;
        if (current === tick)
          current = undefined;
      };
      const removePreUpdate = scene.preUpdate.addEventListener(() => {
        if (stopped)
          return;
        // A second synchronous Scene tick can precede the first microtask.
        // Never merge its owners just because Native frameNumber is unchanged.
        finish(current, 'nextPreUpdate');
        const start = performance.now();
        const tick = {
          sample: { tick: nextTick++, at: start, frameBefore: numeric(scene._frameState.frameNumber), realRender: false, renderCompleted: 'unknown', renderErrorEvents: 0, observerCpuMs: 0, finalizeObserverCpuMs: 0, detailRetained: true, nativeCpuMs: 0, updateCalls: 0, unknownDrawCalls: 0, owners: [], vertexArrays: [] } as OwnerUpdateTick,
          owners: new Map<number, OwnerUpdateSample>(),
          vertexArrays: new Map<number, OwnerUpdateTick['vertexArrays'][number]>(),
          finished: false,
        };
        current = tick;
        queueMicrotask(() => finish(tick, 'microtask'));
        const setupCpuMs = performance.now() - start;
        tick.sample.observerCpuMs += setupCpuMs;
        observation.observerCpuMs += setupCpuMs;
      });
      const removePostUpdate = scene.postUpdate.addEventListener(() => observe(current, () => {
        if (current) {
          current.sample.frameAfter = numeric(scene._frameState.frameNumber);
          current.sample.newFrame = typeof scene._frameState.newFrame === 'boolean' ? scene._frameState.newFrame : 'unknown';
        }
      }));
      const removePostRender = scene.postRender.addEventListener(() => observe(current, () => {
        if (current)
          current.sample.realRender = true;
      }));
      const removeRenderError = scene.renderError.addEventListener(() => observe(current, () => {
        if (current)
          current.sample.renderErrorEvents++;
      }));
      primitive.update = wrappedUpdate;
      scene.context.draw = wrappedDraw;
      target.cityOwnerUpdateObserver = {
        stop: () => {
          stopped = true;
          finish(current, 'stop');
          observation.stopped = performance.now();
          removePreUpdate();
          removePostUpdate();
          removePostRender();
          removeRenderError();
          if (primitive.update === wrappedUpdate)
            primitive.update = originalUpdate;
          if (scene.context.draw === wrappedDraw)
            scene.context.draw = originalDraw;
        },
      };
    };
    requestAnimationFrame(attach);
  }, omitted);
}
