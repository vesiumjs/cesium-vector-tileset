import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { EvaluationParameters } from '../../../style/evaluation-parameters';
import type { ZoomHistory } from '../../../style/zoom-history';
import Point from '@mapbox/point-geometry';
import * as Cesium from 'cesium';
import { BufferPolygonCollection, ComponentDatatype, Geometry, GeometryAttribute, GeometryInstance, HeightReference, Primitive, SceneMode } from 'cesium';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { FillExtrusionBucket } from '../../../data/bucket/fill-extrusion-bucket';
import { FillExtrusionStyleLayer } from '../../../style/style-layer/fill-extrusion-style-layer';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { CanonicalTileID } from '../../../tile/tile-id';
import { buildVectorTile } from '../../vector/__test__/vector-tile-helper';
import { VectorTileRenderer } from '../../vector/vector-tile-renderer';
import { UNBOUNDED_BUDGET } from '../frame-budget';
import { captureUploadedPrimitiveBytes, collectionGpuBytes, rememberPrimitiveBytes, sharePrimitiveBytes } from '../resource-memory';
import { memoryEntries } from './memory-entry-helper';

const canonical = new CanonicalTileID(20, 1, 1);

interface NativeBuffer {
  readonly sizeInBytes: number;
}

interface NativeVertexArray {
  readonly numberOfAttributes: number;
  readonly indexBuffer: NativeBuffer;
  getAttribute: (index: number) => { vertexBuffer?: NativeBuffer };
}

/** Real Cesium Buffer/VA objects; only their GL allocation sink is replaced. */
function uploadedPrimitive(index32 = false) {
  const runtime = Cesium as typeof Cesium & {
    Buffer: {
      createVertexBuffer: (options: object) => NativeBuffer;
      createIndexBuffer: (options: object) => NativeBuffer;
    };
    VertexArray: new (options: object) => NativeVertexArray;
  };
  const bufferData = vi.fn();
  const context = {
    _gl: { createBuffer: () => ({}), bindBuffer: vi.fn(), bufferData },
    _webgl2: true,
    elementIndexUint: true,
    vertexArrayObject: false,
  };
  const vertices = runtime.Buffer.createVertexBuffer({ context, sizeInBytes: 96, usage: 35044 });
  const indices = runtime.Buffer.createIndexBuffer({
    context,
    typedArray: index32 ? new Uint32Array([0, 1, 2]) : new Uint16Array([0, 1, 2]),
    indexDatatype: index32 ? 5125 : 5123,
    usage: 35044,
  });
  const vertexArray = new runtime.VertexArray({
    context,
    attributes: [
      { index: 0, vertexBuffer: vertices, componentsPerAttribute: 3, componentDatatype: ComponentDatatype.FLOAT, strideInBytes: 24 },
      { index: 1, vertexBuffer: vertices, componentsPerAttribute: 3, componentDatatype: ComponentDatatype.FLOAT, strideInBytes: 24, offsetInBytes: 12 },
      { index: 2, value: [1] },
    ],
    indexBuffer: indices,
  });
  const primitive = new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new Geometry({
        attributes: {
          position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(9) }),
        },
        indices: new Uint32Array([0, 1, 2]),
      }),
    }),
  });
  rememberPrimitiveBytes(primitive);
  // Native createVertexArray releases these inputs and publishes ready only
  // in afterRender. Repeat the VA to exercise physical-buffer de-duplication.
  Object.assign(primitive, { _va: [vertexArray, vertexArray], geometryInstances: undefined });
  let ready = false;
  Object.defineProperty(primitive, 'ready', { get: () => ready });
  return {
    primitive,
    vertexArray,
    bufferData,
    ready: () => {
      ready = true;
    },
  };
}

function fillBucket(): FillBucket {
  const layer = new FillStyleLayer({
    id: 'fill',
    type: 'fill',
    paint: { 'fill-color': '#ff0000', 'fill-antialias': false },
  } as LayerSpecification, {});
  layer.recalculate({ zoom: 0, zoomHistory: {} as ZoomHistory } as EvaluationParameters, []);
  const bucket = new FillBucket({ layers: [layer], zoom: 0 } as never);
  bucket.addFeature({} as never, [[
    new Point(0, 0),
    new Point(100, 0),
    new Point(100, 100),
    new Point(0, 100),
  ]], 0, canonical, {});
  return bucket;
}

