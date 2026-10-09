import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { FeatureCollection, MultiPolygon } from 'geojson';
import type { WorkerTileParameters, WorkerTileWithData } from '../../../source/worker-source';
import type { Style } from '../../../style/style';
import type { WorkerMessageSender } from '../../../worker/worker-channel';
import { SceneMode } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FillBucket } from '../../../data/bucket-runtime';
import { GeoJSONWorkerSource } from '../../../source/geojson-worker-source';
import { StyleLayerIndex } from '../../../style/style-layer-index';
import { Tile } from '../../../tile/tile';
import { OverscaledTileID } from '../../../tile/tile-id';
import { createTileTransferRegistry } from '../../../worker/tile-transfer';
import * as tileToEcef from '../../geometry/tile-to-ecef';
import { beginLineBuild, commitLineBuild, stepLineBuild } from '../../line/line-renderer';
import { drawBatchForOwner, linePaintForOwner } from '../../scene/draw-batch';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { fillBucketPrimitives, fillOutlinePaths, projectWorkerBuckets } from '../bucket-geometry';
import { advanceTileConversion, beginTileConversion } from '../tile-conversion';

const geometry: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [[-10, 10], [10, 10], [10, 30], [-10, 30], [-10, 10]],
      [[-5, 15], [-5, 25], [5, 25], [5, 15], [-5, 15]],
    ],
    [[[30, 10], [40, 10], [40, 20], [30, 20], [30, 10]]],
  ],
};

async function workerTile(sourceGeometry = geometry) {
  const layers: LayerSpecification[] = ['parks', 'parks-copy'].map(id => ({
    id,
    type: 'fill',
    source: 'polygons',
    filter: ['==', ['get', 'keep'], true],
    paint: { 'fill-color': '#338866' },
  }));
  const index = new StyleLayerIndex(layers);
  const channel = { sendAsync: vi.fn().mockResolvedValue({}) } as unknown as WorkerMessageSender;
  const worker = new GeoJSONWorkerSource(channel, index, []);
  const data: FeatureCollection = {
    type: 'FeatureCollection',
    features: [false, true].map((keep, id) => ({ type: 'Feature', id, properties: { keep }, geometry: sourceGeometry })),
  };
  await worker.loadData({ type: 'geojson', source: 'polygons', data, geojsonVtOptions: { extent: 8192, tolerance: 0 } });
  const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
  const parameters: WorkerTileParameters = {
    uid: 'outlines',
    type: 'geojson',
    source: 'polygons',
    tileID,
    zoom: 0,
    tileSize: 512,
    pixelRatio: 1,
    promoteId: undefined,
    request: { url: '' },
    encoding: 'mvt',
  };
  const parsed = await worker.loadTile(parameters) as WorkerTileWithData;
  const parsedBucket = parsed.buckets.find(bucket => bucket instanceof FillBucket) as FillBucket;
  const sourceVertices = parsedBucket.layoutVertexArray.int16.slice();
  const sourceIndices = parsedBucket.indexArray.uint16.slice();
  projectWorkerBuckets(parsed.buckets, tileID);
  expect(parsedBucket.layoutVertexArray.int16).toEqual(sourceVertices);
  expect(parsedBucket.indexArray.uint16).toEqual(sourceIndices);
  const paths = Array.from(parsedBucket.projectedGeometry?.fillOutlines ?? []).flat();
  const outlineBackings = new Set(paths.flatMap(path => [path.positions.buffer, path.tilePositions.buffer]));
  const outlineBytes = [...outlineBackings].reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
  const planarPaths = Array.from(parsedBucket.projectedGeometry?.fillPlanarOutlines ?? []).flat();
  const planarBackings = new Set(planarPaths.flatMap(path => [path.positions.buffer, path.tilePositions.buffer]));
  const planarBytes = [...planarBackings].reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
  const transfers: Transferable[] = [];
  const serialized = createTileTransferRegistry().serialize(parsed, transfers);
  const outlineTransfers = transfers.filter(transfer => outlineBackings.has(transfer as ArrayBuffer));
  const planarTransfers = transfers.filter(transfer => planarBackings.has(transfer as ArrayBuffer));
  const received = createTileTransferRegistry().deserialize(structuredClone(serialized, { transfer: transfers })) as WorkerTileWithData;
  const style = {
    hasLayer: (id: string) => id in index._layers,
    getLayer: (id: string) => index._layers[id],
  } as unknown as Style;
  const tile = new Tile(tileID, 512);
  tile.loadVectorData(received, style);
  const bucket = tile.buckets.parks;
  if (!(bucket instanceof FillBucket))
    throw new TypeError('fixture must parse a fill bucket');
  return { tile, bucket, tileID, outlineBytes, outlineTransfers, outlineBackings, planarBytes, planarTransfers, planarBackings };
}

