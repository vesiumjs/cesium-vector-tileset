import type { TilePoint } from '../../geometry/surface-subdivision';
import Point from '@mapbox/point-geometry';
import { SceneMode } from 'cesium';
import earcut from 'earcut';
import { describe, expect, it, vi } from 'vitest';
import { FillLayoutArray, TriangleIndexArray } from '../../../data/array-types.g';
import { FillBucket } from '../../../data/bucket-runtime';
import { FillBucket as ParserFillBucket } from '../../../data/bucket/fill-bucket';
import { SegmentVector } from '../../../data/segment';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { OverscaledTileID } from '../../../tile/tile-id';
import { createTileTransferRegistry } from '../../../worker/tile-transfer';
import * as planarFill from '../../geometry/planar-fill';
import { fillBucketPrimitives, fillOutlinePaths, projectWorkerBuckets } from '../bucket-geometry';

function bucketFor(points: TilePoint[], holes: number[] = []) {
  const bucket = new FillBucket();
  bucket.layoutVertexArray = new FillLayoutArray();
  bucket.indexArray = new TriangleIndexArray();
  const triangles = earcut(points.flat(), holes);
  for (const [x, y] of points) bucket.layoutVertexArray.emplaceBack(x, y);
  for (let index = 0; index < triangles.length; index += 3)
    bucket.indexArray.emplaceBack(triangles[index], triangles[index + 1], triangles[index + 2]);
  bucket.segments = new SegmentVector([{ vertexOffset: 0, primitiveOffset: 0, vertexLength: points.length, primitiveLength: triangles.length / 3 }]);
  bucket.polygons = [{ polygonGroupId: 0, featureIndex: 0, vertexOffset: 0, primitiveOffset: 0, vertexLength: points.length, primitiveLength: triangles.length / 3, holes }];
  return bucket;
}

