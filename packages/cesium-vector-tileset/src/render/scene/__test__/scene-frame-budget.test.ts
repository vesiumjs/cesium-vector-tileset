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

describe('complete idle Scene allowance', () => {
  it('shares one physical tick across owners and renews it while the render frame number stays unchanged', () => {
    const { scene, time } = renderFixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    let previous: ReturnType<typeof first.frame> | undefined;
    scene.render(true, () => {
      previous = first.frame(1);
      expect(second.frame(1).tileBudget).toBe(previous.tileBudget);
      time(50);
      const stages = { upload: false, build: true, paint: false, placement: false };
      const quota = previous.continuation('build', stages)!;
      expect(quota.takeMinimumProgress?.()).toBe(true);
      expect(second.frame(1).continuation('build', stages)).toBeUndefined();
    });
    time(100);
    scene.render(true, () => {
      expect(first.frame(1).tileBudget).not.toBe(previous!.tileBudget);
      expect(second.frame(1).tileBudget).toBe(first.frame(1).tileBudget);
      const stages = { upload: false, build: true, paint: false, placement: false };
      expect(second.frame(1).continuation('build', stages)).toBeDefined();
      expect(first.frame(1).continuation('build', stages)).toBeUndefined();
    });
    first.release();
    second.release();
  });

  it.each([true, false])('shares and never extends early preUpdate allowance after Native decides idle=%s', (idle) => {
    const { scene, time } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(true, () => lease.frame(scene._frameState.frameNumber), 1);
    scene.render(false, () => lease.frame(scene._frameState.frameNumber), 12);
    if (!idle)
      scene.render(true, () => lease.frame(scene._frameState.frameNumber), 1);
    let early: ReturnType<typeof lease.frame>;
    const remove = scene.preUpdate.addEventListener(() => {
      // Native has not reset newFrame or incremented frameNumber yet.
      early = lease.frame(scene._frameState.frameNumber);
    });
    time(100);
    scene.render(idle, () => {
      const decided = lease.frame(scene._frameState.frameNumber);
      decided.measure(() => {
        time(103);
        expect(decided.tileBudget.exhausted).toBe(true);
        expect(early.tileBudget.exhausted).toBe(true);
      });
      expect(decided.tileBudget).toBe(early.tileBudget);
      expect(decided.placementBudget).toBe(early.placementBudget);
    });
    remove();
    lease.release();
  });

  it('deducts an early work handle used in the tail after Native changes the frame number', () => {
    const { scene, time, advance } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(true, () => lease.frame(1));
    let early: ReturnType<typeof lease.frame>;
    const removeEarly = scene.preUpdate.addEventListener(() => early = lease.frame(scene._frameState.frameNumber));
    const removeTail = scene.postUpdate.addEventListener(() => early.measure(() => advance(2)));
    scene.render(false, () => {
      const decided = lease.frame(scene._frameState.frameNumber);
      decided.measure(() => advance(3));
    }, 3);
    removeEarly();
    removeTail();
    time(100);
    scene.render(false, () => {
      const next = lease.frame(scene._frameState.frameNumber);
      next.measure(() => {
        time(110);
        // Only the 3ms uncharged tail is mandatory, leaving 10.67ms of work.
        expect(next.tileBudget.exhausted).toBe(false);
        time(111);
        expect(next.tileBudget.exhausted).toBe(true);
      });
    });
    lease.release();
  });

  it('includes the early listener prefix and old-handle tail charge after Native decides to idle', () => {
    const { scene, time, advance } = renderFixture(5);
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(false, () => lease.frame(scene._frameState.frameNumber), 12);
    let early: ReturnType<typeof lease.frame>;
    const removeEarly = scene.preUpdate.addEventListener(() => early = lease.frame(scene._frameState.frameNumber));
    const removeTail = scene.postUpdate.addEventListener(() => early.measure(() => advance(2)));
    scene.render(true, () => {
      const decided = lease.frame(scene._frameState.frameNumber);
      decided.measure(() => advance(3));
    }, 3);
    removeEarly();
    removeTail();
    time(100);
    scene.render(true, () => {
      const next = lease.frame(scene._frameState.frameNumber);
      // The 5ms prefix and 3ms uncharged tail remain mandatory.
      next.measure(() => {
        time(110.5);
        expect(next.tileBudget.exhausted).toBe(false);
        time(111);
        expect(next.tileBudget.exhausted).toBe(true);
      });
    });
    lease.release();
  });

  it('reserves the full idle tail after postUpdate', () => {
    const { scene, time } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(true, () => lease.frame(1), 8);
    time(100);
    scene.render(true, () => {
      const work = lease.frame(1);
      work.measure(() => {
        time(105);
        expect(work.tileBudget.exhausted).toBe(false);
        time(106);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    });
    lease.release();
  });

  it('deducts preparation charged in the idle tail as well as the body', () => {
    const { scene, time, advance } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    let work: ReturnType<typeof lease.frame>;
    const remove = scene.postUpdate.addEventListener(() => work.measure(() => advance(2)));
    scene.render(true, () => {
      work = lease.frame(1);
      work.measure(() => advance(3));
    }, 3);
    remove();
    time(100);
    scene.render(true, () => {
      const next = lease.frame(1);
      next.measure(() => {
        time(110);
        expect(next.tileBudget.exhausted).toBe(false);
        time(111);
        expect(next.tileBudget.exhausted).toBe(true);
      });
    });
    lease.release();
  });

  it('includes listeners registered before the budget observer in both deadline and idle reserve', () => {
    const { scene, time } = renderFixture(5);
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(true, () => {
      const work = lease.frame(1);
      work.measure(() => {
        time(11.2);
        expect(work.tileBudget.exhausted).toBe(false);
        time(11.4);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    }, 3);
    time(100);
    scene.render(true, () => {
      const work = lease.frame(1);
      // The 5ms prefix and 3ms tail are reserved once, leaving 5.67ms work.
      expect(work.tileBudget.exhausted).toBe(false);
      work.measure(() => {
        time(110.6);
        expect(work.tileBudget.exhausted).toBe(false);
        time(110.7);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    });
    lease.release();
  });

  it.each(['host-wrapper', 'old-bound-wrapper', 'native-bound-alias', 'unwrapped-hooks'] as const)('uses render reserve after %s bypasses complete-call observation', (kind) => {
    const { scene, time } = renderFixture();
    const native = scene.render.bind(scene);
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(true, () => lease.frame(1), 1);
    const wrapped = scene.render.bind(scene);
    time(100);
    const operation = (): void => {
      const work = lease.frame(1);
      work.measure(() => {
        time(107);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    };
    if (kind === 'host-wrapper') {
      scene.render = (...args) => wrapped(...args);
      scene.render(true, operation);
    }
    else if (kind === 'old-bound-wrapper') {
      scene.render = native;
      wrapped(true, operation);
    }
    else if (kind === 'native-bound-alias') {
      native(true, operation);
    }
    else {
      scene.preUpdate.raiseEvent(scene);
      operation();
    }
    lease.release();
  });

  it.each(['exception', 'reentry', 'frame-state', 'frame-number', 'tick', 'method'] as const)('rejects an idle sample invalidated by %s', (kind) => {
    const { scene, time, advance } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const wrapped = scene.render;
    const operation = (): void => {
      lease.frame(scene._frameState.frameNumber);
      advance(1);
      if (kind === 'exception')
        throw new Error('native failure');
      if (kind === 'reentry')
        scene.render(true, () => lease.frame(1));
      if (kind === 'frame-state')
        scene._frameState = { ...scene._frameState };
      if (kind === 'frame-number')
        scene._frameState.frameNumber++;
      if (kind === 'tick')
        scene.preUpdate.raiseEvent(scene);
      if (kind === 'method')
        scene.render = (...args) => Reflect.apply(wrapped, scene, args);
    };
    if (kind === 'exception')
      expect(() => scene.render(true, operation)).toThrow('native failure');
    else
      expect(scene.render(true, operation)).toBe('complete');
    // Restore our still-live wrapper after method invalidation to verify its
    // rejected call did not seed a permissive idle estimate.
    scene.render = wrapped;
    time(100);
    scene.render(true, () => {
      const work = lease.frame(scene._frameState.frameNumber);
      work.measure(() => {
        time(107);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    });
    lease.release();
  });

  it.each([{ configurable: false, writable: true }, { configurable: true, writable: false }])('leaves unsupported render descriptors unchanged: %j', (flags) => {
    const { scene, time } = renderFixture();
    Object.defineProperty(scene, 'render', { ...flags, value: scene.render, enumerable: true });
    const descriptor = Object.getOwnPropertyDescriptor(scene, 'render');
    const lease = acquireSceneFrameBudget(scene, {});
    expect(Object.getOwnPropertyDescriptor(scene, 'render')).toEqual(descriptor);
    scene.render(true, () => lease.frame(1), 1);
    time(100);
    scene.render(true, () => {
      const work = lease.frame(1);
      work.measure(() => {
        time(107);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    });
    expect(() => lease.release()).not.toThrow();
    expect(Object.getOwnPropertyDescriptor(scene, 'render')).toEqual(descriptor);
  });

  it('requires both observation hooks and an explicit Native idle flag', () => {
    const { scene, time } = renderFixture();
    Reflect.deleteProperty(scene, 'postRender');
    const original = scene.render;
    const lease = acquireSceneFrameBudget(scene, {});
    expect(scene.render).toBe(original);
    scene.render(true, () => lease.frame(1), 1);
    time(100);
    scene.render(true, () => {
      const work = lease.frame(1);
      work.measure(() => {
        time(107);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    });
    lease.release();
    const unknown = renderFixture();
    const observer = acquireSceneFrameBudget(unknown.scene, {});
    unknown.scene.render(true, () => {
      unknown.scene._frameState.newFrame = undefined;
      observer.frame(1);
    }, 1);
    unknown.time(100);
    unknown.scene.render(true, () => {
      const work = observer.frame(1);
      work.measure(() => {
        unknown.time(107);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    });
    observer.release();
  });

  it('charges nested preparation once when measuring the complete idle call', () => {
    const { scene, time, advance } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(true, () => {
      const work = lease.frame(1);
      work.measure(() => work.measure(() => advance(1)));
    });
    time(100);
    scene.render(true, () => {
      const work = lease.frame(1);
      work.measure(() => {
        time(113);
        expect(work.tileBudget.exhausted).toBe(false);
        time(114);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    });
    lease.release();
  });

  it('keeps one minimum token when method ownership changes during the same physical tick', () => {
    const { scene, time } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const wrapped = scene.render;
    scene.render(true, () => {
      time(50);
      const stages = { upload: false, build: true, paint: false, placement: false };
      expect(lease.frame(1).continuation('build', stages)).toBeDefined();
      scene.render = (...args) => Reflect.apply(wrapped, scene, args);
      expect(lease.frame(1).continuation('build', stages)).toBeUndefined();
    });
    lease.release();
  });

  it('shares the minimum token when an older work handle consumes it after method ownership changes', () => {
    const { scene, time } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const wrapped = scene.render;
    scene.render(true, () => {
      const early = lease.frame(1);
      scene.render = (...args) => Reflect.apply(wrapped, scene, args);
      const decided = lease.frame(1);
      time(50);
      const stages = { upload: false, build: true, paint: false, placement: false };
      expect(early.continuation('build', stages)).toBeDefined();
      expect(decided.continuation('build', stages)).toBeUndefined();
    });
    lease.release();
  });

  it('tightens existing idle handles to render reserve after method ownership changes', () => {
    const { scene, time } = renderFixture(5);
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(true, () => lease.frame(scene._frameState.frameNumber), 1);
    scene.render(false, () => lease.frame(scene._frameState.frameNumber), 12);
    const wrapped = scene.render;
    time(100);
    scene.render(true, () => {
      const early = lease.frame(scene._frameState.frameNumber);
      early.measure(() => {
        time(106);
        expect(early.tileBudget.exhausted).toBe(false);
        scene.render = (...args) => Reflect.apply(wrapped, scene, args);
        const fallback = lease.frame(scene._frameState.frameNumber);
        time(107);
        expect(fallback.tileBudget.exhausted).toBe(true);
        expect(early.tileBudget.exhausted).toBe(true);
        expect(fallback.tileBudget).toBe(early.tileBudget);
      });
    });
    lease.release();
  });

  it('restores the exact own descriptor only after the last participant releases', () => {
    const { scene } = renderFixture();
    Object.defineProperty(scene, 'render', { value: scene.render, configurable: true, writable: true, enumerable: false });
    const descriptor = Object.getOwnPropertyDescriptor(scene, 'render');
    const keys = Object.keys(scene);
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    const wrapped = scene.render;
    first.release();
    expect(scene.render).toBe(wrapped);
    expect(scene.render(true, () => second.release(), 1)).toBe('complete');
    expect(Object.getOwnPropertyDescriptor(scene, 'render')).toEqual(descriptor);
    expect(Object.keys(scene)).toEqual(keys);
    expect(scene.preUpdate.numberOfListeners).toBe(1);
    expect(scene.postRender.numberOfListeners).toBe(0);
  });

  it('restores inheritance and preserves a subsequently installed host method', () => {
    const { scene } = renderFixture();
    const original = scene.render;
    Reflect.deleteProperty(scene, 'render');
    Object.setPrototypeOf(scene, { render: original });
    const first = acquireSceneFrameBudget(scene, {});
    expect(Object.hasOwn(scene, 'render')).toBe(true);
    first.release();
    expect(Object.hasOwn(scene, 'render')).toBe(false);
    const second = acquireSceneFrameBudget(scene, {});
    const host = () => 'host';
    scene.render = host;
    second.release();
    expect(scene.render).toBe(host);
  });

  it('forwards the dynamic receiver, original arguments and exceptions through the render wrapper', () => {
    const failure = new Error('native failure');
    const firstArgument = {};
    const secondArgument = {};
    const scene = {
      preUpdate: new Event(),
      postRender: new Event(),
      label: 'scene',
      render(this: { label: string }, first: object, second: object): string {
        if (first === failure)
          throw failure;
        expect(first).toBe(firstArgument);
        expect(second).toBe(secondArgument);
        return this.label;
      },
    };
    const lease = acquireSceneFrameBudget(scene, {});
    const wrapped = scene.render;
    expect(scene.render(firstArgument, secondArgument)).toBe('scene');
    expect(Reflect.apply(wrapped, { label: 'other' }, [firstArgument, secondArgument])).toBe('other');
    expect(() => scene.render(failure, secondArgument)).toThrow(failure);
    lease.release();
    expect(Reflect.apply(wrapped, { label: 'released' }, [firstArgument, secondArgument])).toBe('released');
  });

  it('keeps real render reserve and idle reserve independent in both directions', () => {
    const { scene, time, advance } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(false, () => lease.frame(scene._frameState.frameNumber), 12);
    time(100);
    scene.render(true, () => {
      const work = lease.frame(scene._frameState.frameNumber);
      work.measure(() => {
        advance(2);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    });
    time(200);
    scene.render(true, () => {
      const work = lease.frame(scene._frameState.frameNumber);
      work.measure(() => {
        advance(8);
        expect(work.tileBudget.exhausted).toBe(false);
      });
    });
    time(300);
    scene.render(false, () => {
      const work = lease.frame(scene._frameState.frameNumber);
      work.measure(() => {
        advance(2);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    }, 10);
    time(400);
    scene.render(true, () => {
      const work = lease.frame(scene._frameState.frameNumber);
      work.measure(() => {
        advance(5);
        expect(work.tileBudget.exhausted).toBe(false);
      });
    });
    lease.release();
  });
});

describe('postPasses CPU preparation', () => {
  it('uses only the remaining physical frame time after drawing, without reserving mandatory work again', () => {
    const { scene, time } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    let work: ReturnType<typeof lease.frame>;
    const preparation = vi.fn();
    scene.render(false, () => {
      work = lease.frame(scene._frameState.frameNumber);
      time(12);
      expect(work.tileBudget.exhausted).toBe(false);
    }, 0, () => {
      expect(work.prepareAfterPasses((budget) => {
        preparation();
        expect(budget.takeMinimumProgress).toBeUndefined();
        expect(budget.exhausted).toBe(false);
        time(FRAME_CPU_TARGET_MS - 1);
        expect(budget.exhausted).toBe(true);
      })).toBe(true);
      expect(work.prepareAfterPasses(preparation)).toBe(false);
    });
    expect(preparation).toHaveBeenCalledOnce();
    lease.release();
  });

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

  it('excludes measured postPasses CPU from the next mandatory reserve without double-charging nested work', () => {
    const { scene, time, advance } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    let work: ReturnType<typeof lease.frame>;
    scene.render(false, () => {
      work = lease.frame(scene._frameState.frameNumber);
      work.measure(() => advance(2));
    }, 10, () => {
      expect(work.prepareAfterPasses(() => work.measure(() => advance(3)))).toBe(true);
    });
    time(100);
    scene.render(false, () => {
      const next = lease.frame(scene._frameState.frameNumber);
      next.measure(() => {
        time(103.5);
        expect(next.tileBudget.exhausted).toBe(false);
        time(103.7);
        expect(next.tileBudget.exhausted).toBe(true);
      });
    });
    lease.release();
  });

  it.each(['idle', 'expired', 'outside-render', 'reentry', 'frame-state', 'frame-number', 'tick', 'method', 'ineligible'] as const)('rejects postPasses preparation for %s', (kind) => {
    const { scene, time } = renderFixture();
    let eligible = true;
    const lease = acquireSceneFrameBudget(scene, {}, () => eligible);
    let work: ReturnType<typeof lease.frame>;
    const prepare = vi.fn();
    scene.render(kind === 'idle', () => {
      work = lease.frame(scene._frameState.frameNumber);
      if (kind === 'expired')
        time(FRAME_CPU_TARGET_MS - 1);
      if (kind === 'reentry')
        scene.render(false, () => lease.frame(scene._frameState.frameNumber));
      if (kind === 'frame-state')
        scene._frameState = { ...scene._frameState };
      if (kind === 'frame-number')
        scene._frameState.frameNumber++;
      if (kind === 'tick')
        scene.preUpdate.raiseEvent(scene);
      if (kind === 'method') {
        const original = scene.render;
        scene.render = (...args) => Reflect.apply(original, scene, args);
      }
      if (kind === 'ineligible')
        eligible = false;
    }, 0, () => {
      if (kind !== 'outside-render')
        expect(work.prepareAfterPasses(prepare)).toBe(false);
    });
    expect(work.prepareAfterPasses(prepare)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    lease.release();
  });
});

describe('complete scene preparation allowance', () => {
  it('charges mandatory preamble once while reserving the remaining Scene work', () => {
    const { scene, time, advance } = renderFixture();
    const lease = acquireSceneFrameBudget(scene, {});
    // Six milliseconds before preparation and three after it are mandatory.
    scene.render(false, () => {
      lease.frame(scene._frameState.frameNumber);
      advance(6);
    }, 3);
    time(100);
    scene.render(false, () => {
      const work = lease.frame(scene._frameState.frameNumber);
      advance(6);
      // The whole-frame reserve is 9ms + 1ms margin. The elapsed preamble
      // has already consumed 6ms of that reserve, not deferred allowance.
      expect(work.tileBudget.exhausted).toBe(false);
      work.measure(() => {
        advance(FRAME_CPU_TARGET_MS - 10 - 2 - 0.01);
        expect(work.tileBudget.exhausted).toBe(false);
        advance(0.02);
        expect(work.tileBudget.exhausted).toBe(true);
        expect(work.placementBudget.exhausted).toBe(false);
      });
    }, 3);
    lease.release();
  });

  it('includes earlier preUpdate listeners in the real Scene reserve and hard cap', () => {
    const { scene, time, advance } = renderFixture(6);
    const lease = acquireSceneFrameBudget(scene, {});
    scene.render(false, () => lease.frame(scene._frameState.frameNumber), 3);
    time(100);
    scene.render(false, () => {
      const work = lease.frame(scene._frameState.frameNumber);
      // The full Scene mandatory cost is prefix 6 + tail 3, plus margin 1.
      work.measure(() => {
        advance(FRAME_CPU_TARGET_MS - 10 - 2 - 0.01);
        expect(work.tileBudget.exhausted).toBe(false);
        advance(0.02);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    }, 3);
    lease.release();
  });

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
      expect(shared.tileBudget).toBe(work.tileBudget);
      expect(shared.tileBudget.exhausted).toBe(false);
      shared.measure(() => {
        advance(FRAME_CPU_TARGET_MS - 7 - 2 - 6 + 0.01);
        expect(work.tileBudget.exhausted).toBe(true);
      });
    }, 3);
    first.release();
    second.release();
  });

  it('caps preparation at the physical tick even when mandatory work exceeds its reserve', () => {
    const { scene, time, advance } = renderFixture(2);
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    scene.render(false, () => first.frame(scene._frameState.frameNumber));
    time(100);
    scene.render(false, () => {
      const work = first.frame(scene._frameState.frameNumber);
      // The trained reserve is 3ms. The early prefix and body spent 12ms.
      advance(10);
      work.measure(() => {
        advance(FRAME_CPU_TARGET_MS - 2 - 12 - 0.01);
        expect(work.tileBudget.exhausted).toBe(false);
        advance(0.02);
        expect(work.tileBudget.exhausted).toBe(true);
        expect(work.placementBudget.exhausted).toBe(false);
      });
      const shared = second.frame(scene._frameState.frameNumber);
      expect(shared.tileBudget).toBe(work.tileBudget);
      expect(shared.tileBudget.exhausted).toBe(true);
      advance(2);
      expect(shared.placementBudget.exhausted).toBe(true);
    });
    first.release();
    second.release();
  });

  it('starts and measures a continuation when its deferred stage actually runs', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const stages = { upload: false, build: false, paint: false, placement: true };
    scene.preUpdate.raiseEvent();
    const work = lease.frame(1);
    // The stage's mandatory preamble finished three milliseconds after the
    // original physical deadline was already spent.
    time(53);
    work.run('placement', stages, (quota) => {
      expect(quota.takeMinimumProgress?.()).toBe(true);
      expect(quota.takeMinimumProgress?.()).toBe(false);
      time(54.9);
      expect(quota.exhausted).toBe(false);
      time(55);
      expect(quota.exhausted).toBe(true);
    });
    scene.postRender.raiseEvent();
    time(100);
    scene.preUpdate.raiseEvent();
    const next = lease.frame(2);
    next.run('placement', stages, (quota) => {
      time(102.64);
      expect(quota.exhausted).toBe(false);
      time(102.66);
      expect(quota.exhausted).toBe(true);
    });
    lease.release();
  });

  it('passes a continuation floor through the actual stage runner and charges its measured work once', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const stages = { upload: false, build: true, paint: false, placement: false };
    scene.preUpdate.raiseEvent();
    const work = lease.frame(1);
    time(50);
    work.run('build', stages, (quota) => {
      expect(quota.takeMinimumProgress?.()).toBe(true);
      expect(quota.takeMinimumProgress?.()).toBe(false);
      time(61);
      expect(quota.exhausted).toBe(false);
      time(62);
      expect(quota.exhausted).toBe(true);
    }, 12);
    // Mandatory charge is 62 - 12 = 50ms. Its continuation is therefore
    // 50 * 0.05 = 2.5ms, even though the previous run requested 12ms.
    scene.postRender.raiseEvent();
    time(100);
    scene.preUpdate.raiseEvent();
    const next = lease.frame(2);
    next.run('build', stages, (quota) => {
      time(102.49);
      expect(quota.exhausted).toBe(false);
      time(102.5);
      expect(quota.exhausted).toBe(true);
    });
    lease.release();
  });

  it('keeps the original normal placement deadline inside the deferred stage runner', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const stages = { upload: false, build: false, paint: false, placement: true };
    scene.preUpdate.raiseEvent();
    const work = lease.frame(1);
    work.measure(() => time(7));
    work.run('placement', stages, (budget) => {
      expect(budget).toBe(work.placementBudget);
      expect(budget.takeMinimumProgress).toBeUndefined();
      time(9);
      expect(budget.exhausted).toBe(true);
    });
    lease.release();
  });

  it('keeps placement on its original deadline while tile work is already spent', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const stages = { upload: false, build: false, paint: false, placement: true };
    scene.preUpdate.raiseEvent();
    const work = lease.frame(1);
    work.measure(() => time(7));
    expect(work.tileBudget.exhausted).toBe(true);
    const placement = work.continuation('placement', stages)!;
    expect(placement).toBe(work.placementBudget);
    expect(placement.takeMinimumProgress).toBeUndefined();
    work.measure(() => {
      time(9);
      expect(placement.exhausted).toBe(true);
    });
    lease.release();
  });

  it('shares the selected placement quota and its first-unit admission across physical Scene owners', () => {
    const { scene, time } = fixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    const stages = { upload: false, build: false, paint: false, placement: true };
    scene.preUpdate.raiseEvent();
    const a = first.frame(1);
    const b = second.frame(1);
    time(50);
    const quota = a.continuation('placement', stages)!;
    expect(quota.takeMinimumProgress?.()).toBe(true);
    expect(quota.takeMinimumProgress?.()).toBe(false);
    expect(a.continuation('placement', stages)).toBeUndefined();
    expect(b.continuation('placement', stages)).toBeUndefined();
    time(51.9);
    expect(quota.exhausted).toBe(false);
    time(52);
    expect(quota.exhausted).toBe(true);
    first.release();
    second.release();
  });

  it('does not add a placement quota after another stage consumes the Scene continuation', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const stages = { upload: true, build: false, paint: false, placement: true };
    scene.preUpdate.raiseEvent();
    const work = lease.frame(1);
    time(50);
    expect(work.continuation('upload', stages)).toBeDefined();
    expect(work.continuation('placement', stages)).toBeUndefined();
    lease.release();
  });

  it('shares one deadline and progress grant across owners and viewports', () => {
    const { scene, time } = fixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    scene.preUpdate.raiseEvent();
    const frame = first.frame(1);
    expect(second.frame(1).tileBudget).toBe(frame.tileBudget);
    time(50);
    expect(frame.tileBudget.exhausted).toBe(true);
    expect(first.frame(1).tileBudget.exhausted).toBe(true);
    const stages = { upload: true, build: true, paint: false, placement: true };
    const minimum = first.frame(1).continuation('upload', stages)!;
    expect(minimum.takeMinimumProgress?.()).toBe(true);
    expect(minimum.takeMinimumProgress?.()).toBe(false);
    expect(first.frame(1).continuation('build', stages)).toBeUndefined();
    expect(second.frame(1).continuation('upload', stages)).toBeUndefined();
    first.release();
    second.release();
    expect(scene.preUpdate.numberOfListeners).toBe(0);
    expect(scene.postRender.numberOfListeners).toBe(0);
  });

  it('uses the Scene event boundary when a caller omits its frame number', () => {
    const { scene, time } = fixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    scene.preUpdate.raiseEvent();
    const frame = first.frame();
    time(50);
    expect(second.frame().tileBudget).toBe(frame.tileBudget);
    expect(first.frame().tileBudget.exhausted).toBe(true);
    scene.postRender.raiseEvent();
    time(100);
    scene.preUpdate.raiseEvent();
    expect(first.frame().tileBudget).not.toBe(frame.tileBudget);
    first.release();
    second.release();
  });

  it.each([undefined, 12])('applies the requested continuation floor %s only after admission', (minimumMs) => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const stages = { upload: false, build: true, paint: false, placement: false };
    scene.preUpdate.raiseEvent();
    const work = lease.frame(1);
    time(50);
    const quota = work.continuation('build', stages, minimumMs)!;
    expect(quota.takeMinimumProgress?.()).toBe(true);
    expect(quota.takeMinimumProgress?.()).toBe(false);
    time(51.9);
    expect(quota.exhausted).toBe(false);
    time(52);
    expect(quota.exhausted).toBe(minimumMs === undefined);
    time(61);
    expect(quota.exhausted).toBe(minimumMs === undefined);
    time(62);
    expect(quota.exhausted).toBe(true);
    lease.release();
  });

  it('shares the floored continuation admission across participants, stages and repeated callbacks', () => {
    const { scene, time } = fixture();
    const first = acquireSceneFrameBudget(scene, {});
    const second = acquireSceneFrameBudget(scene, {});
    const stages = { upload: true, build: true, paint: false, placement: true };
    scene.preUpdate.raiseEvent();
    const work = first.frame(1);
    time(50);
    expect(second.frame(1).continuation('upload', stages, 12)).toBeUndefined();
    expect(work.continuation('build', stages, 12)).toBeUndefined();
    expect(work.continuation('paint', stages, 12)).toBeUndefined();
    const quota = work.continuation('upload', stages, 12)!;
    expect(quota.takeMinimumProgress?.()).toBe(true);
    expect(quota.takeMinimumProgress?.()).toBe(false);
    expect(work.continuation('build', stages, 12)).toBeUndefined();
    expect(work.continuation('placement', stages, 12)).toBeUndefined();
    expect(first.frame(1).continuation('upload', stages, 12)).toBeUndefined();
    expect(second.frame(1).continuation('upload', stages, 12)).toBeUndefined();
    first.release();
    second.release();
  });

  it('keeps the ordinary tile allowance and deadline when a continuation floor is requested', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const stages = { upload: false, build: true, paint: false, placement: false };
    scene.preUpdate.raiseEvent();
    const work = lease.frame(1);
    const quota = work.continuation('build', stages, 12)!;
    expect(quota).toBe(work.tileBudget);
    expect(quota.takeMinimumProgress).toBeUndefined();
    work.measure(() => {
      time(6);
      expect(quota.exhausted).toBe(false);
      time(7);
      expect(quota.exhausted).toBe(true);
    });
    lease.release();
  });

  it('gives overload preparation a shared two millisecond quota', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    scene.preUpdate.raiseEvent();
    const work = lease.frame(1);
    time(50);
    const stages = { upload: false, build: true, paint: false, placement: false };
    const quota = work.continuation('build', stages)!;
    time(51.5);
    expect(quota.exhausted).toBe(false);
    time(52);
    expect(quota.exhausted).toBe(true);
    expect(work.continuation('build', stages)).toBeUndefined();
    lease.release();
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

  it('caps overload preparation at one frame target under severe mandatory cost', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    scene.preUpdate.raiseEvent();
    lease.frame(0);
    time(1000);
    scene.postRender.raiseEvent();
    time(2000);
    scene.preUpdate.raiseEvent();
    const work = lease.frame(1);
    const quota = work.continuation('build', { upload: false, build: true, paint: false, placement: false })!;
    time(2016);
    expect(quota.exhausted).toBe(false);
    time(2017);
    expect(quota.exhausted).toBe(true);
    lease.release();
  });

  it('rotates only runnable stages without giving empty stages extra upload turns', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    const stages = { upload: true, build: true, paint: false, placement: false };
    const counts = { upload: 0, build: 0 };
    for (let index = 0; index < 8; index++) {
      time(index * 100);
      scene.preUpdate.raiseEvent();
      const work = lease.frame(index);
      time(index * 100 + 50);
      for (const stage of ['upload', 'build'] as const) {
        if (work.continuation(stage, stages))
          counts[stage]++;
      }
    }
    expect(counts).toEqual({ upload: 4, build: 4 });
    lease.release();
  });

  it('keeps observing hidden and unready participants without spending their overload turns', () => {
    const { scene, time } = fixture();
    let shown = false;
    let ready = false;
    const hidden = acquireSceneFrameBudget(scene, {}, () => shown && ready);
    const active = acquireSceneFrameBudget(scene, {});
    const stages = { upload: false, build: true, paint: false, placement: false };
    for (let index = 0; index < 3; index++) {
      time(index * 100);
      scene.preUpdate.raiseEvent();
      const work = active.frame(index);
      time(index * 100 + 50);
      expect(work.continuation('build', stages)).toBeDefined();
      if (index === 0)
        shown = true;
    }
    ready = true;
    const turns = [0, 0];
    for (let index = 3; index < 7; index++) {
      time(index * 100);
      scene.preUpdate.raiseEvent();
      const work = [hidden.frame(index), active.frame(index)];
      time(index * 100 + 50);
      work.forEach((frame, owner) => {
        if (frame.continuation('build', stages))
          turns[owner]++;
      });
    }
    expect(turns).toEqual([2, 2]);
    hidden.release();
    expect(scene.preUpdate.numberOfListeners).toBe(1);
    active.release();
    expect(scene.preUpdate.numberOfListeners).toBe(0);
  });

  it('returns time when the rolling mandatory P95 recovers from cold startup', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    scene.preUpdate.raiseEvent();
    lease.frame(0);
    time(100);
    scene.postRender.raiseEvent();
    for (let index = 1; index <= 32; index++) {
      time(index * 1000);
      scene.preUpdate.raiseEvent();
      lease.frame(index);
      time(index * 1000 + 5);
      scene.postRender.raiseEvent();
    }
    time(33000);
    scene.preUpdate.raiseEvent();
    const recovered = lease.frame(33);
    time(33001);
    expect(recovered.tileBudget.exhausted).toBe(false);
    lease.release();
  });

  it('reserves measured mandatory Scene CPU while excluding preparation', () => {
    const { scene, time } = fixture();
    const lease = acquireSceneFrameBudget(scene, {});
    scene.preUpdate.raiseEvent();
    const frame = lease.frame(1);
    frame.measure(() => time(4));
    time(15);
    scene.postRender.raiseEvent();
    time(20);
    scene.preUpdate.raiseEvent();
    const next = lease.frame(2);
    // Eleven milliseconds of mandatory CPU plus a one millisecond margin.
    next.measure(() => {
      time(20 + FRAME_CPU_TARGET_MS - 12 - 2 + 0.01);
      expect(next.tileBudget.exhausted).toBe(true);
      expect(next.placementBudget.exhausted).toBe(false);
    });
    lease.release();
  });

  it('ignores another Scene and mismatched frame samples', () => {
    const { scene, time } = fixture();
    const state = { frameNumber: 1 };
    Object.assign(scene, { _frameState: state });
    const lease = acquireSceneFrameBudget(scene, {});
    scene.preUpdate.raiseEvent(scene);
    lease.frame(1);
    time(100);
    scene.postRender.raiseEvent({});
    state.frameNumber = 2;
    scene.postRender.raiseEvent(scene);
    time(200);
    scene.preUpdate.raiseEvent(scene);
    state.frameNumber = 3;
    const next = lease.frame(3);
    time(201);
    expect(next.tileBudget.exhausted).toBe(false);
    lease.release();
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
