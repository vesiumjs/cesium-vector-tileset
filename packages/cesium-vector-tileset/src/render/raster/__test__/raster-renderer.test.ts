import type { RetainedSurface } from '../../scene/scene-collections';
import type { TilePublishResult } from '../../scene/tile-publish-queue';
import { PrimitiveCollection, SceneMode, TextureMagnificationFilter, TextureMinificationFilter } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { RasterStyleLayer } from '../../../style/style-layer/raster-style-layer';
import { Tile } from '../../../tile/tile';
import { OverscaledTileID } from '../../../tile/tile-id';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { collectionGpuBytes } from '../../scene/resource-memory';
import { SceneCollections } from '../../scene/scene-collections';
import { TileGeneration } from '../../scene/tile-generation';
import { destroyRasterResources, RasterTileRenderer } from '../raster-renderer';

beforeEach(() => vi.stubGlobal('OffscreenCanvas', class {}));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const layer = new RasterStyleLayer({ id: 'imagery', type: 'raster', source: 'source' }, {});
  layer.recalculate(new EvaluationParameters(12), []);
  const renderer = new RasterTileRenderer();
  renderer.setLayers([layer], new Map([[layer.id, 0]]));
  const image = document.createElement('canvas');
  image.width = 128;
  image.height = 64;
  const tileID = new OverscaledTileID(12, 0, 12, 2048, 1362);
  return { layer, renderer, image, tileID };
}

function publishSurface(scene: SceneCollections, tileId: string, tileID: OverscaledTileID, retained: RetainedSurface, complete = true): { next: PrimitiveCollection; generation: TileGeneration } {
  const next = new PrimitiveCollection();
  const tile = new Tile(tileID, 512);
  const progress = { vector: complete ? 'complete' as const : 'surface' as const, pattern: true, symbol: true };
  const generation = new TileGeneration(tile, 1, SceneMode.SCENE3D, 1, progress);
  const result: TilePublishResult = {
    tileId,
    sourceId: 'source',
    tileID,
    generationId: 1,
    generation,
    stage: complete ? 'complete' : 'surface',
    progress,
    retainPreviousGeneration: !complete,
    previousVector: [],
    retiredVector: [],
    addedVector: [next],
    raster: { removed: [], added: [], removedMaterials: [] },
    removedSymbols: [],
    addedSymbols: [],
    firstUpdateSymbols: [],
    retainedSurfaces: [retained],
    featureIndex: undefined,
  };
  scene.applyPublication(result);
  return { next, generation };
}

