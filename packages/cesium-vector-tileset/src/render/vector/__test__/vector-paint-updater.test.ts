import type { CircleLayerSpecification, FillLayerSpecification, LineLayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Primitive, PrimitiveCollection } from 'cesium';
import type { VectorTileRecord } from '../vector-tile-renderer';
import Point from '@mapbox/point-geometry';
import { BufferPoint, BufferPointCollection, BufferPointMaterial, BufferPolygon, BufferPolygonCollection, BufferPolygonMaterial, Cartesian3, SceneMode } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircleBucket } from '../../../data/bucket/circle-bucket';
import { FillBucket } from '../../../data/bucket/fill-bucket';
import { LineBucket } from '../../../data/bucket/line-bucket';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { CircleStyleLayer } from '../../../style/style-layer/circle-style-layer';
import { FillStyleLayer } from '../../../style/style-layer/fill-style-layer';
import { LineStyleLayer } from '../../../style/style-layer/line-style-layer';
import { OverscaledTileID } from '../../../tile/tile-id';
import { LineFamilyChunk } from '../../line/line-family';
import { beginLineBuild, commitLineBuild, discardLineBuild, stepLineBuild } from '../../line/line-renderer';
import { linePaintForOwner } from '../../scene/draw-batch';
import { paintRevision } from '../feature-attributes';
import { createVectorPaintState, VectorPaintUpdater } from '../vector-paint-updater';
import { VectorTileRenderer } from '../vector-tile-renderer';
import { buildVectorTile } from './vector-tile-helper';

afterEach(() => vi.restoreAllMocks());

function lineRecord(tileId: string, instance = false, sharedLayer?: LineStyleLayer, family = false): { record: VectorTileRecord; layer: LineStyleLayer } {
  const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
  const layer = sharedLayer ?? new LineStyleLayer({
    id: 'roads',
    type: 'line',
    source: 'city',
    paint: {
      'line-width': instance ? ['get', 'width'] : ['interpolate', ['linear'], ['zoom'], 0, 0, 24, 24],
      'line-color': ['step', ['zoom'], '#0000ff', 10, '#ff0000'],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0, 24, 1],
    },
  } satisfies LineLayerSpecification, {});
  layer.recalculate(new EvaluationParameters(8), []);
  const layers = [layer];
  if (family) {
    const casing = new LineStyleLayer({ id: 'casing', type: 'line', source: 'city', paint: { 'line-width': 4 } }, {});
    casing.recalculate(new EvaluationParameters(8), []);
    layers.push(casing);
  }
  const bucket = new LineBucket({ layers, zoom: 0 } as never);
  bucket.addFeature({ properties: { width: 7 }, type: 2 } as never, [[new Point(0, 0), new Point(4096, 4096)]], 0, tileID.canonical, {}, {});
  const positions = new Float64Array([...Cartesian3.pack(Cartesian3.fromDegrees(0, 0), []), ...Cartesian3.pack(Cartesian3.fromDegrees(1, 0), [])]);
  const sources = layers.map(layer => ({ layerId: layer.id, featureIndex: 0, positions, tilePositions: new Float64Array([0, 0, 4096, 4096]) }));
  const buckets = Object.fromEntries(layers.map(layer => [layer.id, bucket]));
  const build = beginLineBuild(sources, buckets, tileId, tileID, 0, 8);
  expect(stepLineBuild(build, { exhausted: false })).toBe(true);
  const lines = commitLineBuild(build)!;
  const record: VectorTileRecord = {
    generationId: 0,
    complete: true,
    buckets,
    layerIds: layers.map(layer => layer.id),
    paint: createVectorPaintState({ buckets: [bucket], paintRevisions: [layer.paintRevision], styleZoom: 8, styleRevision: 0, pixelRatio: 1, standard: false }),
    tileID,
    linePrimitives: sources,
    collections: new Map([['lines', lines]]),
    mode: SceneMode.SCENE3D,
  };
  return { record, layer };
}

function paintUpdater(records: Map<string, VectorTileRecord>) {
  return new VectorPaintUpdater({
    records: () => records,
    pixelRatio: () => 1,
    lighting: () => undefined,
    replace: (tileId, kind, old, replacement, replacements) => {
      records.get(tileId)!.collections.set(kind, replacement);
      replacements.push({ tileId, old, replacement });
    },
  });
}

