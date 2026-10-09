import type { BrowserContext } from 'playwright/test';

interface TileRequestID {
  key: string;
  overscaledZ: number;
  wrap: number;
  z: number;
  x: number;
  y: number;
}

interface TileLifecycleEvent {
  eventId: number;
  callId: number;
  stage: 'request' | 'loadVectorData' | 'tileLoaded' | 'enqueue' | 'beginTileBuild' | 'advanceTileBuild' | 'publish' | 'discardBuild';
  phase: 'start' | 'return' | 'throw';
  at: number;
  frame?: number;
  cameraVersion?: number;
  motionPhase?: string;
  attachmentId: number;
  sourceId: string;
  tileObjectId: number;
  tileUid?: number;
  tileId?: string;
  key?: string;
  overscaledZ?: number;
  wrap?: number;
  z?: number;
  x?: number;
  y?: number;
  generationId?: number;
  buildPhase?: string;
  publishStage?: string;
  surfacePhase?: string;
  symbolPhase?: string;
}

interface CityReturnFrame {
  at: number;
  frame?: number;
  cameraVersion: number;
  observedGlobe?: Array<{ z: number; x: number; y: number }>;
  sources: Array<{
    sourceId: string;
    zoom?: number;
    ideals?: Array<TileRequestID | undefined>;
    loaded: Array<TileRequestID | undefined>;
    renderable: string[];
    symbols: string[];
  }>;
  kinds: Record<string, string[]>;
}

interface TileRequestObservation {
  diagnosticOnly: true;
  fairTiming: false;
  coverageIncomplete: true;
  semantics: string;
  armed?: number;
  stopped?: number;
  observerCpuMs: number;
  lifecycleSemantics: string;
  events: TileLifecycleEvent[];
  droppedEvents: number;
  returnFrames: CityReturnFrame[];
  attachments: Array<{
    attachmentId: number;
    sourceId: string;
    at: number;
    frame?: number;
    existingDispatchedLoads: number;
    existingTiles: Array<{ id?: TileRequestID; state?: string }>;
    detached?: number;
  }>;
  retentions: Array<{
    retentionId: number;
    attachmentId: number;
    at: number;
    frame?: number;
    styleZoom?: number;
    coveringZoom?: number;
    ideals: TileRequestID[];
    unknownIdeals: number;
  }>;
  requests: Array<{
    attachmentId: number;
    sourceId: string;
    at: number;
    frame?: number;
    styleZoom?: number;
    coveringZoom?: number;
    requested?: TileRequestID;
    tileState?: string;
    requestedState?: string;
    reason: 'ideal' | 'parent-fallback' | 'reload' | 'unknown';
    inRetainedScope: boolean;
    retentionId?: number;
    relatedIdealKeys: string[];
  }>;
}

