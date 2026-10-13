import type { Budget } from './frame-budget';
import { FrameBudget } from './frame-budget';

export const FRAME_CPU_TARGET_MS = 1000 / 60;
const PLACEMENT_RESERVE_MS = 2;
const MANDATORY_MARGIN_MS = 1;
const MINIMUM_PROGRESS_MS = 2;
const OVERLOAD_SERVICE_RATIO = 0.05;
const SAMPLE_COUNT = 32;

type Stage = 'upload' | 'build' | 'paint' | 'placement';
export type RunnableStages = Record<Stage, boolean>;
interface ObservedScene {
  preUpdate?: { addEventListener: (listener: (scene?: object) => void) => () => void };
  postUpdate?: { addEventListener: (listener: (scene?: object) => void) => () => void };
  postRender?: { addEventListener: (listener: (scene?: object) => void) => () => void };
}
interface Participant {
  eligible: () => boolean;
  stage: number;
}
interface FrameWork {
  frameNumber?: number;
  start: number;
  tick: number;
  deferredMs: number;
  operationStart?: number;
  operationDepth: number;
  tileBudget: SceneStageBudget;
  placementBudget: SceneStageBudget;
  participant?: object;
  stage: number;
  continuationMs: number;
  continued: boolean;
  preparedAfterPasses: boolean;
  idle: boolean;
}

/** Classification changes may remove allowance, never renew it within a tick. */
class SceneStageBudget extends FrameBudget {
  private _end: number;

  private _allowance: number;

  private readonly _charged: (now: number) => number;

  constructor(allowance: number, deadline: number, charged: (now: number) => number) {
    super(0, deadline);
    this._charged = charged;
    this._allowance = allowance;
    this._end = deadline;
  }

  override get exhausted(): boolean {
    const now = performance.now();
    return now >= this._end || this._charged(now) >= this._allowance;
  }

  tighten(allowance: number, deadline: number): void {
    this._allowance = Math.min(this._allowance, allowance);
    this._end = Math.min(this._end, deadline);
  }
}

function deferredCharge(frame: FrameWork, now: number): number {
  return frame.deferredMs + (frame.operationStart === undefined ? 0 : now - frame.operationStart);
}

export class MinimumProgressBudget extends FrameBudget {
  private _available = true;

  takeMinimumProgress(): boolean {
    const available = this._available;
    this._available = false;
    return available;
  }
}

const scenes = new WeakMap<object, SceneBudget>();

class SceneBudget {
  readonly participants = new Map<object, Participant>();

  private readonly _removeListeners: Array<() => void> = [];

  private readonly _samples: number[] = [];

  private readonly _idleSamples: number[] = [];

  private _idleReserve?: number;

  private _destroyed = false;

  private _reserve = FRAME_CPU_TARGET_MS / 2;

  private _start?: number;

  private _frame?: FrameWork;

  private _sequence = 0;

  private _tick = 0;

  constructor(scene: ObservedScene) {
    if (scene.preUpdate) {
      this._removeListeners.push(scene.preUpdate.addEventListener((eventScene) => {
        if (eventScene && eventScene !== scene)
          return;
        this._tick++;
        this._start = performance.now();
      }));
    }
    if (scene.postRender) {
      this._removeListeners.push(scene.postRender.addEventListener((eventScene) => {
        if (eventScene && eventScene !== scene)
          return;
        const frame = this._frame;
        if (!frame || this._start === undefined || frame.tick !== this._tick) {
          return;
        }
        const now = performance.now();
        const mandatory = Math.max(0, now - frame.start - deferredCharge(frame, now));
        this._samples.push(mandatory);
        if (this._samples.length > SAMPLE_COUNT)
          this._samples.shift();
        const sorted = [...this._samples].sort((a, b) => a - b);
        const measured = sorted[Math.floor(sorted.length * 0.95)] + MANDATORY_MARGIN_MS;
        // Recover only when the rolling mandatory P95 supports it. Retaining
        // an expired startup spike would reduce preparation to its minimum.
        this._reserve = measured;
      }));
    }
    if (scene.postUpdate) {
      this._removeListeners.push(scene.postUpdate.addEventListener((eventScene) => {
        if (eventScene && eventScene !== scene)
          return;
        const frame = this._frame;
        if (!frame?.idle || frame.tick !== this._tick)
          return;
        // Idle ticks have no postRender event. Observe their synchronous tail
        // after postPassesUpdate and afterRender without wrapping Scene.render.
        queueMicrotask(() => {
          if (this._destroyed || this._frame !== frame || frame.tick !== this._tick || !frame.idle)
            return;
          const now = performance.now();
          this._idleSamples.push(Math.max(0, now - frame.start - deferredCharge(frame, now)));
          if (this._idleSamples.length > SAMPLE_COUNT)
            this._idleSamples.shift();
          const sorted = [...this._idleSamples].sort((a, b) => a - b);
          this._idleReserve = sorted[Math.floor(sorted.length * 0.95)] + MANDATORY_MARGIN_MS;
        });
      }));
    }
  }

