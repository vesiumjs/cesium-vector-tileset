import { afterEach, describe, expect, it, vi } from 'vitest';

import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { SymbolProjectionContext } from '../symbol-placement';
import { samePlacementParameters, SymbolPlacementScope } from '../symbol-placement-pass';

const view = { viewProjection: new Float64Array(16), width: 1000, height: 1000, pixelRatio: 1, cameraZoom: 10, orthographic: true, mercatorProjection: true, cameraToCenterDistance: undefined };
const batch = { geometry: { pairs: [] }, options: { pairs: [] } };

afterEach(() => vi.restoreAllMocks());

describe('prepared symbol scope adoption', () => {
  it('keeps a fixed recency deadline through continuous zoom and focus-distance changes', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const scope = new SymbolPlacementScope((a, b) => a === b, 300);
    const initial = { ...view, orthographic: false, cameraToCenterDistance: 100 };
    scope.prepare([batch]);
    expect(scope.advance(initial, UNBOUNDED_BUDGET, new SymbolProjectionContext())).toBeDefined();
    for (const time of [20, 40, 299]) {
      now = time;
      const current = { ...initial, cameraZoom: 10 + time / 1000, cameraToCenterDistance: 100 - time / 10 };
      expect(samePlacementParameters(initial, current)).toBe(false);
      expect(scope.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext())).toBeUndefined();
      expect(scope.pending).toBe(true);
      expect(scope.job).toBeUndefined();
      expect(scope.runnable).toBe(false);
      expect(scope.nextPlacementTime).toBe(300);
    }
    now = 300;
    const current = { ...initial, cameraZoom: 10.3, cameraToCenterDistance: 70 };
    expect(scope.runnable).toBe(true);
    const result = scope.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext());
    expect(result?.view.cameraZoom).toBe(10.3);
    expect(result?.view.cameraToCenterDistance).toBe(70);
    expect(scope.pending).toBe(false);
  });

  it('immediately catches up structural changes after adopting a frozen-view result', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const source = new SymbolPlacementScope((a, b) => a === b, 300);
    source.prepare([batch]);
    const prepared = source.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext())!;
    const visible = new SymbolPlacementScope((a, b) => a === b, 300);
    visible.prepare([batch]);
    const current = { ...view, pixelRatio: 2 };
    expect(visible.activate(prepared, current)).toBe(true);
    expect(visible.pending).toBe(true);
    expect(visible.runnable).toBe(true);
    expect(visible.nextPlacementTime).toBeUndefined();
    const caughtUp = visible.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext());
    expect(caughtUp?.view.pixelRatio).toBe(2);
    expect(visible.pending).toBe(false);
  });

  it('finishes an active frozen job before waiting for a zoom/distance catch-up', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const pairs = [{ text: -1, icon: -1 }, { text: -1, icon: -1 }];
    const scope = new SymbolPlacementScope((a, b) => a === b, 300);
    const initial = { ...view, orthographic: false, cameraToCenterDistance: 100 };
    scope.prepare([{ geometry: { pairs }, options: { pairs } }]);
    expect(scope.advance(initial, { exhausted: true }, new SymbolProjectionContext())).toBeUndefined();
    const frozen = scope.job;
    expect(frozen?.pass.done).toBe(false);
    now = 20;
    const current = { ...initial, cameraZoom: 11, cameraToCenterDistance: 50 };
    expect(scope.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext())).toBe(frozen);
    expect(frozen?.view.cameraZoom).toBe(10);
    expect(scope.pending).toBe(true);
    expect(scope.runnable).toBe(false);
    expect(scope.nextPlacementTime).toBe(320);
    now = 40;
    expect(scope.advance({ ...current, cameraZoom: 12 }, UNBOUNDED_BUDGET, new SymbolProjectionContext())).toBeUndefined();
    expect(scope.nextPlacementTime).toBe(320);
    now = 320;
    expect(scope.advance({ ...current, cameraZoom: 12 }, UNBOUNDED_BUDGET, new SymbolProjectionContext())?.view.cameraZoom).toBe(12);
  });

  it('makes new content urgent during recency while retaining an active frozen job', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const pairs = [{ text: -1, icon: -1 }, { text: -1, icon: -1 }];
    const first = { geometry: { pairs }, options: { pairs } };
    const second = { geometry: { pairs }, options: { pairs } };
    const third = { geometry: { pairs: [] }, options: { pairs: [] } };
    const scope = new SymbolPlacementScope((a, b) => a === b, 300);
    scope.prepare([first]);
    scope.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext());
    now = 20;
    scope.prepare([second]);
    expect(scope.runnable).toBe(true);
    expect(scope.nextPlacementTime).toBeUndefined();
    expect(scope.advance(view, { exhausted: true }, new SymbolProjectionContext())).toBeUndefined();
    const frozen = scope.job;
    expect(frozen?.pass.done).toBe(false);
    now = 30;
    scope.prepare([third]);
    expect(scope.job).toBe(frozen);
    expect(scope.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext())).toBe(frozen);
    expect(scope.isCurrent(frozen!)).toBe(false);
    expect(scope.runnable).toBe(true);
    expect(scope.nextPlacementTime).toBeUndefined();
    expect(scope.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext())?.batches).toEqual([third]);
    expect(scope.pending).toBe(false);
  });
});