/** Observe real pyramid load invocations without changing their arguments or promises. */
export async function observeCityTileRequests(context: BrowserContext) {
  await context.addInitScript(() => {
    const observation: TileRequestObservation = {
      diagnosticOnly: true,
      fairTiming: false,
      coverageIncomplete: true,
      semantics: 'Cumulative pyramid _loadTile invocations after attachment, not network fetches or parse completion. Requests during _updateRetainedTiles are classified against its exact ideal IDs; outside that scope ancestor requests remain unknown. Reloads are tagged independently. Attachments can miss earlier calls and calls during an identity replacement before the next synchronization.',
      observerCpuMs: 0,
      lifecycleSemantics: 'Synchronous method start/return/throw after attachment for registered tiles of this tileset. loadVectorData starts after data has reached its caller; it is not a network response or Worker receive timestamp. Return records method return, not Promise completion. Native frame numbers can repeat across idle ticks. Events contain metadata only and are capped at 8192; coverage can miss calls before registration or during identity replacement.',
      events: [],
      droppedEvents: 0,
      returnFrames: [],
      attachments: [],
      retentions: [],
      requests: [],
    };
    window.cityTileRequests = observation;
    type Method = (this: any, ...args: any[]) => any;
    interface Hook {
      pyramid: any;
      source: object;
      sourceId: string;
      attachmentId: number;
      retention?: TileRequestObservation['retentions'][number];
      scopes: Array<TileRequestObservation['retentions'][number]>;
      reloadDepth: number;
      restore: () => void;
    }
    const hooks = new Map<object, Hook>();
    interface TileRegistration {
      attachmentId: number;
      sourceId: string;
      tileObjectId: number;
      tileUid?: number;
    }
    const registeredTiles = new WeakMap<object, TileRegistration>();
    const registeredBuckets = new WeakMap<object, TileRegistration>();
    const activeAttachments = new Set<number>();
    const prototypeRestores = new Map<object, () => void>();
    let nextTileObjectId = 0;
    let nextCallId = 0;
    let publishQueue: any;
    let vectorRenderer: any;
    let restorePublishQueue: (() => void) | undefined;
    let restoreVectorRenderer: (() => void) | undefined;
    let stopped = false;
    let polling = 0;
    let tileset: any;
    let scene: any;
    let removePreUpdate: (() => void) | undefined;
    let removePostRender: (() => void) | undefined;
    const measure = <T>(operation: () => T): T => {
      const start = performance.now();
      try {
        return operation();
      }
      finally {
        observation.observerCpuMs += performance.now() - start;
      }
    };
    const id = (value: any): TileRequestID | undefined => {
      const canonical = value?.canonical;
      if (typeof value?.key !== 'string' || !canonical
        || ![value.overscaledZ, value.wrap, canonical.z, canonical.x, canonical.y].every(Number.isSafeInteger)) {
        return undefined;
      }
      return { key: value.key, overscaledZ: value.overscaledZ, wrap: value.wrap, z: canonical.z, x: canonical.x, y: canonical.y };
    };
    const stamp = () => ({
      at: performance.now(),
      frame: scene?._frameState?.frameNumber as number | undefined,
      styleZoom: tileset?._renderer.evaluation?.zoom as number | undefined,
    });
    const replaceMethod = (target: any, name: string, factory: (original: Method) => Method): (() => void) => {
      const original = target[name] as Method;
      if (typeof original !== 'function')
        return () => {};
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      const wrapped = factory(original);
      target[name] = wrapped;
      return () => {
        if (target[name] !== wrapped)
          return;
        if (descriptor)
          Object.defineProperty(target, name, descriptor);
        else
          delete target[name];
      };
    };
    const registration = (tile: object): TileRegistration | undefined => {
      const value = registeredTiles.get(tile);
      return value && activeAttachments.has(value.attachmentId) ? value : undefined;
    };
    const rememberBuckets = (tile: any, value: TileRegistration): void => {
      if (tile.buckets && typeof tile.buckets === 'object')
        registeredBuckets.set(tile.buckets, value);
    };
    type BuildMetadata = Pick<TileLifecycleEvent, 'buildPhase' | 'publishStage' | 'surfacePhase' | 'symbolPhase'>;
    const recordEvent = (value: TileRegistration, stage: TileLifecycleEvent['stage'], phase: TileLifecycleEvent['phase'], callId: number, tileID: any, tileId?: string, generationId?: number, metadata?: BuildMetadata): void => {
      if (observation.events.length >= 8192) {
        observation.droppedEvents++;
        return;
      }
      const coord = id(tileID);
      const motion = window.cityMotion?.state();
      observation.events.push({
        eventId: observation.events.length,
        callId,
        stage,
        phase,
        at: performance.now(),
        frame: scene?._frameState?.frameNumber as number | undefined,
        cameraVersion: motion?.poseIndex,
        motionPhase: motion?.phase,
        ...value,
        tileId: tileId ?? (coord ? `${value.sourceId}/${coord.key}` : undefined),
        ...coord,
        generationId,
        ...metadata,
      });
    };
    const observeCall = <T>(value: TileRegistration, stage: TileLifecycleEvent['stage'], tileID: any, operation: () => T, returned?: (result: T) => void, tileId?: string, generationId?: number, resultGeneration?: (result: T) => number | undefined, metadata?: () => BuildMetadata): T => {
      const callId = measure(() => {
        const callId = nextCallId++;
        recordEvent(value, stage, 'start', callId, tileID, tileId, generationId, metadata?.());
        return callId;
      });
      let result: T;
      try {
        result = operation();
      }
      catch (error) {
        measure(() => recordEvent(value, stage, 'throw', callId, tileID, tileId, generationId, metadata?.()));
        throw error;
      }
      measure(() => {
        returned?.(result);
        recordEvent(value, stage, 'return', callId, tileID, tileId, resultGeneration ? resultGeneration(result) : generationId, metadata?.());
      });
      return result;
    };
    const registerTile = (tile: any, hook: Hook): TileRegistration => {
      let value = registeredTiles.get(tile);
      if (!value || value.attachmentId !== hook.attachmentId) {
        value = { attachmentId: hook.attachmentId, sourceId: hook.sourceId, tileObjectId: ++nextTileObjectId, tileUid: tile.uid };
        registeredTiles.set(tile, value);
      }
      rememberBuckets(tile, value);
      const prototype = Object.getPrototypeOf(tile);
      if (!prototypeRestores.has(prototype)) {
        prototypeRestores.set(prototype, replaceMethod(prototype, 'loadVectorData', original => function (...args: any[]) {
          const value = measure(() => registration(this));
          if (stopped || !value)
            return original.apply(this, args);
          return observeCall(value, 'loadVectorData', this.tileID, () => original.apply(this, args), () => rememberBuckets(this, value));
        }));
      }
      return value;
    };
    // Matches OverscaledTileID.isChildOf, including overscaling and world copies.
    const childOf = (child: TileRequestID, parent: TileRequestID): boolean => {
      if (child.wrap !== parent.wrap || child.overscaledZ <= parent.overscaledZ)
        return false;
      if (parent.overscaledZ === 0)
        return true;
      const difference = child.z - parent.z;
      return difference >= 0 && parent.x === Math.floor(child.x / 2 ** difference)
        && parent.y === Math.floor(child.y / 2 ** difference);
    };
    const attach = (pyramid: any, source: object, sourceId: string): Hook => {
      const attachmentId = observation.attachments.length;
      activeAttachments.add(attachmentId);
      observation.attachments.push({
        attachmentId,
        sourceId,
        ...stamp(),
        existingDispatchedLoads: pyramid._dispatchedLoads?.size ?? 0,
        existingTiles: (pyramid._activeTiles?.getAllTiles?.() ?? []).map((tile: any) => ({ id: id(tile.tileID), state: tile.state as string | undefined })),
      });
      const restores: Array<() => void> = [];
      const hook: Hook = {
        pyramid,
        source,
        sourceId,
        attachmentId,
        scopes: [],
        reloadDepth: 0,
        restore: () => {
          for (const restore of restores) restore();
          activeAttachments.delete(attachmentId);
          observation.attachments[attachmentId].detached = performance.now();
        },
      };
      const wrap = (name: string, factory: (original: Method) => Method): void => {
        restores.push(replaceMethod(pyramid, name, factory));
      };
      wrap('_updateRetainedTiles', original => function (...args: any[]) {
        if (this !== pyramid || stopped)
          return original.apply(this, args);
        const retention = measure(() => {
          const raw = Array.isArray(args[0]) ? args[0] : [];
          const ideals = raw.map(id).filter((value: TileRequestID | undefined): value is TileRequestID => !!value);
          const retention = {
            retentionId: observation.retentions.length,
            attachmentId,
            ...stamp(),
            coveringZoom: pyramid._covering?.zoom as number | undefined,
            ideals,
            unknownIdeals: raw.length - ideals.length,
          };
          observation.retentions.push(retention);
          hook.retention = retention;
          hook.scopes.push(retention);
          return retention;
        });
        try {
          return original.apply(this, args);
        }
        finally {
          measure(() => {
            hook.scopes.pop();
            hook.retention = hook.scopes.at(-1) ?? retention;
          });
        }
      });
      wrap('_reloadTile', original => function (...args: any[]) {
        if (this !== pyramid || stopped)
          return original.apply(this, args);
        measure(() => hook.reloadDepth++);
        try {
          return original.apply(this, args);
        }
        finally {
          measure(() => hook.reloadDepth--);
        }
      });
      wrap('_loadTile', original => function (...args: any[]) {
        if (this !== pyramid || stopped)
          return original.apply(this, args);
        measure(() => {
          if (activeAttachments.has(attachmentId) && args[0] && typeof args[0] === 'object') {
            const value = registerTile(args[0], hook);
            recordEvent(value, 'request', 'start', nextCallId++, args[0].tileID);
          }
          const requested = id(args[0]?.tileID);
          const active = hook.scopes.at(-1);
          const retention = active ?? hook.retention;
          const exact = requested && retention?.ideals.find(ideal => ideal.key === requested.key
            && ideal.overscaledZ === requested.overscaledZ && ideal.wrap === requested.wrap
            && ideal.z === requested.z && ideal.x === requested.x && ideal.y === requested.y);
          const ancestors = requested ? retention?.ideals.filter(ideal => childOf(ideal, requested)) ?? [] : [];
          const requestedState = typeof args[2] === 'string' ? args[2] : undefined;
          const reload = hook.reloadDepth > 0 || requestedState === 'reloading' || requestedState === 'expired';
          observation.requests.push({
            attachmentId,
            sourceId,
            ...stamp(),
            coveringZoom: pyramid._covering?.zoom as number | undefined,
            requested,
            tileState: typeof args[0]?.state === 'string' ? args[0].state : undefined,
            requestedState,
            reason: reload ? 'reload' : exact ? 'ideal' : active && ancestors.length > 0 ? 'parent-fallback' : 'unknown',
            inRetainedScope: !!active,
            retentionId: retention?.retentionId,
            relatedIdealKeys: exact ? [exact.key] : ancestors.map(ideal => ideal.key),
          });
        });
        // Return the original promise itself: no await, then, or replacement.
        return original.apply(this, args);
      });
      wrap('_tileLoaded', original => function (...args: any[]) {
        const value = measure(() => registration(args[0]));
        if (this !== pyramid || stopped || !value || value.attachmentId !== attachmentId)
          return original.apply(this, args);
        return observeCall(value, 'tileLoaded', args[0].tileID, () => original.apply(this, args));
      });
      return hook;
    };
    const synchronizeBuilders = (): void => {
      const currentQueue = tileset?._renderer.publishQueue;
      if (publishQueue !== currentQueue) {
        restorePublishQueue?.();
        publishQueue = currentQueue;
        const restoreEnqueue = currentQueue && replaceMethod(currentQueue, '_enqueue', original => function (...args: any[]) {
          const value = measure(() => registration(args[1]));
          if (this !== currentQueue || publishQueue !== currentQueue || stopped || !value || value.sourceId !== args[0])
            return original.apply(this, args);
          return observeCall(value, 'enqueue', args[1].tileID, () => original.apply(this, args), () => rememberBuckets(args[1], value), undefined, args[2]);
        });
        const restorePublish = currentQueue && replaceMethod(currentQueue, '_publish', original => function (...args: any[]) {
          const job = args[0];
          const value = measure(() => registration(job?.tile));
          if (this !== currentQueue || publishQueue !== currentQueue || stopped || !value || value.sourceId !== job.sourceId)
            return original.apply(this, args);
          return observeCall(value, 'publish', job.tile.tileID, () => original.apply(this, args), undefined, job.tileId, job.generationId, undefined, () => ({ publishStage: args[1] }));
        });
        const restoreDiscard = currentQueue && replaceMethod(currentQueue, '_discard', original => function (...args: any[]) {
          const job = args[0];
          const value = measure(() => registration(job?.tile));
          if (this !== currentQueue || publishQueue !== currentQueue || stopped || !value || value.sourceId !== job.sourceId)
            return original.apply(this, args);
          return observeCall(value, 'discardBuild', job.tile.tileID, () => original.apply(this, args), undefined, job.tileId, job.generationId, undefined, () => ({ buildPhase: job.vectorBuild?.phase, surfacePhase: job.surfaces, symbolPhase: job.symbols }));
        });
        restorePublishQueue = () => {
          restoreDiscard?.();
          restorePublish?.();
          restoreEnqueue?.();
        };
      }
      const currentRenderer = tileset?._renderer.vector;
      if (vectorRenderer !== currentRenderer) {
        restoreVectorRenderer?.();
        vectorRenderer = currentRenderer;
        const restoreBegin = currentRenderer && replaceMethod(currentRenderer, 'beginTileBuild', original => function (...args: any[]) {
          const input = args[0];
          const value = measure(() => registeredBuckets.get(input?.buckets));
          if (this !== currentRenderer || vectorRenderer !== currentRenderer || stopped || !value || !activeAttachments.has(value.attachmentId) || value.sourceId !== input.sourceId)
            return original.apply(this, args);
          return observeCall(value, 'beginTileBuild', input.tileID, () => original.apply(this, args), undefined, input.tileId, input.generationId, result => result?.generationId);
        });
        const restoreAdvance = currentRenderer && replaceMethod(currentRenderer, 'advanceTileBuild', original => function (...args: any[]) {
          const build = args[0];
          const value = measure(() => registeredBuckets.get(build?.buckets));
          if (this !== currentRenderer || vectorRenderer !== currentRenderer || stopped || !value || !activeAttachments.has(value.attachmentId) || value.sourceId !== build.sourceId)
            return original.apply(this, args);
          return observeCall(value, 'advanceTileBuild', build.tileID, () => original.apply(this, args), undefined, build.tileId, build.generationId, undefined, () => ({ buildPhase: build.phase }));
        });
        restoreVectorRenderer = () => {
          restoreAdvance?.();
          restoreBegin?.();
        };
      }
    };
    const synchronize = (): void => {
      if (stopped)
        return;
      measure(() => {
        const validation = window.renderValidation;
        const currentTileset = validation?.tileset as any;
        const currentScene = validation?.viewer?.scene as any;
        if (tileset !== currentTileset) {
          for (const hook of hooks.values()) hook.restore();
          hooks.clear();
          for (const restore of prototypeRestores.values()) restore();
          prototypeRestores.clear();
          tileset = currentTileset;
        }
        synchronizeBuilders();
        if (scene !== currentScene) {
          removePreUpdate?.();
          removePostRender?.();
          scene = currentScene;
          removePreUpdate = scene?.preUpdate?.addEventListener(synchronize);
          removePostRender = scene?.postRender?.addEventListener(() => {
            const motion = window.cityMotion?.state();
            if (!motion || motion.poseIndex < 95 || observation.returnFrames.length >= 128)
              return;
            measure(() => {
              const covering = tileset?._renderer.covering;
              const kinds: Record<string, string[]> = {};
              for (const command of scene._frameState.commandList) {
                const batch = validation?.drawBatch(command) ?? validation?.drawBatch(command.owner);
                if (batch)
                  (kinds[batch.kind] ??= []).push(batch.tileId);
              }
              observation.returnFrames.push({
                ...stamp(),
                cameraVersion: motion.poseIndex,
                observedGlobe: covering?._renderedGlobe?._surface?._tilesToRender.map((tile: any) => ({ z: tile.level, x: tile.x, y: tile.y })),
                sources: Array.from(hooks.values(), hook => ({
                  sourceId: hook.sourceId,
                  zoom: hook.pyramid._covering?.zoom,
                  ideals: hook.pyramid._covering?.idealTileIDs.map(id),
                  loaded: hook.pyramid.getLoadedTileIDs(0, 24).map(id),
                  renderable: hook.pyramid.getRenderableIds(),
                  symbols: hook.pyramid.getRenderableIds(true),
                })),
                kinds,
              });
            });
          });
        }
        const current = new Set<object>();
        for (const [sourceId, pyramid] of Object.entries(tileset?._renderer.style?.tilePyramids ?? {}) as Array<[string, any]>) {
          if (!pyramid || typeof pyramid._loadTile !== 'function' || typeof pyramid._updateRetainedTiles !== 'function')
            continue;
          const source = pyramid.getSource?.() as object | undefined;
          if (!source)
            continue;
          current.add(pyramid);
          const existing = hooks.get(pyramid);
          if (existing?.source === source && existing.sourceId === sourceId)
            continue;
          existing?.restore();
          hooks.set(pyramid, attach(pyramid, source, sourceId));
          observation.armed ??= performance.now();
        }
        for (const [pyramid, hook] of hooks) {
          if (!current.has(pyramid)) {
            hook.restore();
            hooks.delete(pyramid);
          }
        }
      });
    };
    window.cityTileRequestObserver = {
      stop: () => {
        if (stopped)
          return;
        measure(() => {
          stopped = true;
          cancelAnimationFrame(polling);
          removePreUpdate?.();
          removePostRender?.();
          for (const hook of hooks.values()) hook.restore();
          hooks.clear();
          restorePublishQueue?.();
          restoreVectorRenderer?.();
          for (const restore of prototypeRestores.values()) restore();
          prototypeRestores.clear();
          observation.stopped = performance.now();
          window.cityTileRequestObserver = undefined;
        });
      },
    };
    const poll = (): void => {
      synchronize();
      if (!stopped)
        polling = requestAnimationFrame(poll);
    };
    polling = requestAnimationFrame(poll);
  });
}

declare global {
  interface Window {
    cityTileRequests: TileRequestObservation;
    cityTileRequestObserver?: { stop: () => void };
  }
}