function lineUniforms(record: VectorTileRecord) {
  return linePaintForOwner((record.collections.get('lines') as PrimitiveCollection).get(0))!;
}

function destroy(records: Map<string, VectorTileRecord>) {
  for (const record of records.values()) {
    if (record.paint.lineBuild)
      discardLineBuild(record.paint.lineBuild);
    for (const collection of record.collections.values()) {
      if (!collection.isDestroyed())
        collection.destroy();
    }
  }
}

function mixedSurfaceRecord(mode: SceneMode, dependency: 'constant' | 'source' | 'camera' | 'composite' | 'state') {
  const road = lineRecord('city/mixed');
  const tileID = new OverscaledTileID(13, 0, 13, 4093, 2724);
  const fill = new FillStyleLayer({
    id: 'land',
    type: 'fill',
    source: 'city',
    paint: {
      'fill-antialias': false,
      'fill-color': dependency === 'source'
        ? ['get', 'color']
        : dependency === 'camera'
          ? ['interpolate', ['linear'], ['zoom'], 8, '#0000ff', 9, '#ff0000']
          : dependency === 'composite'
            ? ['interpolate', ['linear'], ['zoom'], 8, ['get', 'color'], 9, ['get', 'nextColor']]
            : dependency === 'state'
              ? ['case', ['boolean', ['feature-state', 'selected'], false], '#ff0000', '#0000ff']
              : '#0000ff',
    },
  } satisfies FillLayerSpecification);
  const circle = new CircleStyleLayer({
    id: 'dots',
    type: 'circle',
    source: 'city',
    paint: {
      'circle-color': '#00ff00',
      'circle-radius': dependency === 'source'
        ? ['get', 'radius']
        : dependency === 'camera'
          ? ['interpolate', ['linear'], ['zoom'], 8, 5, 9, 13]
          : dependency === 'composite'
            ? ['interpolate', ['linear'], ['zoom'], 8, ['get', 'radius'], 9, ['get', 'nextRadius']]
            : dependency === 'state'
              ? ['number', ['feature-state', 'radius'], 5]
              : 5,
    },
  } satisfies CircleLayerSpecification);
  fill.recalculate(new EvaluationParameters(8), []);
  circle.recalculate(new EvaluationParameters(8), []);
  const land = new FillBucket({ layers: [fill], zoom: 8 } as never);
  const dots = new CircleBucket({ layers: [circle], zoom: 8 } as never);
  const properties = { color: '#0000ff', nextColor: '#ff0000', radius: 5, nextRadius: 13 };
  const fillFeature = { id: 1, type: 3 as const, properties };
  const pointFeature = { id: 2, type: 1 as const, properties };
  land.addFeature(fillFeature as never, [[new Point(1000, 1000), new Point(2000, 1000), new Point(2000, 2000), new Point(1000, 2000)]], 0, tileID, {});
  dots.addFeature(pointFeature as never, [[new Point(1500, 1500)]], 0, tileID.canonical);
  const renderer = new VectorTileRenderer();
  const buckets = { ...road.record.buckets, land, dots };
  buildVectorTile(renderer, { tileId: 'city/mixed', tileID, mode, buckets, styleZoom: 8, styleRevision: 0 });
  const record = (renderer as unknown as { _records: Map<string, VectorTileRecord> })._records.get('city/mixed')!;
  destroy(new Map([['old-road', road.record]]));
  return { record, fill, circle, road: road.layer, land, dots, fillFeature, pointFeature };
}

function surfacePaint(record: VectorTileRecord) {
  if (record.standard) {
    const polygon = record.standard.polygons[0];
    const attributes = polygon.primitive.getGeometryInstanceAttributes(polygon.id);
    const point = record.standard.points[0];
    return { color: [...attributes.color], circleColor: point.color.toRgba(), diameter: point.pixelSize, visible: point.show };
  }
  const polygon = new BufferPolygon();
  const point = new BufferPoint();
  const polygons = [...record.collections.values()].find(collection => collection instanceof BufferPolygonCollection)! as BufferPolygonCollection;
  const points = [...record.collections.values()].find(collection => collection instanceof BufferPointCollection)! as BufferPointCollection;
  polygons.get(0, polygon);
  points.get(0, point);
  const fill = polygon.getMaterial(new BufferPolygonMaterial());
  const circle = point.getMaterial(new BufferPointMaterial()) as BufferPointMaterial;
  return { color: [fill.color.red * 255, fill.color.green * 255, fill.color.blue * 255, fill.color.alpha * 255], circleColor: circle.color.toRgba(), diameter: circle.size, visible: point.show };
}

