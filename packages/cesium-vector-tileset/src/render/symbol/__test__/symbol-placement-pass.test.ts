import type { PlacementView } from '../symbol-placement';
import { afterEach, describe, expect, it, vi } from 'vitest';
/* eslint-disable antfu/no-import-node-modules-by-path -- Installed MapLibre placement is the independent recency oracle. */
import { MercatorTransform } from '../../../../../../node_modules/maplibre-gl/src/geo/projection/mercator_transform';
import { Placement } from '../../../../../../node_modules/maplibre-gl/src/symbol/placement';
/* eslint-enable antfu/no-import-node-modules-by-path */
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { SymbolProjectionContext } from '../symbol-placement';
import { samePlacementParameters, SymbolPlacementScope } from '../symbol-placement-pass';

const view = { viewProjection: new Float64Array(16), width: 1000, height: 1000, pixelRatio: 1, cameraZoom: 10, orthographic: true, mercatorProjection: true, cameraToCenterDistance: undefined };
const batch = { geometry: { pairs: [] }, options: { pairs: [] } };

afterEach(() => vi.restoreAllMocks());

describe('prepared symbol scope adoption', () => {
  it.each([0.5, 1, 2, -1])('matches MapLibre placement recency after a stopped zoom-out of %s levels', (delta) => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const transform = new MercatorTransform({ maxZoom: 24 });
    transform.resize(view.width, view.height);
    transform.setZoom(view.cameraZoom);
    const oracle = new Placement(transform, undefined as never, 300, true);
    oracle.commit(now);
    const scope = new SymbolPlacementScope((a, b) => a === b, 300);
    scope.prepare([batch]);
    scope.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext());
    const stopped = { ...view, cameraZoom: view.cameraZoom - delta };
    const deadline = Math.max(40, 300 * (1 - Math.max(0, delta / 1.5)));
    for (const time of [20, 40, deadline - 0.01, deadline]) {
      now = time;
      const recent = oracle.stillRecent(now, stopped.cameraZoom);
      const result = scope.advance(stopped, UNBOUNDED_BUDGET, new SymbolProjectionContext());
      expect(result !== undefined, `zoom delta ${delta} at ${time}ms`).toBe(!recent);
      if (result)
        break;
    }
    expect(scope.pending).toBe(false);
    expect(scope.complete?.view.cameraZoom).toBe(stopped.cameraZoom);
  });

  it('preserves MapLibre recency while zoom-out is still moving', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const transform = new MercatorTransform({ maxZoom: 24 });
    transform.resize(view.width, view.height);
    transform.setZoom(view.cameraZoom);
    const oracle = new Placement(transform, undefined as never, 300, true);
    oracle.commit(now);
    const scope = new SymbolPlacementScope((a, b) => a === b, 300);
    scope.prepare([batch]);
    scope.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext());
    for (const time of [20, 40, 100, 200, 299, 300]) {
      now = time;
      const current = { ...view, cameraZoom: 10 - time / 100 };
      const recent = oracle.stillRecent(now, current.cameraZoom);
      expect(scope.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext()) !== undefined).toBe(!recent);
    }
  });

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

  it('keeps zoom and focus-distance adoption stale until the fixed recency deadline', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const source = new SymbolPlacementScope((a, b) => a === b, 300);
    const initial = { ...view, orthographic: false, cameraToCenterDistance: 100 };
    source.prepare([batch]);
    const prepared = source.advance(initial, UNBOUNDED_BUDGET, new SymbolProjectionContext())!;
    const visible = new SymbolPlacementScope((a, b) => a === b, 300);
    visible.prepare([batch]);
    now = 20;
    const current = { ...initial, cameraZoom: 11, cameraToCenterDistance: 50 };
    expect(visible.activate(prepared, current)).toBe(true);
    expect(visible.pending).toBe(true);
    expect(visible.runnable).toBe(false);
    expect(visible.nextPlacementTime).toBe(320);
    expect(visible.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext())).toBeUndefined();
    now = 320;
    expect(visible.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext())?.view).toMatchObject({ cameraZoom: 11, cameraToCenterDistance: 50 });
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

  it('preserves recency and catch-up for a matrix-only camera change', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const source = new SymbolPlacementScope((a, b) => a === b, 300);
    source.prepare([batch]);
    const prepared = source.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext())!;
    const visible = new SymbolPlacementScope((a, b) => a === b, 300);
    visible.prepare([batch]);
    const projection = new Float64Array(view.viewProjection);
    projection[12] = 1;
    const current = { ...view, viewProjection: projection };
    expect(visible.activate(prepared, current)).toBe(true);
    expect(visible.pending).toBe(true);
    expect(visible.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext())).toBeUndefined();
    expect(visible.job).toBeUndefined();
    expect(visible.runnable).toBe(false);
    expect(visible.nextPlacementTime).toBe(300);
    now = 20;
    expect(visible.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext())).toBeUndefined();
    expect(visible.pending).toBe(true);
    expect(visible.job).toBeUndefined();
    expect(visible.runnable).toBe(false);
    expect(visible.nextPlacementTime).toBe(300);
    now = 300;
    expect(visible.runnable).toBe(true);
    expect(visible.nextPlacementTime).toBeUndefined();
    expect(visible.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext())?.view.viewProjection[12]).toBe(1);
    expect(visible.pending).toBe(false);
    expect(visible.runnable).toBe(false);
    expect(visible.nextPlacementTime).toBeUndefined();
  });

  it('does not schedule another pass for an exact-view adoption', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const source = new SymbolPlacementScope((a, b) => a === b, 300);
    source.prepare([batch]);
    const prepared = source.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext())!;
    const visible = new SymbolPlacementScope((a, b) => a === b, 300);
    visible.prepare([batch]);
    expect(visible.activate(prepared, view)).toBe(true);
    expect(visible.pending).toBe(false);
    expect(visible.advance(view, UNBOUNDED_BUDGET, new SymbolProjectionContext())).toBeUndefined();
  });

  const structuralChanges: Array<[string, Partial<PlacementView>, Partial<PlacementView>]> = [
    ['width', {}, { width: 1200 }],
    ['height', {}, { height: 1200 }],
    ['pixel ratio', {}, { pixelRatio: 2 }],
    ['orthographic projection', {}, { orthographic: true }],
    ['mercator projection', {}, { mercatorProjection: false }],
    ['focus capability removed', {}, { cameraToCenterDistance: undefined }],
    ['focus capability added', { cameraToCenterDistance: undefined }, { cameraToCenterDistance: 100 }],
    ['position projection added', {}, { projectPosition: () => [0, 0, 0] }],
    ['position projection removed', { projectPosition: () => [0, 0, 0] }, { projectPosition: undefined }],
    ['occlusion capability added', {}, { isPointVisible: () => true }],
    ['occlusion capability removed', { isPointVisible: () => true }, { isPointVisible: undefined }],
    ['viewport x', {}, { viewport: { x: 1, y: 0, width: 1000, height: 1000 } }],
    ['viewport y', {}, { viewport: { x: 0, y: 1, width: 1000, height: 1000 } }],
    ['viewport width', {}, { viewport: { x: 0, y: 0, width: 900, height: 1000 } }],
    ['viewport height', {}, { viewport: { x: 0, y: 0, width: 1000, height: 900 } }],
  ];

  it.each(structuralChanges)('bypasses recency when %s changes', (_name, setup, change) => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const scope = new SymbolPlacementScope((a, b) => a === b, 300);
    const initial: PlacementView = { ...view, orthographic: false, cameraToCenterDistance: 100, viewport: { x: 0, y: 0, width: 1000, height: 1000 }, ...setup };
    scope.prepare([batch]);
    scope.advance(initial, UNBOUNDED_BUDGET, new SymbolProjectionContext());
    now = 20;
    const current = { ...initial, ...change };
    expect(samePlacementParameters(initial, current)).toBe(false);
    // A spent clock creates, but does not advance, the newly urgent job.
    expect(scope.advance(current, { exhausted: true }, new SymbolProjectionContext(), false, false)).toBeUndefined();
    expect(scope.job?.view).toMatchObject(change);
    expect(scope.runnable).toBe(true);
    expect(scope.nextPlacementTime).toBeUndefined();
    expect(scope.advance(current, UNBOUNDED_BUDGET, new SymbolProjectionContext())?.view).toMatchObject(change);
    expect(scope.pending).toBe(false);
  });
});

it('invalidates frozen placement when focus distance or projection kind changes', () => {
  const perspective = { ...view, orthographic: false, cameraToCenterDistance: 100 };
  expect(samePlacementParameters(perspective, { ...perspective, cameraToCenterDistance: 200 })).toBe(false);
  expect(samePlacementParameters(perspective, { ...perspective, orthographic: true })).toBe(false);
  expect(samePlacementParameters(perspective, { ...perspective, mercatorProjection: false })).toBe(false);
  expect(samePlacementParameters(perspective, { ...perspective })).toBe(true);
});
