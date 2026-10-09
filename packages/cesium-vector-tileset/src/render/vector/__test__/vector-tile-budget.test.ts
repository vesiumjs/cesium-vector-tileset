import { BufferPolygonCollection, BufferPolygonMaterial, Cartesian3, HeightReference, SceneMode } from 'cesium';
import * as Cesium from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverscaledTileID } from '../../../tile/tile-id';
import { tileBoundingSphere } from '../../geometry/tile-bounding-sphere';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';
import { VectorTileBuilder } from '../vector-tile-builder';

const EncodedCartesian3 = (Cesium as unknown as { EncodedCartesian3: { fromCartesian: (position: Cartesian3, result: { high: Cartesian3; low: Cartesian3 }) => { high: Cartesian3; low: Cartesian3 } } }).EncodedCartesian3;

afterEach(() => vi.restoreAllMocks());

function polygonBuild(count = 1000, heightReference = HeightReference.NONE, mode = SceneMode.SCENE3D) {
  const builder = new VectorTileBuilder(() => ({ pixelRatio: 1, heightReference }));
  const tileID = new OverscaledTileID(14, 0, 14, 8186, 5446);
  const state = builder.begin({ tileId: `city/${tileID.key}`, tileID, buckets: {}, styleZoom: 14, mode });
  state.phase = 'polygons';
  const material = new BufferPolygonMaterial();
  const polygons = Array.from({ length: count }, (_, featureIndex) => ({
    positions: new Float64Array([4000000 + featureIndex, 0, 4000000, 4000001 + featureIndex, 0, 4000000, 4000000 + featureIndex, 1, 4000000]),
    ringVertexCount: 3,
    holes: [],
    triangles: new Uint32Array([0, 1, 2]),
    material,
    pickObject: { tileId: state.tileId, layerId: 'land', featureIndex, generationId: state.generationId },
  }));
  state.result = { polygons, points: [], linePrimitives: [], layerIds: ['land'] };
  return { builder, state, polygons };
}

