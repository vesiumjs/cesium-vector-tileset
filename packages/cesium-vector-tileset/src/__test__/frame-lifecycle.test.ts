import type { RenderFrameState } from '../render/scene/render-frame';
import type { VectorDrapingProvider, VectorTileRenderer } from '../render/vector/vector-tile-renderer';
import Point from '@mapbox/point-geometry';
import { BufferPolygonCollection, HeightReference, SceneMode } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../cesium-vector-tileset';
import { FillBucket } from '../data/bucket/fill-bucket';
import { buildVectorTile } from '../render/vector/__test__/vector-tile-helper';
import { EvaluationParameters } from '../style/evaluation-parameters';
import { FillStyleLayer } from '../style/style-layer/fill-style-layer';
import { OverscaledTileID } from '../tile/tile-id';

function frame(vectorProvider?: VectorDrapingProvider): RenderFrameState {
  return {
    mode: SceneMode.SCENE3D,
    frameNumber: 1,
    commandList: [],
    afterRender: [],
    camera: { _scene: { vectorProvider } } as RenderFrameState['camera'],
  };
}

describe('primitive frame lifecycle', () => {
  it('continues asynchronous style loading through the first frame queue', async () => {
    const tileset = new CesiumVectorTileset({ style: { version: 8, sources: {}, layers: [] } });
    const state = frame();
    try {
      // Bind the callback while style loading is still pending.
      expect(tileset.ready).toBe(false);
      tileset.update(state);
      await tileset.whenReady();
      expect(state.afterRender).toHaveLength(1);
      expect(state.afterRender!.shift()!()).toBe(true);

      tileset.setGpuMemoryBudgetBytes(1024);
      tileset.setGpuMemoryBudgetBytes(2048);
      expect(state.afterRender).toHaveLength(1);
      expect(state.afterRender!.shift()!()).toBe(true);

      // Cesium clears and reuses the queue after every frame.
      tileset.setGpuMemoryBudgetBytes(4096);
      expect(state.afterRender).toHaveLength(1);
      tileset.destroy();
      expect(state.afterRender!.shift()!()).toBe(false);
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });

  it('drapes fills with the provider supplied by the frame and detaches a replaced provider', async () => {
    const tileset = new CesiumVectorTileset({
      style: { version: 8, sources: {}, layers: [] },
      heightReference: HeightReference.CLAMP_TO_GROUND,
    });
    const provider = { markForFrame: vi.fn(), remove: vi.fn() };
    const replacement = { markForFrame: vi.fn(), remove: vi.fn() };
    const state = frame(provider);
    try {
      tileset.update(state);
      await tileset.whenReady();
      const renderer = (tileset as unknown as { _vectorRenderer: VectorTileRenderer })._vectorRenderer;
      const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
      const layer = new FillStyleLayer({ id: 'land', type: 'fill', source: 'land', paint: { 'fill-antialias': false } });
      layer.recalculate(new EvaluationParameters(0), []);
      const bucket = new FillBucket({ layers: [layer], zoom: 0 } as never);
      bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
      buildVectorTile(renderer, { tileId: `land/${tileID.key}`, buckets: { land: bucket }, tileID });
      const [collection] = renderer.getTileCollections(`land/${tileID.key}`);
      expect(collection).toBeInstanceOf(BufferPolygonCollection);
      expect((collection as BufferPolygonCollection).heightReference).toBe(HeightReference.CLAMP_TO_GROUND);
      renderer.markDrapedCollections(1);
      expect(provider.markForFrame).toHaveBeenCalledWith(collection, 1, HeightReference.CLAMP_TO_GROUND);

      state.camera._scene!.vectorProvider = replacement;
      // Keep the tile fixture out of source scheduling while exercising rebinding.
      tileset.show = false;
      tileset.update(state);
      expect(provider.remove).toHaveBeenCalledWith(collection);
      renderer.markDrapedCollections(2);
      expect(replacement.markForFrame).toHaveBeenCalledWith(collection, 2, HeightReference.CLAMP_TO_GROUND);
      tileset.destroy();
      expect(replacement.remove).toHaveBeenCalledWith(collection);
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });
});