  frame(frameNumber?: number, idle = false): FrameWork {
    if (this._frame && this._frame.frameNumber === frameNumber
      && this._frame.idle === idle
      && (this._start !== undefined ? this._frame.tick === this._tick : frameNumber !== undefined)) {
      return this._frame;
    }
    const sameTick = this._start !== undefined && this._frame?.tick === this._tick ? this._frame : undefined;
    const start = this._start ?? performance.now();
    const allowance = FRAME_CPU_TARGET_MS - (idle ? this._idleReserve ?? this._reserve : this._reserve);
    const deadline = start + FRAME_CPU_TARGET_MS;
    if (sameTick) {
      sameTick.frameNumber = frameNumber;
      sameTick.idle = idle;
      sameTick.tileBudget.tighten(allowance - PLACEMENT_RESERVE_MS, deadline - PLACEMENT_RESERVE_MS);
      sameTick.placementBudget.tighten(allowance, deadline);
      return sameTick;
    }
    const participants = [...this.participants].filter(([, state]) => state.eligible());
    const selected = participants[this._sequence++ % participants.length];
    const frame: FrameWork = this._frame = {
      frameNumber,
      start,
      tick: this._tick,
      deferredMs: 0,
      operationDepth: 0,
      // Mandatory work already elapsed belongs to the whole-Scene reserve.
      // Charge deferred work once, and independently cap the physical tick.
      tileBudget: new SceneStageBudget(allowance - PLACEMENT_RESERVE_MS, deadline - PLACEMENT_RESERVE_MS, now => deferredCharge(frame, now)),
      placementBudget: new SceneStageBudget(allowance, deadline, now => deferredCharge(frame, now)),
      participant: selected?.[0],
      stage: selected ? selected[1].stage++ : 0,
      continuationMs: Math.max(MINIMUM_PROGRESS_MS, Math.min(
        FRAME_CPU_TARGET_MS,
        (this._reserve - MANDATORY_MARGIN_MS) * OVERLOAD_SERVICE_RATIO,
      )),
      continued: false,
      preparedAfterPasses: false,
      idle,
    };
    return frame;
  }

  prepareAfterPasses(frame: FrameWork, participant: object, operation: (budget: Budget) => void): boolean {
    if (this._destroyed || frame !== this._frame || frame.tick !== this._tick || frame.idle
      || frame.participant !== participant || !this.participants.get(participant)?.eligible()
      || frame.preparedAfterPasses) {
      return false;
    }
    // Drawing is complete. Its actual elapsed time, rather than another
    // mandatory reserve, limits this one shared CPU preparation turn.
    const budget = FrameBudget.until(frame.start + FRAME_CPU_TARGET_MS - MANDATORY_MARGIN_MS);
    if (budget.exhausted)
      return false;
    frame.preparedAfterPasses = true;
    operation(budget);
    return true;
  }

  destroy(): void {
    this._destroyed = true;
    for (const remove of this._removeListeners)
      remove();
  }
}

/** One participant's view of a shared physical frame, including bounded overload progress. */
export class SceneFrameWork {
  readonly tileBudget: FrameBudget;
  readonly placementBudget: FrameBudget;

  private readonly _frame: FrameWork;

  private readonly _participant: object;

  private readonly _owner: SceneBudget;

  constructor(frame: FrameWork, participant: object, owner: SceneBudget) {
    this._frame = frame;
    this._participant = participant;
    this._owner = owner;
    this.tileBudget = frame.tileBudget;
    this.placementBudget = frame.placementBudget;
  }

  /** Prepare CPU-only work after a real draw, using that physical tick's tail. */
  prepareAfterPasses(operation: (budget: Budget) => void): boolean {
    return this._owner.prepareAfterPasses(this._frame, this._participant, budget => this.measure(() => operation(budget)));
  }

  measure<T>(operation: () => T): T {
    const frame = this._frame;
    if (frame.operationDepth++ === 0)
      frame.operationStart = performance.now();
    try {
      return operation();
    }
    finally {
      if (--frame.operationDepth === 0) {
        frame.deferredMs += performance.now() - frame.operationStart!;
        frame.operationStart = undefined;
      }
    }
  }

  /** Grant service only after mandatory preamble, and measure the deferred stage. */
  run<T>(stage: Stage, runnable: RunnableStages, operation: (budget: Budget) => T, minimumMs?: number): T {
    const budget = this.continuation(stage, runnable, minimumMs)
      ?? (stage === 'placement' ? this.placementBudget : this.tileBudget);
    return this.measure(() => operation(budget));
  }

  /** Only runnable stages participate; worker waiting receives no continuation allowance. */
  continuation(stage: Stage, runnable: RunnableStages, minimumMs?: number): Budget | undefined {
    const budget = stage === 'placement' ? this.placementBudget : this.tileBudget;
    if (!budget.exhausted)
      return budget;
    const frame = this._frame;
    if (frame.participant !== this._participant || frame.continued || !runnable[stage])
      return undefined;
    const selected = this._selectedStage(runnable);
    if (selected !== stage)
      return undefined;
    frame.continued = true;
    // Cooperative work units may overrun; keep making progress instead of
    // hiding a mandatory-cost overload by indefinitely stopping publication.
    return new MinimumProgressBudget(Math.max(frame.continuationMs, minimumMs ?? 0));
  }

  /**
   * @internal
   */
  private _selectedStage(runnable: RunnableStages): Stage | undefined {
    const stages = (['upload', 'build', 'paint', 'placement'] as const).filter(stage => runnable[stage]);
    return stages[this._frame.stage % stages.length];
  }
}

export interface SceneFrameBudgetLease {
  frame: (frameNumber?: number, idle?: boolean) => SceneFrameWork;
  release: () => void;
}

/** Observe once per Scene, and release both event listeners with its last participant. */
export function acquireSceneFrameBudget(scene: ObservedScene, participant: object, eligible: () => boolean = () => true): SceneFrameBudgetLease {
  let owner = scenes.get(scene);
  if (!owner) {
    owner = new SceneBudget(scene);
    scenes.set(scene, owner);
  }
  owner.participants.set(participant, { eligible, stage: 0 });
  let released = false;
  return {
    frame: (frameNumber, idle) => new SceneFrameWork(owner.frame(frameNumber, idle), participant, owner),
    release: () => {
      if (released)
        return;
      released = true;
      owner.participants.delete(participant);
      if (owner.participants.size === 0) {
        owner.destroy();
        scenes.delete(scene);
      }
    },
  };
}