describe('raster resource ownership', () => {
  it('preserves a ready batch when neighbouring tiles and its texture dimensions change', () => {
    const { layer, renderer, image, tileID } = fixture();
    try {
      const initial = renderer.addTile('first', tileID, image, [layer], true);
      const ready = initial.added[0];
      vi.spyOn(ready, 'ready', 'get').mockReturnValue(true);
      const neighbour = renderer.addTile('second', tileID, image, [layer], true);
      expect(neighbour.removed).not.toContain(ready);
      expect(renderer.collections.get(layer.id)!.contains(ready)).toBe(true);
      destroyRasterResources(neighbour);
      const third = renderer.addTile('third', tileID, image, [layer], true);
      destroyRasterResources(third);
      const neighbourOwner = third.added[0];
      vi.spyOn(neighbourOwner, 'ready', 'get').mockReturnValue(true);
      const removing = renderer.removeTile('second');
      expect(removing.removed).not.toContain(neighbourOwner);
      expect(renderer.collections.get(layer.id)!.contains(neighbourOwner)).toBe(true);
      const appearance = ready.appearance;
      const material = appearance.material;
      image.width *= 2;
      const resized = renderer.update();
      expect(resized.added).toEqual([]);
      expect(resized.removed).toEqual([]);
      expect(resized.textureChanged).toBe(true);
      expect(ready.appearance).toBe(appearance);
      expect(ready.appearance.material).toBe(material);
      expect(renderer.update().textureChanged).toBe(false);
      layer.setPaintProperty('raster-resampling', 'nearest');
      layer.updateTransitions({ now: 0, transition: { duration: 0, delay: 0 } });
      layer.recalculate(new EvaluationParameters(12), []);
      const resampled = renderer.update(1);
      expect(resampled.added).toEqual([]);
      expect(resampled.removed).toEqual([]);
      expect(ready.appearance.material).toBe(material);
      expect(material.minificationFilter).toBe(TextureMinificationFilter.NEAREST);
      expect(material.magnificationFilter).toBe(TextureMagnificationFilter.NEAREST);
      const last = renderer.removeTile('third');
      expect(last.removed).toContain(neighbourOwner);
      destroyRasterResources(last);
      expect(ready.isDestroyed()).toBe(false);
    }
    finally { destroyRasterResources(renderer.clear()); }
  });

  it('migrates every pending tile to a rebuilt shared successor before uploads resume', () => {
    const { layer, renderer, image, tileID } = fixture();
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, () => {}, () => true);
    root.add(renderer.collections.get(layer.id)!);
    try {
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], true));
      destroyRasterResources(renderer.addTile('second', tileID, image, [layer], true));
      const nextImage = document.createElement('canvas');
      nextImage.width = image.width;
      nextImage.height = image.height;
      const first = renderer.addTile('first', tileID, nextImage, [layer], true);
      scene.applyRasterUpdate(first);
      const second = renderer.addTile('second', tileID, nextImage, [layer], true);
      scene.applyRasterUpdate(second);
      scene.flushRemovals();
      expect(first.retained!.visible).toBe(true);
      expect(second.retained!.visible).toBe(true);
      expect(scene.hasPendingReplacement('first')).toBe(true);
      expect(scene.hasPendingReplacement('second')).toBe(true);
      // No upload allowance: neither logical tile can complete merely because
      // adding its neighbour replaced the shared Native owner.
      scene.pumpFirstUpdates({ mode: SceneMode.SCENE3D, commandList: [] } as never, { exhausted: true }, undefined, false);
      expect(first.retained!.visible).toBe(true);
      nextImage.width *= 2;
      const resized = renderer.update();
      scene.applyRasterUpdate(resized);
      scene.flushRemovals();
      expect(first.retained!.visible).toBe(true);
      expect(second.retained!.visible).toBe(true);
      const finalOwner = resized.added[0];
      // Model only the external GPU completion boundary; the shared batch,
      // ownership changes and Scene upload/handoff state are real.
      vi.spyOn(finalOwner, 'ready', 'get').mockReturnValue(true);
      vi.spyOn(finalOwner, 'update').mockImplementation(() => {});
      scene.pumpFirstUpdates({ mode: SceneMode.SCENE3D, commandList: [] } as never, UNBOUNDED_BUDGET);
      scene.flushRemovals();
      expect(first.retained!.visible).toBe(false);
      expect(second.retained!.visible).toBe(false);
      expect(scene.hasPendingReplacement('first')).toBe(false);
      expect(scene.hasPendingReplacement('second')).toBe(false);
      expect(finalOwner.show).toBe(true);
      expect(scene.pendingFirstUpdateCount).toBe(0);
      // Evicting one logical tile during another shared successor build must
      // cancel that tile alone, without dropping its neighbour's predecessor.
      const lastImage = document.createElement('canvas');
      lastImage.width = nextImage.width;
      lastImage.height = nextImage.height;
      const nextFirst = renderer.addTile('first', tileID, lastImage, [layer], true);
      scene.applyRasterUpdate(nextFirst);
      const nextSecond = renderer.addTile('second', tileID, lastImage, [layer], true);
      scene.applyRasterUpdate(nextSecond);
      scene.applyRasterUpdate(renderer.removeTile('first'));
      scene.flushRemovals();
      expect(nextFirst.retained!.visible).toBe(false);
      expect(nextSecond.retained!.visible).toBe(true);
      expect(scene.hasPendingReplacement('first')).toBe(false);
      expect(scene.hasPendingReplacement('second')).toBe(true);
    }
    finally {
      scene.clearPendingReplacements();
      scene.flushRemovals();
      destroyRasterResources(renderer.clear());
      root.destroyPrimitives = true;
      root.destroy();
    }
  });

  it('keeps per-layer coverage while a multi-layer tile waits for its successor', () => {
    const { layer, renderer, image, tileID } = fixture();
    const overlay = new RasterStyleLayer({ id: 'overlay', type: 'raster', source: 'source' }, {});
    overlay.recalculate(new EvaluationParameters(12), []);
    renderer.setLayers([layer, overlay]);
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, () => {}, () => true);
    for (const parent of renderer.collections.values())
      root.add(parent);
    try {
      const original = renderer.addTile('first', tileID, image, [layer, overlay]);
      const retained = renderer.takeDisplacedTile('first', [])!;
      publishSurface(scene, 'first', tileID, retained, false);
      const clear = { hiddenLayers: new Map<string, ReadonlySet<string>>(), hiddenSymbols: new Set<string>() };
      const covered = { ...clear, hiddenLayers: new Map([['first', new Set([layer.id])]]) };
      scene.syncTileVisibility(covered, clear);
      expect(original.added[0].show).toBe(false);
      expect(original.added[1].show).toBe(true);
      scene.syncTileVisibility(clear, covered);
      expect(original.added.every(primitive => primitive.show)).toBe(true);
    }
    finally {
      scene.clearPendingReplacements();
      scene.flushRemovals();
      destroyRasterResources(renderer.clear());
      root.destroyPrimitives = true;
      root.destroy();
    }
  });

  it('releases only a cancelled tile and cleans up the last shared owner at scene teardown', () => {
    const { layer, renderer, image, tileID } = fixture();
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, () => {}, () => true);
    root.add(renderer.collections.get(layer.id)!);
    let cancelled: PrimitiveCollection | undefined;
    try {
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], true));
      const shared = renderer.addTile('second', tileID, image, [layer], true);
      destroyRasterResources(shared);
      const primitive = shared.added[0];
      const destroy = vi.spyOn(primitive, 'destroy');
      const first = renderer.takeDisplacedTile('first', [])!;
      const second = renderer.takeDisplacedTile('second', [])!;
      cancelled = publishSurface(scene, 'first', tileID, first, false).next;
      publishSurface(scene, 'second', tileID, second, false);
      scene.detach(cancelled);
      expect(scene.flushRemovals()).toBe(true);
      expect(scene.flushRemovals()).toBe(false);
      expect(first.visible).toBe(false);
      expect(second.visible).toBe(true);
      expect(primitive.isDestroyed()).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
      scene.clearPendingReplacements();
      expect(scene.flushRemovals()).toBe(true);
      expect(scene.flushRemovals()).toBe(false);
      expect(primitive.isDestroyed()).toBe(true);
      expect(destroy).toHaveBeenCalledTimes(1);
      let bytes = 0;
      renderer.visitMemoryEntries((_tileId, size) => bytes += size);
      expect(bytes).toBe(0);
    }
    finally {
      scene.clearPendingReplacements();
      scene.flushRemovals();
      destroyRasterResources(renderer.clear());
      if (cancelled && !cancelled.isDestroyed())
        cancelled.destroy();
      root.destroyPrimitives = true;
      root.destroy();
    }
  });

  it('counts a shared held batch once alongside its new generation until the last old tile releases', () => {
    const { layer, renderer, image, tileID } = fixture();
    const memory = () => {
      let bytes = 0;
      renderer.visitMemoryEntries((_tileId, size, pinned) => {
        expect(pinned).toBe(true);
        bytes += size;
      });
      return bytes;
    };
    try {
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], true));
      const singletonBytes = memory();
      destroyRasterResources(renderer.addTile('second', tileID, image, [layer], true));
      const oldBytes = memory();
      const first = renderer.takeDisplacedTile('first', [])!;
      const second = renderer.takeDisplacedTile('second', [])!;
      expect(memory()).toBe(oldBytes);
      const successor = renderer.addTile('first', tileID, image, [layer], true);
      expect(memory()).toBe(oldBytes + singletonBytes);
      first.setVisible(false);
      first.release();
      expect(memory()).toBe(oldBytes + singletonBytes);
      expect(successor.added[0].isDestroyed()).toBe(false);
      second.release();
      expect(memory()).toBe(singletonBytes);
      expect(successor.added[0].isDestroyed()).toBe(false);
    }
    finally { destroyRasterResources(renderer.clear()); }
  });

  it('hands shared animated tiles to the scene independently and destroys their owner after the last handoff', () => {
    const { layer, renderer, image, tileID } = fixture();
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, () => {}, () => true);
    root.add(renderer.collections.get(layer.id)!);
    try {
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], true));
      const secondTileID = new OverscaledTileID(12, 0, 12, 2049, 1362);
      const shared = renderer.addTile('second', secondTileID, image, [layer], true);
      destroyRasterResources(shared);
      const primitive = shared.added[0];
      const destroy = vi.spyOn(primitive, 'destroy');
      const destroyMaterial = vi.spyOn(primitive.appearance.material, 'destroy');
      const first = renderer.takeDisplacedTile('first', []);
      const second = renderer.takeDisplacedTile('second', []);
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      const parent = renderer.collections.get(layer.id)!;
      destroyRasterResources(renderer.setLayers([], new Map([[layer.id, 0]])));
      const firstNext = publishSurface(scene, 'first', tileID, first!);
      const secondNext = publishSurface(scene, 'second', secondTileID, second!, false);
      const hasHeldCoverage = (tileId: string) => scene.someDrawableCollection(tileId, 'vector', () => false, owner => owner === primitive);
      expect(hasHeldCoverage('first')).toBe(true);
      expect(hasHeldCoverage('second')).toBe(true);
      // Give only the first successor its readiness turn. The second remains
      // queued, so the old texture and its second tile must remain drawable.
      scene.pumpFirstUpdates({ mode: SceneMode.SCENE3D, commandList: [] } as never, UNBOUNDED_BUDGET);
      scene.flushRemovals();
      expect(firstNext.next.show).toBe(true);
      expect(secondNext.next.show).toBe(false);
      expect(primitive.show).toBe(true);
      expect(first!.visible).toBe(false);
      expect(second!.visible).toBe(true);
      expect(hasHeldCoverage('first')).toBe(false);
      expect(hasHeldCoverage('second')).toBe(true);
      expect(primitive.isDestroyed()).toBe(false);
      expect(renderer.collectUnusedLayerCollections()).toEqual([]);
      expect(destroy).not.toHaveBeenCalled();
      secondNext.generation.publication.vector = 'complete';
      scene.finishReplacements();
      scene.flushRemovals();
      expect(primitive.isDestroyed()).toBe(true);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroyMaterial).toHaveBeenCalledTimes(1);
      expect(renderer.collectUnusedLayerCollections()).toEqual([parent]);
    }
    finally {
      scene.clearPendingReplacements();
      scene.flushRemovals();
      destroyRasterResources(renderer.clear());
      root.destroyPrimitives = true;
      root.destroy();
    }
  });

  it('keeps both displayed and successor static generations pinned until handoff release', () => {
    const { layer, renderer, image, tileID } = fixture();
    const memory = () => {
      let total = 0;
      renderer.visitMemoryEntries((_tileId, bytes, pinned) => {
        expect(pinned).toBe(true);
        total += bytes;
      });
      return total;
    };
    try {
      renderer.addTile('first', tileID, image, [layer]);
      const originalBytes = memory();
      const successorImage = document.createElement('canvas');
      successorImage.width = image.width;
      successorImage.height = image.height;
      const successor = renderer.addTile('first', tileID, successorImage, [layer]);
      expect(renderer.collections.get(layer.id)!.length).toBe(2);
      expect(memory()).toBe(originalBytes * 2);
      successor.retained!.release();
      expect(memory()).toBe(originalBytes);
      successor.retained!.release();
      expect(memory()).toBe(originalBytes);
    }
    finally { destroyRasterResources(renderer.clear()); }
  });

  it('counts one shared animated texture while preserving all batch geometry bytes', () => {
    const { layer, renderer, image, tileID } = fixture();
    const bytes = () => {
      let total = 0;
      renderer.visitMemoryEntries((_tileId, size, pinned) => {
        expect(pinned).toBe(true);
        total += size;
      });
      return total;
    };
    try {
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], true));
      const initialBytes = bytes();
      const otherTileID = new OverscaledTileID(12, 0, 12, 2049, 1362);
      const published = renderer.addTile('second', otherTileID, image, [layer], true);
      destroyRasterResources(published);
      const primitive = published.added[0];
      expect(renderer.collections.get(layer.id)!.length).toBe(1);
      expect(bytes() - collectionGpuBytes(primitive)).toBe(image.width * image.height * 4);
      expect(bytes()).toBeGreaterThan(initialBytes);

      // Removing the tile charged for the batch must transfer its accounting
      // to the surviving tile rather than drop or duplicate the texture.
      destroyRasterResources(renderer.removeTile('first'));
      const surviving = renderer.collections.get(layer.id)!.get(0);
      expect(bytes() - collectionGpuBytes(surviving)).toBe(image.width * image.height * 4);
      expect(renderer.hasPickObject({ type: 'raster', tileId: 'second', layerId: layer.id })).toBe(true);
      destroyRasterResources(renderer.removeTile('second'));
      expect(bytes()).toBe(0);
    }
    finally { destroyRasterResources(renderer.clear()); }
  });

  it('refreshes a resized animated batch once and preserves a steady batch', () => {
    const { layer, renderer, image, tileID } = fixture();
    try {
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], true));
      destroyRasterResources(renderer.addTile('second', tileID, image, [layer], true));
      const collection = renderer.collections.get(layer.id)!;
      const original = collection.get(0);
      expect(renderer.update().added).toEqual([]);
      expect(renderer.update().added).toEqual([]);
      expect(collection.get(0)).toBe(original);
      image.width *= 2;
      const resized = renderer.update();
      expect(resized.added).toHaveLength(1);
      expect(resized.removed).toEqual([original]);
      destroyRasterResources(resized);
      expect(original.isDestroyed()).toBe(true);
      expect(renderer.update().added).toEqual([]);
      expect(collection.get(0)).toBe(resized.added[0]);
    }
    finally { destroyRasterResources(renderer.clear()); }
  });

  it('keeps a displaced parent until its last retained generation is released', () => {
    const { layer, renderer, image, tileID } = fixture();
    try {
      const published = renderer.addTile('first', tileID, image, [layer]);
      const parent = renderer.collections.get(layer.id)!;
      const retained = renderer.takeDisplacedTile('first', [])!;
      // The layer survives in the style but has moved to another render track.
      destroyRasterResources(renderer.setLayers([], new Map([[layer.id, 0]])));
      expect(renderer.collectUnusedLayerCollections()).toEqual([]);
      expect(parent.get(0)).toBe(published.added[0]);
      expect(published.added[0].isDestroyed()).toBe(false);
      retained.release();
      expect(renderer.collectUnusedLayerCollections()).toEqual([parent]);
      expect(renderer.collections.size).toBe(0);
      parent.destroy();
    }
    finally { destroyRasterResources(renderer.clear()); }
  });
});
