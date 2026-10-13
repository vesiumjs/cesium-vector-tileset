import type { EvaluationParameters } from '../../../style/evaluation-parameters';
import type { ZoomHistory } from '../../../style/zoom-history';
import Point from '@mapbox/point-geometry';
import { PrimitiveCollection, SceneMode } from 'cesium';
import { describe, expect, it } from 'vitest';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { LineBucket } from '../../../data/bucket/line-bucket';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { LineStyleLayer } from '../../../style/style-layer/line-style-layer';
import { CanonicalTileID } from '../../../tile/tile-id';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { GpuMemoryBudget } from '../../scene/gpu-memory-budget';
import { collectionGpuBytes, primitiveResourceOwner } from '../../scene/resource-memory';
import { SceneCollections } from '../../scene/scene-collections';
import { VectorTileRenderer } from '../vector-tile-renderer';
import { buildVectorTile } from './vector-tile-helper';

function fillTile(renderer: VectorTileRenderer, x = 1) {
  const layer = new FillStyleLayer({ id: 'fill', type: 'fill', paint: { 'fill-color': '#ff0000', 'fill-antialias': false } }, {});
  layer.recalculate({ zoom: 0, zoomHistory: {} as ZoomHistory } as EvaluationParameters, []);
  const bucket = new FillBucket({ layers: [layer], zoom: 0 } as never);
  const tileID = new CanonicalTileID(20, x, 1);
  bucket.addFeature({} as never, [[new Point(0, 0), new Point(7, 0), new Point(7, 7), new Point(0, 7)]], 0, tileID, {});
  return { layer, tileId: tileID.key, collection: buildVectorTile(renderer, { tileId: tileID.key, buckets: { fill: bucket }, tileID })! };
}

function lineTile(renderer: VectorTileRenderer) {
  const layers = ['road', 'road-copy'].map(id => new LineStyleLayer({ id, type: 'line', source: 'roads', paint: { 'line-width': 4 } }, {}));
  for (const layer of layers)
    layer.recalculate({ zoom: 20, zoomHistory: {} as ZoomHistory } as EvaluationParameters, []);
  const bucket = new LineBucket({ layers, zoom: 20 } as never);
  const tileID = new CanonicalTileID(20, 1, 1);
  bucket.addFeature({ type: 2, properties: {}, index: 0, patterns: {}, dashes: {} } as never, [[new Point(100, 100), new Point(500, 100), new Point(500, 500)]], 0, tileID, {}, {});
  const collection = buildVectorTile(renderer, { tileId: tileID.key, buckets: Object.fromEntries(layers.map(layer => [layer.id, bucket])), tileID, styleZoom: 20 });
  if (!(collection instanceof PrimitiveCollection))
    throw new Error('line fixture must produce a Native collection');
  return { bucket, tileId: tileID.key, collection };
}