describe('planar fill tile seams', () => {
  it('keeps actual Shanghai thin source edges distinct through the public bucket conversion', () => {
    const [mesh] = fillBucketPrimitives(bucketFor([[298, 122], [300, 26], [264, 32], [232, -52]]), new OverscaledTileID(17, 0, 17, 65534, 65534), SceneMode.COLUMBUS_VIEW, 'pattern');
    const boundary = Array.from({ length: mesh.tilePositions.length / 2 }, (_, index) => [mesh.tilePositions[index * 2], mesh.tilePositions[index * 2 + 1]])
      .filter(point => point[1] === 0)
      .map(point => point[0])
      .sort((a, b) => a - b);
    expect(boundary).toHaveLength(2);
    expect(boundary[0]).toBeCloseTo(251.72413793103448, 12);
    expect(boundary[1]).toBeCloseTo(251.8095238095238, 12);
    expect(Array.from(mesh.positions).every(Number.isFinite)).toBe(true);
    let area = 0;
    for (let index = 0; index < mesh.triangles.length; index += 3) {
      const [a, b, c] = Array.from(mesh.triangles.subarray(index, index + 3)).map(vertex => [mesh.tilePositions[vertex * 2], mesh.tilePositions[vertex * 2 + 1]]);
      area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    expect(area).toBeCloseTo(1731.7799671592784, 8);
  });

  it('clips the real buffered water rectangle without diagonal intersections on either tile boundary', () => {
    const points: TilePoint[] = [[-2048, 2987], [-2048, -2048], [10240, -2048], [10240, 2987], [-2048, 2987]];
    const boundary = (tileX: number, x: number) => {
      const tile = new OverscaledTileID(17, 0, 17, tileX, 65534);
      const [mesh] = fillBucketPrimitives(bucketFor(points), tile, SceneMode.COLUMBUS_VIEW, 'pattern');
      const ys = Array.from({ length: mesh.tilePositions.length / 2 }, (_, index) => [mesh.tilePositions[index * 2], mesh.tilePositions[index * 2 + 1]])
        .filter(point => point[0] === x)
        .map(point => point[1]);
      return [...new Set(ys)].sort((a, b) => a - b);
    };
    expect(boundary(65534, 8192)).toEqual([0, 2987]);
    expect(boundary(65535, 0)).toEqual([0, 2987]);
  });

  it('joins actual parser chunks once, retaining the feature paint slot and pattern coordinates', () => {
    const layer = new FillStyleLayer({ id: 'water', type: 'fill', source: 'finite', paint: { 'fill-color': '#0000ff' } });
    layer.recalculate(new EvaluationParameters(17), []);
    const bucket = new ParserFillBucket({ layers: [layer], zoom: 17 } as never);
    const tile = new OverscaledTileID(17, 0, 17, 65534, 65534);
    const maximum = SegmentVector.MAX_VERTEX_ARRAY_LENGTH;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      SegmentVector.MAX_VERTEX_ARRAY_LENGTH = 3;
      bucket.addFeature({} as never, [[[-2048, 2987], [-2048, -2048], [10240, -2048], [10240, 2987], [-2048, 2987]].map(([x, y]) => new Point(x, y))], 17, tile.canonical, {});
    }
    finally {
      SegmentVector.MAX_VERTEX_ARRAY_LENGTH = maximum;
      warning.mockRestore();
    }
    expect(bucket.polygons).toHaveLength(2);
    expect(bucket.polygons.map(polygon => polygon.polygonGroupId)).toEqual([0, 0]);
    const ranges = structuredClone(bucket.programConfigurations.getFeatureRanges());
    const [mesh, ...others] = fillBucketPrimitives(bucket, tile, SceneMode.COLUMBUS_VIEW, 'pattern');
    expect(others).toHaveLength(0);
    expect(mesh.featureIndex).toBe(17);
    expect(mesh.triangles).toHaveLength(6);
    expect(Array.from(mesh.tilePositions).filter((_coordinate, index) => index % 2 === 1).sort((a, b) => a - b)).toEqual([0, 0, 2987, 2987]);
    expect(bucket.programConfigurations.getFeatureRanges()).toEqual(ranges);
    expect(ranges.map(range => [range.index, range.start, range.end])).toEqual([[17, 0, 1]]);
    projectWorkerBuckets([bucket], tile);
    const paths = fillOutlinePaths(bucket, mesh, SceneMode.COLUMBUS_VIEW);
    expect(paths).toEqual(Array.from(bucket.projectedGeometry!.fillPlanarOutlines!).flat());
    const transfers: Transferable[] = [];
    const registry = createTileTransferRegistry();
    const wire = registry.serialize(bucket, transfers);
    const restored = registry.deserialize(structuredClone(wire, { transfer: transfers })) as FillBucket;
    expect(restored.polygons.map(polygon => [polygon.polygonGroupId, polygon.featureIndex])).toEqual([[0, 17], [0, 17]]);
    expect(Array.from(restored.projectedGeometry!.fill!)).toHaveLength(1);
    expect(fillBucketPrimitives(restored, tile, SceneMode.COLUMBUS_VIEW, 'pattern')).toHaveLength(1);
  });

  it('keeps overlapping components and different features in separate primitives', () => {
    const layer = new FillStyleLayer({ id: 'water', type: 'fill', source: 'finite' });
    layer.recalculate(new EvaluationParameters(17), []);
    const bucket = new ParserFillBucket({ layers: [layer], zoom: 17 } as never);
    const tile = new OverscaledTileID(17, 0, 17, 65534, 65534);
    const ring = [[-100, -100], [9000, -100], [9000, 9000], [-100, 9000], [-100, -100]].map(([x, y]) => new Point(x, y));
    bucket.addFeature({} as never, [ring, ring], 17, tile.canonical, {});
    bucket.addFeature({} as never, [ring], 99, tile.canonical, {});
    expect(new Set(bucket.polygons.map(polygon => polygon.polygonGroupId)).size).toBe(3);
    const meshes = fillBucketPrimitives(bucket, tile, SceneMode.COLUMBUS_VIEW, 'pattern');
    expect(meshes.map(mesh => mesh.featureIndex)).toEqual([17, 17, 99]);
    expect(meshes.every(mesh => mesh.tilePositions.length === 8 && mesh.triangles.length === 6)).toBe(true);
    expect(bucket.programConfigurations.getFeatureRanges().map(range => [range.index, range.start, range.end])).toEqual([[17, 0, 1], [99, 1, 2]]);
  });

  it('keeps non-clipped in-tile source triangles without boundary reconstruction', () => {
    const points: TilePoint[] = [[100, 100], [4000, 100], [4000, 4000], [100, 4000]];
    const bucket = bucketFor(points);
    const probe = vi.spyOn(planarFill, 'clipPlanarFill');
    try {
      const [mesh] = fillBucketPrimitives(bucket, new OverscaledTileID(17, 0, 17, 65534, 65534), SceneMode.COLUMBUS_VIEW, 'pattern');
      expect(Array.from(mesh.tilePositions)).toEqual(points.flat());
      expect(Array.from(mesh.triangles)).toEqual(Array.from(bucket.indexArray.uint16.subarray(0, bucket.indexArray.length * 3)));
      expect(probe).not.toHaveBeenCalled();
    }
    finally {
      probe.mockRestore();
    }
  });

  it('does not turn a wholly outside hole into a clipped outer polygon', () => {
    const layer = new FillStyleLayer({ id: 'water', type: 'fill', source: 'finite' });
    layer.recalculate(new EvaluationParameters(17), []);
    const bucket = new ParserFillBucket({ layers: [layer], zoom: 17 } as never);
    const tile = new OverscaledTileID(17, 0, 17, 65534, 65534);
    const rings = [
      [[-1000, -1000], [10000, -1000], [10000, 10000], [-1000, 10000], [-1000, -1000]],
      [[8500, 1000], [8500, 3000], [9500, 3000], [9500, 1000], [8500, 1000]],
    ].map(ring => ring.map(([x, y]) => new Point(x, y)));
    bucket.addFeature({} as never, rings, 42, tile.canonical, {});
    expect(bucket.polygons).toHaveLength(1);
    expect(bucket.polygons[0].holes).toEqual([]);
    const [mesh, ...others] = fillBucketPrimitives(bucket, tile, SceneMode.COLUMBUS_VIEW, 'pattern');
    expect(others).toHaveLength(0);
    expect(mesh.tilePositions).toHaveLength(8);
    expect(mesh.triangles).toHaveLength(6);
    expect(mesh.featureIndex).toBe(42);
  });

  it('keeps the globe grid and pole extensions on the existing curved path', () => {
    const points: TilePoint[] = [[-100, -100], [9000, -100], [9000, 9000], [-100, 9000]];
    const probe = vi.spyOn(planarFill, 'clipPlanarFill');
    try {
      const [curved] = fillBucketPrimitives(bucketFor(points), new OverscaledTileID(13, 0, 13, 4096, 0), SceneMode.SCENE3D, 'pattern');
      expect(curved.subdivision).toBe(2);
      expect(Array.from(curved.tilePositions).some((value, index) => index % 2 === 1 && value === -32768)).toBe(true);
      expect(probe).not.toHaveBeenCalled();
      const [flat] = fillBucketPrimitives(bucketFor(points), new OverscaledTileID(17, 0, 17, 65536, 0), SceneMode.SCENE3D, 'pattern');
      expect(flat.subdivision).toBe(1);
      expect(Array.from(flat.tilePositions).filter((_value, index) => index % 2 === 1).sort((a, b) => a - b)).toEqual([0, 0, 8192, 8192]);
      expect(probe).toHaveBeenCalledOnce();
    }
    finally {
      probe.mockRestore();
    }
  });
});
