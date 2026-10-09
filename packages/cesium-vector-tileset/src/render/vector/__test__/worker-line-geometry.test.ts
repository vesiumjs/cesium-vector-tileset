import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { FeatureCollection } from 'geojson';
import type { WorkerTileParameters, WorkerTileWithData } from '../../../source/worker-source';
import type { Style } from '../../../style/style';
import type { WorkerMessageSender } from '../../../worker/worker-channel';
import { SceneMode } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashAtlas } from '../../../assets/dash-atlas';
import { LineBucket } from '../../../data/bucket-runtime';
import { GeoJSONWorkerSource } from '../../../source/geojson-worker-source';
import { StyleLayerIndex } from '../../../style/style-layer-index';
import { Tile } from '../../../tile/tile';
import { OverscaledTileID } from '../../../tile/tile-id';
import { createTileTransferRegistry } from '../../../worker/tile-transfer';
import { lineInputs } from '../../geometry/line-input';
import { DashMaterial, dashRowsForFeature } from '../../line/dash-material';
import { createLineGeometry, LineGeometryCache } from '../../line/line-geometry';
import { beginLineBuild, commitLineBuild, discardLineBuild, stepLineBuild } from '../../line/line-renderer';
import * as preparedGeometry from '../../line/prepared-line-geometry';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { projectWorkerBuckets } from '../bucket-geometry';
import { advanceTileConversion, beginTileConversion } from '../tile-conversion';

function sourceRecords(geometry: NonNullable<ReturnType<typeof createLineGeometry>>) {
  const input = lineInputs.get(geometry)!;
  return {
    positions: Array.from(input.positions),
    vertices: Array.from(input.vertices),
    closed: input.closed,
    ...('longitudes' in input ? { longitudes: Array.from(input.longitudes) } : {}),
  };
}

