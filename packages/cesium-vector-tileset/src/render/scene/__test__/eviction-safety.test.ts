import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { EvaluationParameters } from '../../../style/evaluation-parameters';
import type { ZoomHistory } from '../../../style/zoom-history';
import Point from '@mapbox/point-geometry';
import { PrimitiveCollection, SceneMode } from 'cesium';
import { beforeAll, describe, expect, it } from 'vitest';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { CanonicalTileID } from '../../../tile/tile-id';
import { buildVectorTile } from '../../vector/__test__/vector-tile-helper';
import { VectorTileRenderer } from '../../vector/vector-tile-renderer';
import { GpuMemoryBudget } from '../gpu-memory-budget';
import { SceneCollections } from '../scene-collections';
import { memoryEntries } from './memory-entry-helper';

function tileIDFor(x: number): CanonicalTileID {
  return new CanonicalTileID(20, x, 1);
}

function addTile(renderer: VectorTileRenderer, x: number, mode: SceneMode = SceneMode.SCENE3D): string {
  const layer = new FillStyleLayer({
    id: 'fill',
    type: 'fill',
    paint: { 'fill-color': '#ff0000', 'fill-antialias': false },
  } as LayerSpecification, {});
  layer.recalculate({ zoom: 0, zoomHistory: {} as ZoomHistory } as EvaluationParameters, []);
  const bucket = new FillBucket({ layers: [layer], zoom: 0 } as never);
  const id = tileIDFor(x);
  bucket.addFeature({} as never, [[
    new Point(0, 0),
    new Point(7, 0),
    new Point(7, 7),
    new Point(0, 7),
  ]], 0, id, {});
  buildVectorTile(renderer, { tileId: id.key, buckets: { fill: bucket }, tileID: id, mode });
  return id.key;
}

/**
 * Eviction safety is the invariant the memory budget exists to protect: a live
 * tile's collections are attached to the scene, so destroying one mid-scene
 * leaves the renderer holding detached geometry (or Cesium stops rendering).
 * Evictability is therefore reported per entry - live entries pinned, pooled
 * entries not - and only the pooled ones may be evicted. This is what the tileset
 * relied on when it stopped building a protected-key set per frame.
 */
describe('bucket tile eviction safety', () => {
  beforeAll(() => {
    if (typeof OffscreenCanvas === 'undefined') {
      globalThis.OffscreenCanvas = class {} as unknown as typeof OffscreenCanvas;
    }
  });

  it('reports live tiles pinned and pooled tiles evictable', () => {
    const renderer = new VectorTileRenderer();
    const liveId = addTile(renderer, 1);
    const pooledId = addTile(renderer, 2);

    expect(memoryEntries(renderer).find(e => e.key === liveId)?.pinned).toBe(true);
    expect(memoryEntries(renderer).find(e => e.key === pooledId)?.pinned).toBe(true);

    // Retiring moves a tile out of the scene: it becomes evictable.
    renderer.retireTile(pooledId, SceneMode.SCENE3D);
    const entries = memoryEntries(renderer);
    expect(entries.find(e => e.key === liveId)?.pinned).toBe(true);
    expect(entries.find(e => e.key === pooledId)?.pinned).toBeUndefined();
  });

  it('evicts the pooled tile and never the live one, even under pressure', () => {
    const renderer = new VectorTileRenderer();
    const liveId = addTile(renderer, 1);
    const pooledId = addTile(renderer, 2);
    renderer.retireTile(pooledId, SceneMode.SCENE3D);

    // A budget far below the live tile's own size: the only evictable entry is
    // the pooled one, so pressure can never reach the live tile.
    const budget = new GpuMemoryBudget(1);
    const evicted = budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(evicted).toEqual([pooledId]);
    expect(evicted).not.toContain(liveId);

    // The reported eviction is actionable: taking it destroys the pooled tile.
    const taken = renderer.takeRetired(pooledId);
    expect(taken.length).toBeGreaterThan(0);
    expect(renderer.tileIds).toContain(liveId);
    expect(renderer.tileIds).not.toContain(pooledId);
  });

  it.each([
    [SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW],
    [SceneMode.COLUMBUS_VIEW, SceneMode.SCENE2D],
  ])('keeps mode %i replacement resources reusable only in their own mode when mode %i follows', (mode, nextMode) => {
    const renderer = new VectorTileRenderer();
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, () => {}, () => true);
    const old = new PrimitiveCollection();
    const tileId = addTile(renderer, 3, mode);
    const next = renderer.getTileCollections(tileId)[0] as PrimitiveCollection;
    scene.add(old);
    scene.replaceWhenReady(tileId, old, next);

    expect(renderer.retireTile(tileId, mode)).toEqual([]);
    scene.detach(next);
    scene.flushRemovals();

    expect(renderer.restoreTile(tileId, nextMode)).toBe(false);
    expect(renderer.retiredCollections).toEqual([next]);
    expect(next.isDestroyed()).toBe(false);
    expect(renderer.restoreTile(tileId, mode)).toBe(true);
    for (const collection of renderer.getTileCollections(tileId)) {
      collection.show = true;
      scene.add(collection);
    }
    // These Cesium lifecycle calls still visit the collection when no GPU
    // render pass is active, so the regression needs no WebGL fixture.
    const frame = { mode, passes: { render: false, pick: false }, commandList: [] };
    expect.soft(() => scene.updateChildren(frame as never)).not.toThrow();
    expect.soft(() => (root as unknown as { postPassesUpdate: (state: unknown) => void }).postPassesUpdate(frame)).not.toThrow();
    expect.soft(next.isDestroyed()).toBe(false);
    expect(old.isDestroyed()).toBe(true);

    // A predecessor can leave view after the tileset has already cleared the
    // old pool for a mode change. Its late retirement must release ownership.
    expect(renderer.retireTile(tileId, nextMode)).toEqual([next]);
    expect(renderer.retiredCollections).toEqual([]);
    expect(renderer.restoreTile(tileId, nextMode)).toBe(false);
    scene.detach(next);
    scene.deferDestroy(next);
    scene.flushRemovals();
    expect(next.isDestroyed()).toBe(true);
    renderer.removeAll();
    root.destroy();
  });
});