describe('surface paint dependencies in mixed road tiles', () => {
  it.each([
    [SceneMode.SCENE3D, 'constant'],
    [SceneMode.SCENE3D, 'source'],
    [SceneMode.COLUMBUS_VIEW, 'constant'],
    [SceneMode.COLUMBUS_VIEW, 'source'],
  ] as const)('retains actual %s %s surface paint while road camera uniforms change', (mode, dependency) => {
    const entry = mixedSurfaceRecord(mode, dependency);
    const records = new Map([['city/mixed', entry.record]]);
    const updater = paintUpdater(records);
    try {
      updater.update({ zoom: 8, styleRevision: 0 });
      const original = surfacePaint(entry.record);
      const fillReads = vi.spyOn(entry.land.programConfigurations, 'getFeatureRange');
      const circleReads = vi.spyOn(entry.dots.programConfigurations, 'getFeatureRange');
      for (const zoom of [8.125, 8.875, 9.25]) {
        for (const layer of [entry.road, entry.fill, entry.circle])
          layer.recalculate(new EvaluationParameters(zoom), []);
        const fillPaint = vi.spyOn(entry.fill.paint, 'get');
        const circlePaint = vi.spyOn(entry.circle.paint, 'get');
        updater.updateLivePaint({ zoom });
        updater.update({ zoom, styleRevision: 0 });
        expect(lineUniforms(entry.record).widthUniform()).toBe(zoom);
        expect(fillReads).not.toHaveBeenCalled();
        expect(circleReads).not.toHaveBeenCalled();
        expect(fillPaint).not.toHaveBeenCalled();
        expect(circlePaint).not.toHaveBeenCalled();
      }
      expect(surfacePaint(entry.record)).toEqual(original);
    }
    finally { destroy(records); }
  });

  it.each([
    [SceneMode.SCENE3D, 'camera'],
    [SceneMode.SCENE3D, 'composite'],
    [SceneMode.COLUMBUS_VIEW, 'camera'],
    [SceneMode.COLUMBUS_VIEW, 'composite'],
  ] as const)('keeps actual %s %s surface evaluation on its existing one-eighth zoom steps', (mode, dependency) => {
    const entry = mixedSurfaceRecord(mode, dependency);
    const records = new Map([['city/mixed', entry.record]]);
    const updater = paintUpdater(records);
    try {
      updater.update({ zoom: 8, styleRevision: 0 });
      const original = surfacePaint(entry.record);
      const fillReads = vi.spyOn(entry.land.programConfigurations, 'getFeatureRange');
      const circleReads = vi.spyOn(entry.dots.programConfigurations, 'getFeatureRange');
      for (const layer of [entry.road, entry.fill, entry.circle])
        layer.recalculate(new EvaluationParameters(8.025), []);
      updater.update({ zoom: 8.025, styleRevision: 0 });
      expect(fillReads).not.toHaveBeenCalled();
      expect(circleReads).not.toHaveBeenCalled();
      expect(surfacePaint(entry.record)).toEqual(original);
      for (const layer of [entry.road, entry.fill, entry.circle])
        layer.recalculate(new EvaluationParameters(8.125), []);
      updater.updateLivePaint({ zoom: 8.125 });
      updater.update({ zoom: 8.125, styleRevision: 0 });
      expect(fillReads).toHaveBeenCalledOnce();
      expect(circleReads).toHaveBeenCalledOnce();
      const current = surfacePaint(entry.record);
      expect(current.color[0]).toBeGreaterThan(0);
      expect(current.color[2]).toBeLessThan(255);
      expect(current.diameter).toBe(12);
      expect(current.visible).toBe(true);
      expect(lineUniforms(entry.record).widthUniform()).toBe(8.125);
    }
    finally { destroy(records); }
  });

  it.each([SceneMode.SCENE3D, SceneMode.COLUMBUS_VIEW])('refreshes %s surface zoom dependencies when constant paint becomes camera paint', (mode) => {
    const entry = mixedSurfaceRecord(mode, 'constant');
    const records = new Map([['city/mixed', entry.record]]);
    const updater = paintUpdater(records);
    try {
      updater.update({ zoom: 8, styleRevision: 0 });
      entry.fill.setPaintProperty('fill-color', ['interpolate', ['linear'], ['zoom'], 8, '#0000ff', 9, '#ff0000']);
      entry.circle.setPaintProperty('circle-radius', ['interpolate', ['linear'], ['zoom'], 8, 5, 9, 13]);
      for (const layer of [entry.fill, entry.circle]) {
        layer.updateTransitions({ now: 100, transition: { duration: 0 } });
        layer.recalculate(new EvaluationParameters(8.25, { now: 100 }), []);
      }
      updater.update({ zoom: 8.25, styleRevision: 1 });
      const first = surfacePaint(entry.record);
      expect(first.color[0]).toBeGreaterThan(0);
      expect(first.diameter).toBe(14);
      const reads = vi.spyOn(entry.land.programConfigurations, 'getFeatureRange');
      for (const layer of [entry.fill, entry.circle])
        layer.recalculate(new EvaluationParameters(8.375), []);
      updater.update({ zoom: 8.375, styleRevision: 1 });
      const next = surfacePaint(entry.record);
      expect(reads).toHaveBeenCalledOnce();
      expect(next.color[0]).toBeGreaterThan(first.color[0]);
      expect(next.diameter).toBe(16);
    }
    finally { destroy(records); }
  });

  it.each([SceneMode.SCENE3D, SceneMode.COLUMBUS_VIEW])('applies %s feature-state paint revisions even with a constant surface zoom key', (mode) => {
    const entry = mixedSurfaceRecord(mode, 'state');
    const records = new Map([['city/mixed', entry.record]]);
    const updater = paintUpdater(records);
    try {
      updater.update({ zoom: 8, styleRevision: 0 });
      const revision = paintRevision(entry.land);
      entry.land.update([{ id: '1', state: { selected: true } }], () => entry.fillFeature, { imagePositions: {} });
      entry.dots.update([{ id: '2', state: { radius: 13 } }], () => entry.pointFeature, { imagePositions: {} });
      expect(paintRevision(entry.land)).toBeGreaterThan(revision);
      updater.invalidate();
      updater.update({ zoom: 8, styleRevision: 0 });
      const current = surfacePaint(entry.record);
      expect(current.color).toEqual([255, 0, 0, 255]);
      expect(current.diameter).toBe(26);
      expect(current.visible).toBe(true);
    }
    finally { destroy(records); }
  });

  it.each([SceneMode.SCENE3D, SceneMode.COLUMBUS_VIEW])('continues %s forced surface transitions within one camera zoom step', (mode) => {
    const entry = mixedSurfaceRecord(mode, 'constant');
    const records = new Map([['city/mixed', entry.record]]);
    const updater = paintUpdater(records);
    try {
      updater.update({ zoom: 8, styleRevision: 0 });
      entry.fill.setPaintProperty('fill-color', '#ff0000');
      entry.circle.setPaintProperty('circle-radius', 13);
      for (const layer of [entry.fill, entry.circle]) {
        layer.updateTransitions({ now: 100, transition: { duration: 100 } });
        layer.recalculate(new EvaluationParameters(8, { now: 150 }), []);
      }
      const frame = { zoom: 8, styleRevision: 1, force: true, transitionLayerIds: new Set(['land', 'dots']) };
      updater.update(frame);
      const first = surfacePaint(entry.record);
      expect(first.diameter).toBe(18);
      for (const layer of [entry.fill, entry.circle])
        layer.recalculate(new EvaluationParameters(8, { now: 200 }), []);
      updater.update(frame);
      const next = surfacePaint(entry.record);
      expect(next.color[0]).toBeGreaterThan(first.color[0]);
      expect(next.diameter).toBe(26);
    }
    finally { destroy(records); }
  });
});

