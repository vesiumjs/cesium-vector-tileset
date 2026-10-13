import type { GeometryInstance } from 'cesium';
import type { PatternBuildInput, PatternPrimitiveID } from '../pattern-renderer';
import Point from '@mapbox/point-geometry';
import { SceneMode } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageAtlas } from '../../../assets/image-atlas';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { LineBucket } from '../../../data/bucket/line-bucket';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { LineStyleLayer } from '../../../style/style-layer/line-style-layer';
import { OverscaledTileID } from '../../../tile/tile-id';
import { RGBAImage } from '../../../util/image';
import { linePaintForOwner } from '../../scene/draw-batch';
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

describe('pattern line layout and paint', () => {
  function lineFixture(cap: 'butt' | 'round', width: number | ['interpolate', ['linear'], ['zoom'], number, number | ['get', string], number, number | ['get', string]] = 0.25) {
    const layer = new LineStyleLayer({ id: 'hatch', type: 'line', source: 'source', layout: { 'line-cap': cap, 'line-join': 'round' }, paint: { 'line-pattern': 'hatch', 'line-width': width } }, {});
    layer.recalculate(new EvaluationParameters(2.25), ['hatch']);
    const tileID = new OverscaledTileID(2, 0, 2, 1, 1);
    const bucket = new LineBucket({ layers: [layer], zoom: 2 } as never);
    const feature = { properties: { width: 4 }, type: 2, index: 0, patterns: {}, dashes: {} };
    bucket.addFeature(feature as never, [[new Point(100, 100), new Point(500, 100), new Point(500, 500)]], 0, tileID.canonical, {}, {});
    const atlas = new ImageAtlas({}, { hatch: { data: new RGBAImage({ width: 1, height: 1 }, new Uint8Array([255, 0, 0, 255])), pixelRatio: 1, sdf: false, version: 0 } });
    const renderer = new PatternTileRenderer();
    renderer.setLayers([layer], new Map([[layer.id, 0]]));
    const input: PatternBuildInput = { tileId: 'road', tileID, tileFeatureIndex: undefined, buckets: { hatch: bucket }, atlas, layers: [layer], styleZoom: 2.25, mode: SceneMode.SCENE3D };
    const begun = renderer.beginPatternBuild(input);
    if (begun.status !== 'resumable')
      throw new Error('line fixture must build');
    renderer.stepPatternBuild(begun.state, { exhausted: false });
    const update = renderer.commitPatternBuild(begun.state);
    return { renderer, input, primitive: update.added[0], close: () => destroyPatternResources(renderer.clear()) };
  }

  it('keeps round endpoints and subpixel widths when a line uses an image', () => {
    const butt = lineFixture('butt');
    const round = lineFixture('round');
    try {
      const buttInstance = (butt.primitive.geometryInstances as import('cesium').GeometryInstance[])[0];
      const roundInstance = (round.primitive.geometryInstances as import('cesium').GeometryInstance[])[0];
      expect(roundInstance.geometry.indices!.length).toBeGreaterThan(buttInstance.geometry.indices!.length);
      expect(roundInstance.attributes.lineWidth.value[0]).toBe(0.25);
    }
    finally {
      butt.close();
      round.close();
    }
  });

  it('rebuilds composite paint within the same integer zoom', () => {
    const state = lineFixture('round', ['interpolate', ['linear'], ['zoom'], 2, ['get', 'width'], 3, 8]);
    try {
      expect((state.primitive.geometryInstances as import('cesium').GeometryInstance[])[0].attributes.lineWidth.value[0]).toBe(5);
      expect(state.renderer.beginPatternBuild({ ...state.input, styleZoom: 2.75 }).status).toBe('resumable');
    }
    finally {
      state.close();
    }
  });

  it('updates pixel width for a reused image line when the camera zooms', () => {
    const state = lineFixture('round', 4);
    try {
      const paint = linePaintForOwner(state.primitive)!;
      const initialScale = paint.metersPerPixel;
      expect(state.renderer.beginPatternBuild({ ...state.input, styleZoom: 3.25 }).status).toBe('complete');
      state.renderer.update(undefined, 3.25);
      expect(paint.metersPerPixel).toBeCloseTo(initialScale / 2);
      expect(state.renderer.collections.get('hatch')!.get(0)).toBe(state.primitive);
    }
    finally { state.close(); }
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
  const input: PatternBuildInput = { tileId: tileID.key, tileID, tileFeatureIndex: undefined, buckets: { hatch: bucket }, atlas, layers: [layer], styleZoom: 2, mode: SceneMode.SCENE3D };
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
  it('keeps old and new geometry pinned while a tile generation handoff is pending', () => {
    const state = fixture();
    const workerReplacement = fixture();
    const memory = () => {
      let bytes = 0;
      state.renderer.visitMemoryEntries((_tileId, size, pinned) => {
        expect(pinned).toBe(true);
        bytes += size;
      });
      return bytes;
    };
    try {
      state.build();
      const originalBytes = memory();
      const successor = state.build({ ...state.input, buckets: workerReplacement.input.buckets });
      expect(memory()).toBe(originalBytes * 2);
      successor.retained!.setVisible(false);
      expect(memory()).toBe(originalBytes * 2);
      successor.retained!.release();
      expect(memory()).toBe(originalBytes);
      successor.retained!.release();
      expect(memory()).toBe(originalBytes);
    }
    finally {
      state.close();
      workerReplacement.close();
    }
  });

  it('keeps a displaced parent until its retained generation is released', () => {
    const state = fixture();
    try {
      const original = state.build();
      const pick = (original.added[0].geometryInstances as GeometryInstance[])[0].id as PatternPrimitiveID;
      const parent = state.renderer.collections.get('hatch')!;
      const retained = state.renderer.takeDisplacedTile(state.input.tileId, [])!;
      // The solid successor has the same ID; its old pattern parent must
      // still survive until the displayed pattern generation is released.
      destroyPatternResources(state.renderer.setLayers([], new Map([['hatch', 0]])));
      expect(state.renderer.collectUnusedLayerCollections()).toEqual([]);
      expect(parent.get(0)).toBe(original.added[0]);
      expect(state.renderer.hasPickObject(pick)).toBe(true);
      retained.release();
      expect(state.renderer.hasPickObject(pick)).toBe(false);
      expect(original.added[0].isDestroyed()).toBe(true);
      expect(state.renderer.collectUnusedLayerCollections()).toEqual([parent]);
      parent.destroy();
    }
    finally { state.close(); }
  });

  it('keeps an empty parent while retired geometry can still be restored', () => {
    const state = fixture();
    try {
      const original = state.build();
      const parent = state.renderer.collections.get('hatch')!;
      state.renderer.retireTile(state.input.tileId);
      destroyPatternResources(state.renderer.setLayers([], new Map()));
      expect(parent.length).toBe(0);
      expect(state.renderer.collectUnusedLayerCollections()).toEqual([]);
      expect(state.renderer.restoreTile(state.input.tileId)).toBe(true);
      expect(parent.get(0)).toBe(original.added[0]);
      destroyPatternResources(state.renderer.removeTile(state.input.tileId));
      expect(state.renderer.collectUnusedLayerCollections()).toEqual([parent]);
      parent.destroy();
    }
    finally { state.close(); }
  });

  it('keeps an empty parent while a detached build still needs it', () => {
    const state = fixture();
    try {
      const begun = state.renderer.beginPatternBuild(state.input);
      if (begun.status !== 'resumable')
        throw new Error('fixture must start a detached build');
      const parent = state.renderer.collections.get('hatch')!;
      destroyPatternResources(state.renderer.setLayers([], new Map()));
      expect(parent.length).toBe(0);
      expect(state.renderer.collectUnusedLayerCollections()).toEqual([]);
      state.renderer.abandonPatternBuild(begun.state);
      expect(state.renderer.collectUnusedLayerCollections()).toEqual([parent]);
      parent.destroy();
    }
    finally { state.close(); }
  });

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
