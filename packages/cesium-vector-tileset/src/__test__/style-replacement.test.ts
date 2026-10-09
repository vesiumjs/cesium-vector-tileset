import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { BufferPolygonCollection } from 'cesium';
import type { SceneCollections } from '../render/scene/scene-collections';
import type { TileResidency } from '../render/scene/tile-residency';
import type { VectorTileRenderer } from '../render/vector/vector-tile-renderer';
import type { Style } from '../style/style';
import type { FillStyleLayer } from '../style/style-layer/fill-style-layer';
import Point from '@mapbox/point-geometry';
import { BufferPolygon, BufferPolygonMaterial, Color, SceneMode } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../cesium-vector-tileset';
import { FillBucket } from '../data/bucket/fill-bucket';
import { UNBOUNDED_BUDGET } from '../render/scene/frame-budget';
import { buildVectorTile } from '../render/vector/__test__/vector-tile-helper';
import { EvaluationParameters } from '../style/evaluation-parameters';
import { Tile } from '../tile/tile';
import { OverscaledTileID } from '../tile/tile-id';

function style(color = '#3366aa', source = 'land'): StyleSpecification {
  return {
    version: 8,
    sources: { [source]: { type: 'vector', tiles: ['http://example.invalid/{z}/{x}/{y}.pbf'] } },
    layers: [{ 'id': 'land', 'type': 'fill', source, 'source-layer': 'land', 'paint': { 'fill-color': color, 'fill-antialias': false } }],
  };
}

async function loadedSurface(initial = style()) {
  const tileset = new CesiumVectorTileset({ style: initial });
  await tileset.whenReady();
  const internals = (tileset as unknown as { _renderer: { style: Style; vector: VectorTileRenderer } })._renderer;
  const tileID = new OverscaledTileID(12, 0, 12, 2048, 1362);
  const layer = internals.style.getLayer('land') as FillStyleLayer;
  layer.recalculate(new EvaluationParameters(12), []);
  const bucket = new FillBucket({ layers: [layer], zoom: 12 } as never);
  bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
  buildVectorTile(internals.vector, { tileId: `land/${tileID.key}`, buckets: { land: bucket }, tileID });
  const [surface] = internals.vector.getTileCollections(`land/${tileID.key}`);
  tileset.add(surface);
  return { tileset, internals, surface, tileID };
}