describe('vector replacement memory', () => {
  it('pins both physical generations until Scene destroys the predecessor', () => {
    const renderer = new VectorTileRenderer();
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, () => {}, () => true, collection => renderer.releaseDrapedCollection(collection), () => true, collection => renderer.releaseCollection(collection));
    const budget = new GpuMemoryBudget(1);
    const previous = fillTile(renderer);
    scene.add(previous.collection);
    budget.update(visit => renderer.visitMemoryEntries(visit));
    const generationBytes = budget.totalBytes;
    expect(generationBytes).toBeGreaterThan(0);

    const next = fillTile(renderer);
    scene.replaceWhenReady(next.tileId, previous.collection, next.collection);
    expect(root.contains(previous.collection)).toBe(true);
    expect(root.contains(next.collection)).toBe(true);
    expect(budget.update(visit => renderer.visitMemoryEntries(visit))).toEqual([]);
    expect(budget.totalBytes).toBe(generationBytes * 2);

    scene.deferDestroy(previous.collection);
    budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(budget.totalBytes).toBe(generationBytes * 2);
    // A third generation can replace a still-uploading successor before the
    // original visible owner is released. All three allocations still exist.
    const latest = fillTile(renderer);
    scene.replaceWhenReady(latest.tileId, next.collection, latest.collection);
    expect(budget.update(visit => renderer.visitMemoryEntries(visit))).toEqual([]);
    expect(budget.totalBytes).toBe(generationBytes * 3);
    scene.flushRemovals();
    expect(root.contains(previous.collection)).toBe(false);
    budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(budget.totalBytes).toBe(generationBytes);

    renderer.retireTile(latest.tileId, SceneMode.SCENE3D);
    scene.detach(latest.collection);
    expect(budget.update(visit => renderer.visitMemoryEntries(visit))).toEqual([latest.tileId]);
    for (const collection of renderer.takeRetired(latest.tileId))
      scene.deferDestroy(collection);
    scene.flushRemovals();
    budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(budget.totalBytes).toBe(0);
    renderer.removeAll();
    root.destroy();
  });

  it('counts shared line geometry once and includes its paint rebuild until Scene releases the old owner', () => {
    const renderer = new VectorTileRenderer();
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, () => {}, () => true, collection => renderer.releaseDrapedCollection(collection), () => true, collection => renderer.releaseCollection(collection));
    const budget = new GpuMemoryBudget(1);
    const previous = lineTile(renderer);
    scene.add(previous.collection);
    budget.update(visit => renderer.visitMemoryEntries(visit));
    const generationBytes = budget.totalBytes;
    const owner = primitiveResourceOwner(previous.collection.get(0))!;
    expect(generationBytes).toBeGreaterThan(0);
    expect(generationBytes).toBe(collectionGpuBytes(owner));
    const owners = new Set<object>();
    expect(collectionGpuBytes(previous.collection, owners)).toBe(generationBytes);
    expect(collectionGpuBytes(owner, owners)).toBe(0);
    previous.bucket.featureLineJoinCaps[0] = { ...previous.bucket.lineJoinCap, cap: 'round' };
    const replacements = renderer.updatePaint({ zoom: 20, styleRevision: 1, budget: UNBOUNDED_BUDGET });
    expect(replacements).toHaveLength(1);
    const next = replacements[0].replacement;
    scene.replaceWhenReady(previous.tileId, previous.collection, next);
    expect(budget.update(visit => renderer.visitMemoryEntries(visit))).toEqual([]);
    const handoffBytes = budget.totalBytes;
    expect(handoffBytes).toBeGreaterThan(generationBytes);

    scene.deferDestroy(previous.collection);
    scene.flushRemovals();
    budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(previous.collection.isDestroyed()).toBe(true);
    expect(budget.totalBytes + generationBytes).toBe(handoffBytes);

    renderer.removeTile(previous.tileId);
    scene.detachForDestruction(next);
    scene.flushRemovals();
    budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(budget.totalBytes).toBe(0);
    renderer.removeAll();
    root.destroy();
  });

  it('releases Buffer allocations without making the retained CPU collection unusable', () => {
    const renderer = new VectorTileRenderer();
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, () => {}, () => true, collection => renderer.releaseDrapedCollection(collection), () => true, collection => renderer.releaseCollection(collection));
    const budget = new GpuMemoryBudget(1);
    const tile = fillTile(renderer);
    scene.add(tile.collection);
    budget.update(visit => renderer.visitMemoryEntries(visit));
    const generationBytes = budget.totalBytes;
    for (const collection of renderer.removeModeSpecificCollections())
      scene.detachForDestruction(collection);
    budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(budget.totalBytes).toBe(generationBytes);
    scene.flushRemovals();
    budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(budget.totalBytes).toBe(0);
    // Native destroy releases GPU storage and permits later reupload of the
    // retained CPU geometry. It intentionally keeps isDestroyed() false.
    expect(tile.collection.isDestroyed()).toBe(false);
    expect(collectionGpuBytes(tile.collection)).toBe(generationBytes);
    scene.add(tile.collection);
    expect(root.contains(tile.collection)).toBe(true);
    scene.detachForDestruction(tile.collection);
    scene.flushRemovals();
    budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(budget.totalBytes).toBe(0);
    const pooled = fillTile(renderer);
    renderer.retireTile(pooled.tileId, SceneMode.SCENE3D);
    const rebuilt = fillTile(renderer);
    scene.add(rebuilt.collection);
    budget.update(visit => renderer.visitMemoryEntries(visit));
    // Republishing destroys an old pooled Buffer directly in the renderer;
    // that already-released allocation must not remain in held accounting.
    expect(budget.totalBytes).toBe(generationBytes);
    renderer.removeTile(rebuilt.tileId);
    scene.detachForDestruction(rebuilt.collection);
    scene.flushRemovals();
    budget.update(visit => renderer.visitMemoryEntries(visit));
    expect(budget.totalBytes).toBe(0);
    renderer.removeAll();
    root.destroy();
  });
});