async function workerLines(dashed = false, longPath = false) {
  const layers: LayerSpecification[] = ['round', 'miter'].map(join => ({
    id: join,
    type: 'line',
    source: 'roads',
    filter: ['==', ['get', 'join'], join],
    layout: { 'line-join': join as 'round' | 'miter', 'line-cap': join === 'round' ? 'round' : 'square' },
    ...(dashed ? { paint: { 'line-dasharray': [2, 1] } } : {}),
  }));
  const index = new StyleLayerIndex(layers);
  const worker = new GeoJSONWorkerSource({ sendAsync: vi.fn().mockResolvedValue({}) } as unknown as WorkerMessageSender, index, []);
  const paths = [
    [[-10, 20], [-8, 21], [-8, 21], [-7, 20]],
    [[170, 10], [190, 15], [170, 20]],
    [[10, 20], [11, 22], [13, 20], [10, 20]],
  ];
  const data: FeatureCollection = {
    type: 'FeatureCollection',
    features: ['round', 'miter'].flatMap(join => paths.map(coordinates => ({ type: 'Feature' as const, properties: { join }, geometry: { type: 'LineString' as const, coordinates } }))),
  };
  await worker.loadData({ type: 'geojson', source: 'roads', data, geojsonVtOptions: { extent: 8192, tolerance: 0 } });
  const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
  const parameters: WorkerTileParameters = { uid: 'roads', type: 'geojson', source: 'roads', tileID, zoom: 0, tileSize: 512, pixelRatio: 1, promoteId: undefined, request: { url: '' }, encoding: 'mvt' };
  const parsed = await worker.loadTile(parameters) as WorkerTileWithData;
  if (longPath) {
    const bucket = parsed.buckets.find(bucket => bucket instanceof LineBucket && bucket.layers[0].id === 'round') as LineBucket;
    const points = new Int16Array(24000 * 2);
    for (let index = 0; index < points.length / 2; index++) {
      points[index * 2] = 4000 + index % 3;
      points[index * 2 + 1] = 3600 + index % 2;
    }
    bucket.linePaths.push({ featureIndex: bucket.linePaths[0].featureIndex, points });
  }
  projectWorkerBuckets(parsed.buckets, tileID);
  const expected = new Map<string, Array<{ geometry: NonNullable<ReturnType<typeof createLineGeometry>>; input: ReturnType<typeof sourceRecords>; featureIndex: number }>>();
  for (const bucket of parsed.buckets) {
    if (!(bucket instanceof LineBucket))
      continue;
    expected.set(bucket.layers[0].id, Array.from(bucket.projectedGeometry!.lines!, (source) => {
      const geometry = createLineGeometry(source.positions, { ...(bucket.featureLineJoinCaps[source.featureIndex] ?? bucket.lineJoinCap), widthPx: 255 }, false, { tileID: tileID.canonical, tilePositions: source.tilePositions })!;
      return { geometry, featureIndex: source.featureIndex, input: sourceRecords(geometry) };
    }));
  }
  const transfers: Transferable[] = [];
  const serialized = createTileTransferRegistry().serialize(parsed, transfers);
  const restored = createTileTransferRegistry().deserialize(structuredClone(serialized, { transfer: transfers })) as WorkerTileWithData;
  const tile = new Tile(tileID, 512);
  tile.loadVectorData(restored, { hasLayer: (id: string) => id in index._layers, getLayer: (id: string) => index._layers[id] } as unknown as Style);
  return { tile, tileID, expected };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('worker solid line compilation', () => {
  it('transfers complete strips and reuses them across publications without main-thread compilation', async () => {
    const { tile, tileID, expected } = await workerLines();
    const inputs = Array.from(expected.values()).flat().map(reference => reference.input);
    expect(inputs.some(input => input.closed)).toBe(true);
    expect(inputs.some(input => input.longitudes?.some(longitude => Math.abs(longitude) > Math.PI))).toBe(true);
    const compiler = vi.spyOn(LineGeometryCache.prototype, 'compile');
    const firstGeometries: object[] = [];
    for (let publication = 0; publication < 2; publication++) {
      const conversion = beginTileConversion(tile.buckets, tileID, 7, 'roads', undefined, undefined, publication * 2, SceneMode.SCENE3D);
      expect(advanceTileConversion(conversion, UNBOUNDED_BUDGET)).toBe(true);
      const build = beginLineBuild(conversion.result.linePrimitives, tile.buckets, 'roads/0', tileID, 7, publication * 2);
      expect(stepLineBuild(build, UNBOUNDED_BUDGET)).toBe(true);
      expect(compiler).not.toHaveBeenCalled();
      let geometryIndex = 0;
      for (const layer of build.byLayer) {
        const references = expected.get(layer.layerId)!;
        expect(layer.instances).toHaveLength(references.length);
        for (const [index, instance] of layer.instances!.entries()) {
          expect(Object.keys(instance.geometry.attributes)).toEqual(Object.keys(references[index].geometry.attributes));
          for (const [name, attribute] of Object.entries(instance.geometry.attributes)) {
            const expectedAttribute = (references[index].geometry.attributes as unknown as Record<string, typeof attribute>)[name];
            expect(attribute.componentDatatype).toBe(expectedAttribute.componentDatatype);
            expect(attribute.componentsPerAttribute).toBe(expectedAttribute.componentsPerAttribute);
            expect(attribute.normalize).toBe(expectedAttribute.normalize);
            expect(Array.from(attribute.values)).toEqual(Array.from(expectedAttribute.values));
          }
          const indices = instance.geometry.indices as unknown as Uint16Array | Uint32Array;
          const expectedIndices = references[index].geometry.indices as unknown as Uint16Array | Uint32Array;
          expect(indices.BYTES_PER_ELEMENT).toBe(expectedIndices.BYTES_PER_ELEMENT);
          expect(Array.from(indices)).toEqual(Array.from(expectedIndices));
          expect(instance.geometry.boundingSphere).toEqual(references[index].geometry.boundingSphere);
          expect(sourceRecords(instance.geometry)).toEqual(references[index].input);
          expect(instance.id).toEqual({ type: 'line', tileId: 'roads/0', layerId: layer.layerId, featureIndex: references[index].featureIndex, generationId: 7 });
          if (publication === 0)
            firstGeometries.push(instance.geometry);
          else expect(instance.geometry).toBe(firstGeometries[geometryIndex]);
          geometryIndex++;
        }
      }
      commitLineBuild(build)!.destroy();
      discardLineBuild(build);
    }
  });

  it('preserves wide strip indices through the same packed Worker transport', async () => {
    const { tile, tileID, expected } = await workerLines(false, true);
    const compiler = vi.spyOn(LineGeometryCache.prototype, 'compile');
    const conversion = beginTileConversion(tile.buckets, tileID, 7, 'roads', undefined, undefined, 0, SceneMode.SCENE3D);
    advanceTileConversion(conversion, UNBOUNDED_BUDGET);
    const build = beginLineBuild(conversion.result.linePrimitives, tile.buckets, 'roads/0', tileID, 7, 0);
    expect(stepLineBuild(build, UNBOUNDED_BUDGET)).toBe(true);
    expect(compiler).not.toHaveBeenCalled();
    const actual = build.byLayer.find(layer => layer.layerId === 'round')!.instances!.at(-1)!.geometry;
    const reference = expected.get('round')!.at(-1)!;
    const indices = actual.indices as unknown as Uint32Array;
    expect(indices.BYTES_PER_ELEMENT).toBe(4);
    expect(Array.from(indices)).toEqual(Array.from(reference.geometry.indices!));
    expect(sourceRecords(actual)).toEqual(reference.input);
    discardLineBuild(build);
  });

  it.each([SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW])('retains the scene-specific planar compiler (mode %s)', async (mode) => {
    const { tile, tileID } = await workerLines();
    const compiler = vi.spyOn(LineGeometryCache.prototype, 'compile');
    const conversion = beginTileConversion(tile.buckets, tileID, 7, 'roads', undefined, undefined, 0, mode);
    advanceTileConversion(conversion, UNBOUNDED_BUDGET);
    const build = beginLineBuild(conversion.result.linePrimitives, tile.buckets, 'roads/0', tileID, 7, 0, true);
    expect(stepLineBuild(build, UNBOUNDED_BUDGET)).toBe(true);
    expect(compiler.mock.calls).toHaveLength(conversion.result.linePrimitives.length);
    for (const layer of build.byLayer) {
      const bucket = tile.buckets[layer.layerId] as LineBucket;
      for (const [index, source] of layer.sources.entries()) {
        const expected = createLineGeometry(source.positions, { ...(bucket.featureLineJoinCaps[source.featureIndex] ?? bucket.lineJoinCap), widthPx: 255 }, true, { tileID: tileID.canonical, tilePositions: source.tilePositions })!;
        expect(layer.instances![index].geometry.attributes).toEqual(expected.attributes);
        expect(layer.instances![index].geometry.indices).toEqual(expected.indices);
        expect(sourceRecords(layer.instances![index].geometry)).toEqual(sourceRecords(expected));
      }
    }
    discardLineBuild(build);
  });

  it('recompiles only a changed layout or replaced source owner', async () => {
    const { tile, tileID } = await workerLines();
    const conversion = beginTileConversion(tile.buckets, tileID, 7, 'roads', undefined, undefined, 0, SceneMode.SCENE3D);
    advanceTileConversion(conversion, UNBOUNDED_BUDGET);
    const source = conversion.result.linePrimitives[0];
    const bucket = tile.buckets[source.layerId] as LineBucket;
    const original = bucket.featureLineJoinCaps[source.featureIndex] ?? bucket.lineJoinCap;
    bucket.featureLineJoinCaps[source.featureIndex] = { ...original, join: 'bevel' };
    const compiler = vi.spyOn(LineGeometryCache.prototype, 'compile');
    const changed = beginLineBuild([source], tile.buckets, 'roads/0', tileID, 7, 0);
    expect(stepLineBuild(changed, UNBOUNDED_BUDGET)).toBe(true);
    expect(compiler).toHaveBeenCalledTimes(1);
    const expected = createLineGeometry(source.positions, { ...original, join: 'bevel', widthPx: 255 }, false, { tileID: tileID.canonical, tilePositions: source.tilePositions })!;
    expect(changed.byLayer[0].instances![0].geometry.attributes).toEqual(expected.attributes);
    discardLineBuild(changed);
    bucket.featureLineJoinCaps[source.featureIndex] = original;
    compiler.mockClear();
    const replaced = beginLineBuild([{ ...source, positions: source.positions.slice() }], tile.buckets, 'roads/0', tileID, 7, 0);
    expect(stepLineBuild(replaced, UNBOUNDED_BUDGET)).toBe(true);
    expect(compiler).toHaveBeenCalledTimes(1);
    discardLineBuild(replaced);
  });

  it('leaves dash-only buckets to the live scene atlas compiler', async () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    const preparation = vi.spyOn(preparedGeometry, 'prepareLineGeometry');
    const { tile, tileID } = await workerLines(true);
    expect(preparation).not.toHaveBeenCalled();
    const dash = { material: new DashMaterial(new DashAtlas(256, 64)) };
    const compiler = vi.spyOn(LineGeometryCache.prototype, 'compile');
    const conversion = beginTileConversion(tile.buckets, tileID, 7, 'roads', undefined, undefined, 0, SceneMode.SCENE3D);
    advanceTileConversion(conversion, UNBOUNDED_BUDGET);
    expect(conversion.result.linePrimitives.every(source => source.prepared === undefined)).toBe(true);
    const build = beginLineBuild(conversion.result.linePrimitives, tile.buckets, 'roads/0', tileID, 7, 0, false, dash);
    expect(stepLineBuild(build, UNBOUNDED_BUDGET)).toBe(true);
    expect(compiler.mock.calls).toHaveLength(conversion.result.linePrimitives.length);
    for (const layer of build.byLayer) {
      const bucket = tile.buckets[layer.layerId] as LineBucket;
      for (const [index, source] of layer.sources.entries()) {
        const rows = dashRowsForFeature(bucket, source.featureIndex, layer.layerId, undefined, dash.material.atlas)!;
        const expected = createLineGeometry(source.positions, { ...(bucket.featureLineJoinCaps[source.featureIndex] ?? bucket.lineJoinCap), widthPx: 255, dashFrom: rows.from, dashTo: rows.to }, false, { tileID: tileID.canonical, tilePositions: source.tilePositions })!;
        expect(layer.instances![index].geometry.attributes).toEqual(expected.attributes);
        expect(layer.instances![index].geometry.indices).toEqual(expected.indices);
        expect(sourceRecords(layer.instances![index].geometry)).toEqual(sourceRecords(expected));
      }
    }
    discardLineBuild(build);
    dash.material.destroy();
  });
});