describe('style replacement resource lifetime', () => {
  it('holds a deleted source until the new source has finished uploading', async () => {
    const { tileset, surface, tileID } = await loadedSurface();
    const internals = (tileset as unknown as { _renderer: { residency: TileResidency; collections: SceneCollections } })._renderer;
    internals.residency.published('land', tileID);
    try {
      const next = style('#22aa55', 'city');
      tileset.setStyle(next);
      expect(tileset.contains(surface)).toBe(true);
      expect(surface.show).toBe(true);
      expect(surface.isDestroyed()).toBe(false);
      const successor = new OverscaledTileID(12, 0, 12, 2048, 1362);
      internals.residency.published('city', successor);
      expect(internals.residency.hiddenStyleTiles.has(`city/${successor.key}`)).toBe(true);
      expect(internals.residency.completeSourceReplacement()).toBe(true);
      expect(tileset.contains(surface)).toBe(false);
      expect(internals.residency.hiddenStyleTiles.size).toBe(0);
      internals.collections.flushRemovals();
      expect(internals.residency.completeSourceReplacement()).toBe(false);
    }
    finally { tileset.destroy(); }
  });

  it('releases hidden intermediate sources while preserving the visible predecessor', async () => {
    const { tileset, surface, tileID } = await loadedSurface();
    const internals = (tileset as unknown as { _renderer: { residency: TileResidency; vector: VectorTileRenderer } })._renderer;
    internals.residency.published('land', tileID);
    try {
      const next = style('#3366aa', 'city');
      tileset.setStyle(next);
      internals.residency.published('city', tileID);
      const third = style('#3366aa', 'region');
      tileset.setStyle(third);
      expect(tileset.contains(surface)).toBe(true);
      expect(internals.residency.drawRanks.has(`city/${tileID.key}`)).toBe(false);
      internals.residency.published('region', tileID);
      expect([...internals.residency.hiddenStyleTiles]).toEqual([`region/${tileID.key}`]);
      expect(internals.vector.getTileCollections(`land/${tileID.key}`)).toContain(surface);
    }
    finally { tileset.destroy(); }
  });

  it('cancels a source handoff when the next style removes all source layers', async () => {
    const initial: StyleSpecification = {
      ...style(),
      // Root settings captured from the VersaTiles colorful public style.
      sky: {
        'sky-color': 'rgb(191,217,242)',
        'horizon-color': 'rgb(255,255,255)',
        'fog-color': 'rgb(255,255,255)',
        'sky-horizon-blend': 0.8,
        'horizon-fog-blend': 0.8,
        'fog-ground-blend': 0.5,
        'atmosphere-blend': 0,
      },
      projection: { type: 'globe' },
    };
    const { tileset, surface, tileID } = await loadedSurface(initial);
    const internals = (tileset as unknown as { _renderer: { residency: TileResidency } })._renderer;
    internals.residency.published('land', tileID);
    try {
      const next = { ...initial, ...style('#3366aa', 'city') };
      tileset.setStyle(next);
      expect(tileset.contains(surface)).toBe(true);
      const background: StyleSpecification = { ...initial, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#22aa55' } }] };
      tileset.setStyle(background);
      expect(tileset.contains(surface)).toBe(false);
      expect(tileset.stats().bucket.tiles).toBe(0);
      expect(internals.residency.hiddenStyleTiles.size).toBe(0);
      expect(internals.residency.completeSourceReplacement()).toBe(false);
      expect(tileset.styleSpec).toEqual(background);
      tileset.setStyle(initial);
      expect(tileset.styleSpec).toEqual(initial);
      expect(() => tileset.setStyle({ ...initial, sky: { 'sky-color': '#ffffff' } })).toThrow('Unimplemented: setSky');
      expect(tileset.styleSpec).toEqual(initial);
    }
    finally { tileset.destroy(); }
  });

  it('retains old LOD coverage through worker reparse and releases it after the new surface uploads', async () => {
    const { tileset, surface, tileID } = await loadedSurface();
    const internals = (tileset as unknown as { _renderer: { style: Style; vector: VectorTileRenderer; residency: TileResidency; collections: SceneCollections } })._renderer;
    internals.residency.published('land', tileID);
    const next = style('#22aa55');
    next.layers[0].filter = ['==', ['get', 'kind'], 'water'];
    const childID = new OverscaledTileID(13, 0, 13, 4096, 2724);
    const child = new Tile(childID, 512);
    child.state = 'reloading';
    const pyramid = internals.style.tilePyramids.land;
    const loaded = vi.spyOn(pyramid, 'loaded').mockImplementation(() => child.state === 'loaded');
    const lookup = vi.spyOn(pyramid, 'getTileByID').mockImplementation(key => key === childID.key ? child : undefined);
    try {
      tileset.setStyle(next);
      expect(internals.style._updatedSources.land).toBe('reload');
      internals.residency.syncSource('land', pyramid, [childID.key], SceneMode.SCENE3D);
      expect(tileset.contains(surface)).toBe(true);
      expect(surface.show).toBe(true);
      expect(internals.vector.getTileCollections(`land/${tileID.key}`)).toContain(surface);

      const layer = internals.style.getLayer('land') as FillStyleLayer;
      layer.recalculate(new EvaluationParameters(13), []);
      const bucket = new FillBucket({ layers: [layer], zoom: 13 } as never);
      bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, childID, {});
      child.buckets = { land: bucket };
      child.state = 'loaded';
      buildVectorTile(internals.vector, { tileId: `land/${childID.key}`, buckets: child.buckets, tileID: childID });
      internals.residency.commit({
        sourceId: 'land',
        tileId: `land/${childID.key}`,
        tileID: childID,
        generationId: internals.vector.tileBuildLayers(`land/${childID.key}`)!.generationId,
        stage: 'complete',
        progress: { vector: 'complete', pattern: true, symbol: true },
        buckets: child.buckets,
        styleRevision: internals.style.styleRevision,
        mode: SceneMode.SCENE3D,
        featureIndex: child.latestFeatureIndex,
        retainPreviousGeneration: false,
        previousVector: [],
        retiredVector: [],
        addedVector: [],
        raster: { added: [], removed: [], removedMaterials: [] },
        addedSymbols: [],
        removedSymbols: [],
        firstUpdateSymbols: [],
      });
      const [successor] = internals.vector.getTileCollections(`land/${childID.key}`);
      tileset.add(successor);
      internals.collections.queueFirstUpdate([successor]);
      internals.residency.syncSource('land', pyramid, [childID.key], SceneMode.SCENE3D);
      expect(surface.show).toBe(true);
      expect(tileset.contains(surface)).toBe(true);
      expect(internals.collections.hasPendingFirstUpdate(successor)).toBe(true);

      // The native Buffer collection uploads synchronously. Control its GPU
      // update seam while exercising the real scene queue and residency.
      vi.spyOn(successor as BufferPolygonCollection & { update: (frame: unknown) => void }, 'update').mockImplementation(() => {});
      internals.collections.pumpFirstUpdates({ mode: SceneMode.SCENE3D, commandList: [] } as never, UNBOUNDED_BUDGET);
      expect(internals.collections.hasPendingFirstUpdate(successor)).toBe(false);
      internals.residency.syncSource('land', pyramid, [childID.key], SceneMode.SCENE3D);
      expect(surface.show).toBe(false);
      expect(tileset.contains(surface)).toBe(false);
      expect(successor.show).toBe(true);
      expect(tileset.contains(successor)).toBe(true);
    }
    finally {
      loaded.mockRestore();
      lookup.mockRestore();
      tileset.destroy();
    }
  });

  it('updates paint on a new generation while its predecessor remains frozen', async () => {
    const { tileset, internals, surface } = await loadedSurface();
    try {
      const next = style('#aa3355');
      next.layers[0].filter = ['==', ['get', 'kind'], 'water'];
      tileset.setStyle(next);
      internals.style.update(new EvaluationParameters(12));
      const tileID = new OverscaledTileID(12, 0, 12, 2048, 1362);
      const layer = internals.style.getLayer('land') as FillStyleLayer;
      const bucket = new FillBucket({ layers: [layer], zoom: 12 } as never);
      bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
      buildVectorTile(internals.vector, { tileId: `land/${tileID.key}`, buckets: { land: bucket }, tileID });
      const [successor] = internals.vector.getTileCollections(`land/${tileID.key}`) as BufferPolygonCollection[];
      expect(successor).not.toBe(surface);
      tileset.add(successor);
      const painted = style('#22aa55');
      painted.layers[0].filter = next.layers[0].filter;
      tileset.setStyle(painted);
      internals.style.update(new EvaluationParameters(12));
      internals.vector.updatePaint({ zoom: 12, styleRevision: internals.style.styleRevision, budget: UNBOUNDED_BUDGET });
      expect(successor.get(0, new BufferPolygon()).getMaterial(new BufferPolygonMaterial()).color).toEqual(Color.fromCssColorString('#22aa55'));
      expect((surface as BufferPolygonCollection).get(0, new BufferPolygon()).getMaterial(new BufferPolygonMaterial()).color).toEqual(Color.fromCssColorString('#3366aa'));
    }
    finally { tileset.destroy(); }
  });
});
