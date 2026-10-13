import { Event } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireSceneFrameBudget, FRAME_CPU_TARGET_MS } from '../scene-frame-budget';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const scene = { preUpdate: new Event(), postRender: new Event() };
  return { scene, time: (value: number) => {
    now = value;
  } };
}

function renderFixture(prefix = 0) {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const scene = {
    _frameState: { frameNumber: 1, newFrame: undefined as boolean | undefined },
    preUpdate: new Event(),
    postUpdate: new Event(),
    postRender: new Event(),
    render(idle: boolean, operation: () => void, tail = 0, afterPasses?: () => void): string {
      scene.preUpdate.raiseEvent(scene);
      scene._frameState.newFrame = !idle;
      if (!idle)
        scene._frameState.frameNumber++;
      operation();
      scene.postUpdate.raiseEvent(scene);
      now += tail;
      afterPasses?.();
      if (!idle)
        scene.postRender.raiseEvent(scene);
      return 'complete';
    },
  };
  scene.preUpdate.addEventListener(() => now += prefix);
  return { scene, time: (value: number) => now = value, advance: (value: number) => now += value };
}

describe('shared idle Scene allowance', () => {
  it('reserves mandatory idle work that runs after postUpdate', async () => {
    const { scene, time, advance } = renderFixture();
    const owner = acquireSceneFrameBudget(scene, {});
    try {
      scene.render(true, () => {
        owner.frame(1, true);
        advance(2);
      }, 10);
      await Promise.resolve();
      time(100);
      scene.render(true, () => {
        const work = owner.frame(1, true);
        work.measure(() => advance(2));
        expect(work.tileBudget.exhausted).toBe(true);
      });
    }
    finally { owner.release(); }
  });

  it('leaves the host render method intact while owners acquire and release budgets', () => {
    const { scene } = renderFixture();
    const render = scene.render;
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    try {
      expect(scene.render).toBe(render);
    }
    finally {
      first.release();
      second.release();
    }
    expect(scene.render).toBe(render);
  });

  it('shares one physical tick across owners and renews it while the render frame number stays unchanged', async () => {
    const { scene, time } = renderFixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    let previous: ReturnType<typeof first.frame> | undefined;
    scene.render(true, () => {
      previous = first.frame(1, true);
      time(50);
      const stages = { upload: false, build: true, paint: false, placement: false };
      const quota = previous.continuation('build', stages)!;
      expect(quota.takeMinimumProgress?.()).toBe(true);
      expect(second.frame(1, true).continuation('build', stages)).toBeUndefined();
    });
    await Promise.resolve();
    time(100);
    scene.render(true, () => {
      const stages = { upload: false, build: true, paint: false, placement: false };
      expect(second.frame(1, true).continuation('build', stages)).toBeDefined();
      expect(first.frame(1, true).continuation('build', stages)).toBeUndefined();
    });
    first.release();
    second.release();
  });
});

describe('postPasses CPU preparation', () => {
  it('shares one fair preparation turn across eligible participants', () => {
    const { scene, time } = renderFixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    const hidden = acquireSceneFrameBudget(scene, {}, () => false);
    const prepared: string[] = [];
    for (const tick of [0, 100]) {
      time(tick);
      scene.render(false, () => first.frame(scene._frameState.frameNumber), 10, () => {
        expect(hidden.frame(scene._frameState.frameNumber).prepareAfterPasses(() => prepared.push('hidden'))).toBe(false);
        const a = first.frame(scene._frameState.frameNumber);
        const b = second.frame(scene._frameState.frameNumber);
        expect(b.prepareAfterPasses(() => prepared.push('second'))).toBe(tick === 100);
        expect(a.prepareAfterPasses(() => prepared.push('first'))).toBe(tick === 0);
        expect(a.prepareAfterPasses(() => prepared.push('repeat'))).toBe(false);
        expect(b.prepareAfterPasses(() => prepared.push('repeat'))).toBe(false);
      });
    }
    expect(prepared).toEqual(['first', 'second']);
    first.release();
    second.release();
    hidden.release();
  });
});

