import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { FeatureCollection } from 'geojson';
import type { WorkerTileParameters, WorkerTileWithData } from '../../source/worker-source';
import type { Style } from '../../style/style';
import type { WorkerMessageSender } from '../../worker/worker-channel';
import type { ProjectedBucketGeometry } from '../projected-geometry';
import { SceneMode } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { UNBOUNDED_BUDGET } from '../../render/scene/frame-budget';
import { fillBucketPrimitives, lineBucketPrimitives, projectWorkerBuckets } from '../../render/vector/bucket-geometry';
import { advanceTileConversion, beginTileConversion } from '../../render/vector/tile-conversion';
import { GeoJSONWorkerSource } from '../../source/geojson-worker-source';
import { StyleLayerIndex } from '../../style/style-layer-index';
import { Tile } from '../../tile/tile';
import { OverscaledTileID } from '../../tile/tile-id';
import { createTileTransferRegistry } from '../../worker/tile-transfer';
import { FillBucket } from '../bucket-runtime';

function graph(value: unknown) {
  const seen = new Set<object>();
  let objects = 0;
  let views = 0;
  const visit = (input: unknown): void => {
    if (!input || typeof input !== 'object' || seen.has(input))
      return;
    seen.add(input);
    if (ArrayBuffer.isView(input)) {
      views++;
      return;
    }
    if (input instanceof ArrayBuffer)
      return;
    objects++;
    if (input instanceof Map) {
      for (const entry of input.values()) visit(entry);
    }
    else {
      for (const entry of Object.values(input)) visit(entry);
    }
  };
  visit(value);
  return { objects, views };
}

function snapshot(geometry: ProjectedBucketGeometry) {
  return {
    fill: geometry.fill && Array.from(geometry.fill, primitive => ({
      ...primitive,
      positions: Array.from(primitive.positions),
      triangles: Array.from(primitive.triangles),
      holes: Array.from(primitive.holes),
    })),
    lines: geometry.lines && Array.from(geometry.lines, primitive => ({
      ...primitive,
      positions: Array.from(primitive.positions),
      tilePositions: Array.from(primitive.tilePositions),
      prepared: primitive.prepared && Object.fromEntries(Object.entries(primitive.prepared).map(([key, value]) => [key, ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value])),
    })),
    fillOutlines: geometry.fillOutlines && Array.from(geometry.fillOutlines, paths => Array.from(paths, path => ({ ...path, positions: Array.from(path.positions), tilePositions: Array.from(path.tilePositions) }))),
    fillPlanarOutlines: geometry.fillPlanarOutlines && Array.from(geometry.fillPlanarOutlines, paths => Array.from(paths, path => ({ ...path, positions: Array.from(path.positions), tilePositions: Array.from(path.tilePositions) }))),
    circles: geometry.circles && Array.from(geometry.circles, primitive => ({ ...primitive, position: [...primitive.position] })),
  };
}

async function transport(count: number) {
  const layers: LayerSpecification[] = [
    { id: 'fill', type: 'fill', source: 'geometry', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#448866' } },
    { id: 'fill-copy', type: 'fill', source: 'geometry', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#448866' } },
    { id: 'line', type: 'line', source: 'geometry', filter: ['==', ['geometry-type'], 'LineString'] },
    { id: 'circle', type: 'circle', source: 'geometry', filter: ['==', ['geometry-type'], 'Point'] },
  ];
  const index = new StyleLayerIndex(layers);
  const worker = new GeoJSONWorkerSource({ sendAsync: vi.fn().mockResolvedValue({}) } as unknown as WorkerMessageSender, index, []);
  const data: FeatureCollection = { type: 'FeatureCollection', features: [] };
  for (let feature = 0; feature < count; feature++) {
    const x = -40 + feature * 0.5;
    data.features.push(
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [
        [[x, 10], [x + 2, 10], [x + 2, 12], [x, 12], [x, 10]],
        [[x + 0.5, 10.5], [x + 0.5, 11.5], [x + 1.5, 11.5], [x + 1.5, 10.5], [x + 0.5, 10.5]],
      ] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[x, 15], [x + 1, 16], [x + 1, 16], [x + 2, 15], [x, 15]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [x, 20] } },
    );
  }
  await worker.loadData({ type: 'geojson', source: 'geometry', data, geojsonVtOptions: { extent: 8192, tolerance: 0 } });
  const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
  const parameters: WorkerTileParameters = { uid: 'packed', type: 'geojson', source: 'geometry', tileID, zoom: 0, tileSize: 512, pixelRatio: 1, promoteId: undefined, request: { url: '' }, encoding: 'mvt' };
  const parsed = await worker.loadTile(parameters) as WorkerTileWithData;
  projectWorkerBuckets(parsed.buckets, tileID);
  const expected = parsed.buckets.map(bucket => snapshot(bucket.projectedGeometry!));
  const transfers: Transferable[] = [];
  const serialized = createTileTransferRegistry().serialize(parsed, transfers) as { buckets: Array<{ projectedGeometry: object }> };
  const wireGraphs = serialized.buckets.map(bucket => graph(bucket.projectedGeometry));
  const restored = createTileTransferRegistry().deserialize(structuredClone(serialized, { transfer: transfers })) as WorkerTileWithData;
  const receiveGraphs = restored.buckets.map(bucket => graph(bucket.projectedGeometry));
  const tile = new Tile(tileID, 512);
  tile.loadVectorData(restored, { hasLayer: (id: string) => id in index._layers, getLayer: (id: string) => index._layers[id] } as unknown as Style);
  return { parsed: restored, tile, tileID, expected, wireGraphs, receiveGraphs };
}

