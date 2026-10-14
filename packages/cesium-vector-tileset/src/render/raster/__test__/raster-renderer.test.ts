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
import { RasterCoverage } from '../raster-coverage';
import { destroyRasterResources, RasterTileRenderer } from '../raster-renderer';

const textures = vi.hoisted(() => ({ uploads: [] as Array<{ source: object; texture: { isDestroyed: () => boolean }; destroy: ReturnType<typeof vi.fn> }> }));

vi.mock('cesium', async (importOriginal) => {
  const original = await importOriginal<typeof import('cesium')>();
  const Texture = (original as unknown as { Texture: { prototype: object } }).Texture;
  return {
    ...original,
    Texture: vi.fn(class {
      constructor(options: { source: object; width: number; height: number }) {
        let destroyed = false;
        const destroy = vi.fn(() => {
          destroyed = true;
        });
        // Replace only GL allocation. Native Material still performs its
        // real Texture instanceof/adoption/destruction contract.
        const texture = Object.create(Texture.prototype, {
          _width: { value: options.width },
          _height: { value: options.height },
          copyFrom: { value: vi.fn() },
          destroy: { value: destroy },
          isDestroyed: { value: () => destroyed },
        });
        textures.uploads.push({ source: options.source, texture, destroy });
        return texture;
      }
    }),
  };
});