afterEach(() => vi.restoreAllMocks());

describe('worker fill outlines', () => {
  it.each([SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW])('preserves unsampled planar outer and hole rings through transfer and conversion (mode %s)', async (mode) => {
    const { tile, bucket, tileID } = await workerTile({
      type: 'MultiPolygon',
      coordinates: [[
        [[-11, 8], [11, 12], [15, 32], [-9, 30], [-11, 8]],
        [[-4, 16], [-2, 24], [7, 25], [5, 17], [-4, 16]],
      ]],
    });
    const rings = bucket.polygons.flatMap((polygon) => {
      const starts = [0, ...polygon.holes];
      return starts.map((start, index) => {
        const end = starts[index + 1] ?? polygon.vertexLength;
        const points = Array.from(bucket.layoutVertexArray.int16.subarray((polygon.vertexOffset + start) * 2, (polygon.vertexOffset + end) * 2));
        if (points[0] !== points.at(-2) || points[1] !== points.at(-1))
          points.push(points[0], points[1]);
        return points;
      });
    });
    expect(rings).toHaveLength(2);
    fillBucketPrimitives(bucket, tileID, mode);
    const project = vi.spyOn(tileToEcef, 'tileLocalToWgs84Ecef');
    const state = beginTileConversion(tile.buckets, tileID, 1, 'polygons', undefined, undefined, 0, mode);
    expect(advanceTileConversion(state, UNBOUNDED_BUDGET)).toBe(true);
    for (const layerId of ['parks', 'parks-copy']) {
      expect(state.result.linePrimitives.filter(source => source.layerId === layerId).map(source => Array.from(source.tilePositions))).toEqual(rings);
    }
    expect(project.mock.calls).toHaveLength(0);
  });

  it.each([SceneMode.SCENE3D, SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW, SceneMode.MORPHING])('consumes transferred outlines without projecting rings on the main thread (mode %s)', async (mode) => {
    const { tile, bucket, tileID } = await workerTile();
    expect(tile.buckets['parks-copy']).toBe(bucket);
    expect(bucket.projectedGeometry?.fillOutlines).toBeDefined();
    // Resolve the mode's fill surface first. Planar meshes intentionally use a
    // different subdivision at z0; this probe isolates outline publication.
    if (mode === SceneMode.SCENE2D || mode === SceneMode.COLUMBUS_VIEW)
      fillBucketPrimitives(bucket, tileID, mode);
    const originalVertices = bucket.layoutVertexArray.int16.slice();
    const originalIndices = bucket.indexArray.uint16.slice();
    const sourcePaths = Array.from((mode === SceneMode.SCENE2D || mode === SceneMode.COLUMBUS_VIEW
      ? bucket.projectedGeometry?.fillPlanarOutlines
      : bucket.projectedGeometry?.fillOutlines) ?? []).flat();
    const originalPaths = sourcePaths.map(path => ({ positions: path.positions.slice(), tilePositions: path.tilePositions.slice() }));
    const project = vi.spyOn(tileToEcef, 'tileLocalToWgs84Ecef');
    const state = beginTileConversion(tile.buckets, tileID, 1, 'polygons', undefined, undefined, 0, mode);
    expect(advanceTileConversion(state, UNBOUNDED_BUDGET)).toBe(true);
    const outlines = state.result.linePrimitives;
    const ringCount = bucket.polygons.reduce((count, polygon) => count + 1 + polygon.holes.length, 0);
    expect(outlines).toHaveLength(ringCount * 2);
    expect(outlines.every(outline => outline.featureIndex === 1)).toBe(true);
    for (const outline of outlines) {
      expect(Array.from(outline.tilePositions.subarray(0, 2))).toEqual(Array.from(outline.tilePositions.subarray(-2)));
      const source = sourcePaths.find(path => path.tilePositions === outline.tilePositions);
      expect(source).toBeDefined();
      // Height rides the draw command; all family members keep source owners.
      expect(outline.positions).toBe(source!.positions);
      expect(outline.offsetMeters).toBeGreaterThan(0);
    }
    expect(sourcePaths.map(path => ({ positions: path.positions, tilePositions: path.tilePositions }))).toEqual(originalPaths);
    expect(bucket.layoutVertexArray.int16).toEqual(originalVertices);
    expect(bucket.indexArray.uint16).toEqual(originalIndices);
    expect(project.mock.calls).toHaveLength(0);
    const build = beginLineBuild(outlines, tile.buckets, 'polygons/0', tileID, 1, 0, mode !== SceneMode.SCENE3D);
    expect(stepLineBuild(build, UNBOUNDED_BUDGET)).toBe(true);
    const collection = commitLineBuild(build)!;
    for (let index = 0; index < collection.length; index++) {
      const primitive = collection.get(index);
      const layerId = drawBatchForOwner(primitive)!.layerId;
      const source = outlines.find(outline => outline.layerId === layerId)!;
      expect(linePaintForOwner(primitive)!.offsetUniform()).toBe(source.offsetMeters);
    }
    collection.destroy();
  });

  it('transfers two coordinate backings per outline topology and preserves their polygon views', async () => {
    const { bucket, tileID, outlineBytes, outlineTransfers, outlineBackings, planarBytes, planarTransfers, planarBackings } = await workerTile();
    const outlines = bucket.projectedGeometry!.fillOutlines!;
    const paths = Array.from(outlines).flat();
    const count = paths.reduce((sum, path) => sum + path.positions.length / 3, 0);
    expect(outlines.length).toBe(bucket.polygons.length);
    expect(paths).toHaveLength(3);
    expect(new Set(paths.map(path => path.positions.buffer)).size).toBe(1);
    expect(new Set(paths.map(path => path.tilePositions.buffer)).size).toBe(1);
    expect(paths[0].positions.buffer).not.toBe(paths[0].tilePositions.buffer);
    expect(outlineTransfers).toHaveLength(2);
    expect([...outlineBackings].every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(outlineBytes).toBe(count * 40);
    expect(outlineBytes).toBe(3000);
    expect(planarTransfers).toHaveLength(2);
    expect([...planarBackings].every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(planarBytes).toBe(600);
    let offset = 0;
    for (const path of paths) {
      expect(path.positions.byteOffset).toBe(offset * 24);
      expect(path.tilePositions.byteOffset).toBe(offset * 16);
      offset += path.positions.length / 3;
    }
    for (const mode of [SceneMode.SCENE3D, SceneMode.SCENE2D]) {
      const modeOutlines = mode === SceneMode.SCENE2D ? bucket.projectedGeometry!.fillPlanarOutlines! : outlines;
      for (const primitive of fillBucketPrimitives(bucket, tileID, mode)) {
        expect(fillOutlinePaths(bucket, primitive, mode)).toBe(modeOutlines.get(primitive.polygonIndex));
      }
    }
  });

  it('keeps clipped buffered rings open at tile boundaries after transfer', async () => {
    const { bucket } = await workerTile({
      type: 'MultiPolygon',
      coordinates: [[[[170, 10], [190, 10], [190, 30], [170, 30], [170, 10]]]],
    });
    const paths = [bucket.projectedGeometry!.fillOutlines!, bucket.projectedGeometry!.fillPlanarOutlines!].flatMap(outlines => Array.from(outlines).flat());
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every(path => !path.closed)).toBe(true);
    for (const path of paths) {
      const xs = Array.from(path.tilePositions).filter((_coordinate, index) => index % 2 === 0);
      expect(xs.every(x => x >= 0 && x <= 8192)).toBe(true);
      expect([xs[0], xs.at(-1)].some(x => x === 0 || x === 8192)).toBe(true);
    }
  });

  it('clips planar edges at their exact source intersections rather than rounded globe samples', async () => {
    const { bucket } = await workerTile({
      type: 'MultiPolygon',
      coordinates: [[[[170, 10], [190, 17], [190, 30], [170, 25], [170, 10]]]],
    });
    const paths = Array.from(bucket.projectedGeometry!.fillPlanarOutlines!).flat();
    expect(paths.length).toBeGreaterThan(0);
    const edges = bucket.polygons.flatMap((polygon) => {
      const coordinates = bucket.layoutVertexArray.int16.subarray(polygon.vertexOffset * 2, (polygon.vertexOffset + polygon.vertexLength) * 2);
      const points = Array.from({ length: polygon.vertexLength }, (_point, index) => [coordinates[index * 2], coordinates[index * 2 + 1]]);
      return points.map((point, index) => [point, points[(index + 1) % points.length]]);
    });
    let boundaryPoints = 0;
    for (const path of paths) {
      expect(path.closed).toBe(false);
      for (let index = 0; index < path.tilePositions.length; index += 2) {
        const x = path.tilePositions[index];
        const y = path.tilePositions[index + 1];
        if (x === 0 || x === 8192)
          boundaryPoints++;
        expect(edges.some(([from, to]) => {
          const cross = (x - from[0]) * (to[1] - from[1]) - (y - from[1]) * (to[0] - from[0]);
          return Math.abs(cross) < 1e-7 && x >= Math.min(from[0], to[0]) && x <= Math.max(from[0], to[0])
            && y >= Math.min(from[1], to[1]) && y <= Math.max(from[1], to[1]);
        })).toBe(true);
      }
    }
    expect(boundaryPoints).toBeGreaterThan(0);
  });
});