describe('buffer polygon build allowance', () => {
  it('bounds all actual source and Native Float32 encoded vertices once at build time', () => {
    const { builder, state, polygons } = polygonBuild(3);
    // Include a vertex not referenced by a triangle: Native still uploads it.
    polygons[0].positions = new Float64Array([...polygons[0].positions, 4000010.1, -4.2, 4000000.3]);
    const originals = polygons.map(polygon => polygon.positions.slice());
    const encode = vi.spyOn(EncodedCartesian3, 'fromCartesian');
    try {
      builder.step(state, UNBOUNDED_BUDGET);
      expect(encode).toHaveBeenCalledTimes(polygons.reduce((count, polygon) => count + polygon.positions.length / 3, 0));
      const collection = state.entries[0][1] as BufferPolygonCollection;
      const bounds = collection.boundingVolume;
      expect(bounds.radius).toBeLessThan(20);
      const point = new Cartesian3();
      const decoded = new Cartesian3();
      const encoded = { high: new Cartesian3(), low: new Cartesian3() };
      for (const [index, polygon] of polygons.entries()) {
        expect(polygon.positions).toEqual(originals[index]);
        for (let offset = 0; offset < polygon.positions.length; offset += 3) {
          point.x = polygon.positions[offset];
          point.y = polygon.positions[offset + 1];
          point.z = polygon.positions[offset + 2];
          expect(Cartesian3.distance(point, bounds.center)).toBeLessThanOrEqual(bounds.radius);
          EncodedCartesian3.fromCartesian(point, encoded);
          decoded.x = Math.fround(encoded.high.x) + Math.fround(encoded.low.x);
          decoded.y = Math.fround(encoded.high.y) + Math.fround(encoded.low.y);
          decoded.z = Math.fround(encoded.high.z) + Math.fround(encoded.low.z);
          expect(Cartesian3.distance(decoded, bounds.center)).toBeLessThanOrEqual(bounds.radius);
        }
      }
      expect(collection.boundingVolume).toBe(bounds);
    }
    finally { builder.discard(state); }
  });

  it('slices one large polygon bounds scan before allocating a Native owner and cancels without destroying an owner', () => {
    const { builder, state, polygons } = polygonBuild(1);
    const positions = new Float64Array(10000 * 3);
    for (let index = 0; index < 10000; index++) {
      positions[index * 3] = 4000000 + index * 0.1;
      positions[index * 3 + 1] = index % 17;
      positions[index * 3 + 2] = 4000000;
    }
    polygons[0].positions = positions;
    const encode = vi.spyOn(EncodedCartesian3, 'fromCartesian');
    const add = vi.spyOn(BufferPolygonCollection.prototype, 'add');
    const destroy = vi.spyOn(BufferPolygonCollection.prototype, 'destroy');
    try {
      builder.step(state, { exhausted: true });
      expect(encode.mock.calls.length).toBeGreaterThan(0);
      expect(encode.mock.calls.length).toBeLessThanOrEqual(32);
      expect(add).not.toHaveBeenCalled();
      expect(state.entries).toEqual([]);
    }
    finally { builder.discard(state); }
    builder.discard(state);
    expect(destroy).not.toHaveBeenCalled();
    expect(polygons[0].positions).toBe(positions);
    expect(positions[positions.length - 3]).toBe(4000999.9);
  });

  it('slices the actual radius pass and cancels it before allocating a Native owner', () => {
    const { builder, state, polygons } = polygonBuild(1);
    const positions = new Float64Array(96 * 3);
    for (let index = 0; index < 96; index++) {
      positions[index * 3] = 4000000 + index;
      positions[index * 3 + 1] = index % 17;
      positions[index * 3 + 2] = 4000000;
    }
    polygons[0].positions = positions;
    const original = positions.slice();
    const encode = vi.spyOn(EncodedCartesian3, 'fromCartesian');
    const distance = vi.spyOn(Cartesian3, 'distanceSquared');
    const add = vi.spyOn(BufferPolygonCollection.prototype, 'add');
    const destroy = vi.spyOn(BufferPolygonCollection.prototype, 'destroy');
    try {
      for (let quantum = 0; quantum < 3; quantum++)
        builder.step(state, { exhausted: true });
      expect(encode).toHaveBeenCalledTimes(96);
      expect(add).not.toHaveBeenCalled();
      distance.mockClear();
      builder.step(state, { exhausted: true });
      expect(distance.mock.calls.length).toBeGreaterThan(0);
      expect(distance.mock.calls.length).toBeLessThanOrEqual(32);
      expect(encode).toHaveBeenCalledTimes(96);
      expect(add).not.toHaveBeenCalled();
      expect(state.entries).toEqual([]);
    }
    finally { builder.discard(state); }
    expect(destroy).not.toHaveBeenCalled();
    expect(polygons[0].positions).toBe(positions);
    expect(positions).toEqual(original);
  });

  it.each([HeightReference.CLAMP_TO_GROUND, HeightReference.CLAMP_TO_TERRAIN, HeightReference.CLAMP_TO_3D_TILE])('retains the tile sphere for Native clamped height reference %s', (heightReference) => {
    const { builder, state } = polygonBuild(3, heightReference);
    const encode = vi.spyOn(EncodedCartesian3, 'fromCartesian');
    try {
      builder.step(state, UNBOUNDED_BUDGET);
      expect((state.entries[0][1] as BufferPolygonCollection).boundingVolume).toEqual(tileBoundingSphere(state.tileID));
      expect(encode).not.toHaveBeenCalled();
    }
    finally { builder.discard(state); }
  });

  it.each([SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW])('keeps the existing standard polygon path in mode %s', (mode) => {
    const { builder, state } = polygonBuild(3, HeightReference.NONE, mode);
    const encode = vi.spyOn(EncodedCartesian3, 'fromCartesian');
    try {
      builder.step(state, UNBOUNDED_BUDGET);
      expect(state.entries[0][1]).not.toBeInstanceOf(BufferPolygonCollection);
      expect(encode).not.toHaveBeenCalled();
    }
    finally { builder.discard(state); }
  });

  it('yields within one style layer and publishes the complete identical owner', () => {
    const { builder, state, polygons } = polygonBuild();
    const add = vi.spyOn(BufferPolygonCollection.prototype, 'add');
    try {
      let maximumAdded = 0;
      let slices = 0;
      while (state.phase === 'polygons') {
        let checks = 0;
        const before = add.mock.calls.length;
        builder.step(state, { get exhausted() {
          return ++checks > 8;
        } });
        maximumAdded = Math.max(maximumAdded, add.mock.calls.length - before);
        if (++slices > 2000)
          throw new Error('polygon assembly did not finish');
      }
      expect(slices).toBeGreaterThan(1);
      expect(maximumAdded).toBeLessThan(32);
      expect(add).toHaveBeenCalledTimes(polygons.length);
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0][1]).toBeInstanceOf(BufferPolygonCollection);
      expect((state.entries[0][1] as BufferPolygonCollection).primitiveCount).toBe(polygons.length);
      for (const [index, [input]] of add.mock.calls.entries()) {
        expect(input.positions).toBe(polygons[index].positions);
        expect(input.triangles).toBe(polygons[index].triangles);
        expect(input.pickObject).toBe(polygons[index].pickObject);
      }
    }
    finally { builder.discard(state); }
  });

  it('destroys an unpublished partly assembled owner when its tile is canceled', () => {
    const { builder, state } = polygonBuild();
    const add = vi.spyOn(BufferPolygonCollection.prototype, 'add');
    const destroy = vi.spyOn(BufferPolygonCollection.prototype, 'destroy');
    while (add.mock.calls.length < 20) {
      let checks = 0;
      builder.step(state, { get exhausted() {
        return ++checks > 8;
      } });
    }
    expect(add.mock.calls.length).toBeLessThan(1000);
    expect(state.entries).toEqual([]);
    builder.discard(state);
    expect(destroy).toHaveBeenCalledTimes(1);
    builder.discard(state);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('retains synchronous assembly with the same production protocol', () => {
    const { builder, state } = polygonBuild(3);
    try {
      builder.step(state, UNBOUNDED_BUDGET);
      expect(state.phase).toBe('details');
      expect((state.entries[0][1] as BufferPolygonCollection).primitiveCount).toBe(3);
    }
    finally { builder.discard(state); }
  });
});
