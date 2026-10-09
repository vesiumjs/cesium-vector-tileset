import type { SymbolBucket } from '../../packages/cesium-vector-tileset/src/data/bucket-runtime';
import type { FeatureIndex } from '../../packages/cesium-vector-tileset/src/data/feature-index';
import type { SymbolTileGeometry } from '../../packages/cesium-vector-tileset/src/render/symbol/symbol-geometry';
import type { SymbolHalf, SymbolTileInput } from '../../packages/cesium-vector-tileset/src/render/symbol/symbol-renderer';
import type { TestTileset, TestViewer } from './browser-types';
import { tileLocalToWgs84Ecef } from '../../packages/cesium-vector-tileset/src/render/geometry/tile-to-ecef';
import { interpolatedSymbolSize, projectToScreen, symbolViewProjection } from '../../packages/cesium-vector-tileset/src/render/symbol/symbol-placement';

/** Inspect selected real features after timing ends; never traverse geometry in a measured frame. */
export function cityDiagnostics(viewer: TestViewer, tileset: TestTileset, zoom: number) {
  interface Entry {
    input: SymbolTileInput;
    batches: SymbolTileGeometry[];
    layerIds: string[];
    halves: SymbolHalf[];
    collections: Array<{ show: boolean }>;
  }
  const internals = tileset as unknown as {
    _symbolRenderer: { _tiles: Map<string, Entry>; _visibleEntries: Map<string, Entry> };
    _tileResidency: { _tiles: Map<string, { featureIndex?: FeatureIndex }> };
  };
  const matrix = symbolViewProjection(viewer.camera.viewMatrix, viewer.camera.frustum.projectionMatrix);
  const rows = [];
  for (const [tileId, entry] of internals._symbolRenderer._visibleEntries) {
    const featureIndex = internals._tileResidency._tiles.get(tileId)?.featureIndex;
    if (!featureIndex)
      continue;
    for (let batchIndex = 0; batchIndex < entry.batches.length; batchIndex++) {
      const layerId = entry.layerIds[batchIndex];
      const layer = entry.input.layers.find(layer => layer.id === layerId);
      const bucket = entry.input.buckets[layerId] as SymbolBucket | undefined;
      const text = entry.batches[batchIndex].text;
      // Published and source entries have separate constructor identities.
      // The style layer identifies the bucket in either actual library build.
      if (!bucket || layer?.type !== 'symbol' || !text || !layer.sourceLayer)
        continue;
      for (let index = 0; index < bucket.symbolInstances.length; index++) {
        const raw = bucket.symbolInstances.get(index);
        const feature = featureIndex.features.getFeature(layer.sourceLayer, raw.featureIndex);
        if (!feature || !/Westminster|Waterloo|Green Park|Piccadilly/.test(String(feature.properties.name ?? '')))
          continue;
        const anchor = tileLocalToWgs84Ecef(entry.input.tileID, raw.anchorX, raw.anchorY);
        const instance = text.instances.find((instance) => {
          const base = instance.vertexStart * 3;
          return !instance.line && Math.hypot(text.positions[base] - anchor.x, text.positions[base + 1] - anchor.y, text.positions[base + 2] - anchor.z) < 0.01;
        });
        if (!instance)
          continue;
        const vertex = instance.vertexStart;
        const projected = projectToScreen(matrix, viewer.canvas.width, viewer.canvas.height, anchor.x, anchor.y, anchor.z);
        const size = interpolatedSymbolSize(text.sizes[vertex], text.sizesMax[vertex], text.sizeZooms[vertex * 2], text.sizeZooms[vertex * 2 + 1], zoom);
        const box = instance.collisionBox;
        const scale = box && box.layoutSize > 0 ? size / box.layoutSize : 1;
        const screenBox = projected && box
          ? { x1: projected.sx + box.x1 * scale, y1: projected.sy + box.y1 * scale, x2: projected.sx + box.x2 * scale, y2: projected.sy + box.y2 * scale }
          : undefined;
        const uploaded = !text.opacityDirty && entry.halves.some(half => half.opacity?.geometry === text && half.opacity.target?.primitive.ready);
        rows.push({ tileId, layerId, featureIndex: raw.featureIndex, id: feature.id, properties: feature.properties, anchor: projected, screenBox, size, opacity: text.opacities[vertex], uploaded, shown: entry.collections.some(collection => collection.show), current: internals._symbolRenderer._tiles.get(tileId) === entry, vertexCount: instance.vertexCount });
      }
    }
  }
  return rows;
}