describe('projected geometry transport', () => {
  it('keeps wire and initial receive object/view counts bounded by bucket count', async () => {
    const small = await transport(8);
    const dense = await transport(128);
    expect(dense.wireGraphs).toEqual(small.wireGraphs);
    expect(dense.wireGraphs).toEqual([{ objects: 4, views: 12 }, { objects: 4, views: 12 }, { objects: 2, views: 2 }]);
    expect(dense.receiveGraphs).toEqual(small.receiveGraphs);
    expect(dense.receiveGraphs.every(measured => measured.views === 0)).toBe(true);
    for (const measured of [...dense.wireGraphs, ...dense.receiveGraphs]) {
      expect(measured.objects).toBeLessThanOrEqual(12);
      expect(measured.views).toBeLessThanOrEqual(12);
    }
  });

  it.each([SceneMode.SCENE3D, SceneMode.SCENE2D])('restores exact topology and stable source views before real tile conversion (mode %s)', async (mode) => {
    const { parsed, tile, tileID, expected } = await transport(8);
    expect(parsed.buckets.map(bucket => snapshot(bucket.projectedGeometry!))).toEqual(expected);
    for (const bucket of parsed.buckets) {
      const geometry = bucket.projectedGeometry!;
      for (const list of [geometry.fill, geometry.lines, geometry.circles, geometry.fillOutlines, geometry.fillPlanarOutlines]) {
        if (list?.length)
          expect(list.get(0)).toBe(list.get(0));
      }
    }
    expect(tile.buckets['fill-copy']).toBe(tile.buckets.fill);
    for (const bucket of parsed.buckets) {
      if (bucket instanceof FillBucket && (mode === SceneMode.SCENE2D || mode === SceneMode.COLUMBUS_VIEW))
        fillBucketPrimitives(bucket, tileID, mode);
    }
    const state = beginTileConversion(tile.buckets, tileID, 11, 'geometry', undefined, undefined, 0, mode);
    expect(advanceTileConversion(state, UNBOUNDED_BUDGET)).toBe(true);
    expect(state.result.polygons).toHaveLength(16);
    expect(state.result.points).toHaveLength(8);
    expect(state.result.linePrimitives.length).toBeGreaterThanOrEqual(40);
    for (const source of state.result.linePrimitives.filter(source => source.layerId === 'line')) {
      const projected = (mode === SceneMode.SCENE2D || mode === SceneMode.COLUMBUS_VIEW
        ? lineBucketPrimitives(tile.buckets.line as import('../bucket-runtime').LineBucket, tileID, mode)
        : Array.from(tile.buckets.line.projectedGeometry!.lines!)).find(primitive => primitive.featureIndex === source.featureIndex)!;
      expect(source.positions).toEqual(projected.positions);
      expect(source.tilePositions).toEqual(projected.tilePositions);
      expect(source.positions.buffer).toBe(projected.positions.buffer);
      expect(source.tilePositions.buffer).toBe(projected.tilePositions.buffer);
      if (mode === SceneMode.SCENE3D || mode === SceneMode.MORPHING) {
        expect(source.positions).toBe(projected.positions);
        expect(source.tilePositions).toBe(projected.tilePositions);
      }
    }
  });
});
