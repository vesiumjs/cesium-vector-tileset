import type { PatternBuildInput } from '../pattern-renderer';
import Point from '@mapbox/point-geometry';
import { SceneMode } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageAtlas } from '../../../assets/image-atlas';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { OverscaledTileID } from '../../../tile/tile-id';
import { RGBAImage } from '../../../util/image';
import { destroyPatternResources, PatternTileRenderer } from '../pattern-renderer';

beforeEach(() => {
  vi.stubGlobal('OffscreenCanvas', class {});
  const NativeImageData = globalThis.ImageData;
  vi.stubGlobal('ImageData', class extends NativeImageData {
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      super(width, height);
      this.data.set(data);
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

function fixture(opacity = 1) {
  const layer = new FillStyleLayer({ id: 'hatch', type: 'fill', source: 'source', paint: { 'fill-pattern': 'hatch', 'fill-opacity': opacity } });
  layer.recalculate(new EvaluationParameters(2), []);
  const tileID = new OverscaledTileID(2, 0, 2, 1, 1);
  const bucket = new FillBucket({ layers: [layer], zoom: 2 } as never);
  bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
  const atlas = new ImageAtlas({}, { hatch: { data: new RGBAImage({ width: 1, height: 1 }, new Uint8Array([255, 0, 0, 255])), pixelRatio: 1, sdf: false, version: 0 } });
  const input: PatternBuildInput = { tileId: 'original', tileID, tileFeatureIndex: undefined, buckets: { hatch: bucket }, atlas, layers: [layer], styleZoom: 2, mode: SceneMode.SCENE3D };
  const renderer = new PatternTileRenderer();
  renderer.setLayers([layer], new Map([[layer.id, 0]]));
  const build = (request = input) => {
    const begun = renderer.beginPatternBuild(request);
    expect(begun.status).toBe('resumable');
    if (begun.status !== 'resumable')
      throw new Error('evicted pattern tile incorrectly reused its completed state');
    expect(renderer.stepPatternBuild(begun.state, { exhausted: false })).toBe(true);
    return renderer.commitPatternBuild(begun.state);
  };
  return { renderer, input, build, close: () => destroyPatternResources(renderer.clear()) };
}

describe('pattern tile state ownership', () => {
  it('rebuilds identical input after retired resources are cleared', () => {
    const state = fixture();
    try {
      const original = state.build();
      expect(original.added).toHaveLength(1);
      expect(state.renderer.beginPatternBuild(state.input).status).toBe('complete');
      state.renderer.retireTile(state.input.tileId);
      destroyPatternResources(state.renderer.clearRetired());
      expect(original.added[0].isDestroyed()).toBe(true);
      expect(state.renderer.restoreTile(state.input.tileId)).toBe(false);
      const rebuilt = state.build();
      expect(rebuilt.added).toHaveLength(1);
      expect(rebuilt.added[0]).not.toBe(original.added[0]);
      expect(rebuilt.added[0].isDestroyed()).toBe(false);
      expect(state.renderer.stats.tiles).toBe(1);
    }
    finally {
      state.close();
    }
  });

  it.each(['remove', 'retire again', 'capacity', 'overflow'] as const)('rebuilds after a retired owner is permanently released by %s', (operation) => {
    const state = fixture();
    try {
      const original = state.build();
      state.renderer.retireTile(state.input.tileId);
      if (operation === 'remove') {
        destroyPatternResources(state.renderer.removeTile(state.input.tileId));
      }
      else if (operation === 'retire again') {
        destroyPatternResources(state.renderer.retireTile(state.input.tileId));
      }
      else {
        if (operation === 'overflow')
          state.renderer.setRetiredCapacity(1);
        state.build({ ...state.input, tileId: 'replacement' });
        destroyPatternResources(state.renderer.retireTile('replacement'));
        if (operation === 'capacity')
          destroyPatternResources(state.renderer.setRetiredCapacity(1));
      }
      expect(original.added[0].isDestroyed()).toBe(true);
      expect(state.renderer.restoreTile(state.input.tileId)).toBe(false);
      expect(state.build().added).toHaveLength(1);
    }
    finally {
      state.close();
    }
  });

  it('keeps surviving live and retired owners reusable and caches legitimate empty patterns', () => {
    const state = fixture();
    const empty = fixture(0);
    try {
      const original = state.build();
      state.renderer.retireTile(state.input.tileId);
      expect(original.added[0].isDestroyed()).toBe(false);
      expect(state.renderer.restoreTile(state.input.tileId)).toBe(true);
      state.build({ ...state.input, tileId: 'other' });
      state.renderer.retireTile('other');
      destroyPatternResources(state.renderer.clearRetired());
      expect(state.renderer.beginPatternBuild(state.input).status).toBe('complete');
      expect(state.renderer.collections.get('hatch')!.get(0)).toBe(original.added[0]);

      expect(empty.build().added).toEqual([]);
      expect(empty.renderer.beginPatternBuild(empty.input).status).toBe('complete');
      empty.renderer.retireTile(empty.input.tileId);
      expect(empty.renderer.restoreTile(empty.input.tileId)).toBe(true);
      expect(empty.renderer.beginPatternBuild(empty.input).status).toBe('complete');
      empty.renderer.retireTile(empty.input.tileId);
      destroyPatternResources(empty.renderer.clearRetired());
      expect(empty.build().added).toEqual([]);
    }
    finally {
      state.close();
      empty.close();
    }
  });

  it('replaces a retired owner with a new live owner and keeps its completed state', () => {
    const state = fixture();
    try {
      const original = state.build();
      state.renderer.retireTile(state.input.tileId);
      const replacementInput = { ...state.input, styleMutationRevision: 1 };
      const replacement = state.build(replacementInput);
      expect(original.added[0].isDestroyed()).toBe(true);
      destroyPatternResources(state.renderer.clearRetired());
      expect(state.renderer.beginPatternBuild(replacementInput).status).toBe('complete');
      expect(state.renderer.collections.get('hatch')!.get(0)).toBe(replacement.added[0]);
      expect(replacement.added[0].isDestroyed()).toBe(false);
    }
    finally {
      state.close();
    }
  });
});
