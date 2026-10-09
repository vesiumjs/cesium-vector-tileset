import type { PackedLinePaths } from '../../data/line-path-transfer';
import Point from '@mapbox/point-geometry';
import { Color, CompoundExpression, createExpression, EvaluationContext, expressions, StyleExpression } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { FillLayoutArray, StructArrayLayout2i4 } from '../../data/array-types.g';
import { deserialize } from '../../data/bucket';
import { LineBucket as RuntimeLineBucket } from '../../data/bucket-runtime';
import { LineBucket as WorkerLineBucket } from '../../data/bucket/line-bucket';
import { lineStyleForFeature } from '../../render/vector/feature-attributes';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { LineStyleLayer } from '../../style/style-layer/line-style-layer';
import { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import { createTileTransferRegistry } from '../tile-transfer';
import { TransferRegistry } from '../transfer-registry';

describe('worker transfer registries', () => {
  it('restores worker-built geometry with scene paint updates and no builder methods', () => {
    const layer = new LineStyleLayer({
      id: 'road',
      type: 'line',
      source: 'source',
      paint: { 'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 12, 2] },
    }, {});
    const compositeLayer = new LineStyleLayer({
      id: 'composite-road',
      type: 'line',
      source: 'source',
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, ['case', ['boolean', ['feature-state', 'selected'], false], 12, 2], 3, ['case', ['boolean', ['feature-state', 'selected'], false], 24, 4]],
      },
    }, {});
    const layers = [layer, compositeLayer];
    for (const styleLayer of layers)
      styleLayer.recalculate(new EvaluationParameters(2.5), []);
    const bucket = new WorkerLineBucket({ layers, zoom: 2 } as never);
    bucket.addFeature({
      id: 7,
      index: 0,
      sourceLayerIndex: 0,
      geometry: [],
      properties: {},
      type: 2,
      patterns: {},
      dashes: {},
    }, [[new Point(1, 1), new Point(16, 1)]], 0, new CanonicalTileID(2, 1, 1), {}, {});
    const paths = bucket.linePaths.map(path => ({ ...path, points: Array.from(path.points) }));
    const ranges = bucket.programConfigurations.getFeatureRanges().map(range => ({ ...range }));
    const worker = createTileTransferRegistry();
    const scene = createTileTransferRegistry();
    const transferables: Transferable[] = [];
    const encoded = worker.serialize(bucket, transferables);
    const received = structuredClone(encoded, { transfer: transferables });
    const receivedBucket = received as unknown as RuntimeLineBucket;
    const receivedPaths = (received as unknown as { linePaths: PackedLinePaths }).linePaths;
    const receivedJoinCap = receivedBucket.lineJoinCap;
    const receivedConfigurations = receivedBucket.programConfigurations;
    const receivedRanges = receivedConfigurations._featureRanges;
    const receivedRange = receivedRanges[0];
    const restored = scene.deserialize(received) as RuntimeLineBucket;

    expect(restored).toBe(received);
    expect(restored.linePaths.every(path => path.points.buffer === receivedPaths.coordinates.buffer)).toBe(true);
    expect(restored.lineJoinCap).toBe(receivedJoinCap);
    expect(restored.programConfigurations).toBe(receivedConfigurations);
    expect(restored.programConfigurations.getFeatureRanges()).toBe(receivedRanges);
    expect(restored.programConfigurations.getFeatureRanges()[0]).toBe(receivedRange);
    expect(Object.hasOwn(restored, '$name')).toBe(false);
    expect(Array.from(bucket.linePaths[0].points)).toEqual(paths[0].points);
    expect((encoded as unknown as { linePaths: PackedLinePaths }).linePaths.coordinates.byteLength).toBe(0);
    expect(restored).toBeInstanceOf(RuntimeLineBucket);
    expect(restored).not.toBeInstanceOf(WorkerLineBucket);
    expect(Reflect.get(restored, 'populate')).toBeUndefined();
    expect(restored.isEmpty()).toBe(false);
    const buckets = deserialize([restored], { getLayer: (id: string) => layers.find(styleLayer => styleLayer.id === id) } as never);
    expect(buckets.road).toBe(restored);
    expect(buckets['composite-road']).toBe(restored);
    expect(lineStyleForFeature(restored, 0).widthPx).toBe(2);
    expect(lineStyleForFeature(restored, 0, compositeLayer.id, 2.5).widthPx).toBe(3);

    restored.update([{ id: 7, state: { selected: true } }], () => ({ id: 7, properties: {}, type: 2 }), { imagePositions: {}, canonical: new CanonicalTileID(2, 1, 1) });

    expect(lineStyleForFeature(restored, 0).widthPx).toBe(12);
    expect(lineStyleForFeature(restored, 0, compositeLayer.id, 2.5).widthPx).toBe(18);
    expect(restored.programConfigurations.paintRevision).toBe(1);
    expect(restored.linePaths.map(path => ({ ...path, points: Array.from(path.points) }))).toEqual(paths);
    expect(restored.programConfigurations.getFeatureRanges()).toEqual(ranges);
    for (const [index, styleLayer] of layers.entries()) {
      const configuration = restored.programConfigurations.get(styleLayer.id);
      expect(Object.keys(configuration.binders)).toEqual(['line-width']);
      const values = configuration.getAttributeArray('line-width')!;
      expect(values.length).toBe(1);
      expect(values.bytesPerElement).toBe(index === 0 ? 4 : 8);
      expect(Array.from(new Float32Array(values.arrayBuffer))).toEqual(index === 0 ? [12] : [12, 24]);
    }
  });

  it('round-trips expressions between independent scene and worker registries', () => {
    const scene = createTileTransferRegistry();
    const worker = createTileTransferRegistry();
    const compiled = createExpression(['+', ['get', 'count'], 2], 'layers[0].paint.line-width');
    if (compiled.result !== 'success') {
      throw new Error('Fixture expression did not compile');
    }

    const transferables: Transferable[] = [];
    const encoded = scene.serialize(compiled.value, transferables);
    const received = structuredClone(encoded, { transfer: transferables });
    const receivedExpression = (received as unknown as StyleExpression).expression as CompoundExpression;
    const receivedArguments = receivedExpression.args;
    const receivedType = receivedExpression.type;
    const restored = worker.deserialize(received) as StyleExpression;

    expect(restored).toBe(received);
    expect(restored.expression).toBe(receivedExpression);
    expect((restored.expression as CompoundExpression).args).toBe(receivedArguments);
    expect(restored.expression.type).toBe(receivedType);
    expect(restored).toBeInstanceOf(StyleExpression);
    expect(restored.expression).toBeInstanceOf(CompoundExpression);
    expect(restored._evaluator).toBeInstanceOf(EvaluationContext);
    expect(Object.hasOwn(restored, '$name')).toBe(false);
    expect(Object.hasOwn(restored.expression, '$name')).toBe(false);
    expect(Object.hasOwn(restored.expression, 'overload')).toBe(false);
    expect(restored.evaluate({ zoom: 3 }, { properties: { count: 5 } })).toBe(7);
    const returnedTransferables: Transferable[] = [];
    const returnedEncoded = worker.serialize(restored, returnedTransferables);
    const returnedWire = structuredClone(returnedEncoded, { transfer: returnedTransferables });
    const returnedExpression = (returnedWire as unknown as StyleExpression).expression as CompoundExpression;
    const returnedArguments = returnedExpression.args;
    const returned = scene.deserialize(returnedWire) as StyleExpression;
    expect(returned).toBe(returnedWire);
    expect(returned.expression).toBe(returnedExpression);
    expect((returned.expression as CompoundExpression).args).toBe(returnedArguments);
    expect(returned._evaluator).toBeInstanceOf(EvaluationContext);
    expect(returned.evaluate({ zoom: 3 }, { properties: { count: 8 } })).toBe(10);
  });

  it('does not attach registration state to shared constructors or prototypes', () => {
    const constructors = [Object, Error, Color, StyleExpression, ...Object.values(expressions)];
    const keys = constructors.map(constructor => Reflect.ownKeys(constructor));
    const prototypeKeys = constructors.map(constructor => Reflect.ownKeys(constructor.prototype));

    createTileTransferRegistry();
    createTileTransferRegistry();

    for (const [index, constructor] of constructors.entries()) {
      expect(Reflect.ownKeys(constructor)).toEqual(keys[index]);
      expect(Reflect.ownKeys(constructor.prototype)).toEqual(prototypeKeys[index]);
      expect(Object.hasOwn(constructor, '_classRegistryKey')).toBe(false);
    }
  });

  it('transfers generated layout buffers once and restores tile identity methods', () => {
    const scene = createTileTransferRegistry();
    const worker = createTileTransferRegistry();
    const vertices = new FillLayoutArray();
    vertices.emplaceBack(12, 34);
    vertices.emplaceBack(56, 78);
    const tileID = new OverscaledTileID(8, 0, 8, 12, 34);
    const transferables: Transferable[] = [];
    const encoded = worker.serialize({ vertices, tileID }, transferables);

    expect(transferables).toHaveLength(1);
    const received = structuredClone(encoded, { transfer: transferables });
    const receivedData = received as unknown as {
      vertices: FillLayoutArray;
      tileID: OverscaledTileID;
    };
    const receivedVertices = receivedData.vertices;
    const receivedBuffer = receivedVertices.arrayBuffer;
    const receivedTileID = receivedData.tileID;
    const receivedCanonical = receivedTileID.canonical;
    const decoded = scene.deserialize(received) as {
      vertices: FillLayoutArray;
      tileID: OverscaledTileID;
    };

    expect(decoded).toBe(received);
    expect(decoded.vertices.arrayBuffer).toBe(receivedBuffer);
    expect(decoded.tileID).toBe(receivedTileID);
    expect(decoded.tileID.canonical).toBe(receivedCanonical);
    expect(decoded.vertices).not.toBe(receivedVertices);
    expect(decoded.vertices).toBeInstanceOf(StructArrayLayout2i4);
    expect(Object.hasOwn(decoded.tileID, '$name')).toBe(false);
    expect(Object.hasOwn(decoded.tileID.canonical, '$name')).toBe(false);
    expect(vertices.arrayBuffer.byteLength).toBe(0);
    expect(decoded.vertices.length).toBe(2);
    expect(Array.from(decoded.vertices.int16)).toEqual([12, 34, 56, 78]);
    expect(decoded.tileID).toBeInstanceOf(OverscaledTileID);
    expect(decoded.tileID.canonical).toBeInstanceOf(CanonicalTileID);
    expect(decoded.tileID.equals(tileID)).toBe(true);
  });

  it('uses registry-local omissions for the same constructor', () => {
    class Payload {
      visible = 1;
      cached = 2;
    }
    const first = new TransferRegistry();
    const second = new TransferRegistry();
    first.register('Payload', Payload, { omit: ['cached'] });
    second.register('Payload', Payload);

    expect(first.serialize(new Payload())).toEqual({ $name: 'Payload', visible: 1 });
    expect(second.serialize(new Payload())).toEqual({ $name: 'Payload', visible: 1, cached: 2 });
    expect(Object.hasOwn(Payload, '_classRegistryKey')).toBe(false);
  });
});