beforeEach(() => {
  textures.uploads.length = 0;
  vi.stubGlobal('OffscreenCanvas', class {});
});
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
  it('keeps the sampled parent alive after its owner retires and releases it only after Native adopts the child sampler', () => {
    const { layer, renderer, image, tileID } = fixture();
    const childID = tileID.children(13)[0];
    const childImage = document.createElement('canvas');
    childImage.width = childImage.height = 64;
    const context = { defaultTexture: { width: 1, height: 1 } };
    const updateMaterial = (primitive: ReturnType<RasterTileRenderer['addTile']>['added'][number]) => {
      (primitive.appearance.material as typeof primitive.appearance.material & { update: (context: object) => void }).update(context);
    };
    try {
      const parent = renderer.addTile('source/parent', tileID, image, [layer], layer).added[0];
      const child = renderer.addTile('source/child', childID, childImage, [layer], layer).added[0];
      vi.spyOn(parent, 'ready', 'get').mockReturnValue(true);
      vi.spyOn(child, 'ready', 'get').mockReturnValue(true);
      const frame = (id: string) => ({ source: layer, fade: id === 'source/child' ? { opacity: 1, mix: 0.5, tileOpacity: 0.5, parent: tileID } : undefined });
      renderer.update(0, false, undefined, frame);
      updateMaterial(parent);
      updateMaterial(child);
      const parentSampler = parent.appearance.material.uniforms.image;
      expect(child.appearance.material.uniforms.parentImage).toBe(parentSampler);
      const parentUploads = textures.uploads.filter(upload => upload.source === image);
      expect(parentUploads).toHaveLength(1);
      destroyRasterResources(renderer.removeTile('source/parent'));
      expect(parentUploads[0].destroy).not.toHaveBeenCalled();
      renderer.update(0, false, undefined, frame);
      expect(child.appearance.material.uniforms.u_mix).toBe(0);
      expect(parentSampler.isDestroyed()).toBe(false);
      updateMaterial(child);
      expect(child.appearance.material.uniforms.parentImage).toBe(child.appearance.material.uniforms.image);
      expect(parentUploads[0].destroy).toHaveBeenCalledOnce();
      expect(child.appearance.material.uniforms.image.isDestroyed()).toBe(false);
    }
    finally { destroyRasterResources(renderer.clear()); }
  });

  it('updates decoded video pixels through the renderer once per shared image/filter, including paused seeks', () => {
    const { layer, renderer, tileID } = fixture();
    const overlay = new RasterStyleLayer({ id: 'overlay', type: 'raster', source: 'source' }, {});
    overlay.recalculate(new EvaluationParameters(12), []);
    renderer.setLayers([layer, overlay]);
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2, writable: true },
      videoWidth: { value: 8 },
      videoHeight: { value: 4 },
    });
    try {
      const update = renderer.addTile('video', tileID, video, [layer, overlay], layer);
      const copies = update.added.map(primitive => vi.spyOn(primitive.appearance.material as typeof primitive.appearance.material & { copyImage: (image: HTMLVideoElement) => void }, 'copyImage'));
      renderer.update();
      expect(copies.reduce((sum, copy) => sum + copy.mock.calls.length, 0)).toBe(1);
      video.currentTime = 1;
      renderer.update();
      expect(copies.reduce((sum, copy) => sum + copy.mock.calls.length, 0)).toBe(2);
      Object.assign(video, { readyState: 1 });
      renderer.update();
      expect(copies.reduce((sum, copy) => sum + copy.mock.calls.length, 0)).toBe(2);
    }
    finally { destroyRasterResources(renderer.clear()); }
  });

  it('excludes only actual child footprints, regardless of PNG alpha, across mixed descendant depths', () => {
    const parent = new OverscaledTileID(12, 0, 12, 2048, 1362);
    const children = parent.children(14);
    const southEastGrandchild = children[3].children(14)[3];
    const coverage = new RasterCoverage();
    expect(coverage.update(parent, [children[0], southEastGrandchild])).toBe(true);
    expect(coverage.source).toMatchObject({ width: 4, height: 4 });
    expect([...coverage.source!.data]).toEqual([
      255,
      255,
      0,
      0,
      255,
      255,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      255,
    ]);
    expect(coverage.update(parent, [southEastGrandchild, children[0]])).toBe(false);
    expect(coverage.update(parent.scaledTo(11), [southEastGrandchild, children[0]])).toBe(true);
    expect(coverage.source).toMatchObject({ width: 8, height: 8 });
    expect(coverage.update(parent, [])).toBe(true);
    expect(coverage.source).toBeUndefined();
  });

  it('mixes one ready child with its parent while leaving the other parent quadrants visible', () => {
    const { layer, renderer, image, tileID } = fixture();
    const childID = tileID.children(13)[0];
    const childImage = document.createElement('canvas');
    childImage.width = childImage.height = 64;
    try {
      const parent = renderer.addTile('source/parent', tileID, image, [layer], layer).added[0];
      const child = renderer.addTile('source/child', childID, childImage, [layer], layer).added[0];
      vi.spyOn(parent, 'ready', 'get').mockReturnValue(true);
      const ready = vi.spyOn(child, 'ready', 'get').mockReturnValue(false);
      const fade = (id: string) => id === 'source/child'
        ? { source: layer, fade: { opacity: 1, mix: 0.5, tileOpacity: 0.5, parent: tileID } }
        : { source: layer, fade: { opacity: 1, mix: 0, tileOpacity: 0.5 } };
      renderer.update(0, false, undefined, fade);
      expect(parent.appearance.material.uniforms.u_coverage_size).toBe(0);
      ready.mockReturnValue(true);
      renderer.update(0, false, undefined, fade);
      expect(child.appearance.material.uniforms.u_mix).toBe(0.5);
      expect(child.appearance.material.uniforms.u_fade).toBe(1);
      expect(parent.appearance.material.uniforms.u_fade).toBe(1);
      expect(parent.appearance.material.uniforms.u_coverage_size).toBe(2);
      expect(child.appearance.material.uniforms.u_parent_scale).toBe(0.5);
      expect(child.appearance.material.uniforms.u_parent_offset).toMatchObject({ x: 0, y: 0.5 });
      // A data fallback or held parent still excludes ready descendants after
      // their crossfade has completed and no fade descriptor pairs them.
      renderer.update(0, false, undefined, () => ({ source: layer }));
      expect(child.appearance.material.uniforms.u_mix).toBe(0);
      expect(parent.appearance.material.uniforms.u_coverage_size).toBe(2);
      renderer.update(0, false, undefined, fade);
      renderer.update(0, false, undefined, () => ({ source: {}, fade: { opacity: 0.25, mix: 0.75, tileOpacity: 0.25, parent: tileID } }));
      expect(child.appearance.material.uniforms.u_mix).toBe(0.5);
      expect(child.appearance.material.uniforms.u_fade).toBe(1);
      // An outgoing source retains its complete existing presentation;
      // current-source fade state cannot mutate or bind its generation.
      const removed = renderer.removeTile('source/parent');
      destroyRasterResources(removed);
      renderer.update(0, false, undefined, fade);
      expect(child.appearance.material.uniforms.u_mix).toBe(0);
      expect(child.appearance.material.uniforms.u_fade).toBe(1);
    }
    finally { destroyRasterResources(renderer.clear()); }
  });

  it('preserves a ready batch when neighbouring tiles and its texture dimensions change', () => {
    const { layer, renderer, image, tileID } = fixture();
    try {
      const initial = renderer.addTile('first', tileID, image, [layer], layer, true);
      const ready = initial.added[0];
      vi.spyOn(ready, 'ready', 'get').mockReturnValue(true);
      const neighbour = renderer.addTile('second', tileID, image, [layer], layer, true);
      expect(neighbour.removed).not.toContain(ready);
      expect(renderer.collections.get(layer.id)!.contains(ready)).toBe(true);
      destroyRasterResources(neighbour);
      const third = renderer.addTile('third', tileID, image, [layer], layer, true);
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
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], layer, true));
      destroyRasterResources(renderer.addTile('second', tileID, image, [layer], layer, true));
      const nextImage = document.createElement('canvas');
      nextImage.width = image.width;
      nextImage.height = image.height;
      const first = renderer.addTile('first', tileID, nextImage, [layer], layer, true);
      scene.applyRasterUpdate(first);
      const second = renderer.addTile('second', tileID, nextImage, [layer], layer, true);
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
      const nextFirst = renderer.addTile('first', tileID, lastImage, [layer], layer, true);
      scene.applyRasterUpdate(nextFirst);
      const nextSecond = renderer.addTile('second', tileID, lastImage, [layer], layer, true);
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
    renderer.setLayers([layer, overlay], layer);
    const root = new PrimitiveCollection({ destroyPrimitives: false });
    const scene = new SceneCollections(root, () => {}, () => true);
    for (const parent of renderer.collections.values())
      root.add(parent);
    try {
      const original = renderer.addTile('first', tileID, image, [layer, overlay], layer);
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
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], layer, true));
      const shared = renderer.addTile('second', tileID, image, [layer], layer, true);
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
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], layer, true));
      const singletonBytes = memory();
      destroyRasterResources(renderer.addTile('second', tileID, image, [layer], layer, true));
      const oldBytes = memory();
      const first = renderer.takeDisplacedTile('first', [])!;
      const second = renderer.takeDisplacedTile('second', [])!;
      expect(memory()).toBe(oldBytes);
      const successor = renderer.addTile('first', tileID, image, [layer], layer, true);
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
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], layer, true));
      const secondTileID = new OverscaledTileID(12, 0, 12, 2049, 1362);
      const shared = renderer.addTile('second', secondTileID, image, [layer], layer, true);
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
      destroyRasterResources(renderer.addTile('first', tileID, image, [layer], layer, true));
      const initialBytes = bytes();
      const otherTileID = new OverscaledTileID(12, 0, 12, 2049, 1362);
      const published = renderer.addTile('second', otherTileID, image, [layer], layer, true);
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

  it('keeps a displaced parent until its last retained generation is released', () => {
    const { layer, renderer, image, tileID } = fixture();
    try {
      const published = renderer.addTile('first', tileID, image, [layer], layer);
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