describe('per-tile memory accounting', () => {
  beforeAll(() => {
    if (typeof OffscreenCanvas === 'undefined') {
      globalThis.OffscreenCanvas = class {} as unknown as typeof OffscreenCanvas;
    }
  });

  it('reads the latest owner reservation through a replay wrapper', () => {
    const wrapper = {};
    // The alias may be registered before the owner's input reservation.
    const delayed = new Primitive();
    sharePrimitiveBytes(wrapper, delayed, 7);
    Object.assign(delayed, { geometryInstances: new GeometryInstance({
      geometry: new Geometry({ attributes: { position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(3) }) } }),
    }) });
    rememberPrimitiveBytes(delayed);
    expect(collectionGpuBytes(wrapper)).toBe(collectionGpuBytes(delayed) + 7);
    expect(collectionGpuBytes(wrapper)).toBeGreaterThan(7);
  });

  it.each([[false, 102], [true, 108]] as const)('counts actual VA handles and native index width (uint32=%s)', (index32, expected) => {
    const upload = uploadedPrimitive(index32);
    const wrapper = {};
    sharePrimitiveBytes(wrapper, upload.primitive, 7);
    const reservation = collectionGpuBytes(upload.primitive);
    expect(captureUploadedPrimitiveBytes(upload.primitive)).toBe(false);
    expect(collectionGpuBytes(upload.primitive)).toBe(reservation);
    upload.ready();
    expect(captureUploadedPrimitiveBytes(upload.primitive)).toBe(true);
    expect(upload.bufferData).toHaveBeenCalledTimes(2);
    expect(collectionGpuBytes(upload.primitive)).toBe(expected);
    expect(collectionGpuBytes(wrapper)).toBe(expected + 7);
    const reads = vi.spyOn(upload.vertexArray, 'getAttribute');
    expect(captureUploadedPrimitiveBytes(upload.primitive)).toBe(false);
    expect(reads).not.toHaveBeenCalled();
  });

  it('rejects a changed Native upload contract without marking its reservation exact', () => {
    const upload = uploadedPrimitive();
    const reservation = collectionGpuBytes(upload.primitive);
    upload.ready();
    Object.assign(upload.primitive, { _va: undefined });
    expect(() => captureUploadedPrimitiveBytes(upload.primitive)).toThrow('Cesium 1.146 Primitive._va');
    expect(collectionGpuBytes(upload.primitive)).toBe(reservation);
    Object.assign(upload.primitive, { _va: [upload.vertexArray] });
    expect(captureUploadedPrimitiveBytes(upload.primitive)).toBe(true);
    expect(collectionGpuBytes(upload.primitive)).toBe(102);
  });

  it('keeps draped collections as capacity reservations before a terrain renderer uploads them', () => {
    const collection = new BufferPolygonCollection({
      primitiveCountMax: 1,
      vertexCountMax: 4,
      holeCountMax: 0,
      triangleCountMax: 2,
      heightReference: HeightReference.CLAMP_TO_GROUND,
    });
    try {
      // No Primitive VA exists for the future VectorProvider terrain pass.
      // This is a fixed-capacity reservation, not measured uploaded storage.
      expect(collectionGpuBytes(collection)).toBe(4 * (3 * 8 + 16) + 2 * 3 * 2);
      expect(collectionGpuBytes(collection)).toBeGreaterThan(0);
    }
    finally {
      collection.destroy();
    }
  });

  it('accounts for a 3D building even when its tile contains no ground fills', () => {
    const layer = new FillExtrusionStyleLayer({
      id: 'buildings',
      type: 'fill-extrusion',
      paint: { 'fill-extrusion-color': '#ffffff', 'fill-extrusion-height': 100 },
    } as LayerSpecification, {});
    layer.recalculate({ zoom: 14, zoomHistory: {} as ZoomHistory } as EvaluationParameters, []);
    const bucket = new FillExtrusionBucket({ layers: [layer], zoom: 14 } as never);
    bucket.addFeature({ properties: {}, type: 'Polygon' } as never, [[new Point(0, 0), new Point(100, 0), new Point(100, 100), new Point(0, 100)]], 0, canonical, {});
    const renderer = new VectorTileRenderer();
    buildVectorTile(renderer, { tileId: canonical.key, buckets: { buildings: bucket }, tileID: canonical, mode: SceneMode.SCENE3D, styleZoom: 14 });
    try {
      expect(renderer.getTileCollections(canonical.key)).toHaveLength(1);
      expect(memoryEntries(renderer)[0].bytes).toBeGreaterThan(0);
    }
    finally {
      for (const collection of renderer.removeAll()) collection.destroy();
    }
  });

  it('keeps the allocated bytes through retirement and restoration, then releases them', () => {
    const renderer = new VectorTileRenderer();
    buildVectorTile(renderer, { tileId: canonical.key, buckets: { fill: fillBucket() }, tileID: canonical });

    const entry = memoryEntries(renderer)[0];
    expect(entry.bytes).toBeGreaterThan(0);
    expect(entry.pinned).toBe(true);
    renderer.retireTile(canonical.key, SceneMode.SCENE3D);
    expect(renderer.stats.tiles).toBe(0);
    expect(memoryEntries(renderer)).toEqual([{ key: canonical.key, bytes: entry.bytes }]);
    expect(renderer.restoreTile(canonical.key, SceneMode.SCENE3D)).toBe(true);
    expect(renderer.stats.tiles).toBe(1);
    expect(memoryEntries(renderer)).toEqual([entry]);
    for (const collection of renderer.removeAll())
      collection.destroy();
    expect(memoryEntries(renderer)).toEqual([]);
  });

  it('keeps staged geometry outside the live store and releases it on discard', () => {
    const renderer = new VectorTileRenderer();
    const input = { tileId: canonical.key, buckets: { fill: fillBucket() }, tileID: canonical, mode: SceneMode.SCENE3D, styleZoom: 0 };
    const abandoned = renderer.beginTileBuild(input);
    let complete = renderer.advanceTileBuild(abandoned, UNBOUNDED_BUDGET);
    while (!complete) complete = renderer.advanceTileBuild(abandoned, UNBOUNDED_BUDGET);
    const staged = abandoned.entries.map(([, collection]) => collection);
    expect(staged.length).toBeGreaterThan(0);
    expect(renderer.stats.tiles).toBe(0);

    // Cesium's BufferPrimitiveCollection.destroy releases GPU resources while
    // retaining a reusable collection; its isDestroyed() always returns false.
    const releases = staged.map(collection => vi.spyOn(collection, 'destroy'));
    renderer.discardTileBuild(abandoned);
    for (const release of releases) {
      expect(release).toHaveBeenCalledOnce();
      release.mockRestore();
    }
    expect(renderer.stats.tiles).toBe(0);
    expect(memoryEntries(renderer)).toEqual([]);

    const committed = renderer.beginTileBuild(input);
    complete = renderer.advanceTileBuild(committed, UNBOUNDED_BUDGET);
    while (!complete) complete = renderer.advanceTileBuild(committed, UNBOUNDED_BUDGET);
    renderer.commitTileBuild(committed);
    expect(renderer.stats.tiles).toBe(1);
    expect(memoryEntries(renderer)[0].bytes).toBeGreaterThan(0);
    for (const collection of renderer.removeAll())
      collection.destroy();
    expect(memoryEntries(renderer)).toEqual([]);
  });

  it('does not cache a tile that leaves view before its line stage completes', () => {
    const renderer = new VectorTileRenderer();
    const state = renderer.beginTileBuild({
      tileId: canonical.key,
      buckets: { fill: fillBucket() },
      tileID: canonical,
      mode: SceneMode.SCENE3D,
      styleZoom: 0,
    });
    expect(renderer.advanceTileBuild(state, UNBOUNDED_BUDGET)).toBe(false);
    renderer.commitTileBuild(state);
    expect(renderer.tileBuildLayers(canonical.key)?.complete).toBe(false);
    const retired = renderer.retireTile(canonical.key, SceneMode.SCENE3D);
    expect(retired).toHaveLength(1);
    expect(renderer.restoreTile(canonical.key, SceneMode.SCENE3D)).toBe(false);
    for (const collection of retired) collection.destroy();
  });
});
