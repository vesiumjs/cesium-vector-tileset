import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { BufferPolygonCollection } from 'cesium';
import type { RenderLayerIndex } from '../render/scene/render-layer-index';
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
  const internals = tileset as unknown as { _style: Style; _vectorRenderer: VectorTileRenderer };
  const tileID = new OverscaledTileID(12, 0, 12, 2048, 1362);
  const layer = internals._style.getLayer('land') as FillStyleLayer;
  layer.recalculate(new EvaluationParameters(12), []);
  const bucket = new FillBucket({ layers: [layer], zoom: 12 } as never);
  bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
  buildVectorTile(internals._vectorRenderer, { tileId: `land/${tileID.key}`, buckets: { land: bucket }, tileID });
  const [surface] = internals._vectorRenderer.getTileCollections(`land/${tileID.key}`);
  tileset.add(surface);
  return { tileset, internals, surface, tileID };
}

describe('style replacement resource lifetime', () => {
  it('holds a deleted source until the new source has finished uploading', async () => {
    const { tileset, surface, tileID } = await loadedSurface();
    const internals = tileset as unknown as { _tileResidency: TileResidency; _sceneCollections: SceneCollections };
    internals._tileResidency.published('land', tileID);
    try {
      const next = style('#22aa55', 'city');
      tileset.setStyle(next);
      expect(tileset.contains(surface)).toBe(true);
      expect(surface.show).toBe(true);
      expect(surface.isDestroyed()).toBe(false);
      const successor = new OverscaledTileID(12, 0, 12, 2048, 1362);
      internals._tileResidency.published('city', successor);
      expect(internals._tileResidency.hiddenStyleTiles.has(`city/${successor.key}`)).toBe(true);
      expect(internals._tileResidency.completeSourceReplacement()).toBe(true);
      expect(tileset.contains(surface)).toBe(false);
      expect(internals._tileResidency.hiddenStyleTiles.size).toBe(0);
      internals._sceneCollections.flushRemovals();
      expect(internals._tileResidency.completeSourceReplacement()).toBe(false);
    }
    finally { tileset.destroy(); }
  });

  it('releases hidden intermediate sources while preserving the visible predecessor', async () => {
    const { tileset, surface, tileID } = await loadedSurface();
    const internals = tileset as unknown as { _tileResidency: TileResidency; _vectorRenderer: VectorTileRenderer };
    internals._tileResidency.published('land', tileID);
    try {
      const next = style('#3366aa', 'city');
      tileset.setStyle(next);
      internals._tileResidency.published('city', tileID);
      const third = style('#3366aa', 'region');
      tileset.setStyle(third);
      expect(tileset.contains(surface)).toBe(true);
      expect(internals._tileResidency.drawRanks.has(`city/${tileID.key}`)).toBe(false);
      internals._tileResidency.published('region', tileID);
      expect([...internals._tileResidency.hiddenStyleTiles]).toEqual([`region/${tileID.key}`]);
      expect(internals._vectorRenderer.getTileCollections(`land/${tileID.key}`)).toContain(surface);
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
    const internals = tileset as unknown as { _tileResidency: TileResidency };
    internals._tileResidency.published('land', tileID);
    try {
      const next = { ...initial, ...style('#3366aa', 'city') };
      tileset.setStyle(next);
      expect(tileset.contains(surface)).toBe(true);
      const background: StyleSpecification = { ...initial, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#22aa55' } }] };
      tileset.setStyle(background);
      expect(tileset.contains(surface)).toBe(false);
      expect(tileset.stats().bucket.tiles).toBe(0);
      expect(internals._tileResidency.hiddenStyleTiles.size).toBe(0);
      expect(internals._tileResidency.completeSourceReplacement()).toBe(false);
      expect(tileset.styleSpec).toEqual(background);
      tileset.setStyle(initial);
      expect(tileset.styleSpec).toEqual(initial);
      expect(() => tileset.setStyle({ ...initial, sky: { 'sky-color': '#ffffff' } })).toThrow('Unimplemented: setSky');
      expect(tileset.styleSpec).toEqual(initial);
    }
    finally { tileset.destroy(); }
  });

  it('keeps recovered source coverage while its new pyramid is still loading', async () => {
    const { tileset, surface, tileID } = await loadedSurface();
    const internals = tileset as unknown as { _tileResidency: TileResidency; _style: Style };
    internals._tileResidency.published('land', tileID);
    try {
      tileset.setStyle(style('#3366aa', 'city'));
      tileset.setStyle(style());
      const pyramid = internals._style.tilePyramids.land;
      const loaded = vi.spyOn(pyramid, 'loaded').mockReturnValue(false);
      try {
        internals._tileResidency.syncSource('land', pyramid, [], SceneMode.SCENE3D);
        expect(tileset.contains(surface)).toBe(true);
        expect(surface.show).toBe(true);
        expect(internals._tileResidency.hiddenStyleTiles.size).toBe(0);
      }
      finally { loaded.mockRestore(); }
    }
    finally { tileset.destroy(); }
  });

  it.each([false, true])('reindexes fill-pattern when its declaration changes (initially %s)', async (patterned) => {
    const initial = style();
    if (patterned) {
      initial.layers[0].paint = { 'fill-pattern': 'texture' };
    }
    const tileset = new CesiumVectorTileset({ style: initial });
    await tileset.whenReady();
    try {
      const next = style();
      if (!patterned) {
        next.layers[0].paint = { 'fill-pattern': 'texture' };
      }
      tileset.setStyle(next);
      const { _renderLayerIndex: plan } = tileset as unknown as { _renderLayerIndex: RenderLayerIndex };
      expect(plan.patternLayers.map(layer => layer.id)).toEqual(patterned ? [] : ['land']);
    }
    finally { tileset.destroy(); }
  });

  it('keeps an uploaded surface through a paint-only change', async () => {
    const { tileset, internals, surface } = await loadedSurface();
    try {
      tileset.setStyle(style('#22aa55'));
      expect(tileset.contains(surface)).toBe(true);
      expect(surface.show).toBe(true);
      expect(tileset.stats().bucket.tiles).toBe(1);
      internals._style.update(new EvaluationParameters(12));
      expect(internals._vectorRenderer.updatePaint({ zoom: 12, styleRevision: internals._style.styleRevision, budget: UNBOUNDED_BUDGET })).toEqual([]);
      expect((surface as BufferPolygonCollection).get(0, new BufferPolygon()).getMaterial(new BufferPolygonMaterial()).color).toEqual(Color.fromCssColorString('#22aa55'));
      expect(surface.isDestroyed()).toBe(false);
      expect(tileset.styleSpec.layers).toEqual(style('#22aa55').layers);
    }
    finally { tileset.destroy(); }
  });

  it('retains the visible generation until a layout replacement is published', async () => {
    const { tileset, surface } = await loadedSurface();
    try {
      const next = style();
      next.layers[0].filter = ['==', ['get', 'kind'], 'water'];
      tileset.setStyle(next);
      expect(tileset.contains(surface)).toBe(true);
      expect(surface.show).toBe(true);
      expect(surface.isDestroyed()).toBe(false);
      expect(tileset.stats().bucket.tiles).toBe(1);
    }
    finally { tileset.destroy(); }
  });

  it('retains old LOD coverage through worker reparse and releases it after the new surface uploads', async () => {
    const { tileset, surface, tileID } = await loadedSurface();
    const internals = tileset as unknown as {
      _style: Style;
      _vectorRenderer: VectorTileRenderer;
      _tileResidency: TileResidency;
      _sceneCollections: SceneCollections;
    };
    internals._tileResidency.published('land', tileID);
    const next = style('#22aa55');
    next.layers[0].filter = ['==', ['get', 'kind'], 'water'];
    const childID = new OverscaledTileID(13, 0, 13, 4096, 2724);
    const child = new Tile(childID, 512);
    child.state = 'reloading';
    const pyramid = internals._style.tilePyramids.land;
    const loaded = vi.spyOn(pyramid, 'loaded').mockImplementation(() => child.state === 'loaded');
    const lookup = vi.spyOn(pyramid, 'getTileByID').mockImplementation(key => key === childID.key ? child : undefined);
    try {
      tileset.setStyle(next);
      expect(internals._style._updatedSources.land).toBe('reload');
      internals._tileResidency.syncSource('land', pyramid, [childID.key], SceneMode.SCENE3D);
      expect(tileset.contains(surface)).toBe(true);
      expect(surface.show).toBe(true);
      expect(internals._vectorRenderer.getTileCollections(`land/${tileID.key}`)).toContain(surface);

      const layer = internals._style.getLayer('land') as FillStyleLayer;
      layer.recalculate(new EvaluationParameters(13), []);
      const bucket = new FillBucket({ layers: [layer], zoom: 13 } as never);
      bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, childID, {});
      child.buckets = { land: bucket };
      child.state = 'loaded';
      buildVectorTile(internals._vectorRenderer, { tileId: `land/${childID.key}`, buckets: child.buckets, tileID: childID });
      internals._tileResidency.published('land', childID);
      const [successor] = internals._vectorRenderer.getTileCollections(`land/${childID.key}`);
      tileset.add(successor);
      internals._sceneCollections.queueFirstUpdate([successor]);
      internals._tileResidency.syncSource('land', pyramid, [childID.key], SceneMode.SCENE3D);
      expect(surface.show).toBe(true);
      expect(tileset.contains(surface)).toBe(true);
      expect(internals._sceneCollections.hasPendingFirstUpdate(successor)).toBe(true);

      // The native Buffer collection uploads synchronously. Control its GPU
      // update seam while exercising the real scene queue and residency.
      vi.spyOn(successor as BufferPolygonCollection & { update: (frame: unknown) => void }, 'update').mockImplementation(() => {});
      internals._sceneCollections.pumpFirstUpdates({ mode: SceneMode.SCENE3D, commandList: [] } as never, UNBOUNDED_BUDGET);
      expect(internals._sceneCollections.hasPendingFirstUpdate(successor)).toBe(false);
      internals._tileResidency.syncSource('land', pyramid, [childID.key], SceneMode.SCENE3D);
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

  it('keeps constant paint visible while source-dependent paint needs new worker attributes', async () => {
    const { tileset, internals, surface } = await loadedSurface();
    try {
      const collection = surface as BufferPolygonCollection;
      const color = () => collection.get(0, new BufferPolygon()).getMaterial(new BufferPolygonMaterial()).color;
      const previous = Color.clone(color());
      const next = style();
      next.layers[0].paint = { 'fill-color': ['get', 'color'], 'fill-antialias': false };
      tileset.setStyle(next);
      internals._style.update(new EvaluationParameters(12));
      internals._vectorRenderer.updatePaint({ zoom: 12, styleRevision: internals._style.styleRevision, budget: UNBOUNDED_BUDGET });
      expect(color()).toEqual(previous);
      expect(collection.show).toBe(true);
      expect(collection.isDestroyed()).toBe(false);
      expect(tileset.contains(collection)).toBe(true);
    }
    finally { tileset.destroy(); }
  });

  it('keeps the old solid color while its pattern generation is rebuilding', async () => {
    const { tileset, internals, surface } = await loadedSurface();
    try {
      const collection = surface as BufferPolygonCollection;
      const color = () => collection.get(0, new BufferPolygon()).getMaterial(new BufferPolygonMaterial()).color;
      const previous = Color.clone(color());
      const next = style();
      next.layers[0].paint = { 'fill-pattern': 'texture', 'fill-antialias': false };
      tileset.setStyle(next);
      internals._style.update(new EvaluationParameters(12));
      internals._vectorRenderer.updatePaint({ zoom: 12, styleRevision: internals._style.styleRevision, budget: UNBOUNDED_BUDGET });
      expect(color()).toEqual(previous);
      expect(collection.show).toBe(true);
      expect(collection.isDestroyed()).toBe(false);
    }
    finally { tileset.destroy(); }
  });

  it('updates paint on a new generation while its predecessor remains frozen', async () => {
    const { tileset, internals, surface } = await loadedSurface();
    try {
      const next = style('#aa3355');
      next.layers[0].filter = ['==', ['get', 'kind'], 'water'];
      tileset.setStyle(next);
      internals._style.update(new EvaluationParameters(12));
      const tileID = new OverscaledTileID(12, 0, 12, 2048, 1362);
      const layer = internals._style.getLayer('land') as FillStyleLayer;
      const bucket = new FillBucket({ layers: [layer], zoom: 12 } as never);
      bucket.addFeature({} as never, [[new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096)]], 0, tileID, {});
      buildVectorTile(internals._vectorRenderer, { tileId: `land/${tileID.key}`, buckets: { land: bucket }, tileID });
      const [successor] = internals._vectorRenderer.getTileCollections(`land/${tileID.key}`) as BufferPolygonCollection[];
      expect(successor).not.toBe(surface);
      tileset.add(successor);
      const painted = style('#22aa55');
      painted.layers[0].filter = next.layers[0].filter;
      tileset.setStyle(painted);
      internals._style.update(new EvaluationParameters(12));
      internals._vectorRenderer.updatePaint({ zoom: 12, styleRevision: internals._style.styleRevision, budget: UNBOUNDED_BUDGET });
      expect(successor.get(0, new BufferPolygon()).getMaterial(new BufferPolygonMaterial()).color).toEqual(Color.fromCssColorString('#22aa55'));
      expect((surface as BufferPolygonCollection).get(0, new BufferPolygon()).getMaterial(new BufferPolygonMaterial()).color).toEqual(Color.fromCssColorString('#3366aa'));
    }
    finally { tileset.destroy(); }
  });
});