describe('complete scene preparation allowance', () => {
  it('charges running nested preparation once and shares it across owners', () => {
    const { scene, time, advance } = renderFixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    scene.render(false, () => first.frame(scene._frameState.frameNumber), 6);
    time(100);
    scene.render(false, () => {
      const work = first.frame(scene._frameState.frameNumber);
      advance(3);
      work.measure(() => {
        advance(3);
        second.frame(scene._frameState.frameNumber).measure(() => advance(3));
        expect(work.tileBudget.exhausted).toBe(false);
      });
      const shared = second.frame(scene._frameState.frameNumber);
      expect(shared.tileBudget.exhausted).toBe(false);
      shared.measure(() => {
        advance(FRAME_CPU_TARGET_MS - 7 - 2 - 6 + 0.01);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    }, 3);
    first.release();
    second.release();
  });

  it('caps preparation at the observed scene tick even when mandatory work exceeds its reserve', () => {
    const { scene, time, advance } = renderFixture(2);
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    scene.render(false, () => first.frame(scene._frameState.frameNumber));
    time(100);
    scene.render(false, () => {
      const work = first.frame(scene._frameState.frameNumber);
      // Public preUpdate observes the tick after earlier listeners. The body
      // spends 10ms; its elapsed time still caps both preparation stages.
      advance(10);
      work.measure(() => {
        advance(FRAME_CPU_TARGET_MS - 2 - 10 - 0.01);
        expect(work.tileBudget.exhausted).toBe(false);
        advance(0.02);
        expect(work.tileBudget.exhausted).toBe(true);
        expect(work.placementBudget.exhausted).toBe(false);
      });
      const shared = second.frame(scene._frameState.frameNumber);
      expect(shared.tileBudget.exhausted).toBe(true);
      advance(2);
      expect(shared.placementBudget.exhausted).toBe(true);
    });
    first.release();
    second.release();
  });

  it('shares one overload quota scaled to the measured mandatory P95 across participants', () => {
    const { scene, time } = fixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    [200, 210, 220, 230, 240, 250].forEach((mandatory, index) => {
      time(index * 1000);
      scene.preUpdate.raiseEvent();
      first.frame(index);
      time(index * 1000 + mandatory);
      scene.postRender.raiseEvent();
    });
    time(6000);
    scene.preUpdate.raiseEvent();
    const a = first.frame(6);
    const b = second.frame(6);
    const runnable = { upload: false, build: true, paint: false, placement: false };
    const quota = a.continuation('build', runnable)!;
    expect(quota).toBeDefined();
    expect(b.continuation('build', runnable)).toBeUndefined();
    expect(first.frame(6).continuation('build', runnable)).toBeUndefined();
    time(6012);
    expect(quota.exhausted).toBe(false);
    time(6012.5);
    expect(quota.exhausted).toBe(true);
    // Ordinary preparation still honestly reports mandatory overload.
    expect(a.tileBudget.exhausted).toBe(true);
    first.release();
    second.release();
  });

  it('rotates minimum upload/build and placement progress under mandatory overload', () => {
    const { scene, time } = fixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    const stages = { upload: true, build: true, paint: false, placement: true };
    const progress: string[] = [];
    for (let index = 0; index < 8; index++) {
      time(index * 100);
      scene.preUpdate.raiseEvent();
      const a = first.frame(index);
      const b = second.frame(index);
      time(index * 100 + 50);
      for (const [name, frame] of [['a', a], ['b', b]] as const) {
        for (const stage of ['upload', 'build', 'placement'] as const) {
          if (frame.continuation(stage, stages))
            progress.push(`${name}:${stage}`);
        }
        expect(frame.continuation('placement', stages)).toBeUndefined();
      }
      scene.postRender.raiseEvent();
    }
    expect(new Set(progress)).toEqual(new Set(['a:upload', 'b:upload', 'a:build', 'b:build', 'a:placement', 'b:placement']));
    first.release();
    second.release();
  });
});