describe('live uniform line paint', () => {
  it('keeps an activated held evaluator when an unuploaded family writes its first uniform paint', () => {
    const held = lineRecord('city/held-family', false, undefined, true);
    const records = new Map([['city/held-family', held.record]]);
    const updater = paintUpdater(records);
    const chunk = (held.record.collections.get('lines') as PrimitiveCollection).get(0) as LineFamilyChunk;
    try {
      expect(chunk).toBeInstanceOf(LineFamilyChunk);
      expect(chunk.ready).toBe(false);
      const uniforms = linePaintForOwner(chunk.primitive)!;
      const snapshot = updater.captureLivePaint();
      held.layer.setPaintProperty('line-width', 18);
      held.layer.setPaintProperty('line-color', '#0000ff');
      held.layer.updateTransitions({ now: 100, transition: { duration: 0 } });
      held.layer.recalculate(new EvaluationParameters(12, { now: 100 }), []);
      updater.freezeExisting(snapshot);
      const frame = { zoom: 12, budget: { exhausted: true } };
      updater.updateLivePaint(frame);
      expect(uniforms.widthUniform()).toBe(12);
      // Native initialization uses the same family uniform writer. It must
      // retain the activated evaluator instead of reading the new live schema.
      chunk.updateUniformPaint(12);
      updater.updateLivePaint(frame);
      expect(uniforms.widthUniform()).toBe(12);
      expect(uniforms.colorUniform().red).toBe(1);
      updater.updateLivePaint({ ...frame, zoom: 0 });
      expect(uniforms.widthUniform()).toBe(0);
      expect(uniforms.colorUniform().alpha).toBe(0);
    }
    finally { destroy(records); }
  });

  it('updates Native uniforms when camera, global state and transition evaluation replace paint', () => {
    const state = { alpha: 0.5 };
    const layer = new LineStyleLayer({
      id: 'roads',
      type: 'line',
      source: 'city',
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0, 24, 24],
        'line-color': '#ff0000',
        'line-opacity': ['global-state', 'alpha'],
      },
    } satisfies LineLayerSpecification, state);
    const current = lineRecord('city/current', false, layer);
    const records = new Map([['city/current', current.record]]);
    const updater = paintUpdater(records);
    const frame = { zoom: 12, evaluationId: 2, styleRevision: 0, budget: { exhausted: true } };
    try {
      layer.recalculate(new EvaluationParameters(12), []);
      updater.updateLivePaint(frame);
      const uniforms = lineUniforms(current.record);
      expect(uniforms.widthUniform()).toBe(12);
      expect(uniforms.colorUniform().alpha).toBe(0.5);
      layer.recalculate(new EvaluationParameters(13), []);
      updater.updateLivePaint({ ...frame, zoom: 13, evaluationId: 3 });
      expect(uniforms.widthUniform()).toBe(13);
      state.alpha = 0.25;
      layer.recalculate(new EvaluationParameters(12, { now: 100 }), []);
      // Identical frame metadata must not hide a new evaluated paint object.
      updater.updateLivePaint(frame);
      expect(uniforms.widthUniform()).toBe(12);
      expect(uniforms.colorUniform().alpha).toBe(0.25);
      layer.setPaintProperty('line-width', 0);
      layer.setPaintProperty('line-color', '#0000ff');
      layer.setPaintProperty('line-opacity', 0);
      layer.updateTransitions({ now: 100, transition: { duration: 100 } });
      layer.recalculate(new EvaluationParameters(12, { now: 150 }), []);
      updater.updateLivePaint({ ...frame, force: true, styleRevision: 1 });
      expect(uniforms.widthUniform()).toBe(6);
      expect(uniforms.colorUniform().red).toBe(0.5);
      expect(uniforms.colorUniform().blue).toBe(0.5);
      expect(uniforms.colorUniform().alpha).toBe(0.125);
      layer.recalculate(new EvaluationParameters(12, { now: 200 }), []);
      updater.updateLivePaint({ ...frame, force: true, styleRevision: 1 });
      expect(uniforms.widthUniform()).toBe(0);
      expect(uniforms.colorUniform().alpha).toBe(0);
      expect(current.record.paint.lastZoom).toBe(8);
      expect(current.record.paint.lastStyleRevision).toBe(0);
    }
    finally { destroy(records); }
  });

  it('evaluates a newly held snapshot once per exact camera zoom after its record is removed', () => {
    const held = lineRecord('city/held');
    const records = new Map([['city/held', held.record]]);
    const updater = paintUpdater(records);
    try {
      const snapshot = new Map(updater.captureLivePaint());
      const collection = held.record.collections.get('lines') as PrimitiveCollection;
      const evaluate = vi.fn(snapshot.get(collection)!);
      snapshot.set(collection, evaluate);
      updater.freezeExisting(snapshot);
      const frame = { zoom: 12, evaluationId: 2, styleRevision: 0, budget: { exhausted: true } };
      updater.updateLivePaint(frame);
      expect(lineUniforms(held.record).widthUniform()).toBe(12);
      records.delete('city/held');
      updater.updateLivePaint(frame);
      updater.updateLivePaint({ ...frame, evaluationId: 3, styleRevision: 1 });
      expect(evaluate).toHaveBeenCalledTimes(1);
      updater.updateLivePaint({ ...frame, zoom: 0 });
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(lineUniforms(held.record).widthUniform()).toBe(0);
      expect(lineUniforms(held.record).colorUniform().alpha).toBe(0);
      expect(held.record.paint.lastZoom).toBe(8);
    }
    finally {
      records.set('city/held', held.record);
      destroy(records);
    }
  });

  it('reuses one evaluated uniform style across repeated calls and new collection owners', () => {
    const first = lineRecord('city/first');
    const appended = lineRecord('city/appended', false, first.layer);
    const records = new Map([['city/first', first.record]]);
    const updater = paintUpdater(records);
    const firstReads = vi.spyOn((first.record.buckets.roads as LineBucket).programConfigurations, 'getFeatureRange');
    const appendedReads = vi.spyOn((appended.record.buckets.roads as LineBucket).programConfigurations, 'getFeatureRange');
    try {
      first.layer.recalculate(new EvaluationParameters(12), []);
      const frame = { zoom: 12, evaluationId: 2, styleRevision: 0, budget: { exhausted: true } };
      updater.updateLivePaint(frame);
      expect(firstReads).toHaveBeenCalledTimes(1);
      updater.updateLivePaint(frame);
      updater.updateLivePaint({ ...frame, evaluationId: 3 });
      expect(firstReads).toHaveBeenCalledTimes(1);
      // Built at the old zoom, this owner has not received the cached frame.
      expect(lineUniforms(appended.record).widthUniform()).toBe(8);
      records.set('city/appended', appended.record);
      updater.updateLivePaint(frame);
      expect(appendedReads).not.toHaveBeenCalled();
      expect(lineUniforms(appended.record).widthUniform()).toBe(12);
      expect(lineUniforms(appended.record).colorUniform().alpha).toBe(0.5);
      expect(firstReads).toHaveBeenCalledTimes(1);
      expect(first.record.paint.lastZoom).toBe(8);
      expect(appended.record.paint.lastZoom).toBe(8);
    }
    finally {
      records.set('city/appended', appended.record);
      destroy(records);
    }
  });

  it('updates all current records while heavy work is exhausted without completing it', () => {
    const first = lineRecord('city/first');
    const last = lineRecord('city/last');
    const records = new Map([['city/first', first.record], ['city/last', last.record]]);
    const updater = paintUpdater(records);
    try {
      first.layer.recalculate(new EvaluationParameters(12), []);
      last.layer.recalculate(new EvaluationParameters(12), []);
      const frame = { zoom: 12, evaluationId: 2, styleRevision: 0, budget: { exhausted: true } };
      updater.updateLivePaint(frame);
      expect(updater.update(frame)).toEqual([]);
      expect(updater.needsContinuation).toBe(true);
      for (const record of records.values()) {
        const uniforms = lineUniforms(record);
        expect(uniforms.widthUniform()).toBe(12);
        expect(uniforms.colorUniform().alpha).toBe(0.5);
        expect(uniforms.colorUniform().red).toBe(1);
        expect(record.paint.lastZoom).toBe(8);
        expect(record.paint.lastEvaluationId).toBeUndefined();
      }
    }
    finally { destroy(records); }
  });

  it('keeps the committed camera curve live after schema mutation and record replacement', () => {
    const held = lineRecord('city/held');
    const records = new Map([['city/held', held.record]]);
    const updater = paintUpdater(records);
    try {
      const heldPaint = lineUniforms(held.record);
      const snapshot = updater.captureLivePaint();
      held.layer.setPaintProperty('line-width', ['get', 'width']);
      held.layer.setLayoutProperty('line-join', 'bevel');
      held.layer.recalculate(new EvaluationParameters(12), []);
      updater.freezeExisting(snapshot);
      const successor = lineRecord('city/successor');
      successor.layer.recalculate(new EvaluationParameters(12), []);
      records.set('city/successor', successor.record);
      updater.updateLivePaint({ zoom: 12, styleRevision: 1, budget: { exhausted: true } });
      expect(heldPaint.widthUniform()).toBe(12);
      expect(heldPaint.colorUniform().alpha).toBe(0.5);
      expect(heldPaint.colorUniform().red).toBe(1);
      const successorPaint = lineUniforms(successor.record);
      expect(successorPaint.widthUniform()).toBe(12);
      expect(successorPaint.colorUniform().alpha).toBe(0.5);
      records.delete('city/held');
      updater.updateLivePaint({ zoom: 0, styleRevision: 1, budget: { exhausted: true } });
      expect(heldPaint.widthUniform()).toBe(0);
      expect(heldPaint.colorUniform().alpha).toBe(0);
      expect(held.record.paint.frozen).toBe(true);
      for (const collection of held.record.collections.values()) collection.destroy();
      expect(() => updater.updateLivePaint({ zoom: 12 })).not.toThrow();
    }
    finally {
      records.set('city/held', held.record);
      destroy(records);
    }
  });

  it('leaves instance paint and its Native attribute access outside mandatory uniform work', () => {
    const instance = lineRecord('city/instance', true);
    const records = new Map([['city/instance', instance.record]]);
    const updater = paintUpdater(records);
    const primitive = (instance.record.collections.get('lines') as PrimitiveCollection).get(0) as Primitive;
    const instances = primitive.geometryInstances;
    const paint = primitive.getGeometryInstanceAttributes((Array.isArray(instances) ? instances[0] : instances).id);
    const width = [...paint.lineWidth];
    const color = [...paint.color];
    const attributes = vi.spyOn(primitive, 'getGeometryInstanceAttributes').mockImplementation(() => {
      throw new Error('mandatory uniform paint accessed instance attributes');
    });
    try {
      instance.layer.recalculate(new EvaluationParameters(12), []);
      updater.updateLivePaint({ zoom: 12, budget: { exhausted: true } });
      const uniforms = lineUniforms(instance.record);
      expect(uniforms.widthUniform()).toBe(1);
      expect(uniforms.colorUniform().alpha).toBe(1);
      expect(attributes).not.toHaveBeenCalled();
      expect([...paint.lineWidth]).toEqual(width);
      expect([...paint.color]).toEqual(color);
    }
    finally { destroy(records); }
  });

  it('resumes an existing line build with one Scene admission without admitting a second owner', () => {
    const first = lineRecord('city/first');
    const second = lineRecord('city/second');
    const records = new Map([['city/first', first.record], ['city/second', second.record]]);
    const updater = paintUpdater(records);
    const oldOwners = [...records.values()].map(record => record.collections.get('lines')!);
    try {
      for (const [tileId, entry] of [['city/first', first], ['city/second', second]] as const) {
        // Changed source coordinates require a replacement geometry owner.
        entry.record.linePrimitives[0].positions = entry.record.linePrimitives[0].positions.slice();
        entry.layer.recalculate(new EvaluationParameters(9), []);
        let checks = 0;
        const preparation = updater.refresh(tileId, entry.record, {
          zoom: 9,
          budget: {
            get exhausted() {
              return ++checks > 1;
            },
          },
        });
        expect(preparation.ready).toBe(false);
      }
      const replacements = [];
      let ready = false;
      for (let frame = 0; frame < 20 && !ready; frame++) {
        let consumed = false;
        const budget = {
          exhausted: true,
          takeMinimumProgress: () => {
            if (consumed)
              return false;
            consumed = true;
            return true;
          },
        };
        const progress = updater.refresh('city/first', first.record, { zoom: 9, budget });
        replacements.push(...progress.replacements);
        ready = progress.ready;
        expect(updater.refresh('city/second', second.record, { zoom: 9, budget }).ready).toBe(false);
      }
      expect(ready).toBe(true);
      expect(replacements).toHaveLength(1);
      expect(replacements[0].tileId).toBe('city/first');
      expect(second.record.collections.get('lines')).toBe(oldOwners[1]);
    }
    finally {
      destroy(records);
      for (const collection of oldOwners) {
        if (!collection.isDestroyed())
          collection.destroy();
      }
    }
  });
});
